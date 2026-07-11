---
name: cyh-browser-skill
license: MIT
github: https://github.com/cyh-skill/browser-skill
description:
  给 Agent 装上完整浏览器操作能力：直连你日常浏览器（天然登录态），做登录后操作、页面交互（点击/填表/滚动）、抓取 JS 动态渲染或反爬平台（小红书/微博/公众号/X 等）。
  在 web-access(一泽Eze) 的 CDP-proxy 基础上，融合 chrome-use 的多会话隔离、拟人输入、网络拦截，并新增结构化站点适配器。
  普通联网搜索与静态网页抓取优先用内置 WebSearch / WebFetch；只有被登录墙挡、内容靠 JS 渲染、需要模拟真人交互时才用本 skill。
metadata:
  author: cyh (cyh-skill)
  version: "1.0.0"
  based_on:
    - "web-access (一泽Eze, MIT) — CDP-proxy 底座、浏览哲学、站点经验体系"
    - "chrome-use (leeguooooo, Apache-2.0) — 多会话隔离 / 拟人输入 / 网络拦截 / 扩展桥 的思路"
---

# browser-skill

一个融合型浏览器操作 skill。核心是**直连你的日常浏览器**（Chrome / Edge / Chromium 系），天然携带登录态，像人一样完成联网任务。

由 `bridge.mjs` 统一入口自动探测、择优连接通道（可用 `--channel` 强制），两条通道 HTTP API 完全一致，任务里的调用与通道无关：

| 通道 | 连接方式 | 能力 |
|------|----------|--------|
| **A · CDP-proxy**（回退默认，已充分验证） | 需开 `chrome://inspect` 远程调试开关，经 cdp + Node WebSocket 直连 | 全部能力（含 `/net/*` 网络拦截） |
| **B · 扩展桥**（有扩展时优先，实验性） | 未打包扩展 `chrome.debugger` + Node WS 桥 | 免开调试开关、真·彩色标签组；有黄色“正在调试此浏览器”提示条；无 `/net/*`。见 `extension/README.md` |

---

## 前置检查

