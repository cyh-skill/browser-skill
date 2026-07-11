# 两条连接通道

本 skill 直连你的日常浏览器，提供两条通道；HTTP API 完全一致，任务里的调用与通道无关，随时可切换。

## 通道 A · CDP-proxy（默认，已充分验证）

```
Agent ──curl──▶ cdp-proxy.mjs(:3456) ──WebSocket──▶ 浏览器 CDP 端口(chrome://inspect 开关)
```

- **优点**：无需装扩展；支持**全部能力**（含 `/net/*` 网络拦截）；已端到端验证。
- **前提**：在浏览器 `chrome://inspect/#remote-debugging`（Edge 为 `edge://inspect/#remote-debugging`）勾选
  "Allow remote debugging for this browser instance"。
- **启动**：`node scripts/check-deps.mjs`（自动拉起 proxy）。
- **反检测**：拦截页面对调试端口的探测请求；后台 tab 操作；不注入 JS 补丁（连的是你的真实浏览器）。

## 通道 B · 扩展桥（可选，实验性）

```
Agent ──curl──▶ ext-bridge.mjs(:3456) ──WebSocket(:3458)──▶ 未打包扩展 ──chrome.debugger──▶ 浏览器
```

- **优点**：**免开** `chrome://inspect` 调试开关；会话隔离表现为**真·彩色标签组**。
- **代价**：会触发 Chrome「正在调试此浏览器」提示条（`chrome.debugger` 固有）；网络拦截暂用通道 A。
- **状态**：Node 侧 WS 桥已端到端测试；扩展本体需你在浏览器加载后自测。
- **启动**：加载 `extension/` 未打包扩展 + `node scripts/ext-bridge.mjs`，详见 `extension/README.md`。

## 怎么选

| 你的情况 | 用哪条 |
|----------|--------|
| 日常抓取/交互，想要全部能力 | **A** |
| 需要网络拦截（block/mock/rewrite） | **A** |
| 不想开调试开关 / 想要彩色标签组分组多会话 | **B** |

二者都占 `3456`，**同一时间只运行一个**。切换：`pkill -f cdp-proxy.mjs`（或停掉 ext-bridge）后启动另一个。
