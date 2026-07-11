// 小红书笔记详情提取。打开笔记详情页需带 xsec_token，详见 site-patterns/xiaohongshu.com.md。
export const domain = 'xiaohongshu.com';
export const aliases = ['小红书', 'XHS', 'RED'];
export const describe = '小红书笔记：标题 / 作者 / 正文 / 图片原图 URL';

export const pageExpr = `(() => {
  let hasState = false; try { hasState = !!window.__INITIAL_STATE__; } catch (e) {}
  const title = (document.querySelector('#detail-title, .title')?.innerText || document.title || '').trim();
  const author = (document.querySelector('.author-wrapper .username, .author .name, .name')?.innerText || '').trim() || null;
  const desc = (document.querySelector('#detail-desc, .note-text, .desc')?.innerText || '').trim().slice(0, 8000) || null;
  const images = [...document.querySelectorAll('img')].map((i) => i.src).filter((s) => /sns-webpic|sns-img/.test(s));
  return { url: location.href, title, author, desc, images: [...new Set(images)].slice(0, 30), hasInitialState: hasState };
})()`;
