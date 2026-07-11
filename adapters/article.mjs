// 通用文章正文提取器（任意站点可用）。见 adapters/README.md 约定。
export const domain = '*';
export const aliases = ['article', '通用正文', 'readability'];
export const describe = '通用文章：标题 / 作者 / 发布时间 / 正文文本 / 描述';

export const pageExpr = `(() => {
  const pick = (sels) => { for (const s of sels) { const el = document.querySelector(s); if (el) return el; } return null; };
  const meta = (name) => { const el = document.querySelector('meta[property="'+name+'"], meta[name="'+name+'"]'); return el ? el.content : null; };
  const title = (document.querySelector('h1')?.innerText || meta('og:title') || document.title || '').trim();
  const author = meta('author') || meta('article:author') || pick(['[rel=author]','.author','.byline'])?.innerText?.trim() || null;
  const published = meta('article:published_time') || document.querySelector('time[datetime]')?.getAttribute('datetime') || null;
  const main = pick(['article','main','[role=main]','#content','.article','.post','.content']) || document.body;
  const text = (main.innerText || '').replace(/\\n{3,}/g,'\\n\\n').trim().slice(0, 20000);
  return { url: location.href, title, author, published, description: meta('og:description') || meta('description'), wordCount: text.length, text };
})()`;
