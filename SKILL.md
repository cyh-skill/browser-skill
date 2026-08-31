---
name: cyh-browser-skill
license: MIT
description: |
  通过本地 Rust Runtime 控制用户已登录的 Chromium 浏览器，适用于登录后页面读取、表单与点击流程、动态页面提取、UI 验证和需要人工接管的浏览器任务。扩展 Provider 默认负责 Agent Window、页面理解和普通交互，直连 CDP 仅作为网络拦截、文件上传和浏览器级诊断侧车。静态公开信息优先使用 WebSearch/WebFetch，不要为普通网页检索启动真实浏览器。
metadata:
  author: cyh-skill
  version: "2.0.0"
  github: https://github.com/cyh-skill/browser-skill
---

# cyh-browser-skill

所有真实浏览器操作统一通过本 Skill 的本地 Rust Runtime；不要绕过它改用其他浏览器 MCP、Computer Use 或内置浏览器工具。扩展保留用户浏览器登录态，并将 Agent 创建的页面放入独立 Agent Window；用户已有标签页必须经 `/borrow` 的浏览器内确认，完成后归还。

## 何时使用

已登录内容、JS 动态渲染、交互流程、表单、UI 验证、截图或静态抓取无法取得目标时使用本 Skill。普通公开网页、搜索摘要、API 或源码检查优先使用静态工具。

开始真实操作前向用户展示：

> 温馨提示：部分站点对浏览器自动化操作检测严格，存在账号封禁风险。已内置防护措施但无法完全避免，Agent 继续操作即视为接受。强烈建议社交平台用小号操作。

## Runtime

优先调用 PATH 中的二进制；仓库根目录 `install.sh` 默认下载预编译 Runtime，不要求本机安装 Rust，只有 `--from-source` 才需要 Rust/Cargo：

```bash
browser-skill serve
curl -s http://127.0.0.1:3456/health
```

只有 `/health` 返回 `status=ok` 且 `connected=true` 才能操作页面。`providers.extension.connected` 表示扩展可用，`providers.cdp.connected` 表示 CDP 侧车可用。失败时运行 `browser-skill doctor`；不要反复创建 bridge 或标签页。

## 强制生命周期

1. 为当前任务确定唯一 session 名，通过 `POST /new?session=<name>` 创建 Agent Window 页面并记录 `targetId`。
2. 每次页面变化后先 `/observe`；需要紧凑控件列表用 `/snapshot`，需要无障碍树或跨复杂结构诊断用 `/a11y`，视觉信息才用 `/screenshot`。
3. 优先用最新观察得到的 `@eN` 调用 `/click`、`/hover`、`/fill`、`/type`、`/select` 或 `/press`。导航后旧引用失效，必须重新观察。
4. 验证用户要求的可观察成功条件，达到后立即停止，不继续浏览或点击。
5. 用 `/close?session=<name>` 收尾；created 页面关闭，borrowed 页面归还。再次查询 `/targets?managed=1&session=<name>`，确认无残留。

验证码、OTP、登录或重要确认需要用户介入时调用 `/requestHelp`，不要暴力重试。不得读取或外传密码、Cookie、Token、认证头或密码管理器内容。

## Provider 路由

默认不传 `provider`：Runtime 自动路由。扩展是主控，CDP 是能力侧车；两者可以同时在线，但同一 target 同一时刻只能由一个 Provider 附着和写入。网络规则或文件上传触发 CDP lease，中央 target/session 队列会阻止并发写；一次性能力完成后归还扩展，持续网络规则在 `/net/clear` 后统一归还。

需要判断或覆盖路由时，先读 [references/providers.md](references/providers.md)。不要仅因 CDP 可用就跳过 Agent Window、用户借用确认或 managed-target 约束。

## 页面理解与操作

`/observe` 是默认入口，返回页面元信息、正文摘要、heading、landmark、form、frame 状态和带稳定引用的控件；`/snapshot` 是低 token 控件视图；`/a11y` 是 CDP Accessibility 树补充；`/console`、`/network` 用于只读诊断。只有结构化观察不足以判断视觉布局、Canvas、图片或视频时才截图。

完整端点、body 和返回格式见 [references/api.md](references/api.md)。Agent Window、所有权和混合 Provider 的设计不变量见 [references/architecture.md](references/architecture.md)。

## 外部站点知识

核心 Skill 不包含任何特定站点经验或 adapter。Runtime 从 `BROWSER_SKILL_KNOWLEDGE_DIR`、`--knowledge-dir` 或默认的 `~/.browser-skill/knowledge` 读取外部 Knowledge Store；该目录可以是普通本地目录，也可以是独立 Git 仓库。

进入页面前可用 `/knowledge/context?url=<url>` 查询已有知识；发现经过实页验证、可重复使用的新结构或陷阱时，用 `/knowledge/scaffold` 生成草稿，由 Agent 完善并现场验证后，写入 `/knowledge/adapters` 或 `/knowledge/patterns`。不要把站点内容写回核心仓库，不要自动拉取不可信 adapter，也不要在未获得用户明确授权时 commit 或 push Knowledge Store。

生成、验证和存储规则见 [references/knowledge-store.md](references/knowledge-store.md)。
