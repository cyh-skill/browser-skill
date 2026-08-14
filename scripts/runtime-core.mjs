// Shared runtime primitives for both browser channels. Keep this module free of
// browser-specific dependencies so it can be covered by Node's built-in tests.

export class HttpError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export class ManagedTargetRegistry {
  #entries = new Map();
  #now;

  constructor(now = () => Date.now()) {
    this.#now = now;
  }

  get size() { return this.#entries.size; }
  [Symbol.iterator]() { return this.#entries[Symbol.iterator](); }
  entries() { return this.#entries.entries(); }
  values() { return this.#entries.values(); }
  keys() { return this.#entries.keys(); }
  has(targetId) { return this.#entries.has(String(targetId)); }
  get(targetId) { return this.#entries.get(String(targetId)); }
  clear() { this.#entries.clear(); }

  registerCreated(targetId, session = 'default') {
    return this.#register(targetId, session, 'created');
  }

  borrow(targetId, session = 'default') {
    const id = requireTargetId(targetId);
    const existing = this.#entries.get(id);
    if (existing) {
      if (existing.session !== session) {
        throw new HttpError(`target ${id} 已由 session ${existing.session} 托管`, 409);
      }
      existing.lastAccessed = this.#now();
      return { ...existing, alreadyManaged: true };
    }
    return this.#register(id, session, 'borrowed');
  }

  #register(targetId, session, ownership) {
    const id = requireTargetId(targetId);
    const normalizedSession = String(session || 'default').trim() || 'default';
    const entry = { session: normalizedSession, ownership, lastAccessed: this.#now() };
    this.#entries.set(id, entry);
    return { targetId: id, ...entry };
  }

  require(targetId, expectedSession) {
    const id = requireTargetId(targetId);
    const entry = this.#entries.get(id);
    if (!entry) {
      throw new HttpError(
        `target ${id} 未被托管；先用 /new 创建，或显式调用 /borrow?target=${encodeURIComponent(id)}&session=NAME 借用用户标签页`,
        409,
      );
    }
    if (expectedSession && entry.session !== expectedSession) {
      throw new HttpError(`target ${id} 属于 session ${entry.session}，不是 ${expectedSession}`, 409);
    }
    entry.lastAccessed = this.#now();
    return entry;
  }

  release(targetId) {
    const id = requireTargetId(targetId);
    const entry = this.require(id);
    this.#entries.delete(id);
    return { targetId: id, ...entry };
  }

  delete(targetId) {
    return this.#entries.delete(String(targetId));
  }

  touch(targetId) {
    const entry = this.#entries.get(String(targetId));
    if (entry) entry.lastAccessed = this.#now();
    return entry;
  }

  forSession(session) {
    return [...this.#entries.entries()]
      .filter(([, entry]) => entry.session === session)
      .map(([targetId, entry]) => ({ targetId, ...entry }));
  }
}

export class KeyedQueue {
  #tails = new Map();

  get size() { return this.#tails.size; }

  async acquire(key) {
    if (!key) return () => {};
    const normalized = String(key);
    const previous = this.#tails.get(normalized) || Promise.resolve();
    let releaseCurrent;
    const current = new Promise((resolve) => { releaseCurrent = resolve; });
    this.#tails.set(normalized, current);
    await previous.catch(() => {});
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.#tails.get(normalized) === current) this.#tails.delete(normalized);
    };
  }

  async run(key, task) {
    const release = await this.acquire(key);
    try { return await task(); } finally { release(); }
  }

  async acquireMany(keys) {
    const normalized = [...new Set((keys || []).filter(Boolean).map(String))].sort();
    const releases = [];
    for (const key of normalized) releases.push(await this.acquire(key));
    return () => {
      for (const release of releases.reverse()) release();
    };
  }
}

export function requestQueueKeys(pathname, query = {}, targetSession = null) {
  const keys = [];
  if (query.target) keys.push(`target:${query.target}`);
  if (query.session) keys.push(`session:${query.session}`);
  else if (targetSession) keys.push(`session:${targetSession}`);
  else if (pathname === '/new' || pathname === '/borrow') keys.push('session:default');
  return keys;
}

export function requireTargetId(value) {
  const targetId = String(value ?? '').trim();
  if (!targetId) throw new HttpError('需要 ?target=ID', 400);
  return targetId;
}

export function isElementRef(value) {
  return /^@e[1-9]\d*$/.test(String(value || '').trim());
}

export function elementResolverSource(value) {
  const encoded = JSON.stringify(String(value || '').trim());
  return `(() => {
    const input = ${encoded};
    if (/^@e[1-9]\\d*$/.test(input)) {
      const state = window[Symbol.for('cyh-browser-skill.refs.v1')];
      return state?.refs?.get(input) || null;
    }
    try { return document.querySelector(input); } catch { return null; }
  })()`;
}
