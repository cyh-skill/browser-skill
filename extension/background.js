// browser-skill bridge —— MV3 后台 service worker（通道 B）
//
// 通过 WebSocket 连接本地 scripts/ext-bridge.mjs，接收命令并用 chrome.debugger /
// chrome.tabs / chrome.tabGroups 执行，把结果回传。
// 与通道 A（CDP-proxy）相比：免开 chrome://inspect 调试开关；会话隔离用真·彩色标签组。
// 注意：chrome.debugger 会触发 Chrome 顶部「正在调试此浏览器」提示条，属正常现象。

const BRIDGE_URL = 'ws://127.0.0.1:3458';
let ws = null;
let reconnectTimer = null;

// session 名 -> tabGroupId
const sessionGroups = {};
const managedTabs = new Map(); // tabId -> { session, ownership: created|borrowed, lastAccessed }
const commandTails = new Map();
let registryLoaded = false;
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
function colorForSession(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

function log(...a) { console.log('[bridge]', ...a); }

async function ensureRegistryLoaded() {
  if (registryLoaded) return;
  registryLoaded = true;
  try {
    const stored = await chrome.storage.session.get('managedTabs');
    const tabs = await chrome.tabs.query({});
    const liveIds = new Set(tabs.map((tab) => tab.id));
    for (const [tabId, meta] of stored.managedTabs || []) {
      if (liveIds.has(Number(tabId))) managedTabs.set(Number(tabId), meta);
    }
    await persistRegistry();
  } catch (e) { log('load managed registry failed', e.message); }
}

async function persistRegistry() {
  try { await chrome.storage.session.set({ managedTabs: [...managedTabs.entries()] }); }
  catch (e) { log('persist managed registry failed', e.message); }
}

function requireManaged(tabId, expectedSession) {
  if (!Number.isInteger(tabId)) throw new Error('需要 target ID');
  const meta = managedTabs.get(tabId);
  if (!meta) throw new Error(`target ${tabId} 未被托管；先用 /new 创建，或显式调用 /borrow 借用`);
  if (expectedSession && meta.session !== expectedSession) {
    throw new Error(`target ${tabId} 属于 session ${meta.session}，不是 ${expectedSession}`);
  }
  meta.lastAccessed = Date.now();
  return meta;
}

async function registerManaged(tabId, session, ownership) {
  const existing = managedTabs.get(tabId);
  if (existing && existing.session !== session) {
    throw new Error(`target ${tabId} 已由 session ${existing.session} 托管`);
  }
  const meta = existing || { session, ownership, lastAccessed: Date.now() };
  meta.lastAccessed = Date.now();
  managedTabs.set(tabId, meta);
  await persistRegistry();
  return { ...meta, alreadyManaged: Boolean(existing) };
}

async function returnBorrowed(tabId) {
  const meta = requireManaged(tabId);
  if (meta.ownership !== 'borrowed') throw new Error(`target ${tabId} 由 Agent 创建，请用 /close 关闭`);
  await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
  attached.delete(tabId);
  managedTabs.delete(tabId);
  await persistRegistry();
  return { targetId: String(tabId), session: meta.session, ownership: 'borrowed', action: 'returned' };
}

function elementResolverSource(value) {
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

async function acquireCommandKeys(keys) {
  const normalized = [...new Set(keys.filter(Boolean))].sort();
  const releases = [];
  for (const key of normalized) {
    const previous = commandTails.get(key) || Promise.resolve();
    let releaseCurrent;
    const current = new Promise((resolve) => { releaseCurrent = resolve; });
    commandTails.set(key, current);
    await previous.catch(() => {});
    releases.push(() => {
      releaseCurrent();
      if (commandTails.get(key) === current) commandTails.delete(key);
    });
  }
  return () => { for (const release of releases.reverse()) release(); };
}

function connect() {
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => { log('connected', BRIDGE_URL); send({ type: 'hello', ua: navigator.userAgent }); };
  ws.onclose = () => { log('closed'); ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || !msg.id) return;
    try {
      const result = await handle(msg.cmd, msg.args || {});
      send({ id: msg.id, ok: true, result });
    } catch (e) {
      send({ id: msg.id, ok: false, error: String(e && e.message || e) });
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // 800ms 快速重连：让 bridge.mjs 的探测窗口能可靠抓到扩展，断连后也能更快恢复
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 800);
}

// MV3 service worker 会闲置回收：用 alarm 定期唤醒并保活/重连
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState > 1) connect();
  else send({ type: 'ping' });
});

// --- chrome.debugger 封装 ---
const attached = new Set();
function dbg(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}
function attach(tabId) {
  return new Promise((resolve, reject) => {
    if (attached.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else { attached.add(tabId); resolve(); }
    });
  });
}
chrome.debugger.onDetach.addListener((src) => { if (src.tabId) attached.delete(src.tabId); });
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!managedTabs.delete(tabId)) return;
  persistRegistry().catch(() => {});
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

