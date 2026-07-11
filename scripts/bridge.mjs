#!/usr/bin/env node
// scripts/bridge.mjs —— 通道统一入口（看场景自动选）
//
//   有扩展（通道 B：extension + chrome.debugger，彩色标签组、免开 chrome://inspect）→ 走扩展
//   没扩展 → 自动回退通道 A（cdp-proxy 直连 Chrome CDP，经 check-deps 起，全部能力含 /net/*）
//
// 技能对外始终只调本地 CDP_PROXY_PORT（默认 3456）的同一套 HTTP API，底层通道由本入口自动决定。
//
// 用法：
//   node scripts/bridge.mjs [--browser <id>] [--channel auto|ext|cdp] [--ext-wait <ms>]
//     --browser <id>   透传给通道 A（chrome/chrome-canary/chromium/edge）
//     --channel        auto(默认,探到扩展走 B、否则回退 A) / ext(强制扩展) / cdp(强制 CDP)
//                      显式 ext/cdp 时，若在跑的是另一条通道会自动停掉它并切换；auto 则复用在跑实例、不打扰
//     --ext-wait <ms>  探测扩展的等待时长（默认 2000）
// 环境变量：
//   CDP_PROXY_PORT   (默认 3456)  HTTP API 端口
//   EXT_BRIDGE_PORT  (默认 3458)  扩展 WS 端口（探测/通道 B 用）
//   EXT_PROBE_MS     (默认 2000)  探测扩展等待时长
//   BROWSER_SKILL_CHANNEL         同 --channel
//
// 依赖：仅 Node 内置模块。复用同目录 ext-bridge.mjs / check-deps.mjs（均以子进程方式启动，二者不改动）。

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');
const EXT_PORT = parseInt(process.env.EXT_BRIDGE_PORT || '3458');
const PROBE_MS = parseInt(process.env.EXT_PROBE_MS || '2000');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[bridge]', ...a);
const warn = (...a) => console.error('[bridge]', ...a);

function parseArgs(argv) {
  const out = { channel: process.env.BROWSER_SKILL_CHANNEL || 'auto', browser: null, extWait: PROBE_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') out.channel = argv[++i];
    else if (a.startsWith('--channel=')) out.channel = a.slice('--channel='.length);
    else if (a === '--browser') out.browser = argv[++i];
    else if (a.startsWith('--browser=')) out.browser = a.slice('--browser='.length);
    else if (a === '--ext-wait') out.extWait = parseInt(argv[++i]);
    else if (a.startsWith('--ext-wait=')) out.extWait = parseInt(a.slice('--ext-wait='.length));
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  if (!['auto', 'ext', 'cdp'].includes(out.channel)) out.channel = 'auto';
  if (!Number.isFinite(out.extWait) || out.extWait < 0) out.extWait = PROBE_MS;
  return out;
}

function printHelp() {
  console.log(`用法: node scripts/bridge.mjs [--browser <id>] [--channel auto|ext|cdp] [--ext-wait <ms>]

  有扩展走扩展(通道 B)，没有则自动回退 CDP(通道 A)。技能只调 http://127.0.0.1:${HTTP_PORT}。
  --channel ext  强制扩展   --channel cdp  强制 CDP   --browser chrome|edge|...  透传通道 A`);
}

// GET /health（不连浏览器也能返回；两通道都带 channel 字段）
function getHealth(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 在 EXT_PORT 开临时 WS，看扩展会不会连上（扩展 background.js 会持续尝试连 ws://127.0.0.1:EXT_PORT）
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptKey(key) { return crypto.createHash('sha1').update(key + WS_GUID).digest('base64'); }

function probeExtension(port, waitMs) {
  return new Promise((resolve) => {
    let done = false;
    const sockets = new Set();
    const server = http.createServer((req, res) => { res.statusCode = 426; res.end('upgrade required'); });
    const finish = (val) => {
      if (done) return; done = true;
      clearTimeout(timer);
      for (const s of sockets) { try { s.destroy(); } catch {} }
      try { server.close(); } catch {}
      resolve(val);
    };
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
      );
      sockets.add(socket);
      socket.on('error', () => {});
      finish(true); // 有 WS 连上 → 判定扩展存在
    });
    server.on('error', () => finish(false)); // 端口占用等 → 无法探测，按无扩展处理
    server.listen(port, '127.0.0.1');
    const timer = setTimeout(() => finish(false), waitMs);
  });
}

