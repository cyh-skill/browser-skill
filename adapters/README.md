# 结构化站点适配器（adapters/）

把 `references/site-patterns/*.md` 里沉淀的「怎么从某站点取数据」的经验，固化成**可直接返回 JSON** 的提取器。

## 约定

每个适配器是一个 `.mjs` 模块，文件名即适配器名（通常用域名，如 `x.com.mjs`），导出：

| 导出 | 类型 | 说明 |
|------|------|------|
| `domain` | string | 主域名 |
| `aliases` | string[] | 别名（用于人类检索） |
| `describe` | string | 一句话说明这个适配器提取什么 |
| `pageExpr` | string | **在页面上下文执行的 JS 表达式**，必须返回可被 `JSON` 序列化的对象 |

`pageExpr` 会被 CDP `Runtime.evaluate({returnByValue:true, awaitPromise:true})` 注入目标 tab 执行，
所以它跑在**页面里**（能访问 `document`、页面的 `window.__INITIAL_STATE__` 等），
但**不能**访问 Node、文件系统或 skill 里的变量。写成自包含的 IIFE。

## 用法

```bash
# 方式一：proxy 端点（页面已在某 tab 打开）
curl -s -X POST "http://localhost:3456/extract?target=ID&adapter=x.com"

# 方式二：一条命令跑完（自动开 tab → 提取 → 关 tab）
node scripts/run-adapter.mjs x.com "https://x.com/karpathy"
```

## 加新适配器

1. 复制任一现成 `.mjs`，改 `domain` / `pageExpr`。
2. `pageExpr` 里所有取值都 try/catch 或用可选链兜底，取不到就返回 `null`，不要抛异常。
3. 复杂选择器优先参考同名 `references/site-patterns/<domain>.md` 的实战经验。