在开始联网操作前，先跑统一入口 `bridge.mjs`，它会自动探测并择优通道（有扩展走通道 B，否则自动回退通道 A · CDP）：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/bridge.mjs"
```

**Node.js 22+** 必需（使用原生 WebSocket）。

按脚本输出处理：
- `exit 0` → 继续
- `exit 2` → 需询问用户偏好，写入 `${CLAUDE_SKILL_DIR}/config.env` 的 `BROWSER_SKILL_BROWSER`
- `exit 1` → 按 stdout 错误信息处理。若提示包含「Agent 处理顺序」，按其步骤执行（如先用系统命令打开浏览器后重跑），自动可解则不打扰用户；仍失败再向用户求助

支持参数 `--browser <id>`（chrome/edge/… 透传通道 A，本次临时覆盖，不写 config.env）；想固定某通道用 `--channel auto|ext|cdp`（默认 auto）、扩展探测超时 `--ext-wait <ms>`（默认 2000）。切换浏览器时先停掉对应通道的桥、再重跑 `bridge.mjs`——通道 A `pkill -f cdp-proxy.mjs`，通道 B `pkill -f ext-bridge.mjs`。

> 默认自动探测：`bridge.mjs` 探到扩展即走通道 B，否则回退通道 A。想用扩展特性（免开调试开关、彩色标签组）时，先在浏览器加载 `extension/` 未打包扩展，`bridge.mjs` 探到即自动走通道 B，或用 `--channel ext` 强制。详见 `extension/README.md` 与 `references/connection-channels.md`。

检查通过后必须在回复中向用户直接展示以下须知，再执行操作：

```
温馨提示：部分站点对浏览器自动化操作检测严格，存在账号封禁风险。已内置防护措施但无法完全避免，Agent 继续操作即视为接受。强烈建议社交平台用小号操作。
```

## 浏览哲学

**像人一样思考，兼顾高效与适应性的完成任务。**

执行任务时不会过度依赖固有印象所规划的步骤，而是带着目标进入，边看边判断，遇到阻碍就解决，发现内容不够就深入——全程围绕「我要达成什么」做决策。

**① 拿到请求** — 先明确用户要做什么，定义成功标准：什么算完成了？需要获取什么信息、执行什么操作、达到什么结果？这是后续所有判断的锚点。

**② 选择起点** — 根据任务性质、平台特征、达成条件，选一个最可能直达的方式作为第一步去验证。需要操作页面、需要登录态、已知静态方式不可达的平台（小红书、公众号等）→ 直接走浏览器。

**③ 过程校验** — 每一步的结果都是证据。用结果对照①的成功标准，更新判断：路径在推进吗？结果的整体面貌（质量、相关度、量级）是否指向目标可达？发现方向错了立即调整，不在同一个方式上反复重试——搜索没命中不等于"还没找对方法"，也可能是"目标不存在"；API 报错、页面缺少预期元素、重试无改善，都是在告诉你该重新评估方向。遇到弹窗、登录墙，判断它是否真的挡住目标：挡住了就处理，没挡住就绕过——内容可能已在 DOM 中。

**④ 完成判断** — 对照成功标准确认完成后才停止，也不要为了"完整"过度操作、浪费代价。

## 联网工具选择

**确保信息真实性，一手信息优于二手信息**。搜索引擎和聚合平台是发现入口；多次搜索无质的改进时，升级到更根本的获取方式：定位一手来源（官网、官方平台、原始页面）。

| 场景 | 工具 |
|------|------|
| 搜索摘要或关键词结果，发现信息来源 | **WebSearch** |
| URL 已知，从页面定向提取特定信息 | **WebFetch** |
| URL 已知，需要原始 HTML 源码（meta、JSON-LD 等） | **curl** |
| 非公开内容，或已知静态层无效的平台（小红书、公众号等公开内容也被反爬限制） | **浏览器（本 skill）** |
| 需要登录态、交互操作，或需要像人一样在浏览器内自由导航探索 | **浏览器（本 skill）** |

WebSearch / WebFetch / curl 均不处理登录态。**Jina**（可选预处理层）：`r.jina.ai/example.com`（URL 前加前缀），把网页转 Markdown 大幅省 token，适合文章/博客/文档/PDF 等正文类页面；数据面板、商品页等非文章结构可能提取错块。限 20 RPM。

进入浏览器层后，`/eval` 就是你的眼睛和手：**看**（查 DOM 发现链接/按钮/表单/文本）、**做**（`/click`/`/humanClick`/`/type`/`/scroll` 交互）、**读**（提取文字，或对图片/视频 `/screenshot` 视觉识别）。**先了解页面结构，再决定下一步动作**，不需要提前规划所有步骤。

### 补充：本地浏览器书签/历史检索

用户指向**本人访问过的页面**或**组织内部系统**（公网搜不到的目标）时，检索本地浏览器书签/历史：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/find-url.mjs" [关键词...] [--only bookmarks|history] [--browser chrome|edge] [--limit N] [--since 1d|7h|YYYY-MM-DD] [--sort recent|visits]
```

关键词空格分词、多词 AND，匹配 title + url；`--since`/`--sort` 仅作用于历史；`--sort visits` 按访问次数排序（适合"高频访问网站"场景）。

### 程序化操作与 GUI 交互

- **程序化**（构造 URL 直接导航、eval 操作 DOM）：成功时快、精确，但对网站不是正常用户行为，可能触发反爬。
- **GUI 交互**（`/humanClick` 点按钮、`/type` 填输入、`/scroll` 浏览）：为人设计，网站不限制正常 UI 操作，确定性最高，但步骤多、慢。

灵活选择。GUI 交互也是程序化方式的有效探测（观察站点真实行为：URL 模式、必需参数、跳转逻辑）；程序化受阻时 GUI 是可靠兜底。**站点内交互产生的链接是可靠的**：自然到达的 URL 天然携带平台所需完整上下文；手动构造的 URL 可能缺失隐式必要参数，导致被拦截或触发反爬。

---

## 浏览器操作 API

通过 CDP Proxy（或扩展桥）暴露的 HTTP API 操作浏览器，全部用 curl 调用。默认地址 `http://localhost:3456`。
不主动操作用户已有 tab，所有操作在自己创建的后台 tab 中进行；完成后 `/close` 关闭自己创建的 tab，保留用户原有 tab。

### 页面生命周期

```bash
# 列出用户已打开的 tab（?managed=1 只列本 skill 托管的、?session=X 过滤会话）
curl -s http://localhost:3456/targets

# 创建新后台 tab（自动等待加载）— URL 走 POST body，避免含 query 时被切分
curl -s -X POST --data-raw 'https://example.com' http://localhost:3456/new
# 归入某个会话（见「多会话隔离」）
curl -s -X POST --data-raw 'https://example.com' 'http://localhost:3456/new?session=research'

# 页面信息 / 导航 / 后退 / 关闭
curl -s "http://localhost:3456/info?target=ID"
curl -s -X POST --data-raw 'https://example.com' "http://localhost:3456/navigate?target=ID"
curl -s "http://localhost:3456/back?target=ID"
curl -s "http://localhost:3456/close?target=ID"
```

