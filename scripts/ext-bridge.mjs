#!/usr/bin/env node
// ext-bridge（通道 B 的 Node 侧）—— 把 HTTP API(3456) 的命令通过 WebSocket(3458) 转发给
// browser-skill 扩展执行。扩展用 chrome.debugger 驱动浏览器，免开 chrome://inspect 调试开关，
// 会话隔离用真·彩色标签组。
//
// 与通道 A(cdp-proxy.mjs) 二选一运行（都占 3456，同套 HTTP 端点，命令语义一致）。
// ⚠️ 实验性：需先在浏览器加载 extension/ 未打包扩展（见 extension/README.md）。
//
// 依赖：仅 Node 内置模块（自带极简 WS 服务端，无 npm 依赖）。Node.js 18+。

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const HTTP_PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');
const EXT_PORT = parseInt(process.env.EXT_BRIDGE_PORT || '3458');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTERS_DIR = path.join(ROOT, 'adapters');

// ================= 极简 WebSocket 服务端 =================
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let client = null;               // 当前连接的扩展 socket
let clientAlive = false;
let seq = 0;
const pending = new Map();       // id -> {resolve, reject, timer}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function makeFrameParser(onMessage) {
  let buf = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragments = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) { if (buf.length < offset + 2) return; len = buf.readUInt16BE(offset); offset += 2; }
      else if (len === 127) { if (buf.length < offset + 8) return; len = Number(buf.readBigUInt64BE(offset)); offset += 8; }
      let mask = null;
      if (masked) { if (buf.length < offset + 4) return; mask = buf.slice(offset, offset + 4); offset += 4; }
      if (buf.length < offset + len) return; // 帧未收全，等更多数据
      let payload = buf.slice(offset, offset + len);
      if (masked) { const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
      buf = buf.slice(offset + len);

      if (opcode === 0x8) { closeClient(); return; }              // close
      if (opcode === 0x9) { safeSend(encodePong()); continue; }   // ping -> pong
      if (opcode === 0xA) { continue; }                            // pong
      if (opcode === 0x0) {                                        // continuation
        fragments.push(payload);
        if (fin) { const full = Buffer.concat(fragments); fragments = []; if (fragOpcode === 0x1) onMessage(full.toString('utf8')); }
        continue;
      }
      // 0x1 text (0x2 binary 也按文本尝试)
      if (!fin) { fragOpcode = opcode; fragments = [payload]; continue; }
      if (opcode === 0x1 || opcode === 0x2) onMessage(payload.toString('utf8'));
    }
  };
}
function encodePong() { return Buffer.from([0x8a, 0x00]); }
function safeSend(frameBuf) { try { if (client && !client.destroyed) client.write(frameBuf); } catch (e) {} }
function closeClient() { if (client) { try { client.destroy(); } catch (e) {} } client = null; clientAlive = false; }

const wsServer = http.createServer();
wsServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  // 只保留最新连接
  if (client) closeClient();
  client = socket; clientAlive = true;
  console.log('[ext-bridge] 扩展已连接');
  const parse = makeFrameParser(onClientMessage);
  socket.on('data', parse);
  socket.on('close', () => { if (client === socket) { client = null; clientAlive = false; console.log('[ext-bridge] 扩展断开'); } });
  socket.on('error', () => {});
});

function onClientMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.type === 'hello') { console.log('[ext-bridge] hello:', (msg.ua || '').slice(0, 60)); return; }
  if (msg.type === 'ping') return;
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || '扩展执行失败'));
  }
}

function callExt(cmd, args = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!clientAlive) return reject(new Error('扩展未连接：请在浏览器加载 extension/ 未打包扩展（见 extension/README.md）'));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('扩展命令超时: ' + cmd)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    safeSend(encodeFrame(JSON.stringify({ id, cmd, args })));
  });
}

// ================= HTTP API（与通道 A 对齐的子集）=================
async function readBody(req) { let b = ''; for await (const c of req) b += c; return b; }

