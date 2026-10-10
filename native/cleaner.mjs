import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { openStore, closeStore, readContents, keysOf, metadataKey, storageKeyOf, backup, applyWrites } from './vendor/chrome-tab-group-cleaner/store.js';
import { tombstone } from './vendor/chrome-tab-group-cleaner/tombstone.js';
import { pruneBackups } from './backups.mjs';

export const USER_DATA = join(homedir(), 'Library/Application Support/Google/Chrome');
export const STATE_DIR = join(homedir(), '.browser-skill/group-cleaner');
export const MAX_AGE = 5 * 60 * 1000;

export function chromeProfile(userData = USER_DATA) {
  const state = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8'));
  const profiles = Object.entries(state.profile?.info_cache || {});
  // Native messaging does not identify the caller's Chrome profile. Refuse an
  // ambiguous profile rather than applying this extension's open-group guard
  // to a different user's database.
  if (profiles.length !== 1) throw new Error('当前组件仅支持单配置 Chrome；检测到多个配置，已停止清理以避免操作错误的配置。');
  const [dir, info] = profiles[0];
  if (!/^(Default|Profile \d+)$/.test(dir)) throw new Error('不支持此 Chrome 配置目录。');
  const db = join(userData, dir, 'Sync Data/LevelDB');
  if (!existsSync(db)) throw new Error('此配置没有已保存标签组数据库。');
  const prefs = JSON.parse(readFileSync(join(userData, dir, 'Preferences'), 'utf8'));
  const sync = prefs.sync || {};
  return { dir, name: info.name || dir, db, sync: ['keep_everything_synced', 'saved_tab_groups', 'saved_tab_group', 'tab_groups'].some((key) => sync[key] === true) };
}

export function validateTitles(titles) {
  if (!Array.isArray(titles) || titles.length > 10000 || titles.some((title) => typeof title !== 'string' || title.length > 10000)) {
    throw new Error('无法确认正在打开的分组，请重新扫描。');
  }
  return new Set(titles);
}

export async function snapshot(dbPath, allowCopy = true) {
  const { db, temp } = await openStore(dbPath, allowCopy);
  try {
    const contents = await readContents(db);
    const hashes = {};
    for (const key of [...keysOf(contents.groups), ...contents.orphans.map((tab) => tab.key)]) {
      hashes[key] = createHash('sha256').update(await db.get(key)).digest('hex');
    }
    return { contents, hashes };
  } finally { await closeStore(db, temp); }
}

export function selection(contents, scope, orphanSweep, titles) {
  if (!['agent', 'all'].includes(scope) || typeof orphanSweep !== 'boolean') throw new Error('清理范围无效。');
  const open = validateTitles(titles);
  const matches = contents.groups.filter((group) => scope === 'all' || group.title.startsWith('Agent · '));
  const groups = matches.filter((group) => !open.has(group.title));
  const orphanKeys = orphanSweep ? contents.orphans.map((tab) => tab.key) : [];
  return { groups, orphanKeys, keys: [...keysOf(groups), ...orphanKeys], protectedCount: matches.length - groups.length };
}

export async function preparePreview(profile, args) {
  const { contents, hashes } = await snapshot(profile.db);
  const chosen = selection(contents, args.scope, args.orphans, args.openGroupTitles);
  return {
    createdAt: Date.now(), profileDir: profile.dir,
    groups: chosen.groups.map((group) => ({ guid: group.guid, title: group.title, tabCount: group.tabs.length, keys: keysOf([group]) })),
    orphanKeys: chosen.orphanKeys,
    hashes: Object.fromEntries(chosen.keys.map((key) => [key, hashes[key]])),
    requiresSync: profile.sync || chosen.keys.some((key) => contents.metadata.has(storageKeyOf(key))),
    protectedCount: chosen.protectedCount,
  };
}

export function validatePreview(preview, profile, titles, syncAcknowledged) {
  if (!preview || Date.now() - preview.createdAt > MAX_AGE || preview.createdAt > Date.now() || preview.profileDir !== profile.dir) throw new Error('预览已过期或配置已更改，请重新扫描。');
  const open = validateTitles(titles);
  if (preview.groups.some((group) => open.has(group.title))) throw new Error('预览中的分组已被打开，已停止清理，请重新扫描。');
  if ((preview.requiresSync || profile.sync) && syncAcknowledged !== true) throw new Error('请先确认同步删除对其他设备的影响。');
  if (!Object.keys(preview.hashes).length) throw new Error('没有需要清理的记录。');
}

