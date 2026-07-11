---
domain: zhihu.com
aliases: [知乎, Zhihu]
updated: 2026-07-11
---
## 平台特征
- 用户日常浏览器天然携带登录态，直开问题/回答/专栏页即可。未登录时长回答会被「登录后查看全文」遮罩。
- 三类主要页面：问题页 `/question/{id}`（含多条回答）、回答页 `/question/{id}/answer/{aid}`、专栏文章 `/p/{id}`。
- 回答/文章正文在 `.RichContent-inner` / `.RichText`；标题在 `.QuestionHeader-title`（问题）、`h1.Post-Title`（专栏）。
- 回答列表懒加载：滚动加载更多，`.AnswerItem` / `.List-item` 为条目单元。

## 有效模式
- 结构化快照直接用适配器：`adapters/zhihu.com.mjs`（`/extract?adapter=zhihu.com`）——返回标题 + 前若干回答摘要，或专栏正文。
- 长正文优先 `/extract` 或 `/eval` 取 `.RichText` 的 innerText，避免整页 Read 浪费 token。
- 需要更多回答时 `/scroll` 到底部触发下一批，再重取 `.AnswerItem`。

## 已知陷阱
- 未登录/触发风控会弹登录 modal 或「你似乎来到了没有知识存在的荒原」；先确认是否真的挡住目标内容（正文可能已在 DOM 中）。
- 图片/公式常以 `<img>` 承载（`data-actualsrc`），纯文本提取会漏；需要时单独取图片 URL。
- 搜索建议走 WebSearch 定位具体问题/文章 URL，再用浏览器打开，比站内搜索稳。
