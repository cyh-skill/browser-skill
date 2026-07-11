# 浏览器操作 HTTP API 参考

两条连接通道（CDP-proxy / 扩展桥）暴露**同一套** HTTP API，地址默认 `http://localhost:3456`。
本文档以通道 A（CDP-proxy）为准；通道 B 支持其中的浏览命令子集（不含 `/net/*`），见 `connection-channels.md`。

- 启动（通道 A）：`node ${CLAUDE_SKILL_DIR}/scripts/cdp-proxy.mjs &`（Agent 一般由 check-deps 自动管理）
- 强制停止：`pkill -f cdp-proxy.mjs`
- 环境变量：`CDP_PROXY_PORT`（默认 3456）、`CDP_TAB_IDLE_TIMEOUT`（托管 tab 闲置回收毫秒，默认 900000）

## 页面生命周期

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查（含 channel、connected、netRules 数） |
| `/targets` | GET | 列出页面 tab；`?managed=1` 只列托管、`?session=X` 过滤会话 |
| `/sessions` | GET | 列出所有托管会话及其 tab |
| `/new` | POST body=URL | 新建后台 tab（自动等待加载）；`?session=NAME` 归入会话 |
| `/close?target=ID` | GET | 关闭 tab；或 `?session=NAME` 批量关整个会话 |
| `/navigate?target=ID` | POST body=URL | 导航（自动等待加载） |
| `/back?target=ID` | GET | 后退一页 |
| `/info?target=ID` | GET | 页面 title / url / readyState |

> `/new`、`/navigate` 的 **URL 走 POST body**（v2.5.3 起，避免含 query 时被切分）。旧 `GET ?url=` 返回 400 + 迁移指引，见 `migration-2.5.3.md`。

## 看与读

| 端点 | 方法 | 说明 |
|------|------|------|
| `/eval?target=ID` | POST body=JS | 执行 JS 表达式，返回 `{value}` 或 `{error}`；支持 async |
| `/extract?target=ID&adapter=NAME` | POST/GET | 结构化站点适配器提取，返回 `{adapter, data}` |
| `/screenshot?target=ID&file=PATH` | GET | 截图；有 `file` 存本地，否则返回二进制；可选 `format=jpeg` |
| `/scroll?target=ID&y=3000&direction=down` | GET | 滚动；`direction` = down/up/top/bottom，自动等 800ms 触发懒加载 |

## 做（交互）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/click?target=ID` | POST body=CSS | JS `el.click()`，简单快速 |
| `/clickAt?target=ID` | POST body=CSS | CDP 真实鼠标事件，算用户手势，能触发文件对话框 |
| `/humanClick?target=ID` | POST body=CSS | 拟人：曲线鼠标轨迹 → 按下/释放（抗检测） |
| `/type?target=ID` | POST body=JSON | 拟人变速输入 `{selector,text,clear?,min?,max?,enter?}`，支持中文/emoji |
| `/setFiles?target=ID` | POST body=JSON | `{selector,files:[...]}` 给 file input 设本地文件，绕过对话框 |

## 网络拦截（仅通道 A）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/net/block` | POST body=URL glob | 屏蔽匹配请求（`*` 通配） |
| `/net/mock` | POST body=JSON | `{pattern,status?,contentType?,body?}` mock 响应 |
| `/net/rewrite` | POST body=JSON | `{pattern,redirectUrl}` 改写/重定向请求 |
| `/net/rules` | GET | 列出当前规则 |
| `/net/clear` | GET | 清空规则（保留调试端口探测防护） |

## /eval 使用提示

- 返回值必须可序列化（字符串、数字、对象）；DOM 节点不能直接返回，要提取属性。
- 提取大量数据用 `JSON.stringify()` 包裹确保返回字符串。
- 单次 eval 约 10-15s 超时；长抓取让循环在页面后台跑（写 `window` 全局），再用短 eval 轮询结果。
- 根据页面实际 DOM 编写选择器，不要套固定模板。

## 错误处理

| 错误 | 原因 | 解决 |
|------|------|------|
| `Chrome 未开启远程调试端口` | 未开 remote debugging | 提示用户打开 `chrome://inspect/#remote-debugging` 勾选 Allow |
| `attach 失败` | targetId 无效或 tab 已关 | 用 `/targets` 取最新列表 |
| `CDP 命令超时` | 页面长时间未响应 | 重试或检查 tab 状态 |
| `端口已被占用` | 另一实例在运行 | 已有实例可直接复用 |
| `扩展未连接`（通道 B） | 扩展没加载/没连上桥 | 见 `extension/README.md` |
