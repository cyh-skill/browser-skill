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

显式 `provider=cdp` 的普通命令会保留 lease。调用方把对应 target 记录在本次资源清单中，并在诊断结束后调用 `/provider/release`；session 收尾也会尝试归还其 lease。交付前通过 `/health` 核对 lease 状态并声明释放结果。

## 网络规则

将 target 传给首条规则可立即建立持续 CDP lease：

```bash
curl -X POST --data-raw '*://*.example.com/*' \
  'http://127.0.0.1:3456/net/block?target=ID'
```

网络规则必须传入受管 target，规则只匹配该 target 的 Fetch 事件，不会作用到同一浏览器的其他页面。`/net/clear` 是 Runtime 全局清理动作：当前全部规则都属于本次调用时，用它清空规则、关闭 Fetch 拦截并归还所有扩展来源的 CDP lease；存在其他调用持有的规则时，保留其状态并报告清理冲突。

## 调用结束状态

每次调用结束时形成一条可核对的资源结论：

- `released`：本次显式 lease 已释放，临时规则已清除；
- `retained`：同一活动任务继续复用原 session 和 `Agent · <session>` 分组，记录分组内主 target 和下一步用途；
- `blocked`：资源仍有残留，记录 target 或规则、ownership、失败原因和需要的后续动作。

整个用户任务完成时，以 `released` 且该 session 无 managed target 为默认完成状态。同一用户任务的连续浏览器调用以 `retained` 为默认中间状态：复用原 session 和标签分组，分组内保留一个 created 主 target；额外 target 均按 ownership 关闭或归还。用户明确要求多个页面时按指定范围保留在同一分组。

## 降级边界

- Extension 断开：普通命令可回退 CDP；借用标签不再具备浏览器内确认，应只在用户已经明确指定目标时使用。
- CDP 断开：Agent Window 和普通自动化继续工作；网络改写与文件上传返回 503，不伪装成功。
- 两者都断开：`/health` 仍可诊断，但 `connected=false`，任何页面命令停止。
- 不用 URL/title 猜测 target 对应关系；扩展通过 `chrome.debugger.getTargets()` 返回精确 `cdpTargetId`。
