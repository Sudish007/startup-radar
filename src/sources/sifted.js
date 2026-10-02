import { makeRssSource } from '../lib/rss.js';

export default makeRssSource({
  id: 'sifted',
  name: 'Sifted',
  homepage: 'https://sifted.eu/',
  feedUrl: 'https://sifted.eu/feed',
  kind: 'news',
  region: 'europe',
});
