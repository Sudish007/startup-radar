import { mapHnHit } from '../lib/hn.js';

const API_URL = 'https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=50';

export default {
  id: 'hn_show',
  name: 'Hacker News \u2014 Show HN',
  homepage: 'https://news.ycombinator.com/show',
  kind: 'launch',
  region: 'global',
  enabled: () => true,
  requires: null,
  async fetch(ctx) {
    const data = await ctx.http.fetchJson(API_URL, { signal: ctx.signal });
    return (data.hits ?? []).map(mapHnHit);
  },
};
