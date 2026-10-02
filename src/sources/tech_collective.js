import { makeRssSource } from '../lib/rss.js';

export default makeRssSource({
  id: 'tech_collective',
  name: 'Tech Collective (SE Asia)',
  homepage: 'https://www.techcollectivesea.com/',
  feedUrl: 'https://www.techcollectivesea.com/feed/',
  kind: 'news',
  region: 'asia',
});
