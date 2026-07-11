# 两条连接通道

本 skill 直连你的日常浏览器，提供两条通道；HTTP API 完全一致，任务里的调用与通道无关，随时可切换。**统一入口 `node scripts/bridge.mjs` 会自动探测择优（有扩展走通道 B、否则回退通道 A），技能始终只调 `http://127.0.0.1:3456` 同一套 API。**

## 通道 A · CDP-proxy（默认，已充分验证）

```
Agent ──curl──▶ cdp-proxy.mjs(:3456) ──WebSocket──▶ 浏览器 CDP 端口(chrome://inspect 开关)
```

- **优点**：无需装扩展；支持**全部能力**（含 `/net/*` 网络拦截）；已端到端验证。
- **前提**：在浏览器 `chrome://inspect/#remote-debugging`（Edge 为 `edge://inspect/#remote-debugging`）勾选
  "Allow remote debugging for this browser instance"。
- **启动**：由统一入口 `node scripts/bridge.mjs` 自动探测起（没扩展时自动回退本通道）；也可手动直起 `node scripts/check-deps.mjs`（自动拉起 cdp-proxy）。
- **反检测**：拦截页面对调试端口的探测请求；后台 tab 操作；不注入 JS 补丁（连的是你的真实浏览器）。

## 通道 B · 扩展桥（可选，实验性）

```
Agent ──curl──▶ ext-bridge.mjs(:3456) ──WebSocket(:3458)──▶ 未打包扩展 ──chrome.debugger──▶ 浏览器
```

- **优点**：**免开** `chrome://inspect` 调试开关；会话隔离表现为**真·彩色标签组**。
- **代价**：会触发 Chrome「正在调试此浏览器」提示条（`chrome.debugger` 固有）；网络拦截暂用通道 A。
- **状态**：Node 侧 WS 桥已端到端测试；扩展本体需你在浏览器加载后自测。
- **启动**：由统一入口 `node scripts/bridge.mjs` 自动探测起（探到已加载的扩展即用本通道）；也可手动直起 `node scripts/ext-bridge.mjs`，需先在浏览器加载 `extension/` 未打包扩展，详见 `extension/README.md`。

## 怎么选（统一入口自动决策）

统一入口 `node scripts/bridge.mjs` 会自动择优：默认（`--channel auto`）先探测扩展——探到已加载扩展就走 **通道 B**，否则自动回退 **通道 A**。技能始终只调 `http://127.0.0.1:3456` 同一套 API，一般无需手动选。

**强制 / 覆盖自动探测**（`--channel`，默认 `auto`）：

| 你的情况 | 命令 |
|----------|------|
| 让 bridge 自动择优（默认） | `node scripts/bridge.mjs` |
| 需要网络拦截（`/net/*` block/mock/rewrite） | `node scripts/bridge.mjs --channel cdp`（强制通道 A） |
| 想固定用扩展（彩色标签组 / 免开调试开关） | `node scripts/bridge.mjs --channel ext`（强制通道 B） |

- 也可用环境变量 `BROWSER_SKILL_CHANNEL` 固定通道；`--ext-wait <ms>`（默认 2000）调扩展探测超时。
- 二者仍二选一、同占 `3456`，bridge 负责只起其一（先 `GET /health` 复用已有实例，幂等）。
- 停止 / 切换：通道 A `pkill -f cdp-proxy.mjs`；通道 B `pkill -f ext-bridge.mjs`；想固定某条通道用 `--channel`。
