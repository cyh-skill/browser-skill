# 两条连接通道

本 skill 直连你的日常浏览器，提供两条通道；HTTP API 完全一致，任务里的调用与通道无关，随时可切换。**统一入口 `node scripts/bridge.mjs` 会自动探测择优（有扩展走通道 B、否则回退通道 A），技能始终只调 `http://127.0.0.1:3456` 同一套 API。**

## 通道 A · CDP-proxy（能力回退，已充分验证）

```
Agent ──curl──▶ cdp-proxy.mjs(:3456) ──WebSocket──▶ 浏览器 CDP 端口(chrome://inspect 开关)
```

- **优点**：无需装扩展；支持**全部能力**（含 `/net/*` 网络拦截）；已端到端验证。
- **前提**：在浏览器 `chrome://inspect/#remote-debugging`（Edge 为 `edge://inspect/#remote-debugging`）勾选
  "Allow remote debugging for this browser instance"。
- **启动**：由统一入口 `node scripts/bridge.mjs` 自动探测起（没扩展时自动回退本通道）；也可手动直起 `node scripts/check-deps.mjs`（自动拉起 cdp-proxy）。
- **反检测**：拦截页面对调试端口的探测请求；后台 tab 操作；不注入 JS 补丁（连的是你的真实浏览器）。

## 通道 B · 扩展桥（默认推荐，实验性）

```
Agent ──curl──▶ ext-bridge.mjs(:3456) ──WebSocket(:3458)──▶ 未打包扩展 ──chrome.debugger──▶ 浏览器
```

- **优点**：**最不打扰**——**免开** `chrome://inspect` 调试开关、不问你选哪个浏览器、天然登录态；会话隔离表现为**真·彩色标签组**。
- **代价**：会触发 Chrome「正在调试此浏览器」提示条（`chrome.debugger` 固有）；网络拦截暂用通道 A。
- **状态**：Node 侧 WS 桥已端到端测试；扩展本体需你在浏览器加载后自测。
- **启动**：由统一入口 `node scripts/bridge.mjs` 自动探测起（探到已加载的扩展即用本通道）；也可手动直起 `node scripts/ext-bridge.mjs`，需先在浏览器加载 `extension/` 未打包扩展，详见 `extension/README.md`。

## 怎么选（默认 B、能力不足才用 A）

**默认走通道 B**（最不打扰）：先在浏览器加载 `extension/` 未打包扩展，`node scripts/bridge.mjs`（`--channel auto`）探到即走 **通道 B**——免开调试开关、不问你选哪个浏览器、天然登录态；未装扩展则自动回退 **通道 A**。**仅当需要通道 B 不具备的能力**（`/net/*` 网络拦截、`/setFiles`）时才用 **通道 A**。技能始终只调 `http://127.0.0.1:3456` 同一套 API，一般无需手动选。

**强制 / 覆盖自动探测**（`--channel`，默认 `auto`）：

| 你的情况 | 命令 |
|----------|------|
| 让 bridge 自动择优（默认，探到扩展即 B） | `node scripts/bridge.mjs` |
| 想固定用扩展（默认推荐：免开调试开关 / 彩色标签组） | `node scripts/bridge.mjs --channel ext`（强制通道 B） |
| 需要通道 A 能力（`/net/*` 网络拦截、`/setFiles`） | `node scripts/bridge.mjs --channel cdp`（切到通道 A） |

- **一条命令切换**：显式 `--channel cdp` / `--channel ext` 即完成切换——若在跑的是另一条通道，会自动停掉它再切；`auto` 则复用已在跑的实例、不打扰。
- 也可用环境变量 `BROWSER_SKILL_CHANNEL` 固定通道；`--ext-wait <ms>`（默认 2000）调扩展探测超时。
- 二者仍二选一、同占 `3456`，bridge 负责只起其一（先 `GET /health` 复用已有实例，幂等）。
- 手动停止：通道 A `pkill -f cdp-proxy.mjs`；通道 B `pkill -f ext-bridge.mjs`。