### 看与读

```bash
# 执行任意 JS：读写 DOM、提取数据、操控元素、调用页面内部方法。支持 async（await promise），单次 eval 约 10-15s 超时
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'document.title'

# 结构化站点适配器提取（返回标准 JSON），见「结构化站点适配器」
curl -s -X POST "http://localhost:3456/extract?target=ID&adapter=article"

# 截图（含视频当前帧）；指定 file 存本地，否则返回二进制
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/shot.png"

# 滚动（触发懒加载）
curl -s "http://localhost:3456/scroll?target=ID&y=3000"
curl -s "http://localhost:3456/scroll?target=ID&direction=bottom"
```

### 做（交互）

```bash
# JS 点击（el.click()，简单快速，覆盖多数场景）
curl -s -X POST "http://localhost:3456/click?target=ID" -d 'button.submit'

# CDP 真实鼠标点击（算用户手势，能触发文件对话框、绕过部分反自动化检测）
curl -s -X POST "http://localhost:3456/clickAt?target=ID" -d 'button.upload'

# 拟人点击：曲线鼠标轨迹移动到目标再按下/释放（抗检测最强，见「拟人输入」）
curl -s -X POST "http://localhost:3456/humanClick?target=ID" -d 'button.submit'

# 拟人输入：逐字符变速敲击（支持中文/emoji，会触发原生 input 事件）
curl -s -X POST "http://localhost:3456/type?target=ID" \
  -d '{"selector":"input#q","text":"关键词","clear":true,"min":40,"max":160,"enter":true}'

# 文件上传：直接设置 file input 的本地路径，绕过文件对话框
curl -s -X POST "http://localhost:3456/setFiles?target=ID" \
  -d '{"selector":"input[type=file]","files":["/path/to/file.png"]}'
```

### 页面内导航

- **`/click` / `/humanClick`**：在当前 tab 内直接点用户视角中的可交互单元，串行处理。适合连续操作（展开、翻页、进详情）。
- **`/new` + 完整 URL**：用目标链接**完整地址**（含所有参数）在新 tab 打开，适合同时访问多个页面。很多网站链接含会话参数（如 token），提取 URL 时保留完整地址，不要裁剪。URL 通过 POST body 原样传入 `/new` 或 `/navigate`。

---

## 多会话隔离（融合自 chrome-use）

并行调研多个独立目标时，用 `?session=NAME` 把 tab 归入不同会话，各自独立管理、互不干扰：

```bash
curl -s -X POST --data-raw 'https://a.com' 'http://localhost:3456/new?session=projA'
curl -s -X POST --data-raw 'https://b.com' 'http://localhost:3456/new?session=projB'

curl -s http://localhost:3456/sessions                    # 列出所有会话及其 tab
curl -s "http://localhost:3456/targets?session=projA"     # 只看某会话的 tab
curl -s "http://localhost:3456/close?session=projA"       # 一键关掉整个会话
```

- **通道 A**：会话是逻辑标记（CDP 无标签组能力），用于分组管理/批量关闭。
- **通道 B**：会话表现为**真·彩色标签组**（每个 session 一个颜色）。

配合子 Agent 分治：每个子 Agent 用独立 `session` 名，收尾各自 `?session=` 一键清理，不误伤其他 Agent 的 tab。

## 拟人输入（融合自 chrome-use）

面对检测严格的站点，用拟人交互降低被识别为自动化的风险：

- **`/humanClick`**：先沿一条带抖动的贝塞尔曲线把鼠标移到目标，再按下/释放，而非瞬移点击。
- **`/type`**：逐字符 `Input.insertText` 插入 + 随机停顿（`min`/`max` 毫秒），可选 `clear` 先清空、`enter` 末尾回车。可靠支持中文/emoji，并触发页面的 `input` 事件（React 受控输入也能识别）。

不是所有场景都要拟人——程序化方式更快，只在**目标站点对自动化敏感**时才用。

## 网络拦截（融合自 chrome-use，仅通道 A）

在不改代理配置的前提下，对页面请求做屏蔽 / mock / 改写，用于提速、去干扰、调试：

