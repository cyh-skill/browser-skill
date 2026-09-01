// cyh-browser-skill MV3 extension provider.
// Rust owns routing and cross-provider queues; this extension owns Agent Windows,
// browser-side consent, semantic-page primitives, and normal page interaction.

const BRIDGE_URL = 'ws://127.0.0.1:3458';
const API_VERSION = '2.0.0';
const managedTabs = new Map();
const agentWindows = new Map();
const agentGroups = new Map();
const commandTails = new Map();
const attached = new Set();
const consoleBuffers = new Map();
const networkBuffers = new Map();
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
let ws = null;
let reconnectTimer = null;
let registryLoaded = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rnd = (min, max) => min + Math.random() * (max - min);
const log = (...args) => console.log('[browser-skill]', ...args);

function colorForSession(session) {
  let hash = 0;
  for (const character of session) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

function groupTitle(session) {
  return `Agent · ${session}`;
}

async function ensureRegistryLoaded() {
  if (registryLoaded) return;
  registryLoaded = true;
  try {
    const stored = await chrome.storage.session.get(['managedTabs', 'agentWindows', 'agentGroups']);
    const tabs = await chrome.tabs.query({});
    const liveTabs = new Set(tabs.map((tab) => tab.id));
    for (const [tabId, metadata] of stored.managedTabs || []) {
      if (liveTabs.has(Number(tabId))) managedTabs.set(Number(tabId), metadata);
    }
    const windows = await chrome.windows.getAll();
    const liveWindows = new Set(windows.map((window) => window.id));
    for (const [session, windowId] of stored.agentWindows || []) {
      if (liveWindows.has(Number(windowId))) agentWindows.set(session, Number(windowId));
    }
    const groups = await chrome.tabGroups.query({});
    const liveGroups = new Set(groups.map((group) => group.id));
    for (const [session, groupId] of stored.agentGroups || []) {
      if (liveGroups.has(Number(groupId))) agentGroups.set(session, Number(groupId));
    }
    await persistRegistry();
  } catch (error) {
    log('registry restore failed', error.message);
  }
}

async function persistRegistry() {
  await chrome.storage.session.set({
    managedTabs: [...managedTabs.entries()],
    agentWindows: [...agentWindows.entries()],
    agentGroups: [...agentGroups.entries()],
  }).catch((error) => log('registry persist failed', error.message));
}

function requireManaged(tabId, expectedSession) {
  if (!Number.isInteger(tabId)) throw new Error('target ID is required');
  const metadata = managedTabs.get(tabId);
  if (!metadata) throw new Error(`target ${tabId} is unmanaged; create it or borrow it first`);
  if (expectedSession && metadata.session !== expectedSession) {
    throw new Error(`target ${tabId} belongs to session ${metadata.session}, not ${expectedSession}`);
  }
  metadata.lastAccessed = Date.now();
  return metadata;
}

async function registerManaged(tabId, session, ownership, extra = {}) {
  const existing = managedTabs.get(tabId);
  if (existing && existing.session !== session) throw new Error(`target ${tabId} is already managed by session ${existing.session}`);
  const metadata = existing || { session, ownership, createdAt: Date.now() };
  Object.assign(metadata, extra, { lastAccessed: Date.now() });
  managedTabs.set(tabId, metadata);
  await persistRegistry();
  return { ...metadata, alreadyManaged: Boolean(existing) };
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
  try { ws = new WebSocket(BRIDGE_URL); }
  catch { scheduleReconnect(); return; }
  ws.onopen = () => send({
    type: 'hello',
    apiVersion: API_VERSION,
    ua: navigator.userAgent,
    instance: chrome.runtime.id,
    capabilities: ['agentWindow', 'tabGroups', 'borrowConsent', 'a11y', 'console', 'network', 'emulate', 'humanLoop'],
  });
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message?.id) return;
    try { send({ id: message.id, ok: true, result: await handle(message.cmd, message.args || {}) }); }
    catch (error) { send({ id: message.id, ok: false, error: String(error?.message || error) }); }
  };
}

function send(value) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 800);
}

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState > WebSocket.OPEN) connect();
  else send({ type: 'ping' });
});

