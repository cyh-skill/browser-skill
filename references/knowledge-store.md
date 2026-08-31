# 外部 Knowledge Store

默认目录：`~/.browser-skill/knowledge`。可用 `BROWSER_SKILL_KNOWLEDGE_DIR` 或 `browser-skill serve --knowledge-dir PATH` 覆盖。

```text
knowledge/
├── manifest.json
├── adapters/
│   └── <id>.json
└── patterns/
    └── <domain>.md
```

目录可以自行 `git init` 并配置远端，但 Runtime 不负责自动 clone、pull、commit 或 push。

## Adapter 格式

```json
{
  "schemaVersion": 1,
  "id": "example.com",
  "domains": ["example.com"],
  "aliases": ["example"],
  "description": "返回标题与主要记录",
  "expression": "(() => ({url: location.href, title: document.title}))()",
  "sourceUrl": "https://example.com/page",
  "verifiedAt": "2026-08-31"
}
```

文件名、`id` 和 domain 只接受字母、数字、点、下划线与短横线；通用 adapter 可使用 domain `*`。expression 上限 200 KB，在已托管页面主世界执行，必须人工审查。

## 生成流程

1. 用 `/observe`、`/a11y` 和必要的 `/eval` 获取当前页面证据。
2. 调用 `POST /knowledge/scaffold?target=ID`，body 传 `{"kind":"adapter","id":"example.com"}` 或 `{"kind":"pattern","id":"example.com"}`。
3. Agent 根据观察结果完善草稿；不得把一次性 token、账号信息、Cookie、请求签名或个人数据写入知识库。
4. 在当前页面直接 `/eval` expression，确认返回字段、空状态和数量边界。
5. 把完整 JSON `POST /knowledge/adapters`；pattern 用 `POST /knowledge/patterns`，body 为 `{"domain":"example.com","content":"...","sourceUrl":"..."}`。
6. 运行 `browser-skill knowledge validate`，重新 `/extract?target=ID&adapter=example.com` 验证。
7. 只有用户明确要求时才对该独立仓库 commit 或 push。

Pattern 只记录可重复、会改变未来决策的页面路径、平台约束和失败信号；不要保存普通任务日志、账号内容或未经验证的猜测。
