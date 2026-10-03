// Startup Radar client-side filtering. DOM-free ES module shared by
// public/app.js and test/filter.test.js; mirrors the server's /api/items
// semantics (kind, region incl. the "world" scope, sources, since, word /
// word-prefix search over title + summary, newest-first ordering).

export const SINCE_VALUES = new Set(['today', '7d', '30d', '']);

/** Chip value -> ISO lower bound. today = UTC midnight, 7d/30d = now - N days, '' = null. */
export function sinceToIso(since, now = new Date()) {
  if (since === 'today') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return d.toISOString();
  }
  if (since === '7d') return new Date(now.getTime() - 7 * 86_400_000).toISOString();
  if (since === '30d') return new Date(now.getTime() - 30 * 86_400_000).toISOString();
  return null;
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * Lowercase word tokens. Diacritics are folded (e.g. "café" -> "cafe") like the
 * server's FTS5 unicode61 tokenizer does, so the client and server agree.
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return [];
  const folded = text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
  return folded.match(TOKEN_RE) ?? [];
}

/** Same cap as buildFtsQuery() in src/db.js. */
export const MAX_QUERY_TOKENS = 8;

/** Query text -> at most MAX_QUERY_TOKENS tokens (what the server's MATCH expression uses). */
export function queryTokens(q) {
  return tokenize(q).slice(0, MAX_QUERY_TOKENS);
}

const tokenCache = new WeakMap();

function itemTokens(item) {
  let tokens = tokenCache.get(item);
  if (!tokens) {
    tokens = [...new Set(tokenize(`${item.title ?? ''} ${item.summary ?? ''}`))];
    tokenCache.set(item, tokens);
  }
  return tokens;
}

/**
 * Every query token must be a whole word or a word prefix in the item's title or
 * summary ("show" matches "showcase", "ai" does not match "rain"). Mirrors the
 * server's FTS5 `"token"*` prefix MATCH with implicit AND.
 */
export function matchesQuery(item, qTokens) {
  if (!qTokens || qTokens.length === 0) return true;
  const have = itemTokens(item);
  return qTokens.every((t) => have.some((w) => w.startsWith(t)));
}

/** publishedAt desc (ISO strings compare like the server's TEXT column), then id desc. */
export function compareNewestFirst(a, b) {
  const ta = String(a.publishedAt ?? '');
  const tb = String(b.publishedAt ?? '');
  if (ta !== tb) return ta < tb ? 1 : -1;
  return (Number(b.id) || 0) - (Number(a.id) || 0);
}

/**
 * Apply { kind, region, sources, q, since } to `items` and return a new array
 * sorted newest first. `region === 'world'` means every region except 'usa';
 * `sources` is an array of source ids (empty = all); `since` is a SINCE_VALUES entry.
 */
export function filterItems(items, { kind = '', region = '', sources = [], q = '', since = '' } = {}, now = new Date()) {
  const sinceIso = SINCE_VALUES.has(since) ? sinceToIso(since, now) : null;
  const sourceSet = Array.isArray(sources) && sources.length > 0 ? new Set(sources) : null;
  const qTokens = queryTokens(q);

  const out = [];
  for (const item of items) {
    if (kind && item.kind !== kind) continue;
    if (region === 'world') {
      if (item.region === 'usa') continue;
    } else if (region && item.region !== region) {
      continue;
    }
    if (sourceSet && !sourceSet.has(item.source?.id)) continue;
    if (sinceIso && !(String(item.publishedAt ?? '') >= sinceIso)) continue;
    if (qTokens.length > 0 && !matchesQuery(item, qTokens)) continue;
    out.push(item);
  }
  return out.sort(compareNewestFirst);
}

// ---------- identity and honest sorting (UI redesign) ----------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const utf8 = new TextEncoder();

/**
 * Stable identity of an item across builds: 64-bit FNV-1a of the UTF-8 bytes of
 * `String(url ?? '')`, rendered in base 36 (1-13 characters). Numeric ids are
 * per-build SQLite rowids on the static host, so the unique `url` is the key.
 * Pure: never throws, coerces non-strings, same input -> same output.
 */
export function itemKey(url) {
  const bytes = utf8.encode(String(url ?? ''));
  let hash = FNV_OFFSET;
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(36);
}

/** Hacker News points, else Product Hunt votes, else null (only finite numbers count). */
export function pointsOf(item) {
  const extra = item?.extra;
  if (!extra || typeof extra !== 'object') return null;
  if (typeof extra.points === 'number' && Number.isFinite(extra.points)) return extra.points;
  if (typeof extra.votes === 'number' && Number.isFinite(extra.votes)) return extra.votes;
  return null;
}

/** Items with a points/votes value first (descending); ties and the no-value tail fall back to newest-first. */
export function comparePoints(a, b) {
  const pa = pointsOf(a);
  const pb = pointsOf(b);
  if (pa !== null && pb !== null && pa !== pb) return pb - pa;
  if (pa !== null && pb === null) return -1;
  if (pa === null && pb !== null) return 1;
  return compareNewestFirst(a, b);
}

/** `'points'` -> a stable re-sort by comparePoints (new array); any other value keeps the input order. */
export function sortItems(items, sort) {
  if (sort === 'points') return [...items].sort(comparePoints);
  return items;
}
