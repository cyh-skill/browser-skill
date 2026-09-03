---
name: cyh-browser-skill
license: MIT
description: |
  通过本地 Rust Runtime 控制用户已登录的 Chromium 浏览器，执行登录态页面读取、表单与点击流程、动态页面提取、截图、UI 验证和人工接管。扩展 Provider 负责 Agent Window、页面理解和普通交互，直连 CDP 作为网络拦截、文件上传和浏览器级诊断侧车；普通公开信息检索使用 WebSearch/WebFetch。
metadata:
  author: cyh-skill
  version: "2.0.0"
  github: https://github.com/cyh-skill/browser-skill
---

# cyh-browser-skill

这是以 Codex 为当前优先入口、同时兼容 Claude Code 的真实浏览器 Skill；Codex 通过 `SKILL.md` 和 `agents/openai.yaml` 发现并调用它，Claude Code 通过 `.claude-plugin/` 元数据加载同一 Skill。所有真实浏览器操作统一由本 Skill 的本地 Rust Runtime 承担。扩展保留用户浏览器登录态，并将 Agent 创建的页面放入独立 Agent Window 和带 `Agent · <session>` 标题的彩色标签组；用户已有标签页通过 `/borrow` 的浏览器内确认取得临时控制权，完成后归还且不会加入 Agent 标签组。

## 何时使用

本 Skill 接收明确的目标页面、操作和可观察成功条件，并执行需要真实浏览器的登录态内容读取、JS 动态渲染、交互流程、表单、截图、UI 验证或人工接管。普通公开网页、搜索摘要和公开 API 使用静态工具。

开始真实操作前向用户展示：

> 温馨提示：部分站点对浏览器自动化操作检测严格，存在账号封禁风险。已内置防护措施但无法完全避免，Agent 继续操作即视为接受。强烈建议社交平台用小号操作。

## Runtime

优先调用 PATH 中的二进制；仓库根目录 `install.sh` 默认下载预编译 Runtime，不要求本机安装 Rust，只有 `--from-source` 才需要 Rust/Cargo：

```bash
browser-skill serve
curl -s http://127.0.0.1:3456/health
```

页面操作的健康门槛是 `/health` 返回 `status=ok` 且 `connected=true`。`providers.extension.connected` 表示扩展可用，`providers.cdp.connected` 表示 CDP 侧车可用。失败时运行一次 `browser-skill doctor` 并根据结果处理，复用现有 bridge 和 managed 页面。

## 强制生命周期

1. 整个用户需求使用一个稳定 session，并持续复用该 session 对应的 `Agent · <session>` 标签分组。记录本次持有的 created/borrowed target、显式 CDP lease、网络规则和临时模拟状态。先查询 `GET /targets?managed=1&session=<name>`，复用分组内适合继续操作的 managed 主 `targetId`；没有可复用页面时调用一次 `POST /new?session=<name>`。用户已有但尚未托管的页面通过 `/borrow` 获得确认，并保留在用户原窗口而非 Agent 分组。
2. 同一需求默认复用一个主标签页，后续 URL 通过主 target 的 `/navigate` 访问。用户明确要求多页面、需要并排对照，或被测流程要求新窗口/弹窗时才新增标签页；新增页沿用同一 session，用完立即关闭。
3. 每次页面变化后先 `/observe`；需要紧凑控件列表用 `/snapshot`，需要无障碍树或跨复杂结构诊断用 `/a11y`，视觉信息才用 `/screenshot`。
4. 优先用最新观察得到的 `@eN` 调用 `/click`、`/hover`、`/fill`、`/type`、`/select` 或 `/press`。导航后旧引用失效，必须重新观察。
5. 验证用户要求的可观察成功条件，达到后立即停止，不继续浏览或点击。
6. 浏览器步骤结束后执行下面的清理决策门，并在交付前核对实际状态。

## 调用结束清理决策门

