// Related items for the drawer (plan 2.2 item 8b; loaded lazily on the first drawer open). DOM-free:
// significant-token overlap over the loaded 90-day window, the same tokens src/trends.js counts.

import { compareNewestFirst } from './filter.js';
import { significantTokens } from './text.js';

export const MIN_SHARED = 2; // shared significant words that make two items related on their own
export const RELATED_METHOD = 'method: token overlap (\u2265 2 shared significant words, or a shared sector + 1 word) over the loaded 90-day window';

const tokenCache = new WeakMap();

/** Unique significant tokens of title + summary, cached per item object. */
export function tokensOf(item) {
  let set = tokenCache.get(item);
  if (!set) {
    set = new Set(significantTokens(`${item.title ?? ''} ${item.summary ?? ''}`));
    tokenCache.set(item, set);
  }
  return set;
}

/** Number of shared significant tokens. */
export function sharedCount(a, b) {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let n = 0;
  for (const t of small) if (large.has(t)) n += 1;
  return n;
}

const sharesSector = (a, b) => Array.isArray(a.sectors) && Array.isArray(b.sectors) && a.sectors.some((s) => b.sectors.includes(s));

/**
 * relatedItems(item, all, { max }) -> { count, items }: `count` is every related item in `all` (honest number),
 * `items` the first `max` sorted by shared tokens desc, newest first. Related = >= MIN_SHARED shared tokens, or a
 * shared sector and >= 1 shared token. The item itself (same object or same key) is excluded.
 */
export function relatedItems(item, all, { max = 5 } = {}) {
  const url = String(item.url ?? ''); // itemKey() hashes the url, so equal urls = equal keys
  const hits = [];
  for (const other of all) {
    if (other === item || String(other.url ?? '') === url) continue;
    const shared = sharedCount(item, other);
    if (shared >= MIN_SHARED || (shared >= 1 && sharesSector(item, other))) hits.push({ item: other, shared });
  }
  hits.sort((a, b) => b.shared - a.shared || compareNewestFirst(a.item, b.item));
  return { count: hits.length, items: hits.slice(0, max).map((h) => h.item) };
}
