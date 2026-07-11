---
domain: goofish.com
aliases: [闲鱼, 咸鱼, Goofish]
updated: 2026-06-17
---
## 平台特征
- 闲鱼 PC 站 (www.goofish.com)，React SPA。用户日常 Chrome 已登录，CDP 直连可用。
- 搜索结果卡片选择器：`a[href*=item]`，innerText 含「标题 | ¥ | 价格 | X人想要 | 地区 | 好评」。
- 真实搜索数据来自 mtop API：`//h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/`，
  返回 `data.resultList`（每页 30 条）。单条路径：`item.data.item.main.clickParam.args`，
  含 `keyword / price / wantNum / title / id / seller_id / publishTime`。
- `clickParam.args.price` 是真实展示价（起步价/引流价，如 1.88、9.90、60），不是占位。
- `wantNum` 在该 args 字段里常为 0（仅综合排序 top 结果或 DOM 展示层才有真实想要数）；
  想要数的可靠来源是**第一页 DOM 的「X人想要」文本**（默认综合排序）。

## 有效模式
- **必须用 GUI 搜索**：直接构造 `?q=xxx` 导航会被降级——无论 q 是什么，DOM 都返回同一份固定的
  「代写/抄写」通用推荐 feed（33 条），看起来像搜索失效。正确做法：在搜索框
  `input.search-input--WY2l9QD3` 写入关键词（用原生 value setter + input 事件），再点
  `button.search-icon--bewLHteU`（「搜索」按钮）。成功后 URL 会带 `&spm=a21ybx.search.searchInput.0`。
- **抓真实 API 数据**：注入 XHR hook 捕获 `idlemtopsearch` 响应到 `window.__capFull`，
  然后**在同一个 eval 上下文里**立即触发分页（`button.search-pagination-arrow-container--lt2kCP6J`
  索引 0=上一页 1=下一页，`.click()`），分页是 XHR 不整页刷新，能稳定抓到带 keyword 的真实结果。
- 关键陷阱：点「搜索」按钮会触发路由变化、重建 JS 上下文，**清空之前注入的 hook 和 window 变量**。
  所以 hook 要在搜索完成后、靠分页触发 API 时再注入；hook 与分页点击必须在同一次 eval 内完成。

## 已知陷阱
- 并行 `curl -X POST .../new & ... & wait` 创建多 tab 时，POST body(URL) 可能串台，两个 tab 打开同一 URL。
  建议串行创建，或创建后用 `/info` 校验各 tab 的真实 URL。
- 搜索结果总条数 (totalResults) 平台不在页面显式展示，API resultInfo 里也不一定有可靠总数。
- 文案代写类目垂直供给极弱：搜「小红书文案代写/公众号文案代写/AI文案代写」均回落到通用
  「手写抄写/代抄笔记/电脑配置单/法律文书/简历」长尾池，真正的小红书/公众号文案代写占比很小。
