import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeProfile, preparePreview, validatePreview, MAX_AGE } from './cleaner.mjs';
import { stateDir, readJson, saveJson, lastJob, acquireJob, releaseJob } from './state.mjs';

function requireStandardChrome() {
  let pid = process.ppid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const executable = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 3000 }).trim();
    if (basename(executable) === 'Google Chrome') {
      const command = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 3000 });
      if (/--user-data-dir(?:=|\s)/.test(command)) throw new Error('不支持使用 --user-data-dir 的 Chrome，未启动清理。');
      return;
    }
    pid = Number(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 3000 }).trim());
  }
  throw new Error('无法确认调用来自标准 Google Chrome，未启动清理。');
}

async function dispatch(message) {
  if (process.platform !== 'darwin') throw new Error('本地清理组件目前仅支持 macOS Google Chrome。');
  if (message.action === 'status') return { lastJob: lastJob() };
  const profile = chromeProfile();
  const previews = join(stateDir(), 'previews');
  mkdirSync(previews, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(previews)) {
    const path = join(previews, name);
    if (Date.now() - statSync(path).mtimeMs > MAX_AGE) rmSync(path, { force: true });
  }
  if (message.action === 'preview') {
    const preview = await preparePreview(profile, message);
    const token = randomUUID();
    saveJson(join(previews, `${token}.json`), preview);
    return {
      token, profile: `${profile.name} (${profile.dir})`,
      groups: preview.groups.map(({ guid, title, tabCount }) => ({ guid, title, tabCount })),
      orphanCount: preview.orphanKeys.length, entityCount: Object.keys(preview.hashes).length,
      protectedCount: preview.protectedCount, requiresSync: preview.requiresSync, lastJob: lastJob(),
    };
  }
  if (message.action !== 'clean') throw new Error('不支持此操作。');
  requireStandardChrome();
  if (message.confirmRestart !== true) throw new Error('请先确认删除与重启 Chrome。');
  if (!/^[a-f0-9-]{36}$/.test(message.token || '')) throw new Error('预览无效，请重新扫描。');
  const path = join(previews, `${message.token}.json`);
  const preview = readJson(path);
  validatePreview(preview, profile, message.openGroupTitles, message.syncAcknowledged);
  acquireJob();
  const jobId = randomUUID();
  const job = { jobId, state: 'queued', startedAt: Date.now(), message: '准备备份并重启 Chrome。' };
  let fd;
  try {
    const jobFile = join(stateDir(), 'job.json');
    saveJson(jobFile, { preview, openGroupTitles: message.openGroupTitles, syncAcknowledged: message.syncAcknowledged === true, ...job });
    fd = openSync(join(stateDir(), 'worker.log'), 'a', 0o600);
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], { detached: true, stdio: ['ignore', fd, fd] });
    await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
    worker.unref();
    saveJson(join(stateDir(), 'last-job.json'), { ...job, pid: worker.pid });
    rmSync(path, { force: true });
    return { jobId };
  } catch (error) { releaseJob(); saveJson(join(stateDir(), 'last-job.json'), { ...job, state: 'failed', message: error.message }); throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

async function readMessage() {
  let data = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    data = Buffer.concat([data, chunk]);
    if (data.length < 4) continue;
    const size = data.readUInt32LE(0);
    if (size > 1024 * 1024) throw new Error('消息过大。');
    if (data.length >= size + 4) return JSON.parse(data.subarray(4, size + 4).toString('utf8'));
  }
  throw new Error('消息不完整。');
}

function respond(value) {
  let body = Buffer.from(JSON.stringify(value));
  if (body.length > 1024 * 1024) body = Buffer.from(JSON.stringify({ ok: false, error: '分组列表过大，无法安全显示预览，未启动清理。' }));
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
}

try {
  process.umask(0o077);
  const config = readJson(join(stateDir(), 'config.json'));
  if (process.argv[2] !== `chrome-extension://${config.extensionId}/`) throw new Error('未授权的扩展来源。');
  respond({ ok: true, result: await dispatch(await readMessage()) });
} catch (error) { respond({ ok: false, error: error.code === 'ENOENT' ? '清理组件或预览记录不存在，请重新安装或扫描。' : error.message }); }
