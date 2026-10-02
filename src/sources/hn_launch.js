import { mapHnHit } from '../lib/hn.js';

const API_URL =
  'https://hn.algolia.com/api/v1/search_by_date?query=%22Launch%20HN%22&tags=story&hitsPerPage=50';
const PREFIX_RE = /^Launch HN:\s*/i;
const BATCH_RE = /\(YC ([WSFX]\d{2})\)/;

/** Algolia hit -> raw item with the "Launch HN:" prefix removed and extra.batch from "(YC S25)". */
export function mapLaunchHit(hit) {
  const raw = mapHnHit(hit);
  raw.title = String(hit.title ?? '').replace(PREFIX_RE, '');
  const batch = BATCH_RE.exec(hit.title ?? '');
  if (batch) raw.extra.batch = batch[1];
  return raw;
}

export default {
  id: 'hn_launch',
  name: 'Hacker News \u2014 Launch HN',
  homepage: 'https://news.ycombinator.com/',
  kind: 'launch',
  region: 'global',
  enabled: () => true,
  requires: null,
  async fetch(ctx) {
    const data = await ctx.http.fetchJson(API_URL, { signal: ctx.signal });
    return (data.hits ?? [])
      .filter((hit) => PREFIX_RE.test(hit.title ?? ''))
      .map(mapLaunchHit);
  },
};
