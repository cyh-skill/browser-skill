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

## 聊天与投递实战（2026-07-27 补充）

### ⚠️ 会话串台陷阱（最容易发错人）
- `/navigate` 到 `chat?id=<encryptBossId>` 后，页面**先显示目标会话，几秒后可能自动跳到列表首位的未读会话** → 消息、附件简历全发给错误的 HR。
- 防御：navigate 后 sleep 8，**发送前和输入后各校验一次** `document.querySelector('.chat-conversation').innerText.slice(0,40)` 是否含目标公司名，不匹配立即中止。
- 列表里没有未读时不会跳；有未读时优先先把未读处理掉再切目标会话。

### `/type` 长文本会崩
- 单条 >200 字符易触发 `扩展命令超时: type`，且字符会错位（`iOS`→`iS`，末尾多出 `O`）或被截断，Enter 会把半截消息发出去，剩余字符残留输入框。
- 对策：**每条控制在 150 字符内，长话术拆多条串行发**；发送后核对 `#chat-input` 内容与实际发出的 tail；残留用 `el.innerText=''` + dispatch input 清空。

### 发起沟通按钮（两处不同）
- `job_detail` 页：`.btn-startchat`，成功标志是文字 `立即沟通`→`继续沟通`。
- **搜索页右侧详情面板：`.op-btn-chat`**，点击后**文字不变**，成功标志是弹出「已向BOSS发送消息」弹窗 → 点「留在此页」关闭 → 去聊天列表确认新会话。
- 两者都要先伪造可见+聚焦（见下），否则后台 tab 静默失败。
- **弹窗必须关掉**，否则遮罩挡住后续点击，还会造成"上次操作的延迟弹窗"误判成本次成功。

### 后台 tab 伪造可见+聚焦（发起沟通前必跑）
```js
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});
Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
document.hasFocus=()=>true;
window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'));
```
`humanClick` 在后台 tab 点列表项会 `扩展命令超时`；JS `.click()` 切会话也常无效 —— 切会话还是用 navigate + 校验最稳。

### 附件简历
- **对方发「我想要一份您的附件简历」卡片**：点 `.message-card-buttons .card-btn`(文字=同意) → 弹出「请选择要发送的简历」→ 点 `.choose-resume-dialog .list-item` 选中（不选 `.btn-confirm` 是 `disabled`）→ 点 `.btn-confirm`。
- **主动推**：工具栏 `.toolbar-btn`(文字=发简历)。无 `unable` class 时可点，发出的是「附件简历请求」卡片（对方点了才看到 PDF）；带 `unable` 说明必须等对方先索要。同一会话推过一次后按钮即变 `unable`。
- 发送结果 DOM 常延迟刷新，**别看截图下结论**，用 `.chat-conversation` 的 innerText 尾部是否出现「您的附件简历 … 已发送给Boss」判断。

### 简历选择弹窗：⚠️成功了也看不出来，别反复重试（2026-07-28 血泪）
- 选简历只能用 **JS `.click()`**：`.choose-resume-dialog .list-item`（选中后 class 加 `selected`）。**`/clickAt` 真实点击会 toggle 掉选中**，反而把 `.btn-confirm` 打回 `disabled`。
- 别在同一次 eval 里立刻读 `.btn-confirm` 的 class，会读到还没更新的 `disabled`，隔 1-2s 再读。
- **`.btn-confirm`（「发送」）第一次点击通常就成功了，但页面毫无反馈**：弹窗 DOM 不移除、聊天流不追加、卡片「同意」按钮不变灰。别据此判定失败去重试（JS click / clickAt / humanClick / 直接调 `__vue__.options.onConfirm` 全试一遍都"没反应"，实际早就发出去了）。
- **唯一可靠的判定：`/navigate` 重新加载会话，再读 `.chat-conversation` 完整 innerText**，找「您的附件简历 … 已发送给Boss」或「对方已查看了您的附件简历」。
- ⚠️**别只读 `innerText.slice(-120)`**：底部固定有卡片按钮 + 工具栏 +「按Enter键发送」约 80 字符占位，发送记录会被挤出尾窗，看起来就像没发。至少取 `slice(-400)` 或全文 `includes('已发送给Boss')`。
- `__vue__` 层面：组件自身的 `onConfirm` 方法走 `this.options.callback`（不存在，恒为空）→ 手调无效；真正的发送在 `__vue__.options.onConfirm`。但既然按钮点击本来就有效，别走这条路。

### 主动推附件简历：走 `.nlp-exchange` 胶囊（2026-07-28 补充）
- 发过消息后输入框上方会出现「⊗ 发送附件简历」胶囊，选择器 `span.nlp-exchange`（`.toolbar-btn` 那个「发简历」点了没反应时用它）。
- 判断推送成功：`.toolbar-btn`（发简历）class 变成含 `unable`，且 `.nlp-exchange` 胶囊消失。**聊天流里不会出现自己推的请求卡片，别靠 innerText 判断**。

### 会话串台会在「navigate 成功后」二次发生（2026-07-28 血泪补充）
- 已知陷阱是 navigate 后跳首位；这次是 **navigate + 校验通过（读到目标公司名）之后，间隔十几秒再发消息时又跳走了** —— 三条消息全发到刚回复过的另一个 HR。
- 根因：刚给别人发过消息 → 那个会话升到列表首位 → 当前会话被抢。
- 唯一可靠做法：**每条消息 type 前、Enter 前都重新读一次 `.chat-conversation` 头部做断言**，不匹配立即中止（写成循环脚本，别手工发）。
- BOSS 网页版**没有撤回入口**（hover/右键都没有），发错只能补一句"发错窗口了"。

### job_detail id 会被截断
搜索页卡片 `a[href]` 里的 job_detail id 有时不足 28 位（如 `823e69f966270d6c1nF42di`），直接 navigate 会打开空 JD 页。**改用点击卡片 `.job-name`，读右侧 `.job-detail-box` 面板**。

### 学历硬门槛速筛（大专候选人）
JD 里出现「985/211 本科及以上」「全日制本科」「硕士/博士优先」基本刷简历关，除非创业小团队。猎头挂的高薪 AI 岗（45-75K / 100-150K）几乎都带 985 硬性。
