// Derived data computed once per refresh (plan D7): build-static.js writes the result to dist/data/,
// app.js serves it from a cache keyed on the DB state. Phase 2 adds signals, digest and the Atom feed.

import { buildDigest } from './digest.js';
import { EXPORT_LIMITS, itemsPayload } from './export.js';
import { buildAtom } from './feed-xml.js';
import { buildFunding } from './funding.js';
import { EMPTY_SIGNALS } from './signals/run.js';
import { buildTrends } from './trends.js';
import { buildYcLens } from './yc-lens.js';

export const YC_LENS_LIMIT = 2000;

/**
 * { trends, funding, yc, signals, digest, feedXml } - trends/funding over the export window, yc over every
 * stored 'yc' item; `signals` is the latest runSignals() payload (passed in, or db.kvGet('signals'), or the
 * empty shape), digest/feedXml are built from the other four.
 */
export function buildDerived({ db, sources, env = process.env, now = new Date(), limits = EXPORT_LIMITS, signals, publicUrl }) {
  const { items, archive } = itemsPayload({ db, sources, now, limits });
  const windowItems = archive ? [...items, ...archive] : items;
  const ycItems = db.listItems({ sourceId: 'yc', limit: YC_LENS_LIMIT });
  const trends = buildTrends(windowItems, { now });
  const funding = buildFunding(windowItems, { now });
  const yc = buildYcLens(ycItems, { now });
  const signalsPayload = signals ?? db.kvGet?.('signals') ?? EMPTY_SIGNALS;
  const digest = buildDigest({ items: windowItems, funding, yc, signals: signalsPayload, now });
  const base = (typeof publicUrl === 'string' && publicUrl.trim()) || env.PUBLIC_URL?.trim() || 'http://localhost:3000';
  return { trends, funding, yc, signals: signalsPayload, digest, feedXml: buildAtom({ digest, publicUrl: base, now }) };
}
