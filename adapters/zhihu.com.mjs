// 知乎问题/回答/文章提取。
export const domain = 'zhihu.com';
export const aliases = ['知乎', 'Zhihu'];
export const describe = '知乎：问题标题 + 前若干回答摘要，或专栏文章正文';

export const pageExpr = `(() => {
  const title = (document.querySelector('.QuestionHeader-title, h1.Post-Title, .ContentItem-title')?.innerText || document.title || '').trim();
  const answers = [...document.querySelectorAll('.AnswerItem, .List-item')].slice(0, 10).map((a) => ({
    author: (a.querySelector('.AuthorInfo-name')?.innerText || '').trim() || null,
    vote: (a.querySelector('.VoteButton')?.getAttribute('aria-label') || a.querySelector('.VoteButton')?.innerText || '').trim() || null,
    excerpt: (a.querySelector('.RichContent-inner, .RichText')?.innerText || '').trim().slice(0, 1500),
  })).filter((a) => a.excerpt);
  const article = document.querySelector('.Post-RichTextContainer, article .RichText');
  return {
    url: location.href,
    title,
    answerCount: answers.length,
    answers,
    articleText: article ? (article.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 15000) : null,
  };
})()`;
