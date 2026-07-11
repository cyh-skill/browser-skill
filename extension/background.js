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
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
function colorForSession(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

function log(...a) { console.log('[bridge]', ...a); }

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
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

async function evalIn(tabId, expression) {
  await attach(tabId);
  const r = await dbg(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
  return r && r.result ? r.result.value : undefined;
}

async function elementCenter(tabId, selector) {
  const js = '(() => { const el = document.querySelector(' + JSON.stringify(selector) + ');'
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

// --- 命令实现 ---
async function handle(cmd, a) {
  switch (cmd) {
    case 'health':
      return { channel: 'ext-bridge', connected: true };

    case 'list': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ targetId: String(t.id), url: t.url, title: t.title, session: sessionFromGroup(t.groupId) }));
    }

    case 'sessions': {
      const tabs = await chrome.tabs.query({});
      const groups = {};
      for (const t of tabs) {
        const s = sessionFromGroup(t.groupId);
        if (!s) continue;
        (groups[s] ||= []).push({ targetId: String(t.id), url: t.url, title: t.title });
      }
      return Object.entries(groups).map(([session, tabs]) => ({ session, count: tabs.length, tabs }));
    }

    case 'new': {
      const session = a.session || 'default';
      const tab = await chrome.tabs.create({ url: a.url || 'about:blank', active: false });
      await groupTab(tab.id, session);
      if (a.url && a.url !== 'about:blank') { try { await attach(tab.id); await waitComplete(tab.id); } catch (e) {} }
      return { targetId: String(tab.id), session };
    }

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
      const js = '(() => { const el = document.querySelector(' + JSON.stringify(a.selector) + ');'
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
      const focusJs = '(() => { const el = document.querySelector(' + JSON.stringify(a.selector) + ');'
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
      await chrome.tabs.remove(Number(a.target));
      return { ok: true };
    }

    case 'closeSession': {
      const tabs = await chrome.tabs.query({});
      const ids = tabs.filter((t) => sessionFromGroup(t.groupId) === a.session).map((t) => t.id);
      if (ids.length) await chrome.tabs.remove(ids);
      return { closed: ids.length, session: a.session };
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
