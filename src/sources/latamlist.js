import { makeRssSource } from '../lib/rss.js';

export default makeRssSource({
  id: 'latamlist',
  name: 'LatamList',
  homepage: 'https://latamlist.com/',
  feedUrl: 'https://latamlist.com/feed/',
  kind: 'news',
  region: 'latam',
});
