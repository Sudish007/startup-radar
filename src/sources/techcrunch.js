import { makeRssSource } from '../lib/rss.js';

export default makeRssSource({
  id: 'techcrunch',
  name: 'TechCrunch \u2014 Startups',
  homepage: 'https://techcrunch.com/category/startups/',
  feedUrl: 'https://techcrunch.com/category/startups/feed/',
  kind: 'news',
  region: 'usa',
});
