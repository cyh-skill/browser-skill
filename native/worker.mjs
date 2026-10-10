import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { chromeProfile, runCleanup } from './cleaner.mjs';
import { stateDir, readJson, saveJson, releaseJob } from './state.mjs';

const root = stateDir();
const statusFile = join(root, 'last-job.json');
const job = readJson(join(root, 'job.json'));
const config = readJson(join(root, 'config.json'));
const receipt = { jobId: job.jobId, startedAt: job.startedAt, pid: process.pid, state: 'running', message: '正在备份并清理。' };
const running = () => {
  try { execFileSync('/usr/bin/pgrep', ['-x', 'Google Chrome'], { stdio: 'pipe' }); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
};
try {
  process.umask(0o077);
  // Do not start if the native host failed before committing a queued receipt.
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const queued = readJson(statusFile); ready = queued.jobId === job.jobId && queued.pid === process.pid && queued.state === 'queued'; } catch {}
    if (ready) break;
    await delay(50);
  }
  if (!ready) throw new Error('清理任务未能完成启动登记，未退出 Chrome。');
  // Allow the native reply to reach the popup before quitting the browser.
  await delay(1200);
  saveJson(statusFile, receipt);
  const result = await runCleanup(job.preview, {
    profile: chromeProfile, openGroupTitles: job.openGroupTitles, syncAcknowledged: job.syncAcknowledged,
    backupDir: config.backupDir,
    isRunning: running,
    capture: async () => {
      if (!running()) throw new Error('Chrome 已退出，请重新打开并扫描。');
      const windows = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "JSON.stringify(Application('Google Chrome').windows().map(w=>({mode:w.mode(),urls:w.tabs().map(t=>t.url())})))"], { encoding: 'utf8', timeout: 15000 }));
      if (!windows.length || windows.some((window) => window.mode !== 'normal')) throw new Error('存在无痕窗口或无法恢复的窗口，请先关闭它们再清理。');
      saveJson(join(root, 'windows-before.json'), windows);
    },
    quit: async () => {
      execFileSync('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to quit'], { timeout: 20000, stdio: 'pipe' });
      for (let i = 0; i < 80 && running(); i++) await delay(250);
      if (running()) throw new Error('Chrome 未退出（可能有未保存页面的提示），未修改数据库。');
    },
    onBackup: async (backup) => { receipt.backup = backup; saveJson(statusFile, receipt); },
    reopen: async () => {
      execFileSync('/usr/bin/open', ['-a', 'Google Chrome', '--args', '--restore-last-session'], { timeout: 15000, stdio: 'pipe' });
      for (let i = 0; i < 40 && !running(); i++) await delay(250);
      if (!running()) throw new Error('浏览器未启动');
    },
  });
  saveJson(statusFile, { ...receipt, ...result, state: 'complete', finishedAt: Date.now(), message: `已删除 ${result.groups} 个分组、${result.orphanCount} 条孤立标签记录；数据库校验通过，Chrome 已重新启动。${result.backupWarning || `历史备份保留 ${result.backupRetention.kept} 份（最多 3 份）。`}` });
} catch (error) {
  saveJson(statusFile, { ...receipt, state: 'failed', backup: error.backup || receipt.backup, finishedAt: Date.now(), message: error.message });
} finally { rmSync(join(root, 'job.json'), { force: true }); releaseJob(); }
