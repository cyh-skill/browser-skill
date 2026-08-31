# Extension Provider

该 MV3 扩展连接 `ws://127.0.0.1:3458` 的 Rust Runtime，并通过 `chrome.debugger` 与 Chrome Extension API 提供：

- 每个 session 独立 Agent Window；
- 用户已有标签页的页面内借用确认；
- managed ownership、session 收尾与稳定 `@eN`；
- AX 树、console/network 缓冲、普通交互、设备模拟与人工接管；
- 与 Direct CDP sidecar 的 `leaseCdp` / `resumeCdp` 精确交接。

## 加载

打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，指向本目录。重新加载扩展后运行 `browser-skill serve`，再检查 `/health` 中 `providers.extension.connected=true`。

扩展只连接 loopback；Rust WebSocket 服务拒绝非 `chrome-extension://` / `edge-extension://` Origin。`debugger` 与 `<all_urls>` 权限用于用户明确要求的托管页面，不应读取或传输未托管页面内容。

Chrome 会显示扩展正在调试页面的提示，这是 `chrome.debugger` 的正常行为。打开 DevTools 可能导致 debugger detach，Runtime 会将后续失败明确返回，不会伪装成功。
