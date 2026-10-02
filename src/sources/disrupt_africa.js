import { makeRssSource } from '../lib/rss.js';

// disrupt-africa.com redirects to old.disruptafrica.com; use disruptafrica.com.
export default makeRssSource({
  id: 'disrupt_africa',
  name: 'Disrupt Africa',
  homepage: 'https://disruptafrica.com/',
  feedUrl: 'https://disruptafrica.com/feed/',
  kind: 'news',
  region: 'africa',
});
