// 微信公众号文章提取。公众号图文为静态渲染，正文在 #js_content。
export const domain = 'mp.weixin.qq.com';
export const aliases = ['微信公众号', '公众号', 'weixin', 'wechat'];
export const describe = '公众号文章：标题 / 公众号名 / 发布时间 / 正文文本 / 图片';

export const pageExpr = `(() => {
  const g = (id) => document.getElementById(id);
  const title = (g('activity-name')?.innerText || document.querySelector('h1')?.innerText || document.title || '').trim();
  const author = (g('js_name')?.innerText || document.querySelector('.rich_media_meta_nickname')?.innerText || '').trim() || null;
  const publish = (g('publish_time')?.innerText || document.querySelector('#publish_time')?.textContent || '').trim() || null;
  const content = g('js_content') || document.querySelector('.rich_media_content');
  const text = content ? (content.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 20000) : null;
  const images = content ? [...content.querySelectorAll('img')].map((i) => i.getAttribute('data-src') || i.src).filter(Boolean).slice(0, 30) : [];
  return { url: location.href, title, author, publish, wordCount: text ? text.length : 0, text, images };
})()`;
