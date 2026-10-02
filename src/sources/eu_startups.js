import { makeRssSource } from '../lib/rss.js';

// The direct feed (https://www.eu-startups.com/feed/) is 403 behind a Cloudflare
// challenge; the official FeedBurner mirror returns the same items.
export default makeRssSource({
  id: 'eu_startups',
  name: 'EU-Startups',
  homepage: 'https://www.eu-startups.com/',
  feedUrl: 'https://feeds.feedburner.com/eu-startups',
  kind: 'news',
  region: 'europe',
});
