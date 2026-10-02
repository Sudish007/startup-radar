import Parser from 'rss-parser';
import { stripHtml } from './normalize.js';

const parser = new Parser({
  customFields: { item: ['published', 'updated', 'dc:date', 'content:encoded'] },
  timeout: 15000,
});

/** Parse Atom or RSS 2.0 text into rss-parser's feed object. */
export function parseFeed(xmlText) {
  return parser.parseString(xmlText);
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** rss-parser item -> raw adapter item. */
export function feedItemToRaw(item) {
  const extra = compact({ author: item.creator || item.author || undefined });
  return {
    title: item.title?.trim(),
    url: item.link,
    summary: item.contentSnippet || stripHtml(item['content:encoded'] || item.content || item.summary || ''),
    publishedAt: item.isoDate || item.published || item.updated || item['dc:date'] || item.pubDate || null,
    extra,
  };
}

/** Download a feed through the shared http client and parse it. */
export async function fetchFeed(url, ctx) {
  const res = await ctx.http.fetchText(url, { signal: ctx.signal });
  return parseFeed(res.text);
}

/** Factory for the common "one RSS/Atom feed = one source" adapter. */
export function makeRssSource({
  id,
  name,
  homepage,
  feedUrl,
  kind,
  region,
  enabled = () => true,
  requires = null,
  mapItem = feedItemToRaw,
}) {
  return {
    id,
    name,
    homepage,
    feedUrl,
    kind,
    region,
    enabled,
    requires,
    async fetch(ctx) {
      const feed = await fetchFeed(feedUrl, ctx);
      return (feed.items ?? []).map(mapItem).filter(Boolean);
    },
  };
}
