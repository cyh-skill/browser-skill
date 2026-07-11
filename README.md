# browser-skill

> 给 Agent 装上完整浏览器操作能力的融合型 Skill —— 直连你的**日常浏览器**（天然登录态），
> 做登录后操作、页面交互、抓取 JS 动态渲染 / 反爬平台。

在 [web-access](https://github.com/eze-is/web-access)（一泽Eze，MIT）的 CDP-proxy 底座上，
融合 [chrome-use](https://github.com/leeguooooo/chrome-use)（leeguooooo，Apache-2.0）的
**多会话隔离 / 拟人输入 / 网络拦截 / 扩展桥**思路，并新增**结构化站点适配器**。为个人工作流定制。

兼容所有支持 `SKILL.md` 的 Agent（Claude Code、Cursor、Codex/Gemini CLI 等）。

---

## 能力一览

| 能力 | 说明 | 来源 |
|------|------|------|
| 直连日常浏览器 | Chrome / Edge / Chromium 系，天然登录态，动态页面 / 交互 / 视频截帧 | web-access |
| 智能联网工具选择 | WebSearch / WebFetch / curl / Jina / 浏览器，按场景自主判断 | web-access |
| 本地书签/历史检索 | 跨 Chrome / Edge 找公网搜不到的目标或访问过的页面 | web-access |
| 站点经验积累 | 按域名沉淀 URL 模式 / 平台特征 / 陷阱，跨 session 复用 | web-access |
| **多会话隔离** | `?session=NAME` 分组管理并行 tab，一键关会话；通道 B 为真·彩色标签组 | chrome-use |
| **拟人输入** | `/humanClick` 曲线鼠标 + `/type` 变速敲击（支持中文/emoji），抗检测 | chrome-use |
| **网络拦截** | `/net/block`·`/net/mock`·`/net/rewrite`，提速 / 去干扰 / 调试 | chrome-use |
| **双连接通道** | 统一入口自动选通道（有扩展走扩展，否则回退 CDP）；A 全能力、B 免开调试开关 | 融合 |
| **结构化站点适配器** | `/extract?adapter=` 与 `run-adapter.mjs`，URL → 标准 JSON | 新增 |

已内置站点适配器/经验：`article`(通用正文)、`x.com`、`zhihu.com`、`xiaohongshu.com`、
`mp.weixin.qq.com`(公众号)、`goofish.com`(闲鱼)、`zhipin.com`(BOSS直聘)。

## 安装

```bash
# 方式一：让 Agent 自动安装
# “帮我安装这个 skill：https://github.com/cyh-skill/browser-skill”

# 方式二：手动
git clone https://github.com/cyh-skill/browser-skill ~/.claude/skills/browser-skill
# 或 ~/.agents/skills/browser-skill（按你的 Agent 环境）
```

## 前置配置

需要 **Node.js 22+**。通道 A（默认）需浏览器开启远程调试开关：

1. 浏览器地址栏打开 `chrome://inspect/#remote-debugging`（Edge 为 `edge://inspect/#remote-debugging`）
2. 勾选 **Allow remote debugging for this browser instance**（可能需重启浏览器）

浏览器偏好存 `config.env`（首次运行自动从模板创建，gitignored）：

```bash
# 留空 = 每次询问；设值 = 固定该浏览器
BROWSER_SKILL_BROWSER=chrome
```

统一入口（Agent 运行时自动完成）：会自动探测通道——有扩展走通道 B，没有则自动回退通道 A。

```bash
node ~/.claude/skills/browser-skill/scripts/bridge.mjs
```

## 两条连接通道

由 `bridge.mjs` 统一入口自动选（有扩展走 B，否则回退 A；可用 `--channel auto|ext|cdp` 强制）：

| 通道 | 连接 | 何时用 |
|------|------|--------|
| **A · CDP-proxy**（默认，回退项） | `chrome://inspect` 开关 + Node 直连 | 支持全部能力（含 `/net/*` 网络拦截）。已端到端验证 |
| **B · 扩展桥**（实验性） | 未打包扩展 `chrome.debugger` + Node WS 桥 | 免开调试开关、想要真·彩色标签组时。见 [`extension/README.md`](extension/README.md) |

两条通道 HTTP API 完全一致（同一套 `http://127.0.0.1:3456`），任务里的调用与通道无关。详见 [`references/connection-channels.md`](references/connection-channels.md)。

## 快速上手

```bash
# 新建后台 tab（URL 走 POST body）
curl -s -X POST --data-raw 'https://example.com' http://localhost:3456/new
# 执行 JS / 结构化提取 / 拟人输入 / 截图
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'document.title'
curl -s -X POST "http://localhost:3456/extract?target=ID&adapter=article"
curl -s -X POST "http://localhost:3456/type?target=ID" -d '{"selector":"input#q","text":"关键词","enter":true}'
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/shot.png"

# 一条命令跑完结构化提取
node scripts/run-adapter.mjs mp.weixin.qq.com "https://mp.weixin.qq.com/s/xxxx"
```

完整 API 见 [`references/cdp-api.md`](references/cdp-api.md)，设计与哲学见 [`SKILL.md`](SKILL.md)。

## ⚠️ 使用前提醒

通过浏览器自动化操作社交平台（小红书、X、公众号等）存在账号被限流或封禁的风险。
已内置防护但无法完全避免。**强烈建议用小号操作。**

## 致谢与许可

- 底座与哲学：[web-access](https://github.com/eze-is/web-access) · 一泽Eze · MIT
- 能力思路：[chrome-use](https://github.com/leeguooooo/chrome-use) · leeguooooo · Apache-2.0

本项目为二者的融合/衍生作品，MIT 许可。详细署名见 [`NOTICE`](NOTICE)。