async function evalIn(tabId, expression) {
  await attach(tabId);
  const r = await dbg(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
  return r && r.result ? r.result.value : undefined;
}

async function elementCenter(tabId, selector) {
  const js = '(() => { const el = ' + elementResolverSource(selector) + ';'
    + ' if (!el) return { error: "未找到元素" }; el.scrollIntoView({block:"center",inline:"center"});'
    + ' const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, tag: el.tagName }; })()';
  return evalIn(tabId, js);
}

async function waitComplete(tabId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evalIn(tabId, 'document.readyState') === 'complete') return; } catch (e) {}
    await sleep(400);
  }
}

const TARGET_COMMANDS = new Set([
  'navigate', 'back', 'info', 'eval', 'click', 'clickAt', 'humanClick',
  'type', 'scroll', 'screenshot',
]);

// --- 命令实现 ---
async function handle(cmd, a) {
  await ensureRegistryLoaded();
  const tabId = Number(a.target);
  const keys = [];
  if (TARGET_COMMANDS.has(cmd) || cmd === 'close' || cmd === 'return') {
    const meta = requireManaged(tabId, a.session);
    keys.push(`target:${tabId}`, `session:${meta.session}`);
  } else if (cmd === 'borrow') {
    const requestedSession = a.session || 'default';
    const existing = managedTabs.get(tabId);
    if (existing && existing.session !== requestedSession) {
      throw new Error(`target ${tabId} 已由 session ${existing.session} 托管`);
    }
    keys.push(`target:${tabId}`, `session:${existing?.session || requestedSession}`);
  } else if (cmd === 'new' || cmd === 'closeSession') {
    keys.push(`session:${a.session || 'default'}`);
  }
  const release = await acquireCommandKeys(keys);
  try { return await handleUnlocked(cmd, a); } finally { release(); }
}

