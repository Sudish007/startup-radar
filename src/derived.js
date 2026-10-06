// Derived data computed once per refresh (plan D7): build-static.js writes the result to dist/data/,
// app.js serves it from a cache keyed on the DB state. Phase 2 adds signals, digest and the Atom feed.

import { EXPORT_LIMITS, itemsPayload } from './export.js';
import { buildFunding } from './funding.js';
import { buildTrends } from './trends.js';
import { buildYcLens } from './yc-lens.js';

export const YC_LENS_LIMIT = 2000;

/** { trends, funding, yc } - trends/funding over the export window, yc over every stored 'yc' item. */
export function buildDerived({ db, sources, env = process.env, now = new Date(), limits = EXPORT_LIMITS }) {
  const { items, archive } = itemsPayload({ db, sources, now, limits });
  const windowItems = archive ? [...items, ...archive] : items;
  const ycItems = db.listItems({ sourceId: 'yc', limit: YC_LENS_LIMIT });
  return {
    trends: buildTrends(windowItems, { now }),
    funding: buildFunding(windowItems, { now }),
    yc: buildYcLens(ycItems, { now }),
  };
}
