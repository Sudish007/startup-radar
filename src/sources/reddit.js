import { feedItemToRaw } from '../lib/rss.js';
import { stripHtml } from '../lib/normalize.js';

// Disabled by default (ENABLE_REDDIT=true to turn on).
// Verification 2026-10-02: the JSON endpoints (/new.json, api.reddit.com,
// old.reddit.com) returned 403 block pages; the Atom endpoint for r/SideProject
// returned 200, but r/startups/new.rss returned 429 on every probe, so shared
// cloud IPs should expect rate limiting. One feed failing does not fail the
// source; only when every feed fails is the first error thrown.
const FEEDS = [
  { subreddit: 'SideProject', url: 'https://www.reddit.com/r/SideProject/new.rss?limit=50' },
  { subreddit: 'startups', url: 'https://www.reddit.com/r/startups/new.rss?limit=50' },
];
const BOILERPLATE_RE = /\s*submitted by\s+\/u\/\S+[\s\S]*$/;

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

/** Remove the "submitted by /u/name [link] [comments]" trailer from a post body. */
export function stripRedditBoilerplate(html) {
  return stripHtml(html || '').replace(BOILERPLATE_RE, '').trim();
}

/** Atom entry (rss-parser item) -> raw item. */
export function mapRedditItem(item, subreddit) {
  const raw = feedItemToRaw(item);
  raw.summary = stripRedditBoilerplate(item.content);
  raw.extra = compact({ author: item.author ?? raw.extra?.author, subreddit });
  return raw;
}

export default {
  id: 'reddit',
  name: 'Reddit \u2014 r/SideProject + r/startups',
  homepage: 'https://www.reddit.com/r/SideProject/new/',
  kind: 'launch',
  region: 'global',
  enabled: (env) => env.ENABLE_REDDIT === 'true',
  requires: 'ENABLE_REDDIT=true',
  async fetch(ctx) {
    const results = await Promise.allSettled(FEEDS.map((f) => ctx.rss.fetchFeed(f.url, ctx)));
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    const items = [];
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') {
        ctx.log?.(`[reddit] r/${FEEDS[i].subreddit}: ${r.reason?.message ?? r.reason}`);
        return;
      }
      for (const item of r.value.items ?? []) {
        items.push(mapRedditItem(item, FEEDS[i].subreddit));
      }
    });
    return items;
  },
};
