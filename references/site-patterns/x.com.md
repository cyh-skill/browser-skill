---
domain: x.com
aliases: [Twitter, 推特, X]
updated: 2026-07-10
---
## 平台特征
- 已登录用户（用户日常浏览器）可访问他人 profile / following / followers。
- Following 列表页 `x.com/{handle}/following`：主列内容在 `[data-testid="primaryColumn"]`，每个账号是 `[data-testid="UserCell"]`；handle 可从 cell 内 `a[href]` 匹配 `^/([A-Za-z0-9_]{1,15})$` 取得。
- 列表是虚拟化的（react virtualized）：滚动时顶部 cell 会 unmount，DOM 中始终只保留 ~15-37 个 cell，scrollHeight ≈ 已加载条数 * ~223px（无占位 spacer）。**必须边滚边累积去重**，不能滚到底再一次性提取。
- 关注列表按最近关注倒序，最底部是最早/核心关注。

## 有效模式
- **抓 following/followers 全量首选：内部 GraphQL `Following` 接口 + cursor 翻页**（用页面登录态 fetch 重放，别用 DOM 滚动）。流程：`UserByScreenName` 取 rest_id → `Following?variables={userId,count:100,cursor}` 循环翻页，正则抽 `"screen_name":"..."`，`cursorType:"Bottom"` 取下一页 cursor，cursor 不变或连续空页即结束。**不受滚动截断影响，可拿完整列表**（实测 @adolfheir 同账号抓到 karpathy 1107、lennysan 2860、nikitabier 2049 全量，无 429）。参考实现见 `fieldgraph/harv_snippet.js`（`window.__HARV2("handle")`，轮询 `window.__P` 进度，`window.__RES` 出结果，用 `count` 对 `friends_count` 核对抓全）。GraphQL header 需 `x-csrf-token`（=ct0 cookie）+ 固定 Bearer + `x-twitter-auth-type:OAuth2Session`。
- CDP proxy 的 `/eval` 支持 async（await promise），但**单次 eval 超时约 10-15s**，超时返回空字符串。GraphQL 抓取要让翻页循环在页面后台跑（函数同步返回、结果写 window 全局），再用**短 eval 轮询** `window.__RES`，不要在单个 eval 里等整个抓取。
- （fallback，仅在无法用 GraphQL 时）DOM 滚动：列表虚拟化，须 `window.__acc` 边滚边累积去重；后台 tab 滚动后调 `/screenshot` 强制 paint 才触发下一页；但**滚动最多只能拿到最近约 33-35 个就硬停**，不适合全量。

## 已知陷阱
- 右侧栏 "Who to follow" 推荐**也用 `[data-testid="UserCell"]`**，且是按浏览者（登录账号）个性化的，会污染数据（同样几个 handle 出现在所有 seed 下，如 soumithchintala/stanfordnlp）。**采集必须限定 `[data-testid="primaryColumn"]` 作用域，排除 `[data-testid="sidebarColumn"]`。**
- **他人 following 的 DOM 懒加载（滚动）在 ~33-35 个位置硬停**：前端到此不再发翻页请求，无 spinner、无报错文本，继续滚动徒劳且增加封号风险。**这是前端截断，不是账号限流**——同一账号走内部 GraphQL `Following`+cursor 接口可拿完整列表、无 429（此前误判为"账号被限流拿不到全量"是错的，根因在方法：滚动被截断，GraphQL cursor 翻页不受影响）。
- 走 GraphQL 若遇 `429`：sleep ~30s 重试同一 cursor（harv_snippet 已内置）；多 agent 用同账号高并发时仍建议串行/限速稳妥。
- 页面反爬/环境波动下，后台 tab 可能被"回收"或 targetId 失效（eval 返回 `{}` 或空）；每轮操作前用 `location.href` 校验 tab 仍在目标 URL，漂移则重新 navigate。
- `curl -d` 内联 JS 有转义坑（`\"` 在 bash 单引号里原样传入，`{block:\"end\"}` 会成非法 JS）。复杂 JS 写入文件用 `--data-binary @file`。