export function deletionPlan(preview, current, syncAcknowledged, profileSync = false) {
  const { contents, hashes } = current;
  for (const group of preview.groups) {
    const live = contents.groups.find((value) => value.guid === group.guid);
    if (!live || JSON.stringify(keysOf([live]).sort()) !== JSON.stringify([...group.keys].sort())) throw new Error('分组记录已变化，请重新扫描；未删除任何记录。');
  }
  const liveOrphans = new Set(contents.orphans.map((tab) => tab.key));
  if (preview.orphanKeys.some((key) => !liveOrphans.has(key))) throw new Error('孤立标签记录已变化，请重新扫描。');
  const keys = Object.keys(preview.hashes);
  if (keys.some((key) => hashes[key] !== preview.hashes[key])) throw new Error('预览后记录已变化，请重新扫描；未删除任何记录。');
  const synced = profileSync || keys.some((key) => contents.metadata.has(storageKeyOf(key)));
  if (synced && syncAcknowledged !== true) throw new Error('同步状态已变化，请重新扫描并确认同步删除。');
  const writes = [];
  let tombstones = 0;
  for (const key of keys) {
    writes.push({ type: 'del', key });
    const meta = contents.metadata.get(storageKeyOf(key));
    if (meta === undefined) continue;
    const metaKey = metadataKey(storageKeyOf(key));
    writes.push({ type: 'put', key: metaKey, value: tombstone(meta, metaKey, Date.now()) });
    tombstones++;
  }
  return { writes, tombstones };
}

// Browser effects are injected so tests use a real LevelDB and never quit the
// user's browser. The production worker supplies the macOS implementation.
export async function runCleanup(preview, options) {
  const profile = options.profile();
  validatePreview(preview, profile, options.openGroupTitles, options.syncAcknowledged);
  // Validate metadata before interrupting the browser, and again after quit.
  deletionPlan(preview, await snapshot(profile.db), options.syncAcknowledged, profile.sync);
  await options.capture();
  let quitting = false;
  let failure = null;
  let receipt = {};
  try {
    quitting = true;
    await options.quit();
    if (options.isRunning()) throw new Error('Chrome 仍在运行，未修改数据库。');
    const freshProfile = options.profile();
    if (freshProfile.dir !== profile.dir) throw new Error('Chrome 配置发生变化，未修改数据库。');
    const current = await snapshot(profile.db, false);
    const planned = deletionPlan(preview, current, options.syncAcknowledged, freshProfile.sync);
    mkdirSync(dirname(options.backupDir), { recursive: true, mode: 0o700 });
    mkdirSync(options.backupDir, { recursive: true, mode: 0o700 });
    chmodSync(options.backupDir, 0o700);
    receipt.backup = backup(profile.db, options.backupDir);
    chmodSync(receipt.backup, 0o700);
    await options.onBackup?.(receipt.backup);
    await applyWrites(profile.db, planned.writes);
    const after = await snapshot(profile.db, false);
    if (Object.keys(preview.hashes).some((key) => after.hashes[key] !== undefined)) throw new Error('清理后校验失败，请使用备份检查。');
    receipt = { ...receipt, groups: preview.groups.length, orphanCount: preview.orphanKeys.length, entityCount: Object.keys(preview.hashes).length, tombstones: planned.tombstones };
  } catch (error) { failure = error; }
  finally {
    if (quitting && !options.isRunning()) {
      try { await options.reopen(); }
      catch (error) { failure = new Error(`${failure ? `${failure.message}；` : ''}Chrome 恢复失败：${error.message}。请手动打开 Chrome。`); }
    }
  }
  if (failure) { failure.backup = receipt.backup; throw failure; }
  // Rotate only after deletion verification and browser recovery succeed.
  // A failed cleanup keeps all recovery points for investigation.
  try { receipt.backupRetention = pruneBackups(options.backupDir, profile.dir, receipt.backup); }
  catch (error) { receipt.backupWarning = `历史备份清理未完成：${error.message}`; }
  return receipt;
}
