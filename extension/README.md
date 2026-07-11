# 通道 B：浏览器扩展桥（实验性）

这是可选的第二条连接通道。相比通道 A（CDP-proxy 走 `chrome://inspect` 调试开关），通道 B 用一个未打包扩展 + `chrome.debugger` 驱动浏览器：

- ✅ **免开 `chrome://inspect` 远程调试开关**
- ✅ **真·彩色标签组**做会话隔离（`chrome.tabGroups`，每个 `--session` 一个颜色）
- ⚠️ 会触发 Chrome 顶部「"browser-skill bridge" 正在调试此浏览器」提示条（`chrome.debugger` 的固有行为，chrome-use 同理）
- ⚠️ **实验性**：Node 侧的 WS 桥已通过端到端测试；扩展本体（`background.js`）需你在自己的浏览器加载后自测

> 日常首选通道 A（已充分验证、支持网络拦截等全部能力）。只有当你不想开调试开关、或想要彩色标签组时才用通道 B。二者共用 3456 端口，**同一时间只运行一个**。

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本 `extension/` 目录。
3. 记下扩展 ID（无所谓具体值）。

## 运行

```bash
# 启动 Node 侧桥（HTTP API 3456 ⇄ WS 3458）
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
