# 通道 B：浏览器扩展桥（实验性）

这是可选的第二条连接通道。相比通道 A（CDP-proxy 走 `chrome://inspect` 调试开关），通道 B 用一个未打包扩展 + `chrome.debugger` 驱动浏览器：

- ✅ **免开 `chrome://inspect` 远程调试开关**
- ✅ **真·彩色标签组**做会话隔离（`chrome.tabGroups`，每个 `--session` 一个颜色）
- ⚠️ 会触发 Chrome 顶部「"browser-skill bridge" 正在调试此浏览器」提示条（`chrome.debugger` 的固有行为，chrome-use 同理）
- ⚠️ **实验性**：Node 侧的 WS 桥已通过端到端测试；扩展本体（`background.js`）需你在自己的浏览器加载后自测

> 通常直接用统一入口 `node scripts/bridge.mjs` 自动探测：加载了本扩展就会自动走通道 B，没加载则自动回退通道 A。通道 B 仍与通道 A 二选一、同占 3456 端口，**同一时间只运行一个**。

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本 `extension/` 目录。
3. 记下扩展 ID（无所谓具体值）。

## 运行

> 前提：先按上面「安装」把本扩展加载进浏览器（load unpacked），否则探测不到会回退通道 A。

```bash
# 首选：统一入口，探到本扩展后会自动起 ext-bridge 走通道 B
node scripts/bridge.mjs

# 手动 / 强制通道 B 的等价方式（直接起 Node 侧桥，HTTP API 3456 ⇄ WS 3458）
node scripts/ext-bridge.mjs

# 扩展后台会自动连上；确认：
curl -s http://localhost:3456/health      # connected:true 即就绪
```

之后 HTTP API 与通道 A 完全一致（`/new`、`/eval`、`/type`、`/humanClick`、`/extract`、`/screenshot`、`/sessions` …），
SKILL.md 里的所有调用照用即可。会话隔离会在浏览器里表现为彩色标签组。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CDP_PROXY_PORT` | `3456` | HTTP API 端口（与通道 A 同名，便于无缝切换） |
| `EXT_BRIDGE_PORT` | `3458` | 扩展 ↔ 桥 的 WebSocket 端口 |

## 通道 B 暂不支持

- 网络拦截（`/net/*`）：请用通道 A。
- 其余核心浏览命令均已实现：`list/sessions/new/navigate/back/info/eval/extract/click/clickAt/humanClick/type/scroll/screenshot/close/closeSession`。
