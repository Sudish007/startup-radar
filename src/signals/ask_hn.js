// Signal: the 50 newest Ask HN / Tell HN posts (Algolia HN search, same host as hn_show / hn_launch).

export const ASK_HN_URL = 'https://hn.algolia.com/api/v1/search_by_date?tags=ask_hn&hitsPerPage=50';

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Algolia hit -> { title, hnUrl, points, comments, createdAt, author }. */
export function mapAskHnHit(hit) {
  return {
    title: String(hit.title ?? ''),
    hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    points: num(hit.points),
    comments: num(hit.num_comments),
    createdAt: hit.created_at ?? null,
    author: typeof hit.author === 'string' ? hit.author : null,
  };
}

export function mapAskHn(body) {
  const hits = Array.isArray(body?.hits) ? body.hits : [];
  return { posts: hits.filter((h) => h && h.objectID && h.title).map(mapAskHnHit) };
}

export default {
  id: 'ask_hn',
  name: 'Ask HN',
  homepage: 'https://news.ycombinator.com/ask',
  description: '50 newest Ask HN / Tell HN posts; points and comments as reported by Hacker News at fetch time',
  enabled: () => true,
  requires: null,
  async fetch(ctx) {
    const body = await ctx.http.fetchJson(ASK_HN_URL, { signal: ctx.signal });
    return mapAskHn(body);
  },
};
