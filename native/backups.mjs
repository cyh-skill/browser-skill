import { readdirSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const BACKUP_LIMIT = 3;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

// Only complete timestamped backups belonging to this Chrome profile take
// part in rotation. Keep the current recovery point even after a clock change.
export function pruneBackups(root, profileDir, currentBackup) {
  const prefix = `${profileDir}-`;
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && STAMP.test(entry.name.slice(prefix.length)))
    .filter((entry) => {
      try { return lstatSync(join(root, entry.name, 'CURRENT')).isFile(); }
      catch { return false; }
    })
    .map((entry) => resolve(root, entry.name))
    .sort().reverse();
  const current = resolve(currentBackup);
  if (!candidates.includes(current)) throw new Error('本次备份目录未通过核对，保留全部历史备份。');
  const ordered = [current, ...candidates.filter((path) => path !== current)];
  const expired = ordered.slice(BACKUP_LIMIT);
  for (const path of expired) rmSync(path, { recursive: true });
  return { kept: Math.min(ordered.length, BACKUP_LIMIT), removed: expired.length };
}
