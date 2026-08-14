# Changelog

## 1.4.0 - 2026-08-14

- 新增 `/snapshot` 紧凑语义快照；同一页面生命周期内，元素保留稳定 `@eN` 引用。
- `/click`、`/clickAt`、`/humanClick`、`/type` 同时接受 CSS selector 与 `@eN`。
- 新增显式 `/borrow`、`/return` 生命周期，所有页面操作只允许作用于 managed target。
- created tab 在会话收尾时关闭，borrowed tab 只 detach 并归还，永不误关用户原标签页。
- 两条通道加入按 target/session 的请求队列，避免并发动作互相穿插。
- 通道 B 用 `chrome.storage.session` 保存托管注册表；增加 Node 内置回归测试与 API 能力声明。