function dbg(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  attached.add(tabId);
  consoleBuffers.set(tabId, consoleBuffers.get(tabId) || []);
  networkBuffers.set(tabId, networkBuffers.get(tabId) || []);
  await Promise.allSettled([
    dbg(tabId, 'Runtime.enable'), dbg(tabId, 'Log.enable'), dbg(tabId, 'Network.enable'), dbg(tabId, 'Page.enable'),
  ]);
}

async function detach(tabId) {
  if (!attached.has(tabId)) return;
  await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
  attached.delete(tabId);
}

chrome.debugger.onDetach.addListener((source) => { if (source.tabId) attached.delete(source.tabId); });
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;
  if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown' || method === 'Log.entryAdded') {
    appendBuffer(consoleBuffers, tabId, { seq: Date.now(), method, params }, 300);
  }
  if (method === 'Network.responseReceived' || method === 'Network.loadingFailed') {
    const response = params.response || {};
    appendBuffer(networkBuffers, tabId, {
      seq: Date.now(), method,
      url: response.url || params.requestId,
      status: response.status,
      mimeType: response.mimeType,
      resourceType: params.type,
      error: params.errorText,
    }, 500);
  }
});

function appendBuffer(store, key, value, limit) {
  const buffer = store.get(key) || [];
  buffer.push(value);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  store.set(key, buffer);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  managedTabs.delete(tabId);
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
  persistRegistry().catch(() => {});
});
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [session, id] of agentWindows) {
    if (id !== windowId) continue;
    agentWindows.delete(session);
    agentGroups.delete(session);
  }
  persistRegistry().catch(() => {});
});
chrome.tabGroups.onRemoved.addListener((group) => {
  for (const [session, groupId] of agentGroups) if (groupId === group.id) agentGroups.delete(session);
  persistRegistry().catch(() => {});
});

async function ensureAgentWindow(session, url = 'about:blank', noFocus = true) {
  const existingId = agentWindows.get(session);
  if (existingId != null) {
    const existing = await chrome.windows.get(existingId).catch(() => null);
    if (existing) {
      const tab = await chrome.tabs.create({ windowId: existingId, url, active: !noFocus });
      return { windowId: existingId, tab };
    }
    agentWindows.delete(session);
  }
  const created = await chrome.windows.create({ url, type: 'normal', focused: !noFocus, width: 1280, height: 900 });
  const tab = created.tabs?.[0];
  if (!tab?.id) throw new Error('failed to create Agent Window tab');
  agentWindows.set(session, created.id);
  await persistRegistry();
  return { windowId: created.id, tab };
}

async function groupAgentTab(tabId, session, windowId) {
  try {
    let groupId = agentGroups.get(session);
    if (groupId != null) {
      const group = await chrome.tabGroups.get(groupId).catch(() => null);
      if (!group || group.windowId !== windowId) groupId = undefined;
    }
    groupId = await chrome.tabs.group(groupId == null ? { tabIds: [tabId] } : { tabIds: [tabId], groupId });
    await chrome.tabGroups.update(groupId, { title: groupTitle(session), color: colorForSession(session) });
    agentGroups.set(session, groupId);
    await persistRegistry();
    return groupId;
  } catch (error) {
    log('Agent tab grouping failed', error.message);
    return null;
  }
}

async function confirmBorrow(tabId, session) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (requestedSession) => new Promise((resolve) => {
      const old = document.getElementById('__cyh_browser_skill_borrow__');
      if (old) old.remove();
      const root = document.createElement('div');
      root.id = '__cyh_browser_skill_borrow__';
      root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.48);display:grid;place-items:center;font:14px system-ui;color:#111827';
      root.innerHTML = `<div style="width:min(480px,calc(100vw - 40px));background:white;border-radius:16px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.35)"><h2 style="margin:0 0 12px;font-size:20px">允许 Agent 临时控制此标签页？</h2><p style="line-height:1.6;margin:0 0 18px">会话 <b>${String(requestedSession).replace(/[<>&]/g, '')}</b> 请求操作当前页面。完成后标签页会归还，不会被关闭。</p><div style="display:flex;justify-content:flex-end;gap:10px"><button data-result="false" style="padding:9px 16px">拒绝</button><button data-result="true" style="padding:9px 16px;background:#2563eb;color:white;border:0;border-radius:8px">允许</button></div></div>`;
      document.documentElement.appendChild(root);
      const finish = (allowed) => { root.remove(); resolve(allowed); };
      root.addEventListener('click', (event) => {
        const value = event.target?.getAttribute?.('data-result');
        if (value != null) finish(value === 'true');
      });
      setTimeout(() => finish(false), 60000);
    }),
    args: [session],
  }).catch((error) => { throw new Error(`cannot request tab consent: ${error.message}`); });
  return results?.[0]?.result === true;
}

