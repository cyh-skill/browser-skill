#!/usr/bin/env node
// run-adapter - 一条命令跑完结构化提取：开后台 tab → 运行适配器 → 打印 JSON → 关 tab
//
// 用法：
//   node run-adapter.mjs <adapter> <url> [--session NAME] [--keep] [--wait MS]
//
//   <adapter>        adapters/<adapter>.mjs 的名字（如 x.com、article、mp.weixin.qq.com）
//   <url>            目标 URL（原样传入，含 query 也无需转义）
//   --session NAME   归入指定会话（多会话隔离），默认 default
//   --keep           提取后不关闭 tab（便于继续人工/后续操作）
//   --wait MS        提取前额外等待毫秒数（给重前端渲染留时间），默认 0
//
// 前置：cdp-proxy 已在运行（先跑 check-deps.mjs）。本脚本只与本地 proxy 的 HTTP API 交互。

const PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');
const BASE = `http://127.0.0.1:${PORT}`;

function parseArgs(argv) {
  const a = { adapter: null, url: null, session: 'default', keep: false, wait: 0 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--session') a.session = argv[++i];
    else if (v === '--keep') a.keep = true;
    else if (v === '--wait') a.wait = parseInt(argv[++i], 10) || 0;
    else if (v === '-h' || v === '--help') { usage(); process.exit(0); }
    else positional.push(v);
  }
  a.adapter = positional[0];
  a.url = positional[1];
  return a;
}

function usage() {
  console.error('用法: node run-adapter.mjs <adapter> <url> [--session NAME] [--keep] [--wait MS]');
}

async function j(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.adapter || !a.url) { usage(); process.exit(1); }

  // 健康检查
  const health = await j(`${BASE}/health`).catch(() => null);
  if (!health || health.status !== 'ok') {
    console.error(`✗ 未连上 cdp-proxy (${BASE})。请先运行: node scripts/check-deps.mjs`);
    process.exit(1);
  }
  if (!health.connected) {
    console.error('✗ proxy 在运行但尚未连上浏览器。请确认浏览器已开启远程调试开关，再重试。');
    process.exit(1);
  }

  // 开 tab
  const created = await j(`${BASE}/new?session=${encodeURIComponent(a.session)}`, {
    method: 'POST',
    body: a.url,
  });
  const target = created.targetId;
  if (!target) {
    console.error('✗ 创建 tab 失败:', JSON.stringify(created));
    process.exit(1);
  }

  try {
    if (a.wait > 0) await new Promise((r) => setTimeout(r, a.wait));
    // 提取
    const out = await j(`${BASE}/extract?target=${target}&adapter=${encodeURIComponent(a.adapter)}`, { method: 'POST' });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } finally {
    if (!a.keep) {
      await j(`${BASE}/close?target=${target}`).catch(() => {});
    } else {
      console.error(`(--keep) tab 保留: ${target}`);
    }
  }
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