async function handleUnlocked(cmd, a) {
  if (TARGET_COMMANDS.has(cmd)) requireManaged(Number(a.target), a.session);

  switch (cmd) {
    case 'health':
      return {
        channel: 'ext-bridge',
        connected: true,
        apiVersion: '1.4.0',
        managedTabs: managedTabs.size,
        features: ['snapshot', 'elementRefs', 'borrowReturn', 'managedGuard', 'targetQueue'],
      };

    case 'list': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => {
        const meta = managedTabs.get(t.id);
        return {
          targetId: String(t.id),
          url: t.url,
          title: t.title,
          managed: Boolean(meta),
          session: meta?.session || null,
          ownership: meta?.ownership || null,
        };
      });
    }

    case 'sessions': {
      const tabs = await chrome.tabs.query({});
      const byId = new Map(tabs.map((tab) => [tab.id, tab]));
      const groups = {};
      for (const [tabId, meta] of managedTabs) {
        const tab = byId.get(tabId);
        if (!tab) continue;
        (groups[meta.session] ||= []).push({
          targetId: String(tabId),
          url: tab.url,
          title: tab.title,
          ownership: meta.ownership,
          lastAccessed: meta.lastAccessed,
        });
      }
      return Object.entries(groups).map(([session, tabs]) => ({ session, count: tabs.length, tabs }));
    }

    case 'new': {
      const session = a.session || 'default';
      const tab = await chrome.tabs.create({ url: a.url || 'about:blank', active: false });
      await groupTab(tab.id, session);
      await registerManaged(tab.id, session, 'created');
      if (a.url && a.url !== 'about:blank') { try { await attach(tab.id); await waitComplete(tab.id); } catch (e) {} }
      return { targetId: String(tab.id), session, ownership: 'created' };
    }

    case 'borrow': {
      const tabId = Number(a.target);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error(`未找到页面 target ${a.target}`);
      const existing = managedTabs.get(tabId);
      if (!existing) await attach(tabId);
      let meta;
      try {
        meta = await registerManaged(tabId, a.session || 'default', 'borrowed');
      } catch (error) {
        if (!existing) {
          await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
          attached.delete(tabId);
        }
        throw error;
      }
      return {
        targetId: String(tabId),
        session: meta.session,
        ownership: meta.ownership,
        alreadyManaged: meta.alreadyManaged,
      };
    }

    case 'return':
      return returnBorrowed(Number(a.target));

    case 'navigate': {
      const tabId = Number(a.target);
      await chrome.tabs.update(tabId, { url: a.url });
      await waitComplete(tabId);
      return { ok: true };
    }

    case 'back': {
      const tabId = Number(a.target);
      await chrome.tabs.goBack(tabId).catch(() => {});
      return { ok: true };
    }

    case 'info': {
      const tabId = Number(a.target);
      return evalIn(tabId, 'JSON.stringify({title:document.title,url:location.href,ready:document.readyState})');
    }

    case 'eval':
      return { value: await evalIn(Number(a.target), a.expr) };

    case 'click': {
      const tabId = Number(a.target);
      const js = '(() => { const el = ' + elementResolverSource(a.selector) + ';'
        + ' if (!el) return { error: "未找到元素" }; el.scrollIntoView({block:"center"}); el.click();'
        + ' return { clicked: true, tag: el.tagName }; })()';
      return evalIn(tabId, js);
    }

    case 'clickAt':
    case 'humanClick': {
      const tabId = Number(a.target);
      const c = await elementCenter(tabId, a.selector);
      if (!c || c.error) throw new Error(c && c.error || '取坐标失败');
      await attach(tabId);
      if (cmd === 'humanClick') {
        const sx = Math.max(0, c.x - rnd(120, 260)), sy = Math.max(0, c.y - rnd(60, 180));
        const cx = (sx + c.x) / 2 + rnd(-60, 60), cy = (sy + c.y) / 2 + rnd(-40, 40);
        const steps = Math.round(rnd(16, 26));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps, mt = 1 - t;
          const x = mt * mt * sx + 2 * mt * t * cx + t * t * c.x + rnd(-1.2, 1.2);
          const y = mt * mt * sy + 2 * mt * t * cy + t * t * c.y + rnd(-1.2, 1.2);
          await dbg(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
          await sleep(rnd(6, 22));
        }
        await sleep(rnd(40, 120));
      }
      await dbg(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      await sleep(rnd(30, 90));
      await dbg(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      return { clicked: true, humanized: cmd === 'humanClick', x: c.x, y: c.y };
    }

    case 'type': {
      const tabId = Number(a.target);
      const focusJs = '(() => { const el = ' + elementResolverSource(a.selector) + ';'
        + ' if (!el) return { error: "未找到元素" }; el.scrollIntoView({block:"center"}); el.focus();'
        + (a.clear ? ' try { const p = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;'
          + ' const s = Object.getOwnPropertyDescriptor(p, "value").set; s.call(el, ""); el.dispatchEvent(new Event("input",{bubbles:true})); } catch(e){}' : '')
        + ' return { ok: true, tag: el.tagName }; })()';
      const fv = await evalIn(tabId, focusJs);
      if (!fv || fv.error) throw new Error(fv && fv.error || '聚焦失败');
      await attach(tabId);
      const min = Number(a.min ?? 40), max = Number(a.max ?? 160);
      for (const ch of Array.from(a.text || '')) {
        await dbg(tabId, 'Input.insertText', { text: ch });
        await sleep(rnd(min, max));
      }
      if (a.enter) {
        await dbg(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await dbg(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      }
      return { typed: Array.from(a.text || '').length, tag: fv.tag };
    }

    case 'scroll': {
      const tabId = Number(a.target);
      const dir = a.direction || 'down', y = Math.abs(Number(a.y || 3000));
      let js;
      if (dir === 'top') js = 'window.scrollTo(0,0)';
      else if (dir === 'bottom') js = 'window.scrollTo(0,document.body.scrollHeight)';
      else if (dir === 'up') js = 'window.scrollBy(0,-' + y + ')';
      else js = 'window.scrollBy(0,' + y + ')';
      await evalIn(tabId, js + '; "ok"');
      await sleep(800);
      return { ok: true };
    }

    case 'screenshot': {
      const tabId = Number(a.target);
      await attach(tabId);
      const r = await dbg(tabId, 'Page.captureScreenshot', { format: a.format || 'png' });
      return { data: r.data };  // base64；由 bridge 写文件
    }

    case 'close': {
      const tabId = Number(a.target);
      const meta = requireManaged(tabId);
      if (meta.ownership === 'borrowed') return returnBorrowed(tabId);
      await chrome.tabs.remove(tabId);
      managedTabs.delete(tabId);
      await persistRegistry();
      return { targetId: String(tabId), ownership: 'created', action: 'closed' };
    }

    case 'closeSession': {
      const targets = [...managedTabs.entries()].filter(([, meta]) => meta.session === a.session);
      const created = targets.filter(([, meta]) => meta.ownership === 'created').map(([tabId]) => tabId);
      const borrowed = targets.filter(([, meta]) => meta.ownership === 'borrowed').map(([tabId]) => tabId);
      for (const tabId of borrowed) await returnBorrowed(tabId);
      if (created.length) await chrome.tabs.remove(created);
      for (const tabId of created) managedTabs.delete(tabId);
      await persistRegistry();
      return { closed: created.length, returned: borrowed.length, session: a.session };
    }

    default:
      throw new Error('未知命令: ' + cmd);
  }
}

// --- 彩色会话分组 ---
async function groupTab(tabId, session) {
  try {
    let groupId = sessionGroups[session];
    // 已记录的 group 可能已不存在
    if (groupId != null) {
      const exists = await chrome.tabGroups.get(groupId).catch(() => null);
      if (!exists) groupId = undefined;
    }
    groupId = await chrome.tabs.group(groupId != null ? { tabIds: [tabId], groupId } : { tabIds: [tabId] });
    sessionGroups[session] = groupId;
    await chrome.tabGroups.update(groupId, { title: session, color: colorForSession(session) });
  } catch (e) { log('group failed', e.message); }
}
function sessionFromGroup(groupId) {
  if (groupId == null || groupId < 0) return null;
  for (const [s, gid] of Object.entries(sessionGroups)) if (gid === groupId) return s;
  return null;
}

connect();