async function returnBorrowed(tabId) {
  const metadata = requireManaged(tabId);
  if (metadata.ownership !== 'borrowed') throw new Error(`target ${tabId} was created by the Agent; close it instead`);
  await detach(tabId);
  managedTabs.delete(tabId);
  await persistRegistry();
  return { targetId: String(tabId), session: metadata.session, ownership: 'borrowed', action: 'returned' };
}

async function cdpTargetId(tabId) {
  const targets = await chrome.debugger.getTargets();
  return targets.find((target) => target.tabId === tabId)?.id || null;
}

function elementResolverSource(value) {
  const encoded = JSON.stringify(String(value || '').trim());
  return `(() => { const input=${encoded}; if(/^@e[1-9]\\d*$/.test(input)){const v2=window[Symbol.for('cyh-browser-skill.refs.v2')];const v1=window[Symbol.for('cyh-browser-skill.refs.v1')];return v2?.refs?.get(input)||v1?.refs?.get(input)||null;} try{return document.querySelector(input)}catch{return null} })()`;
}

async function evalIn(tabId, expression) {
  await attach(tabId);
  const result = await dbg(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
  return result?.result?.value;
}

async function elementCenter(tabId, selector) {
  return evalIn(tabId, `(() => { const el=${elementResolverSource(selector)}; if(!el)return null; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,tag:el.tagName}; })()`);
}

async function waitComplete(tabId, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evalIn(tabId, 'document.readyState') === 'complete') return true; } catch {}
    await sleep(250);
  }
  return false;
}

const TARGET_COMMANDS = new Set([
  'navigate', 'back', 'forward', 'reload', 'info', 'eval', 'a11y', 'click', 'clickAt', 'humanClick',
  'hover', 'type', 'fill', 'select', 'press', 'scroll', 'screenshot', 'console', 'network', 'emulate', 'requestHelp',
]);

async function handle(command, args) {
  await ensureRegistryLoaded();
  const tabId = Number(args.target);
  const keys = [];
  if (TARGET_COMMANDS.has(command) || command === 'close' || command === 'return' || command === 'resolveTarget' || command === 'leaseCdp' || command === 'resumeCdp') {
    const metadata = requireManaged(tabId, args.session);
    if (metadata.cdpLeased && !['leaseCdp', 'resumeCdp', 'resolveTarget', 'close', 'return'].includes(command)) {
      throw new Error(`target ${tabId} is leased to the direct CDP provider`);
    }
    keys.push(`target:${tabId}`, `session:${metadata.session}`);
  } else if (command === 'borrow') {
    keys.push(`target:${tabId}`, `session:${args.session || 'default'}`);
  } else if (command === 'new' || command === 'closeSession') {
    keys.push(`session:${args.session || 'default'}`);
  }
  const release = await acquireCommandKeys(keys);
  try { return await execute(command, args); }
  finally { release(); }
}