const httpServer = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${HTTP_PORT}`);
  const p = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const json = (o, code = 200) => { res.statusCode = code; res.end(JSON.stringify(o)); };

  try {
    if (p === '/health') return json({ status: 'ok', channel: 'ext-bridge', connected: clientAlive, extPort: EXT_PORT });

    if (p === '/targets') {
      const list = await callExt('list');
      if (q.session) return json(list.filter((t) => t.session === q.session), 200);
      return json(list);
    }
    if (p === '/sessions') return json(await callExt('sessions'));

    if (p === '/new') {
      if (req.method !== 'POST') return json({ error: '/new 需 POST，body 为 URL' }, 400);
      const url = (await readBody(req)).trim() || 'about:blank';
      return json(await callExt('new', { url, session: q.session || 'default' }));
    }
    if (p === '/close') {
      if (!q.target && q.session) return json(await callExt('closeSession', { session: q.session }));
      return json(await callExt('close', { target: q.target }));
    }
    if (p === '/navigate') {
      if (req.method !== 'POST') return json({ error: '/navigate 需 POST，body 为 URL' }, 400);
      const url = (await readBody(req)).trim();
      return json(await callExt('navigate', { target: q.target, url }));
    }
    if (p === '/back') return json(await callExt('back', { target: q.target }));
    if (p === '/info') return json(JSON.parse(await callExt('info', { target: q.target })));

    if (p === '/eval') {
      const expr = (await readBody(req)) || q.expr || 'document.title';
      return json(await callExt('eval', { target: q.target, expr }));
    }

    if (p === '/extract') {
      const name = q.adapter;
      if (!name) return json({ error: '需要 ?adapter=NAME' }, 400);
      const file = path.join(ADAPTERS_DIR, `${name}.mjs`);
      if (!fs.existsSync(file)) return json({ error: `未找到适配器 ${name}` }, 404);
      const mod = await import(pathToFileURL(file).href + `?t=${fs.statSync(file).mtimeMs}`);
      if (typeof mod.pageExpr !== 'string') return json({ error: `适配器 ${name} 未导出 pageExpr` }, 500);
      const r = await callExt('eval', { target: q.target, expr: mod.pageExpr });
      return json({ adapter: name, data: r?.value ?? null });
    }

    if (p === '/click') return json(await callExt('click', { target: q.target, selector: await readBody(req) }));
    if (p === '/clickAt') return json(await callExt('clickAt', { target: q.target, selector: await readBody(req) }));
    if (p === '/humanClick') return json(await callExt('humanClick', { target: q.target, selector: await readBody(req) }));
    if (p === '/type') { const b = JSON.parse(await readBody(req)); return json(await callExt('type', { target: q.target, ...b })); }
    if (p === '/scroll') return json(await callExt('scroll', { target: q.target, y: q.y, direction: q.direction }));

    if (p === '/screenshot') {
      const r = await callExt('screenshot', { target: q.target, format: q.format || 'png' });
      const bin = Buffer.from(r.data, 'base64');
      if (q.file) { fs.writeFileSync(q.file, bin); return json({ saved: q.file }); }
      res.setHeader('Content-Type', 'image/' + (q.format || 'png'));
      res.statusCode = 200; res.end(bin); return;
    }

    return json({ error: '未知端点或通道 B 暂不支持（网络拦截等高级能力请用通道 A cdp-proxy）' }, 404);
  } catch (e) {
    json({ error: e.message }, 500);
  }
});

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  if (!(await checkPortAvailable(HTTP_PORT))) {
    console.error(`[ext-bridge] 端口 ${HTTP_PORT} 已被占用（可能是通道 A cdp-proxy 在跑）。二者二选一。`);
    process.exit(1);
  }
  wsServer.listen(EXT_PORT, '127.0.0.1', () => console.log(`[ext-bridge] WS 等待扩展连接 ws://127.0.0.1:${EXT_PORT}`));
  httpServer.listen(HTTP_PORT, '127.0.0.1', () => console.log(`[ext-bridge] HTTP API http://localhost:${HTTP_PORT}`));
}
process.on('uncaughtException', (e) => console.error('[ext-bridge] 未捕获异常:', e.message));
process.on('unhandledRejection', (e) => console.error('[ext-bridge] 未处理拒绝:', e?.message || e));
main();
