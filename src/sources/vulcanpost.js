import { makeRssSource } from '../lib/rss.js';

// Occasionally slow (up to ~24 s observed); the 15 s per-source timeout isolates it.
export default makeRssSource({
  id: 'vulcanpost',
  name: 'Vulcan Post',
  homepage: 'https://vulcanpost.com/',
  feedUrl: 'https://vulcanpost.com/feed/',
  kind: 'news',
  region: 'asia',
});