async function execute(command, args) {
  const tabId = Number(args.target);
  switch (command) {
    case 'health':
      return { apiVersion: API_VERSION, connected: true, managedTabs: managedTabs.size, agentWindows: agentWindows.size };
    case 'list': {
      const tabs = await chrome.tabs.query({});
      const agentWindowIds = new Set(agentWindows.values());
      return tabs.filter((tab) => {
        if (args.scope === 'agent') return agentWindowIds.has(tab.windowId);
        if (args.scope === 'user') return !agentWindowIds.has(tab.windowId);
        return true;
      }).map((tab) => {
        const metadata = managedTabs.get(tab.id);
        return {
          targetId: String(tab.id), tabId: tab.id, url: tab.url, title: tab.title,
          provider: 'extension',
          managed: Boolean(metadata), session: metadata?.session || null, ownership: metadata?.ownership || null,
          agentWindow: agentWindowIds.has(tab.windowId), windowId: tab.windowId,
          tabGroupId: tab.groupId >= 0 ? tab.groupId : null, cdpTargetId: metadata?.cdpTargetId || null,
        };
      });
    }
    case 'sessions': {
      const tabs = new Map((await chrome.tabs.query({})).map((tab) => [tab.id, tab]));
      const sessions = {};
      for (const [id, metadata] of managedTabs) {
        const tab = tabs.get(id);
        if (!tab) continue;
        (sessions[metadata.session] ||= []).push({ targetId: String(id), tabId: id, url: tab.url, title: tab.title, ...metadata });
      }
      return Object.entries(sessions).map(([session, values]) => ({ session, windowId: agentWindows.get(session), count: values.length, tabs: values }));
    }
    case 'new': {
      const session = args.session || 'default';
      const { windowId, tab } = await ensureAgentWindow(session, args.url || 'about:blank', args.noFocus !== false);
      const tabGroupId = await groupAgentTab(tab.id, session, windowId);
      await attach(tab.id);
      const targetId = await cdpTargetId(tab.id);
      await registerManaged(tab.id, session, 'created', { agentWindowId: windowId, tabGroupId, cdpTargetId: targetId });
      if (args.url && args.url !== 'about:blank') await waitComplete(tab.id);
      return { targetId: String(tab.id), tabId: tab.id, cdpTargetId: targetId, session, ownership: 'created', agentWindowId: windowId, tabGroupId, provider: 'extension' };
    }
    case 'borrow': {
      const session = args.session || 'default';
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error(`target ${tabId} was not found`);
      const existing = managedTabs.get(tabId);
      if (!existing && !(await confirmBorrow(tabId, session))) throw new Error('user denied or did not answer the tab borrow request');
      await attach(tabId);
      const targetId = await cdpTargetId(tabId);
      const metadata = await registerManaged(tabId, session, 'borrowed', {
        originalWindowId: tab.windowId, originalIndex: tab.index, originalActive: tab.active, cdpTargetId: targetId,
      });
      return { targetId: String(tabId), tabId, cdpTargetId: targetId, session, ownership: 'borrowed', alreadyManaged: metadata.alreadyManaged, consent: existing ? 'existing' : 'approved', provider: 'extension' };
    }
    case 'return': return returnBorrowed(tabId);
    case 'resolveTarget': return { targetId: String(tabId), tabId, cdpTargetId: await cdpTargetId(tabId) };
    case 'leaseCdp': {
      const metadata = requireManaged(tabId);
      if (metadata.cdpLeased) return { targetId: String(tabId), tabId, cdpTargetId: metadata.cdpTargetId, leased: true };
      const targetId = metadata.cdpTargetId || await cdpTargetId(tabId);
      if (!targetId) throw new Error(`cannot resolve CDP target for tab ${tabId}`);
      await detach(tabId);
      metadata.cdpTargetId = targetId;
      metadata.cdpLeased = true;
      await persistRegistry();
      return { targetId: String(tabId), tabId, cdpTargetId: targetId, leased: true };
    }
    case 'resumeCdp': {
      const metadata = requireManaged(tabId);
      await attach(tabId);
      metadata.cdpLeased = false;
      await persistRegistry();
      return { targetId: String(tabId), tabId, resumed: true };
    }
    case 'navigate':
      await chrome.tabs.update(tabId, { url: args.url });
      await waitComplete(tabId);
      return { navigated: true, url: args.url };
    case 'back': await chrome.tabs.goBack(tabId); return { ok: true };
    case 'forward': await chrome.tabs.goForward(tabId); return { ok: true };
    case 'reload': await chrome.tabs.reload(tabId, { bypassCache: Boolean(args.hard) }); await waitComplete(tabId); return { ok: true };
    case 'info': return evalIn(tabId, '({title:document.title,url:location.href,ready:document.readyState})');
    case 'eval': return { value: await evalIn(tabId, args.expr) };
    case 'a11y': {
      await attach(tabId);
      const tree = await dbg(tabId, 'Accessibility.getFullAXTree', { depth: Number(args.depth || 12) });
      return {
        nodes: (tree.nodes || []).filter((node) => !['none', 'generic', 'Ignored'].includes(node.role?.value)).slice(0, 1200).map((node) => ({
          nodeId: node.nodeId, backendDOMNodeId: node.backendDOMNodeId, role: node.role?.value, name: node.name?.value,
          value: node.role?.value === 'password' ? undefined : node.value?.value,
          properties: Object.fromEntries((node.properties || []).map((property) => [property.name, property.value?.value])),
        })),
      };
    }
    case 'click': {
      const value = await evalIn(tabId, `(() => { const el=${elementResolverSource(args.selector)}; if(!el)return {error:'not found'}; el.scrollIntoView({block:'center'}); el.click(); return {clicked:true,tag:el.tagName}; })()`);
      if (value?.error) throw new Error(value.error);
      return value;
    }
    case 'hover': {
      const point = await elementCenter(tabId, args.selector);
      if (!point) throw new Error('element was not found');
      await dbg(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
      await sleep(Number(args.settle || 300));
      return { hovered: true, ...point };
    }
    case 'clickAt':
    case 'humanClick': {
      const point = await elementCenter(tabId, args.selector);
      if (!point) throw new Error('element was not found');
      if (command === 'humanClick') {
        const start = { x: Math.max(0, point.x - rnd(100, 260)), y: Math.max(0, point.y - rnd(60, 180)) };
        const control = { x: (start.x + point.x) / 2 + rnd(-50, 50), y: (start.y + point.y) / 2 + rnd(-35, 35) };
        for (let index = 1; index <= 22; index++) {
          const t = index / 22, m = 1 - t;
          await dbg(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', button: 'none',
            x: m*m*start.x + 2*m*t*control.x + t*t*point.x + rnd(-1, 1),
            y: m*m*start.y + 2*m*t*control.y + t*t*point.y + rnd(-1, 1),
          });
          await sleep(rnd(7, 22));
        }
      }
      await dbg(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await sleep(command === 'humanClick' ? rnd(45, 110) : 20);
      await dbg(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      return { clicked: true, humanized: command === 'humanClick', ...point };
    }
    case 'fill': {
      const value = JSON.stringify(String(args.value ?? args.text ?? ''));
      const result = await evalIn(tabId, `(() => { const el=${elementResolverSource(args.selector)}; if(!el)return {error:'not found'}; el.focus(); const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; const set=Object.getOwnPropertyDescriptor(p,'value')?.set; if(set)set.call(el,${value});else el.value=${value}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {filled:true,tag:el.tagName}; })()`);
      if (result?.error) throw new Error(result.error);
      return result;
    }
    case 'type': {
      const focus = await evalIn(tabId, `(() => { const el=${elementResolverSource(args.selector)}; if(!el)return null; el.scrollIntoView({block:'center'}); el.focus(); ${args.clear ? "const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value')?.set?.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}));" : ''} return {tag:el.tagName}; })()`);
      if (!focus) throw new Error('element was not found');
      for (const character of Array.from(String(args.text || ''))) {
        await dbg(tabId, 'Input.insertText', { text: character });
        await sleep(rnd(Number(args.min ?? 40), Number(args.max ?? 160)));
      }
      if (args.enter) await pressKey(tabId, 'Enter');
      return { typed: Array.from(String(args.text || '')).length, tag: focus.tag };
    }
    case 'select': {
      const values = JSON.stringify([args.values ?? args.value].flat().map(String));
      const result = await evalIn(tabId, `(() => { const el=${elementResolverSource(args.selector)}; if(!el)return {error:'not found'};const v=new Set(${values});for(const o of el.options)o.selected=v.has(o.value)||v.has(o.text);el.dispatchEvent(new Event('change',{bubbles:true}));return {selected:[...el.selectedOptions].map(o=>o.value)}; })()`);
      if (result?.error) throw new Error(result.error);
      return result;
    }
    case 'press': await pressKey(tabId, args.key || 'Enter'); return { pressed: args.key || 'Enter' };
    case 'scroll': {
      const direction = args.direction || 'down', amount = Math.abs(Number(args.y || 3000));
      const script = direction === 'top' ? 'scrollTo(0,0)' : direction === 'bottom' ? 'scrollTo(0,document.documentElement.scrollHeight)' : direction === 'up' ? `scrollBy(0,-${amount})` : `scrollBy(0,${amount})`;
      await evalIn(tabId, `${script};({x:scrollX,y:scrollY})`);
      await sleep(500);
      return evalIn(tabId, '({x:scrollX,y:scrollY,height:document.documentElement.scrollHeight})');
    }
    case 'screenshot': await attach(tabId); return dbg(tabId, 'Page.captureScreenshot', { format: args.format || 'png', captureBeyondViewport: false });
    case 'console': return { entries: consoleBuffers.get(tabId) || [] };
    case 'network': return { entries: networkBuffers.get(tabId) || [] };
    case 'emulate': {
      await attach(tabId);
      if (args.off) {
        await Promise.allSettled([dbg(tabId, 'Emulation.clearDeviceMetricsOverride'), dbg(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false })]);
        return { off: true };
      }
      if (args.width || args.height || args.deviceScaleFactor || args.mobile != null) {
        await dbg(tabId, 'Emulation.setDeviceMetricsOverride', { width: Number(args.width || 390), height: Number(args.height || 844), deviceScaleFactor: Number(args.deviceScaleFactor || args.dpr || 1), mobile: Boolean(args.mobile) });
      }
      if (args.userAgent || args.ua) await dbg(tabId, 'Emulation.setUserAgentOverride', { userAgent: args.userAgent || args.ua, acceptLanguage: args.acceptLanguage });
      if (args.touch != null) await dbg(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: Boolean(args.touch), maxTouchPoints: Number(args.maxTouchPoints || 1) });
      return { applied: true };
    }
    case 'requestHelp': return requestHelp(tabId, args);
    case 'close': {
      const metadata = requireManaged(tabId);
      if (metadata.ownership === 'borrowed') return returnBorrowed(tabId);
      await chrome.tabs.remove(tabId);
      managedTabs.delete(tabId);
      await persistRegistry();
      return { targetId: String(tabId), ownership: 'created', action: 'closed' };
    }
    case 'closeSession': {
      const values = [...managedTabs.entries()].filter(([, metadata]) => metadata.session === args.session);
      for (const [id, metadata] of values) if (metadata.ownership === 'borrowed') await returnBorrowed(id);
      const windowId = agentWindows.get(args.session);
      if (windowId != null) await chrome.windows.remove(windowId).catch(() => {});
      for (const [id] of values) managedTabs.delete(id);
      agentWindows.delete(args.session);
      agentGroups.delete(args.session);
      await persistRegistry();
      return { session: args.session, closed: values.filter(([, metadata]) => metadata.ownership === 'created').length, returned: values.filter(([, metadata]) => metadata.ownership === 'borrowed').length };
    }
    default: throw new Error(`unknown extension command: ${command}`);
  }
}

