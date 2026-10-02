import { makeRssSource } from '../lib/rss.js';

export default makeRssSource({
  id: 'inc42',
  name: 'Inc42',
  homepage: 'https://inc42.com/',
  feedUrl: 'https://inc42.com/feed/',
  kind: 'news',
  region: 'india',
});
