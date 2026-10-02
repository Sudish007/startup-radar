import { makeRssSource, feedItemToRaw } from '../lib/rss.js';

// betalist.com/feed, /rss, /startups.rss are 404; the official FeedBurner Atom
// mirror is advertised via <link rel="alternate"> on betalist.com.
// entry.id is the clean startup URL while entry.link carries utm params.
const BETALIST_URL_RE = /^https?:\/\/betalist\.com\//;

export function mapBetalistItem(item) {
  const raw = feedItemToRaw(item);
  if (item.id && BETALIST_URL_RE.test(item.id)) raw.url = item.id;
  return raw;
}

export default makeRssSource({
  id: 'betalist',
  name: 'BetaList',
  homepage: 'https://betalist.com/',
  feedUrl: 'https://feeds.feedburner.com/BetaList',
  kind: 'launch',
  region: 'global',
  mapItem: mapBetalistItem,
});