async function pressKey(tabId, key) {
  await attach(tabId);
  await dbg(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key });
  await dbg(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key });
}

async function requestHelp(tabId, args) {
  const targets = [args.targets ?? args.targetRef].flat().filter(Boolean);
  for (const target of targets) {
    await evalIn(tabId, `(() => {const el=${elementResolverSource(target)};if(!el)return;el.scrollIntoView({block:'center'});el.style.outline='3px solid #f59e0b';el.style.outlineOffset='3px';})()`).catch(() => {});
  }
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (title, prompt, timeout) => new Promise((resolve) => {
      const old = document.getElementById('__cyh_browser_skill_help__'); if (old) old.remove();
      const panel = document.createElement('div'); panel.id = '__cyh_browser_skill_help__';
      panel.style.cssText = 'position:fixed;right:20px;top:20px;z-index:2147483647;width:min(420px,calc(100vw - 40px));background:#fff;color:#111827;border:1px solid #cbd5e1;border-radius:14px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.28);font:14px system-ui';
      panel.innerHTML = `<strong style="font-size:17px">${String(title || '需要你的协助').replace(/[<>&]/g, '')}</strong><p style="line-height:1.6">${String(prompt || '').replace(/[<>&]/g, '')}</p><div style="display:flex;justify-content:flex-end;gap:8px"><button data-outcome="cancelled">取消</button><button data-outcome="continued" style="background:#2563eb;color:white;border:0;border-radius:7px;padding:8px 14px">完成并交回 Agent</button></div>`;
      document.documentElement.appendChild(panel);
      const finish = (outcome) => { panel.remove(); resolve({ outcome }); };
      panel.addEventListener('click', (event) => { const outcome = event.target?.getAttribute?.('data-outcome'); if (outcome) finish(outcome); });
      setTimeout(() => finish('timed_out'), timeout);
    }),
    args: [args.title, args.prompt, Math.min(Number(args.timeout || 300000), 600000)],
  });
  return result?.[0]?.result || { outcome: 'cancelled' };
}

connect();
