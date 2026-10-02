import { makeRssSource } from '../lib/rss.js';

export default makeRssSource({
  id: 'techcrunch_venture',
  name: 'TechCrunch \u2014 Venture',
  homepage: 'https://techcrunch.com/category/venture/',
  feedUrl: 'https://techcrunch.com/category/venture/feed/',
  kind: 'news',
  region: 'usa',
});
