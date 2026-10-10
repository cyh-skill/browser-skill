import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ClassicLevel } from 'classic-level';
import { parseRecord } from './proto.js';
export const KEY_PREFIX = 'saved_tab_group-';
const KEY_END = 'saved_tab_group.';
export const DATA_PREFIX = `${KEY_PREFIX}dt-`;
export const METADATA_PREFIX = `${KEY_PREFIX}md-`;
/** Saved tab groups use the entity guid as their storage key. */
export const storageKeyOf = (dataKey) => dataKey.slice(DATA_PREFIX.length);
export const metadataKey = (storageKey) => `${METADATA_PREFIX}${storageKey}`;
function open(path) {
    return new ClassicLevel(path, { keyEncoding: 'utf8', valueEncoding: 'view' });
}
/**
 * Opens the store, falling back to a throwaway copy when the browser holds the
 * exclusive LOCK. Reads may use the copy; writes must not, so `snapshot` is off
 * for them and the open error surfaces instead.
 */
export async function openStore(path, snapshot) {
    const direct = open(path);
    try {
        await direct.open({ createIfMissing: false });
        return { db: direct, temp: null };
    }
    catch (error) {
        await direct.close().catch(() => {});
        if (!snapshot)
            throw error;
        const temp = mkdtempSync(join(tmpdir(), 'chrome-tab-group-cleaner-'));
        const db = open(temp);
        try {
            cpSync(path, temp, { recursive: true });
            rmSync(join(temp, 'LOCK'), { force: true });
            await db.open({ createIfMissing: false });
            return { db, temp };
        }
        catch (copyError) {
            await db.close().catch(() => {});
            rmSync(temp, { recursive: true, force: true });
            throw copyError;
        }
    }
}
export async function closeStore(db, temp) {
    try { await db.close(); }
    finally { if (temp) rmSync(temp, { recursive: true, force: true }); }
}
export async function readContents(db) {
    const groups = new Map();
    const tabs = [];
    const metadata = new Map();
    const other = [];
    for await (const [key, value] of db.iterator({ gte: KEY_PREFIX, lt: KEY_END })) {
        if (key.startsWith(METADATA_PREFIX)) {
            metadata.set(key.slice(METADATA_PREFIX.length), value);
            continue;
        }
        if (!key.startsWith(DATA_PREFIX)) {
            other.push(key);
            continue;
        }
        const record = parseRecord(value);
        if (record.kind === 'group' && record.guid)
            groups.set(record.guid, { ...record, key, tabs: [] });
        else if (record.kind === 'tab')
            tabs.push({ ...record, key });
    }
    const orphans = [];
    for (const tab of tabs) {
        const group = tab.groupGuid === null ? undefined : groups.get(tab.groupGuid);
        (group?.tabs ?? orphans).push(tab);
    }
    for (const group of groups.values())
        group.tabs.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return {
        groups: [...groups.values()].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
        orphans,
        metadata,
        other
    };
}
export const readStore = async (path, snapshot = true) => {
    const { db, temp } = await openStore(path, snapshot);
    try {
        return await readContents(db);
    }
    finally {
        await closeStore(db, temp);
    }
};
/** Deleting a group means deleting its tabs too, or they linger as orphans. */
export const keysOf = (groups) => groups.flatMap((group) => [group.key, ...group.tabs.map((tab) => tab.key)]);
export function backup(dbPath, destinationRoot) {
    if (!destinationRoot) throw new Error('backup directory must be configured by the plugin');
    const profile = basename(dirname(dirname(dbPath)));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(destinationRoot, `${profile}-${stamp}`);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(dbPath, dest, { recursive: true });
    return dest;
}
export async function applyWrites(dbPath, writes) {
    const db = open(dbPath);
    await db.open({ createIfMissing: false });
    try {
        await db.batch(writes);
    }
    finally {
        await db.close();
    }
}
export const deleteKeys = async (dbPath, keys) => applyWrites(dbPath, keys.map((key) => ({ type: 'del', key })));
/**
 * Copies saved tab group entities from a backup back into a live store. Only
 * keys under the tab group prefix are touched - everything else in the sync
 * store (sessions, preferences, search engines) is left exactly as it is.
 */
export async function restore(backupPath, dbPath) {
    const source = open(backupPath);
    await source.open({ createIfMissing: false });
    const entries = [];
    for await (const [key, value] of source.iterator({ gte: KEY_PREFIX, lt: KEY_END }))
        entries.push([key, value]);
    await source.close();
    const target = open(dbPath);
    await target.open({ createIfMissing: false });
    try {
        await target.batch(entries.map(([key, value]) => ({ type: 'put', key, value })));
    }
    finally {
        await target.close();
    }
    return entries.length;
}
