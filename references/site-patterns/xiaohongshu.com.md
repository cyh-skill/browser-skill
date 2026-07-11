---
domain: xiaohongshu.com
aliases: [小红书, XHS, RED]
updated: 2026-06-12
---
## 平台特征
- (2026-06-12) Web 端为「点点/ai」新布局：explore 页无搜索 input，只有「问点点」textarea；搜索 input（`#search-input`）仅在 `/search_result?keyword=xx` 页面存在。
- 页面状态在 `window.__INITIAL_STATE__`（Vue ref 包装，取 `_rawValue` 解包）。`search.queryTrendingInfo` 是「猜你想搜」（个性化+部分热点混合，type 含 hot/hotSelected/trendingSavAggRecall 的条目为真热点）。
- (2026-06-12) Web 端官方热点榜疑似已下线：`search.searchHotSpots` 恒为空、`/hotspot` 页 404、签名后的 hotlist API 返回空 items；站内有用户笔记称「热榜已经无了」（2026-04）。

## 有效模式
- 页内签名调用 API：`window._webmsxyw(path, body)` 返回 `{"X-s","X-t"}`，配合 `fetch("https://edith.xiaohongshu.com"+path, {headers:{"x-s","x-t"}, credentials:"include"})` 可通过校验（code 0）。
- 小红书热搜榜第三方源（验证可用、当日更新）：`https://api.rebang.today/v1/items?tab=xiaohongshu&sub_tab=hot-search&page=1&version=1`，data.list 为 JSON 字符串，含 title/view_num/tag/www_url。
- 修改搜索框值需用原生 setter + `dispatchEvent(new Event("input",{bubbles:true}))`（Vue 受控输入）。

- (2026-06-12) 笔记详情：直开 `/explore/{noteId}`（无参数）会显示「当前笔记暂时无法浏览」；必须带搜索页提取的 `xsec_token`（`a.getAttribute("href")` 取 `/search_result/{id}?xsec_token=...`，改写成 `/explore/{id}?xsec_token=...&xsec_source=pc_search` 可正常打开）。
- (2026-06-12) 笔记正文常在图片里：`img[src*=sns-webpic]` 取原始 src（带签名路径，勿改 `!` 后缀），加 `Referer: https://www.xiaohongshu.com/` + UA 可直接下载，下载间隔 0.5s。
- (2026-06-12) 利率/榜单类数据可搜博主「三六一二」，每月更新各银行存款利率系列（普通/大额存单/互联网银行/外资/美元），数据为图片表格。

## 已知陷阱
- (2026-06-12) 在用户主页点击笔记卡片（profile 页 a 标签 JS click）触发风控，跳转 `/404/sec_*`；走搜索结果页入口更安全。
- (2026-06-12) `edith.xiaohongshu.com` API 不带 x-s/x-t 签名直接 fetch 返回 `{"code":-1}`。
- (2026-06-12) `/api/sns/web/v1/search/hotlist?source=search_box` 签名通过但 items 恒为空（功能可能已废弃）。
- 自动化操作过程中 tab 曾无故消失（可能被站点检测或页面崩溃），重要数据应尽早提取。
