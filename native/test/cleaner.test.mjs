import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, cpSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassicLevel } from 'classic-level';
import { encode, text, decode } from '../vendor/chrome-tab-group-cleaner/proto.js';
import { applyWrites, readStore, restore } from '../vendor/chrome-tab-group-cleaner/store.js';
import { preparePreview, runCleanup, validatePreview, chromeProfile, snapshot } from '../cleaner.mjs';

const key = (id) => `saved_tab_group-dt-${id}`;
const metaKey = (id) => `saved_tab_group-md-${id}`;
const group = (id, title) => encode(new Map([[1, 1n], [2, encode(new Map([[1, text(id)], [4, encode(new Map([[2, text(title)], [3, 2n]]))]]))]]));
const tab = (id, parent, url = 'https://example.com/') => encode(new Map([[1, 1n], [2, encode(new Map([[1, text(id)], [5, encode(new Map([[1, text(parent)], [2, 0n], [3, text(url)], [4, text('Example')]]))]]))]]));
const metadata = () => encode(new Map([[1, text('client-hash')], [2, text('server-id')], [4, 2n], [5, 2n], [9, text('old-hash')]]));

async function fixture(t, synced = false) {
  const root = mkdtempSync(join(tmpdir(), 'browser-skill-cleaner-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'Default/Sync Data/LevelDB');
  const db = new ClassicLevel(dbPath, { keyEncoding: 'utf8', valueEncoding: 'view' });
  const entries = [
    [key('old'), group('old', 'Agent · old')], [key('old-tab'), tab('old-tab', 'old')],
    [key('active'), group('active', 'Agent · active')], [key('active-tab'), tab('active-tab', 'active')],
    [key('personal'), group('personal', '个人收藏')], [key('personal-tab'), tab('personal-tab', 'personal')],
    [key('orphan'), tab('orphan', 'missing')],
    ['saved_tab_group-GlobalMetadata', Uint8Array.from([1, 2, 3])], ['sessions-dt-unrelated', Uint8Array.from([7, 8, 9])],
  ];
  if (synced) entries.push([metaKey('old'), metadata()], [metaKey('old-tab'), metadata()], [metaKey('orphan'), metadata()]);
  await db.batch(entries.map(([key, value]) => ({ type: 'put', key, value }))); await db.close();
  const profile = { dir: 'Default', name: '测试', db: dbPath, sync: false };
  const preview = await preparePreview(profile, { scope: 'agent', orphans: true, openGroupTitles: ['Agent · active'] });
  let running = true;
  const events = [];
  const options = {
    profile: () => profile, openGroupTitles: ['Agent · active'], syncAcknowledged: synced,
    backupDir: join(root, 'backups'), isRunning: () => running,
    capture: async () => { events.push('capture'); },
    quit: async () => { events.push('quit'); running = false; },
    reopen: async () => { events.push('reopen'); running = true; },
  };
  return { root, profile, preview, options, events };
}

test('Agent 清理只删已预览的历史分组及孤立记录，真实备份可恢复', async (t) => {
  const f = await fixture(t);
  assert.equal(f.preview.groups.length, 1); assert.equal(f.preview.protectedCount, 1);
  const receipt = await runCleanup(f.preview, f.options);
  assert.equal(receipt.entityCount, 3); assert.ok(existsSync(receipt.backup));
  assert.deepEqual(f.events, ['capture', 'quit', 'reopen']);
  const after = await readStore(f.profile.db);
  assert.deepEqual(after.groups.map((g) => g.title).sort(), ['Agent · active', '个人收藏']);
  assert.equal(after.orphans.length, 0);
  const db = new ClassicLevel(f.profile.db, { keyEncoding: 'utf8', valueEncoding: 'view' });
  assert.deepEqual([...await db.get('sessions-dt-unrelated')], [7, 8, 9]);
  assert.deepEqual([...await db.get('saved_tab_group-GlobalMetadata')], [1, 2, 3]); await db.close();
  await restore(receipt.backup, f.profile.db);
  assert.equal((await readStore(f.profile.db)).groups.length, 3);
});

test('全部范围仍保留打开分组，关闭孤立清理选项后不删除孤立标签', async (t) => {
  const f = await fixture(t);
  const preview = await preparePreview(f.profile, { scope: 'all', orphans: false, openGroupTitles: ['Agent · active'] });
  assert.equal(preview.groups.length, 2);
  await runCleanup(preview, f.options);
  const after = await readStore(f.profile.db);
  assert.deepEqual(after.groups.map((g) => g.title), ['Agent · active']); assert.equal(after.orphans.length, 1);
});

test('元数据存在时必须确认同步，并回读真实待提交删除标记', async (t) => {
  const f = await fixture(t, true);
  assert.equal(f.preview.requiresSync, true);
  await assert.rejects(runCleanup(f.preview, { ...f.options, syncAcknowledged: false }), /同步/);
  assert.deepEqual(f.events, []);
  const result = await runCleanup(f.preview, f.options);
  assert.equal(result.tombstones, 3);
  const after = await readStore(f.profile.db);
  for (const value of after.metadata.values()) { const fields = decode(value); assert.equal(fields.get(3), 1n); assert.equal(fields.get(4), 3n); assert.equal(fields.has(9), false); }
});

test('预览过期、分组重新打开时在退出前拒绝', async (t) => {
  const f = await fixture(t);
  assert.throws(() => validatePreview({ ...f.preview, createdAt: 0 }, f.profile, [], false), /过期/);
  await assert.rejects(runCleanup(f.preview, { ...f.options, openGroupTitles: ['Agent · old'] }), /已被打开/);
  assert.deepEqual(f.events, []);
});

test('退出后记录变化则停止删除，并且仍恢复 Chrome', async (t) => {
  const f = await fixture(t);
  const quit = f.options.quit;
  f.options.quit = async () => { await quit(); await applyWrites(f.profile.db, [{ type: 'put', key: key('old-tab'), value: tab('old-tab', 'old', 'https://changed.example/') }]); };
  await assert.rejects(runCleanup(f.preview, f.options), /记录已变化/);
  assert.deepEqual(f.events, ['capture', 'quit', 'reopen']);
  assert.equal((await readStore(f.profile.db)).groups.length, 3);
});

test('预览后新增分组不会进入删除范围', async (t) => {
  const f = await fixture(t);
  await applyWrites(f.profile.db, [{ type: 'put', key: key('new'), value: group('new', 'Agent · new') }]);
  await runCleanup(f.preview, f.options);
  assert.ok((await readStore(f.profile.db)).groups.some((g) => g.guid === 'new'));
});

test('退出后组里新增标签会阻止删除整个预览', async (t) => {
  const f = await fixture(t);
  const quit = f.options.quit;
  f.options.quit = async () => { await quit(); await applyWrites(f.profile.db, [{ type: 'put', key: key('new-tab'), value: tab('new-tab', 'old') }]); };
  await assert.rejects(runCleanup(f.preview, f.options), /分组记录已变化/);
  assert.equal((await readStore(f.profile.db)).groups.length, 3);
  assert.equal(f.events.at(-1), 'reopen');
});

test('Chrome 拒绝退出时不会写库或重复启动浏览器', async (t) => {
  const f = await fixture(t);
  f.options.quit = async () => { throw new Error('拒绝退出'); };
  await assert.rejects(runCleanup(f.preview, f.options), /拒绝退出/);
  assert.deepEqual(f.events, ['capture']); assert.equal((await readStore(f.profile.db)).groups.length, 3);
});

test('备份失败也恢复浏览器并保留全部记录', async (t) => {
  const f = await fixture(t);
  const bad = join(f.root, 'not-a-directory'); writeFileSync(bad, 'x');
  await assert.rejects(runCleanup(f.preview, { ...f.options, backupDir: join(bad, 'backups') }));
  assert.equal(f.events.at(-1), 'reopen'); assert.equal((await readStore(f.profile.db)).groups.length, 3);
});

test('无法读写的同步元数据在退出浏览器前被拒绝', async (t) => {
  const f = await fixture(t, true);
  await applyWrites(f.profile.db, [{ type: 'put', key: metaKey('old'), value: encode(new Map([[4, 1n]])) }]);
  await assert.rejects(runCleanup(f.preview, f.options), /client tag hash/); assert.deepEqual(f.events, []);
});

test('Chrome 持有数据库锁时可读取副本，原始记录不变', async (t) => {
  const f = await fixture(t);
  const db = new ClassicLevel(f.profile.db, { keyEncoding: 'utf8', valueEncoding: 'view' }); await db.open();
  try { const result = await snapshot(f.profile.db); assert.equal(result.contents.groups.length, 3); assert.ok(await db.get(key('old'))); }
  finally { await db.close(); }
});

test('多配置和不安全配置目录均拒绝，不回退到 Default', async (t) => {
  const f = await fixture(t);
  mkdirSync(join(f.root, 'data'));
  const path = join(f.root, 'data/Local State');
  writeFileSync(path, JSON.stringify({ profile: { info_cache: { Default: {}, 'Profile 1': {} } } }));
  assert.throws(() => chromeProfile(join(f.root, 'data')), /多个配置/);
  writeFileSync(path, JSON.stringify({ profile: { info_cache: { '../other': {} } } }));
  assert.throws(() => chromeProfile(join(f.root, 'data')), /目录/);
});

function seedBackups(f) {
  mkdirSync(f.options.backupDir, { recursive: true });
  const old = [1, 2, 3, 4].map((day) => join(f.options.backupDir, `Default-2025-01-0${day}T00-00-00-000Z`));
  for (const path of old) cpSync(f.profile.db, path, { recursive: true });
  return old;
}

test('成功清理后保留本次及最近两份历史备份，其他目录与链接保留', async (t) => {
  const f = await fixture(t);
  const old = seedBackups(f);
  const other = join(f.options.backupDir, 'Profile 1-2025-01-01T00-00-00-000Z');
  cpSync(f.profile.db, other, { recursive: true });
  const manual = join(f.options.backupDir, 'manual-backup'); cpSync(f.profile.db, manual, { recursive: true });
  const incomplete = join(f.options.backupDir, 'Default-2025-01-05T00-00-00-000Z'); mkdirSync(incomplete);
  const linked = join(f.options.backupDir, 'Default-2025-01-06T00-00-00-000Z'); symlinkSync(f.profile.db, linked);
  const receipt = await runCleanup(f.preview, f.options);
  assert.deepEqual(receipt.backupRetention, { kept: 3, removed: 2 });
  assert.ok(existsSync(receipt.backup)); assert.ok(existsSync(old[2])); assert.ok(existsSync(old[3]));
  assert.equal(existsSync(old[0]), false); assert.equal(existsSync(old[1]), false);
  for (const path of [other, manual, incomplete, linked]) assert.ok(existsSync(path));
  assert.equal((await readStore(receipt.backup)).groups.length, 3);
});

test('重启失败时保留全部历史备份和本次恢复文件，不执行轮换', async (t) => {
  const f = await fixture(t);
  const old = seedBackups(f);
  f.options.reopen = async () => { throw new Error('启动失败'); };
  let failure;
  await assert.rejects(runCleanup(f.preview, f.options), (error) => { failure = error; return /恢复失败/.test(error.message); });
  assert.ok(existsSync(failure.backup)); assert.equal(readdirSync(f.options.backupDir).length, 5);
  for (const path of old) assert.ok(existsSync(path));
});
