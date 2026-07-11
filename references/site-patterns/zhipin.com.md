---
domain: zhipin.com
aliases: [BOSS直聘, BOSS直聘网, Boss直聘, www.zhipin.com]
updated: 2026-06-17
---
## 平台特征
- 用户日常 Chrome 天然携带登录态，直接 /new 打开搜索页即可拿到结果（页面顶部显示登录用户名即已登录）。
- 职位搜索页 URL 模式（已验证有效）：
  `https://www.zhipin.com/web/geek/jobs?query=<关键词URLEncode>&city=<城市码>`
  - city 码：全国=100010000，北京=101010100，深圳=101280600（标准 BOSS 城市码体系，可类推）。
  - city 参数生效可靠：改 city 码后结果城市随之变化。
  - 注意：city=100010000(全国) 时结果会被登录用户的"求职期望城市"强烈偏置（实测全部返回杭州）。要做跨赛道可比对照，应显式指定同一大城市（如北京 101010100）。
- 每页职位卡 15 张（首屏，`li.job-card-box`）。点击某卡会在右侧打开详情面板。
- 反爬：访问需 `_security_check` 参数，平台会自动补全；密集开 tab 易触发风控，应串行、放慢节奏，单 tab 内 /navigate 切换关键词最稳。

## 有效模式
- 卡片选择器：`li.job-card-box`
  - 职位名：`.job-name`
  - 薪资：`.job-salary`（**注意见陷阱：数字被剥离**）
  - 标签(经验/学历)：`.tag-list li`
  - 公司：`.boss-name`
  - 地点：`.company-location`
- **读薪资必须用 /screenshot 视觉识别**：DOM 里 `.job-salary` 的数字被反爬剥离，innerText 只剩 `-K`/`-K·薪`/`-元/天`。但页面渲染出的真实数字在截图里清晰可见。流程：/navigate → sleep 4 → /eval 取职位名+标签+公司 → /screenshot + Read 图片读薪资。
- 单 tab 串行切关键词：`POST /navigate?target=ID`，body 为完整 URL。每次 navigate 后 sleep ~4s 等渲染。

## 已知陷阱
- 薪资数字在 DOM 中被剥离（字体/渲染层反爬），纯 /eval 拿不到薪资数值，必须截图。
- city=全国(100010000) 被用户求职期望偏置，得不到真正的全国分布；要可比就锁定具体城市码。
- 页面无"共N个职位"总数指示器，岗位丰富度只能由"是否填满整页(15)+标题是否高度重复(同名职位刷屏=高供给)+是否有翻页"近似判断。
- 高薪职位标题需甄别：销售/BD/会销/直播岗常把"底薪+提成"上限挂在薪资区间(如养老岗"月入5W+"、健康管理师15-30K),实际底薪低,薪资虚高。
