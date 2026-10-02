import { makeRssSource } from '../lib/rss.js';

// /rss is 403 (Cloudflare); /feed works.
export default makeRssSource({
  id: 'yourstory',
  name: 'YourStory',
  homepage: 'https://yourstory.com/',
  feedUrl: 'https://yourstory.com/feed',
  kind: 'news',
  region: 'india',
});