// 通道 B：后台起 ext-bridge，等扩展重连就绪
async function startExtBridge() {
  await sleep(300); // 让探测用的 WS 端口彻底释放，避免与 ext-bridge 抢 EXT_PORT
  const script = path.join(SCRIPT_DIR, 'ext-bridge.mjs');
  const logFile = path.join(os.tmpdir(), 'browser-skill-ext-bridge.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  log(`已后台启动 ext-bridge（pid ${child.pid}），日志：${logFile}`);
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const h = await getHealth(HTTP_PORT);
    if (h && h.channel === 'ext-bridge' && h.connected) {
      log(`通道 B 就绪：http://127.0.0.1:${HTTP_PORT}（扩展已连接）`);
      process.exit(0);
    }
    await sleep(500);
  }
  warn(`通道 B 启动超时：${HTTP_PORT} 未就绪。请确认已在浏览器加载 extension/ 未打包扩展，或改用 --channel cdp。日志：${logFile}`);
  process.exit(1);
}

// 通道 -> /health 的 channel 字段
const CHANNEL_HEALTH = { ext: 'ext-bridge', cdp: 'cdp-proxy' };

// 停掉指定通道的桥，等 HTTP_PORT 释放（用于显式 --channel 切换）
function stopChannel(runningChannel) {
  return new Promise((resolve) => {
    const pat = runningChannel === 'ext-bridge' ? 'ext-bridge.mjs'
      : runningChannel === 'cdp-proxy' ? 'cdp-proxy.mjs' : null;
    if (!pat) return resolve();
    execFile('pkill', ['-f', pat], async () => {
      const start = Date.now();
      while (Date.now() - start < 6000) {
        await sleep(300);
        if (!(await getHealth(HTTP_PORT, 400))) { log(`已停「${runningChannel}」，:${HTTP_PORT} 已释放`); return resolve(); }
      }
      warn(`停「${runningChannel}」后 :${HTTP_PORT} 仍被占用（可能有残留进程），继续尝试启动新通道`);
      resolve();
    });
  });
}

// 通道 A：委派 check-deps（浏览器发现 + 起 cdp-proxy + 退出码语义全保留）
function startCdp(args) {
  const script = path.join(SCRIPT_DIR, 'check-deps.mjs');
  const argv = [];
  if (args.browser) argv.push('--browser', args.browser);
  const child = spawn(process.execPath, [script, ...argv], { stdio: 'inherit' });
  child.on('exit', (code, sig) => process.exit(code == null ? (sig ? 1 : 0) : code));
  child.on('error', (e) => { warn('启动 check-deps 失败：', e.message); process.exit(1); });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1) 已有健康实例：auto 或 请求通道==在跑通道 → 复用（不打扰）；显式指定了另一通道 → 切换
  const existing = await getHealth(HTTP_PORT);
  if (existing && existing.status === 'ok') {
    const running = existing.channel || 'unknown';   // 'ext-bridge' | 'cdp-proxy'
    const wantHealth = CHANNEL_HEALTH[args.channel];  // 显式 ext/cdp 对应的 channel；auto 为 undefined
    if (args.channel === 'auto' || wantHealth === running) {
      if (running === 'ext-bridge' && existing.connected === false) {
        warn(`已有通道 B 实例在 :${HTTP_PORT} 但扩展未连接。请在浏览器加载 extension/，或用 --channel cdp 切到通道 A。`);
      } else {
        log(`已有实例在 :${HTTP_PORT}（通道=${running}, connected=${existing.connected}），直接复用。`);
      }
      process.exit(0);
    }
    // 显式指定了另一条通道 → 停掉在跑的，切过去
    log(`当前在跑通道「${running}」，按 --channel ${args.channel} 切换：先停掉它…`);
    await stopChannel(running);
  }

  // 2) 定通道
  let channel = args.channel;
  if (channel === 'auto') {
    log(`探测扩展（WS ws://127.0.0.1:${EXT_PORT}，最多 ${args.extWait}ms）…`);
    const hasExt = await probeExtension(EXT_PORT, args.extWait);
    channel = hasExt ? 'ext' : 'cdp';
    log(hasExt ? '检测到扩展 → 走通道 B（扩展）' : '未检测到扩展 → 回退通道 A（CDP）');
  }

  // 3) 起对应通道
  if (channel === 'ext') return startExtBridge();
  return startCdp(args);
}

process.on('uncaughtException', (e) => { warn('未捕获异常：', e && e.message || e); process.exit(1); });
main();