调用结束时必须选择并落实一种状态：

1. **整个用户任务已完成，session 归零**：清除本次创建的临时网络规则和模拟状态，释放本次显式取得的 CDP lease，然后调用 `/close?session=<name>`；created 页面和 `Agent · <session>` 分组关闭，borrowed 页面归还。
2. **同一用户任务仍在继续，复用原分组**：保留原 session、原 `Agent · <session>` 分组及其中一个有明确下一步用途的 created 主 target；其余 created 页面通过 `/close?target=<id>` 关闭，暂时不再需要的 borrowed 页面通过 `/return?target=<id>` 归还，临时网络规则、模拟状态和显式 CDP lease 完成清理。用户明确要求保留多个页面时，按其指定范围留在同一分组中。

清理前查询 `/net/rules`。本次调用拥有当前全部规则时，使用 `/net/clear` 清除并归还相关持续 lease；存在其他调用持有的规则时，保留其状态并把冲突作为残留资源报告。显式 `provider=cdp` 或 `/provider/lease` 取得的 lease 通过 `/provider/release?target=<id>` 释放；`/setFiles` 的一次性 lease 由 Runtime 自动归还。保留页面上的临时设备模拟通过 `/emulate` 的 `{"off":true}` 恢复。

最后重新查询 `/targets?managed=1&session=<name>`、`/net/rules` 和 `/health`，核对分组、页面、规则与 lease。最终回复必须包含一条清理声明：session 归零时报告关闭和归还数量；复用分组时报告 session、分组、保留 target、ownership 和下一步用途；清理失败时报告具体残留及失败原因。

验证码、OTP、登录或重要确认需要用户介入时调用 `/requestHelp` 并等待接管。不得读取或外传密码、Cookie、Token、认证头或密码管理器内容，也不得用暴力重试绕过人工确认。

## Provider 路由

默认不传 `provider`：Runtime 自动路由。扩展是主控，CDP 是能力侧车；两者可以同时在线，但同一 target 同一时刻只能由一个 Provider 附着和写入。网络规则或文件上传触发 CDP lease，中央 target/session 队列会阻止并发写；一次性能力完成后归还扩展，持续网络规则在 `/net/clear` 后统一归还。

需要判断或覆盖路由时，先读 [references/providers.md](references/providers.md)。Agent Window、用户借用确认和 managed-target 约束适用于所有 Provider；CDP 可用性只决定侧车能力。

## 页面理解与操作

`/observe` 是默认入口，返回页面元信息、正文摘要、heading、landmark、form、frame 状态和带稳定引用的控件；`/snapshot` 是低 token 控件视图；`/a11y` 是 CDP Accessibility 树补充；`/console`、`/network` 用于只读诊断。只有结构化观察不足以判断视觉布局、Canvas、图片或视频时才截图。

完整端点、body 和返回格式见 [references/api.md](references/api.md)。Agent Window、所有权和混合 Provider 的设计不变量见 [references/architecture.md](references/architecture.md)。

## 外部站点知识

核心 Skill 不包含任何特定站点经验或 adapter。Runtime 从 `BROWSER_SKILL_KNOWLEDGE_DIR`、`--knowledge-dir` 或默认的 `~/.browser-skill/knowledge` 读取外部 Knowledge Store；该目录可以是普通本地目录，也可以是独立 Git 仓库。

进入页面前可用 `/knowledge/context?url=<url>` 查询已有知识；发现经过实页验证、可重复使用的新结构或陷阱时，用 `/knowledge/scaffold` 生成草稿，由 Agent 完善并现场验证后，写入 `/knowledge/adapters` 或 `/knowledge/patterns`。核心仓库只保存通用 Runtime，Knowledge Store 只接收已验证且可信的 adapter 或 pattern；commit 和 push 是需要用户明确授权的独立交付动作。

生成、验证和存储规则见 [references/knowledge-store.md](references/knowledge-store.md)。
