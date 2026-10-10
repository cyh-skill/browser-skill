import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './cleaner.mjs';

export function stateDir() { mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); return STATE_DIR; }
export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function saveJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
export function lastJob() {
  const path = join(stateDir(), 'last-job.json');
  return existsSync(path) ? readJson(path) : null;
}
export function acquireJob() {
  const lock = join(stateDir(), 'job.lock');
  if (existsSync(lock)) {
    const old = lastJob();
    let alive = false;
    if (old?.pid) { try { process.kill(old.pid, 0); alive = true; } catch {} }
    if (alive || !old || Date.now() - old.startedAt < 30000) throw new Error('已有清理任务执行中，请稍后查看结果。');
    saveJson(join(stateDir(), 'last-job.json'), { ...old, state: 'failed', message: '上次清理进程意外退出，请检查备份后重新扫描。' });
    rmSync(lock, { recursive: true, force: true });
  }
  mkdirSync(lock, { mode: 0o700 });
}
export function releaseJob() { rmSync(join(stateDir(), 'job.lock'), { recursive: true, force: true }); }
