# HTTP API

默认地址 `http://127.0.0.1:3456`。所有 target 命令接受 `provider=auto|extension|cdp`，默认 `auto`；只有诊断和明确能力需求才覆盖。

## 生命周期

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | Runtime、Provider、lease、Knowledge Store 状态 |
| `/route?operation=...` | GET | 预览某操作的自动路由 |
| `/targets` | GET | 页面列表；支持 `managed=1`、`session`、`scope=user|agent|all` |
| `/sessions` | GET | Runtime 与扩展 session |
| `/new?session=NAME` | POST URL body | 在 Agent Window 创建新页面；调用前先用 `/targets?managed=1&session=NAME` 查找同一需求的可复用主页面，后续 URL 优先对该 target 使用 `/navigate` |
| `/borrow?target=ID&session=NAME` | POST | 浏览器内确认后借用用户标签 |
| `/return?target=ID` | POST | 归还 borrowed 标签 |
| `/close?target=ID` | GET/POST | 关闭 created 或归还 borrowed |
| `/close?session=NAME` | GET/POST | session 收尾：关闭 created、归还 borrowed，并尝试释放其 CDP lease |

调用结束时查询 `/targets?managed=1&session=NAME` 并落实清理决策：整个用户任务完成时使用 session 收尾；同一用户任务继续时复用原 session 和 `Agent · <session>` 分组，分组内保留一个已声明用途的 created 主 target，其余 target 按 ownership 关闭或归还。交付前再次查询 target、`/net/rules` 和 `/health`，并声明 session 归零或分组复用状态。

## 页面理解

| 端点 | 说明 |
|---|---|
| `/observe?target=ID` | 页面、正文、heading、landmark、form、frame、控件与 `@eN` |
| `/snapshot?target=ID` | 不含正文的紧凑观察 |
| `/a11y?target=ID` | CDP Accessibility 树 |
| `/info?target=ID` | title、URL、readyState |
| `/screenshot?target=ID&file=PATH` | PNG/JPEG；无 file 时返回二进制 |
| `/console?target=ID` | 扩展缓冲的 console/exception 日志 |
| `/network?target=ID` | 扩展缓冲的只读响应与失败元数据 |
| `/eval?target=ID` | POST JavaScript；仅在语义工具不足时使用 |

## 导航与交互

- `/navigate?target=ID`：POST URL body；另有 `/back`、`/forward`、`/reload`、`/waitForNavigation`。
- `/click`、`/clickAt`、`/humanClick`、`/hover`：POST CSS 或 `@eN`。
- `/type`：`{"selector":"@e1","text":"...","clear":true,"enter":false}`。
- `/fill`：`{"selector":"@e1","value":"..."}`。
- `/select`：`{"selector":"@e1","values":["value"]}`。
- `/press`：`{"key":"Enter"}`；`/scroll` 接受 direction 和 y query。
- `/emulate`：POST viewport、UA、touch 参数；`{"off":true}` 清除。
- `/requestHelp`：POST `{"title":"...","prompt":"...","targets":["@e1"],"timeout":300000}`。

## CDP 侧车

- `/setFiles?target=ID`：`{"selector":"input[type=file]","files":["/absolute/path"]}`，一次性 lease 后自动归还。
- `/net/block?target=ID`：body 为 URL glob。
- `/net/mock?target=ID`：`{"pattern":"...","status":200,"contentType":"application/json","body":"{}"}`。
- `/net/rewrite?target=ID`：`{"pattern":"...","redirectUrl":"https://..."}`。
- `/net/rules`、`/net/clear`：查看或清空 Runtime 的全部规则；clear 同时归还持续 lease。调用方确认当前规则均由本次调用持有后使用 clear；存在其他调用的规则时报告冲突。
- `/provider/lease`、`/provider/release`：底层诊断使用的显式接管。

## 外部知识

- `/knowledge`：列出 adapters 与 patterns。
- `/knowledge/context?url=...`：按 host 匹配上下文。
- `/knowledge/scaffold?target=ID`：生成含当前观察证据的草稿。
- `/knowledge/adapters`、`/knowledge/patterns`：校验后写入外部目录。
- `/extract?target=ID&adapter=ID`：执行外部 adapter。

错误均返回 JSON `{error}`；400 为参数错误，409 为 ownership/lease 冲突，503 为所需 Provider 未连接，500 为 Provider 或浏览器执行失败。
