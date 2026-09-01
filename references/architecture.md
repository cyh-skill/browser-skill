# Runtime 架构

```text
Agent
  │ HTTP 127.0.0.1:3456
  ▼
Rust Runtime
  ├─ managed target/session registry
  ├─ target + session operation queues
  ├─ routing and CDP lease coordinator
  ├─ external Knowledge Store
  ├─ WebSocket 127.0.0.1:3458 ── Extension ── chrome.debugger ── Agent Window
  └─ browser WebSocket ────────── Direct CDP sidecar
```

## 不变量

- HTTP 与两个 WebSocket 监听都绑定 loopback；HTTP 拒绝跨站浏览器 Origin/Fetch，扩展入口只接受 `chrome-extension://` 或 `edge-extension://` Origin。本地其他进程仍属于同一信任边界。
- 每个请求先取得 target/session 锁；不同 target 可以并行，同一 target 与 session 收尾串行。
- `created` target 可以关闭；`borrowed` target 只能归还。用户标签默认不受控，`/borrow` 必须通过页面内确认。
- 每个 extension session 对应独立 Agent Window，Agent 创建页同时进入带 `Agent · <session>` 标题的彩色标签组；借用标签保留在用户原窗口且不加入 Agent 标签组，避免用户关闭 Agent Window 时误删原标签。
- Extension 是页面主控，CDP 是能力侧车；同一 target 不双重附着。
- `@eN` 引用来自最近一次页面观察；导航或页面结构变化后必须重新观察。
- Knowledge Store 在核心仓库之外；adapter 被视为可执行本地代码，只加载显式配置的受信目录。

## 页面模型

`/observe` 遍历主文档、同源 frame 与开放 Shadow Root，收集 heading、landmark、form、交互控件、状态、可见性、几何位置、正文摘要和 frame 警告，并维持稳定引用。跨源 frame 或复杂无障碍结构由 `/a11y` 的 CDP Accessibility 树补充；视觉内容由截图补充。

## 组件边界

Rust 负责网络服务、协议、浏览器发现、CDP multiplex、Provider lease、网络拦截、文件系统和知识校验；浏览器扩展必须继续使用 JavaScript，因为 MV3 Service Worker 与 Chrome Extension API 原生运行在该环境中。项目所称“迁移到 Rust”指宿主 Node Runtime 已移除，不代表把浏览器扩展编译成 WASM。
