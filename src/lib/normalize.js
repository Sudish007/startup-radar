import { classifyKind, classifyRegion } from './classify.js';

const TRACKING_PARAM_RE = /^utm_/i;
const DROP_PARAMS = new Set(['ref', 'fbclid']);

/**
 * Canonical form of a URL used for deduplication.
 * Returns null when the value is not an absolute http(s) URL.
 */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM_RE.test(key) || DROP_PARAMS.has(key.toLowerCase())) {
      u.searchParams.delete(key);
    }
  }
  u.hash = '';

  if (u.pathname !== '/' && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  let out = u.toString();
  // URL serializes an empty query as a bare "?" in some cases; drop it.
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#8217': '\u2019',
  '#8216': '\u2018',
  '#8220': '\u201C',
  '#8221': '\u201D',
  '#8230': '\u2026',
};

export function decodeEntities(str) {
  if (!str) return '';
  return String(str).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    const key = body.toLowerCase();
    if (Object.hasOwn(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
    try {
      if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
    } catch {
      return match;
    }
    return match;
  });
}

/** HTML -> plain text: drop script/style blocks, tags, decode entities, collapse whitespace. */
export function stripHtml(html) {
  if (!html) return '';
  const text = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

/** Cut at the last space before `max` and append an ellipsis when truncated. */
export function truncate(text, max = 300) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}\u2026`;
}

/** Date | string | unix seconds -> ISO 8601 string, or null when unparseable. */
export function toIso(value) {
  if (value == null || value === '') return null;
  let d;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === 'number') {
    // Treat values below 1e12 as unix seconds, otherwise milliseconds.
    d = new Date(value < 1e12 ? value * 1000 : value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{9,13}$/.test(trimmed)) {
      const n = Number(trimmed);
      d = new Date(n < 1e12 ? n * 1000 : n);
    } else {
      d = new Date(trimmed);
    }
  } else {
    return null;
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Raw adapter item -> DB row. Returns null when the item is invalid
 * (empty or overlong title, non-http(s) URL).
 */
export function normalizeItem(raw, source, nowIso) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim() : '';
  if (title.length === 0 || title.length > 300) return null;

  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const urlNorm = normalizeUrl(url);
  if (!urlNorm) return null;

  const summary = truncate(stripHtml(raw.summary ?? ''), 300);
  const extra = raw.extra && typeof raw.extra === 'object' ? raw.extra : {};
  const kind = classifyKind(raw.kind ?? source.kind, title, summary);
  const region = classifyRegion(raw.region ?? source.region, `${title} ${summary} ${extra.location ?? ''}`);
  const publishedAt = toIso(raw.publishedAt) ?? nowIso;

  return {
    url_norm: urlNorm,
    url,
    title,
    summary,
    source_id: source.id,
    kind,
    region,
    published_at: publishedAt,
    fetched_at: nowIso,
    extra_json: JSON.stringify(extra),
  };
}
