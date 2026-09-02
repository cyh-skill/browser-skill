# cyh-browser-skill

面向 Codex（当前优先）并兼容 Claude Code 的真实浏览器 Skill，用本地 Rust Runtime 安全控制用户已登录的 Chromium 浏览器。2.0 将原 Node 宿主迁移为 Rust Runtime，并加入独立 Agent Window、浏览器内标签借用确认、增强页面理解、完整交互命令和 Extension/CDP 混合路由。

## 架构

```text
Codex / Claude Code ── HTTP ──> Rust Runtime (:3456)
                    ├─ Extension WS (:3458) ──> Agent Window / chrome.debugger
                    ├─ Direct CDP sidecar ────> network / file / low-level diagnostics
                    └─ external Knowledge Store (~/.browser-skill/knowledge)
```

扩展是默认主控，负责 Agent Window、用户授权、页面观察和普通交互；直连 CDP 只处理网络拦截、文件上传及明确的底层诊断。两个 Provider 可以同时在线，但 Runtime 通过 target lease 和统一队列保证同一标签页不会被同时附着或写入。

## 安装

本仓库以 Codex 为当前优先入口：指令入口为 `SKILL.md`，界面元数据为 `agents/openai.yaml`。将仓库目录安装或链接为 `~/.agents/skills/cyh-browser-skill` 后，重新启动 Codex 会话以加载 Skill。Claude Code 兼容元数据保留在 `.claude-plugin/`，个人 Skill 使用 `/cyh-browser-skill`，插件安装使用 `/browser-skill:cyh-browser-skill`；两个入口共享相同的 `SKILL.md`、Runtime、扩展和安全边界。

随后安装本地 Runtime。默认下载带 SHA-256 校验的预编译文件，运行和安装都不需要 Rust/Cargo：

```bash
./install.sh
browser-skill --version
```

开发者需要从源码编译时才使用 `./install.sh --from-source`；本地已有构建产物可用 `./install.sh --binary PATH`。

最后打开 `chrome://extensions`，开启开发者模式并加载本仓库的 `extension/`。启动 Runtime：

```bash
browser-skill serve
curl -s http://127.0.0.1:3456/health
```

Chrome/Edge 开启 Remote Debugging 后，Runtime 会自动连接 CDP 侧车；也可设置 `BROWSER_SKILL_CDP_ENDPOINT`。仅使用 Agent Window 和普通自动化时不要求 CDP 侧车。

## 核心能力

- 每个 session 独立 Agent Window；created/borrowed 所有权机械隔离。
- `/observe` 的 DOM、同源 frame、开放 Shadow Root、heading、landmark、form、控件状态与稳定 `@eN`；`/a11y` 提供 Accessibility 树补充。
- click、真实坐标点击、拟人点击、hover、fill、变速 type、select、press、scroll、导航等待、截图、设备模拟、console/network 诊断和人工接管。
- CDP sidecar 提供文件上传以及请求 block/mock/rewrite。
- Rust target/session 队列与 Provider lease，支持多个页面并行、同一页面串行。

完整工作流见 [SKILL.md](SKILL.md)，Provider 边界见 [references/providers.md](references/providers.md)，API 见 [references/api.md](references/api.md)。

## 外部站点知识

核心仓库不再内置任何特定站点经验或 adapter。外部 Knowledge Store 默认为 `~/.browser-skill/knowledge`，也可以通过 `BROWSER_SKILL_KNOWLEDGE_DIR` 或 `--knowledge-dir` 指向独立本地/Git 仓库。Runtime 支持查询、生成草稿、验证和保存；不会自动 clone、commit 或 push。

```bash
browser-skill knowledge init
browser-skill knowledge validate
curl -s http://127.0.0.1:3456/knowledge
```

格式和生成流程见 [references/knowledge-store.md](references/knowledge-store.md)。

## 开发验证

```bash
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
node --check extension/background.js
node --check runtime/observe.js
```

Node 只用于可选的扩展源码语法检查，不参与 Runtime；浏览器扩展仍必须使用 JavaScript/MV3 API。

## License

MIT。上游致谢和迁移边界见 [NOTICE](NOTICE)。
