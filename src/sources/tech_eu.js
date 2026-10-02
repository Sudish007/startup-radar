import { makeRssSource } from '../lib/rss.js';

export default makeRssSource({
  id: 'tech_eu',
  name: 'Tech.eu',
  homepage: 'https://tech.eu/',
  feedUrl: 'https://tech.eu/feed/',
  kind: 'news',
  region: 'europe',
});