```bash
# 屏蔽匹配的请求（* 通配）——如挡掉广告/追踪，页面更快更干净
curl -s -X POST "http://localhost:3456/net/block" --data-raw '*://*.doubleclick.net/*'

# mock 一个接口的响应（不打真实后端）
curl -s -X POST "http://localhost:3456/net/mock" \
  -d '{"pattern":"*://api.example.com/config*","status":200,"contentType":"application/json; charset=utf-8","body":"{\"flag\":true}"}'

# 改写/重定向请求到另一个 URL
curl -s -X POST "http://localhost:3456/net/rewrite" \
  -d '{"pattern":"*://cdn.example.com/old.js","redirectUrl":"https://cdn.example.com/new.js"}'

curl -s http://localhost:3456/net/rules     # 列出规则
curl -s http://localhost:3456/net/clear     # 清空规则（保留调试端口防护）
```

规则全局生效于所有托管 tab；不设规则时行为与原版一致（零性能影响）。

## 结构化站点适配器

把「怎么从某站点取数据」的经验固化成**可直接返回 JSON** 的提取器（`adapters/<name>.mjs`）。已内置：`article`（通用正文）、`x.com`、`xiaohongshu.com`、`zhihu.com`、`mp.weixin.qq.com`。

```bash
# 页面已在某 tab 打开时：
curl -s -X POST "http://localhost:3456/extract?target=ID&adapter=x.com"

# 一条命令跑完（开 tab → 提取 → 关 tab）：
node "${CLAUDE_SKILL_DIR}/scripts/run-adapter.mjs" article "https://some.blog/post"
node "${CLAUDE_SKILL_DIR}/scripts/run-adapter.mjs" mp.weixin.qq.com "https://mp.weixin.qq.com/s/xxxx"
```

适配器只提取「当前页面可见/可解析」的结构化快照；需要翻页/全量的复杂抓取（如 X following 全量），仍按对应 `references/site-patterns/*.md` 的实战方案走。新增适配器见 `adapters/README.md`。

---

## 关键技术事实

- 页面中存在大量已加载但未展示的内容（轮播非当前帧、折叠区块、懒加载占位），它们在 DOM 中但对用户不可见。以数据结构（容器、属性、节点关系）为单位思考可直接触达。
- DOM 中有选择器不可跨越的边界（Shadow DOM `shadowRoot`、iframe `contentDocument`）。eval 递归遍历可一次穿透所有层级。
- `/scroll` 到底部触发懒加载，未进入视口的图片才完成加载；提取图片 URL 前先滚动。
- 拿到媒体资源 URL 后，公开资源可直接下载到本地读取；需登录态的资源才在浏览器内 navigate + screenshot。
- 短时间密集打开大量页面（批量 `/new`）可能触发反爬风控——并行创建 tab 时 POST body 偶发串台，建议串行创建或创建后用 `/info` 校验各 tab 真实 URL。
- 平台返回的"内容不存在""页面不见了"不一定反映真实状态，也可能是访问方式问题（URL 缺参、触发反爬）。
- `curl -d` 内联 JS 有转义坑（bash 单引号里 `\"` 原样传入）。复杂 JS 用 `--data-binary @file`。

### 视频内容获取

用户浏览器真实渲染，截图可捕获当前视频帧。通过 `/eval` 操控 `<video>` 元素（获取时长、seek 到任意时间点、播放/暂停），配合 `/screenshot` 采帧，可对视频离散采样分析。

### 登录判断

用户日常浏览器天然携带登录态，大多数常用网站已登录。核心问题只有一个：**目标内容拿到了吗？** 打开页面先尝试获取目标内容；只有确认**无法获取**且判断登录能解决时，才告知用户：

> "当前页面在未登录状态下无法获取[具体内容]，请在你的浏览器中登录 [网站名]，完成后告诉我继续。"

登录完成后无需重启任何东西，直接刷新页面继续。

## 站点经验（references/site-patterns/）

按域名沉淀的操作经验（URL 模式、平台特征、已知陷阱），跨 session 复用。前置检查通过后会列出已有经验。当前包含：`x.com`、`xiaohongshu.com`、`zhihu.com`、`mp.weixin.qq.com`、`goofish.com`(闲鱼)、`zhipin.com`(BOSS直聘)。

按用户输入匹配站点经验：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/match-site.mjs" "用户输入文本"
```

**发现新的有效模式或陷阱时，就地更新对应站点经验文件**——这是本 skill 越用越强的关键。

## 并行调研：子 Agent 分治

任务含多个**独立**调研目标时（同时调研 N 个项目/来源/账号），分治给子 Agent 并行执行，共享一个 Proxy。给每个子 Agent 分配独立 `session` 名做隔离，收尾各自 `?session=` 清理。

## 任务结束

用 `/close` 关闭自己创建的 tab（或 `?session=` 批量关会话），必须保留用户原有 tab。Proxy 持续运行，不建议主动停止——重启后需在浏览器重新授权 CDP 连接。
