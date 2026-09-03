# Changelog

## Unreleased

- 恢复 Agent 创建页的彩色 session 标签组，并以 `Agent · <session>` 标题明确区分用户页面与自动化测试页面。
- 同一用户需求默认复用稳定 session 和单个主标签页，不再为连续修改、重试或验证轮次重复创建页面。

## 2.0.0 - 2026-08-31

- 将 Node HTTP/WS/CDP 宿主迁移为 Rust Runtime，保留 `127.0.0.1:3456` 兼容 API。
- 扩展改为独立 Agent Window，并增加浏览器内借用确认、人工接管和 Provider lease。
- 新增 `/observe`、`/a11y`、hover/fill/select/press、console/network、设备模拟和导航等待。
- Extension 与 Direct CDP 可同时在线；同 target 通过中央队列和 detach/attach lease 交接，禁止双写。
- 网络拦截与文件上传由 CDP sidecar 提供；`/setFiles` 自动归还，`/net/clear` 归还持续 lease。
- 删除核心仓库全部特定站点经验和 adapter，改用外部本地/Git Knowledge Store。
- 删除 Node Runtime、旧站点匹配与 adapter runner；浏览器扩展继续使用 MV3 JavaScript。

## 1.4.0 - 2026-08-14

- 新增 `/snapshot` 紧凑语义快照；同一页面生命周期内，元素保留稳定 `@eN` 引用。
- `/click`、`/clickAt`、`/humanClick`、`/type` 同时接受 CSS selector 与 `@eN`。
- 新增显式 `/borrow`、`/return` 生命周期，所有页面操作只允许作用于 managed target。
- created tab 在会话收尾时关闭，borrowed tab 只 detach 并归还，永不误关用户原标签页。
- 两条通道加入按 target/session 的请求队列，避免并发动作互相穿插。
- 通道 B 用 `chrome.storage.session` 保存托管注册表；增加 Node 内置回归测试与 API 能力声明。
