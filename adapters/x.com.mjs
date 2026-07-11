// X / Twitter 快照提取：页面类型 + 可见 UserCell + 主列推文。
// 注意：完整 following/followers 全量请走 site-patterns/x.com.md 里的 GraphQL cursor 方案，
// 本适配器只做「当前页面可见内容」的结构化快照。
export const domain = 'x.com';
export const aliases = ['twitter', '推特', 'X'];
export const describe = 'X 页面快照：handle / 主列可见用户单元 / 可见推文（限 primaryColumn，排除侧栏推荐）';

export const pageExpr = `(() => {
  const scope = document.querySelector('[data-testid="primaryColumn"]') || document;
  const meta = (n) => document.querySelector('meta[property="'+n+'"]')?.content || null;
  const path = location.pathname;
  const handleFromPath = (path.match(/^\\/([A-Za-z0-9_]{1,15})(?:\\/|$)/) || [])[1] || null;
  const cells = [...scope.querySelectorAll('[data-testid="UserCell"]')].map((c) => {
    const href = [...c.querySelectorAll('a[href]')].map((x) => x.getAttribute('href')).find((h) => /^\\/[A-Za-z0-9_]{1,15}$/.test(h));
    return { handle: href ? href.slice(1) : null, text: (c.innerText || '').replace(/\\n+/g, ' ').trim().slice(0, 160) };
  }).filter((x) => x.handle);
  const tweets = [...scope.querySelectorAll('article[data-testid="tweet"]')].slice(0, 20).map((t) => ({
    text: (t.querySelector('[data-testid="tweetText"]')?.innerText || '').trim().slice(0, 600),
    time: t.querySelector('time')?.getAttribute('datetime') || null,
    link: t.querySelector('a[href*="/status/"]')?.getAttribute('href') || null,
  }));
  return { url: location.href, pageHandle: handleFromPath, title: document.title, description: meta('og:description'), userCells: cells, userCellCount: cells.length, tweets };
})()`;
