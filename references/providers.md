# Provider 路由与联动

Runtime 同时维护 Extension 与 CDP 两个 Provider。`auto` 是默认值；`provider=extension` 或 `provider=cdp` 只用于诊断、能力覆盖或明确降级，不应成为日常硬编码。

## 场景路由

| 场景 | 默认 Provider | 原因 |
|---|---|---|
| 创建任务页面、普通导航、后退、刷新 | Extension | 页面位于独立 Agent Window，保留浏览器侧 session 语义 |
| 观察、语义引用、AX 树、截图 | Extension | 页面模型与 `@eN` 引用由扩展维护 |
| click、hover、fill、type、select、press、scroll | Extension | 普通交互保留 Agent Window、安全借用和调试事件缓冲 |
| console、network 元数据、设备模拟、人工接管 | Extension | 依赖扩展持续附着和页面内 UI |
| 文件上传 `/setFiles` | CDP sidecar | 需要 `DOM.setFileInputFiles` 和本地文件路径 |
| block、mock、rewrite | CDP sidecar | 需要持续 `Fetch` 拦截和请求暂停处理 |
| 扩展未连接时的普通页面自动化 | CDP fallback | 兼容无扩展环境，但没有 Agent Window 和浏览器内借用确认 |
| 强制底层诊断 | `provider=cdp` | 仅用于确认 Provider 差异；会建立 CDP lease |

## 同时在线不等于同时附着

扩展的 `chrome.debugger` 与直连 CDP 可能争用同一 target。Runtime 通过 target 级 lease 联动：

1. 扩展创建 Agent Window 页面，同时记录 `tabId` 与 `cdpTargetId`。
2. 普通命令始终进入统一 target/session 队列并由扩展执行。
3. CDP 能力到来时，扩展执行 `leaseCdp`：解析目标、detach、保留 ownership 和 Agent Window。
4. Rust CDP 连接附着同一 `cdpTargetId` 并执行操作。
5. `/setFiles` 完成后自动 detach CDP 并 `resumeCdp`；网络拦截保持 lease，直到 `/net/clear`。
6. target 被 lease 时，`auto` 后续命令继续走 CDP；强制 `provider=extension` 会返回冲突，不会偷偷双写。

显式控制：

```bash
curl -X POST 'http://127.0.0.1:3456/provider/lease?target=ID&provider=cdp'
curl -X POST 'http://127.0.0.1:3456/provider/release?target=ID'
```

显式 `provider=cdp` 的普通命令会保留 lease，调用方完成诊断后必须 `/provider/release`。session 关闭前 Runtime 也会尝试归还 lease。

## 网络规则

将 target 传给首条规则可立即建立持续 CDP lease：

```bash
curl -X POST --data-raw '*://*.example.com/*' \
  'http://127.0.0.1:3456/net/block?target=ID'
```

网络规则必须传入受管 target，规则只匹配该 target 的 Fetch 事件，不会作用到同一浏览器的其他页面。`/net/clear` 清空全部规则、关闭 Runtime 建立的 Fetch 拦截，并把所有扩展来源的 CDP lease 归还。

## 降级边界

- Extension 断开：普通命令可回退 CDP；借用标签不再具备浏览器内确认，应只在用户已经明确指定目标时使用。
- CDP 断开：Agent Window 和普通自动化继续工作；网络改写与文件上传返回 503，不伪装成功。
- 两者都断开：`/health` 仍可诊断，但 `connected=false`，任何页面命令停止。
- 不用 URL/title 猜测 target 对应关系；扩展通过 `chrome.debugger.getTargets()` 返回精确 `cdpTargetId`。
