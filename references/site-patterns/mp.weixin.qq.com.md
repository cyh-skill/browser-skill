---
domain: mp.weixin.qq.com
aliases: [微信公众号, 公众号, weixin, wechat, 微信文章]
updated: 2026-07-11
---
## 平台特征
- 公众号图文文章 `mp.weixin.qq.com/s/xxxx` 或带 `?__biz=...&mid=...&idx=...&sn=...` 的长链接。正文基本是**服务端静态渲染**，无需登录即可打开单篇文章（分享链接公开可读）。
- 正文容器 `#js_content`；标题 `#activity-name`（或 `h1`）；公众号名 `#js_name`；发布时间 `#publish_time`。
- 正文图片常用**懒加载**：真实地址在 `img` 的 `data-src`（非 `src`）；`src` 可能是占位。

## 有效模式
- 结构化提取直接用适配器：`adapters/mp.weixin.qq.com.mjs`（`/extract?adapter=mp.weixin.qq.com`）——返回标题/公众号/时间/正文文本/图片。
- 纯正文场景也可先 `/scroll` 到底触发图片懒加载，再取 `#js_content` innerText。
- 静态正文用 **Jina**（`r.jina.ai/<url>`）转 Markdown 往往一步到位、最省 token；只有当 Jina 结果缺失或排版乱时再走浏览器。

## 已知陷阱
- 分享链接带的 query 参数（`__biz/mid/idx/sn/chksm` 等）是访问所必需的，`/new` 用 POST body 原样传，不要裁剪。
- 「该内容已被发布者删除」「此内容因违规无法查看」是真实状态，换访问方式无用。
- 图片取 `data-src`；直接 Read 图片需带 `Referer: https://mp.weixin.qq.com/`。
- 环境异常时公众号页偶尔要求「环境异常，完成验证」；属风控，放慢节奏或换网络。
