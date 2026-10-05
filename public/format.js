// Startup Radar formatting helpers. DOM-free ES module shared by app.js,
// sources.js, radar.js and test/format.test.js (importable from Node).

export const KIND_LABELS = { launch: 'Launch', funding: 'Funding', news: 'News', accelerator: 'Accelerator' };
export const REGION_LABELS = { usa: 'USA', europe: 'Europe', asia: 'Asia', india: 'India', latam: 'Latin America', africa: 'Africa', global: 'Global' };

export const kindLabel = (kind) => KIND_LABELS[kind] || String(kind ?? '');
export const regionLabel = (region) => REGION_LABELS[region] || String(region ?? '');

/** Honesty wording, stated once for every page (plan D12): how a derived value was obtained. */
export const METHOD_LABELS = {
  sectors: 'keyword-tagged',
  headline: 'parsed from headline',
  summary: 'parsed from summary',
  usd: 'approx. USD at static rates \u2014 see table',
  related: 'token overlap in the 90-day window',
};

/** stats.sectors [{ id, label, count }] -> { id: label } (ids travel on items, labels once in stats.json). */
export function sectorLabels(stats) {
  const out = {};
  for (const s of Array.isArray(stats?.sectors) ? stats.sectors : []) {
    if (s && typeof s.id === 'string' && typeof s.label === 'string') out[s.id] = s.label;
  }
  return out;
}

const localeDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** "just now", "12 min ago", "3 h ago", "5 d ago"; a locale date beyond 30 days and for future dates. */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffSec = Math.round((now - t) / 1000);
  if (diffSec < 0) return localeDate(t);
  if (diffSec < 60) return 'just now';
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return localeDate(t);
}

export function absoluteTime(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString();
}

/** 1500 -> "1.5K", 12000000 -> "12M", 2.5e9 -> "2.5B"; '' for non-finite input. */
export function compactMoney(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ''));
  if (n >= 1e9) return `${fmt(n / 1e9)}B`;
  if (n >= 1e6) return `${fmt(n / 1e6)}M`;
  if (n >= 1e3) return `${fmt(n / 1e3)}K`;
  return String(n);
}

export const pluralize = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The string parsed as an http(s) URL, else null (rejects javascript:, data:, relative and malformed input). */
export function safeHttpUrl(s) {
  if (typeof s !== 'string' || s === '') return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Hostname without a leading "www."; "unknown host" when the URL does not parse. */
export function hostnameOf(url) {
  const safe = safeHttpUrl(url);
  return safe ? new URL(safe).hostname.replace(/^www\./, '') : 'unknown host';
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const batchText = (batch) => (/^yc\b/i.test(batch) ? batch : `YC ${batch}`);
const roundText = (v) => String(v).replace(/_/g, ' ');

export const pointsText = (n) => pluralize(n, 'point', 'points');
export const commentsText = (n) => pluralize(n, 'comment', 'comments');
export const votesText = (n) => pluralize(n, 'vote', 'votes');

/** Card metadata parts: points/comments, votes, batch + location, Crunchbase round/amount, author (counts pluralised). */
export function metaParts(extra) {
  const parts = [];
  if (!extra || typeof extra !== 'object') return parts;
  if (finite(extra.points)) parts.push(`${pointsText(extra.points)}${finite(extra.comments) ? ` \u00b7 ${commentsText(extra.comments)}` : ''}`);
  else if (finite(extra.comments)) parts.push(commentsText(extra.comments));
  if (finite(extra.votes)) parts.push(votesText(extra.votes));
  if (nonEmpty(extra.batch)) {
    parts.push(batchText(extra.batch));
    if (nonEmpty(extra.location)) parts.push(extra.location);
  }
  if (nonEmpty(extra.investmentType) || finite(extra.moneyRaisedUsd)) {
    parts.push([nonEmpty(extra.investmentType) ? roundText(extra.investmentType) : null, finite(extra.moneyRaisedUsd) ? `$${compactMoney(extra.moneyRaisedUsd)}` : null].filter(Boolean).join(' \u00b7 '));
  }
  if (nonEmpty(extra.author)) parts.push(`by ${extra.author}`);
  return parts;
}

/** The Hacker News discussion URL when it exists and differs from the item's own url, else null. */
export function hnDiscussion(item) {
  const hn = safeHttpUrl(item?.extra?.hnUrl);
  return hn && hn !== safeHttpUrl(item?.url) ? hn : null;
}

const HN_LABELS = { points: 'HN points', comments: 'HN comments', author: 'HN author' };

/** Drawer row label: source-branded wording only for that source (hn_* -> "HN author", producthunt -> "PH votes"), else generic. */
export function rowLabel(field, generic, sourceId) {
  const id = String(sourceId ?? '');
  if (id.startsWith('hn_') && HN_LABELS[field]) return HN_LABELS[field];
  if (id === 'producthunt' && field === 'votes') return 'PH votes';
  return generic;
}

// [extra field, generic row label, formatter]; emitted only for a non-empty string or finite number.
const EXTRA_ROWS = [
  ['points', 'Points'], ['comments', 'Comments'], ['author', 'Author'], ['votes', 'Votes'],
  ['batch', 'Batch', batchText], ['location', 'Location'], ['industry', 'Industry'], ['teamSize', 'Team size'], ['status', 'Status'],
  ['investmentType', 'Round type', roundText], ['moneyRaisedUsd', 'Amount', (v) => `$${compactMoney(v)}`], ['organization', 'Organization'],
];

/** Detail-drawer rows for present fields: Array<{ label, value, href? }> (href only on Source and Website). */
export function detailRows(item) {
  const rows = [];
  const extra = item?.extra && typeof item.extra === 'object' ? item.extra : {};
  const url = safeHttpUrl(item?.url);
  if (url) rows.push({ label: 'Destination', value: hostnameOf(url) });
  const sourceName = item?.source?.name || item?.source?.id;
  if (nonEmpty(sourceName)) rows.push({ label: 'Source', value: sourceName, href: './sources.html' });
  if (nonEmpty(item?.kind)) rows.push({ label: 'Kind', value: kindLabel(item.kind) });
  if (nonEmpty(item?.region)) rows.push({ label: 'Region', value: regionLabel(item.region) });
  if (nonEmpty(item?.publishedAt) && absoluteTime(item.publishedAt)) rows.push({ label: 'Published', value: absoluteTime(item.publishedAt) });
  for (const [field, generic, fmt] of EXTRA_ROWS) {
    const v = extra[field];
    if (nonEmpty(v) || finite(v)) rows.push({ label: rowLabel(field, generic, item?.source?.id), value: fmt ? fmt(v) : String(v) });
  }
  const website = safeHttpUrl(extra.website);
  if (website && website !== url) rows.push({ label: 'Website', value: hostnameOf(website), href: website });
  return rows;
}
