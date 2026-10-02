import { makeRssSource } from '../lib/rss.js';

// RSS of Crunchbase's news site, NOT the Crunchbase database (see crunchbase.js).
export default makeRssSource({
  id: 'crunchbase_news',
  name: 'Crunchbase News',
  homepage: 'https://news.crunchbase.com/',
  feedUrl: 'https://news.crunchbase.com/feed/',
  kind: 'news',
  region: 'usa',
});
