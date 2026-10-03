// Startup Radar formatting helpers. DOM-free ES module shared by public/app.js,
// public/sources.js, public/radar.js and test/format.test.js. Nothing here
// touches `document` or `window`, so it can be imported from Node.

export const KIND_LABELS = {
  launch: 'Launch',
  funding: 'Funding',
  news: 'News',
  accelerator: 'Accelerator',
};

export const REGION_LABELS = {
  usa: 'USA',
  europe: 'Europe',
  asia: 'Asia',
  india: 'India',
  latam: 'Latin America',
  africa: 'Africa',
  global: 'Global',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || String(kind ?? '');
}

export function regionLabel(region) {
  return REGION_LABELS[region] || String(region ?? '');
}

/** "just now", "12 min ago", "3 h ago", "5 d ago", a locale date beyond 30 days or for future dates. */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffSec = Math.round((now - t) / 1000);
  // A source-supplied date in the future is shown as-is rather than as "just now".
  if (diffSec < 0) return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (diffSec < 60) return 'just now';
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Local absolute time via toLocaleString(); '' for unparsable input. */
export function absoluteTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString();
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

/** `n` with the right noun: pluralize(1, 'item', 'items') -> "1 item". */
export function pluralize(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

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
  if (!safe) return 'unknown host';
  return new URL(safe).hostname.replace(/^www\./, '');
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function batchText(batch) {
  return /^yc\b/i.test(batch) ? batch : `YC ${batch}`;
}

/**
 * Card metadata parts joined with " · " by the caller: HN points/comments,
 * PH votes, YC batch (+ location), Crunchbase round/amount, author.
 */
export function metaParts(extra) {
  const parts = [];
  if (!extra || typeof extra !== 'object') return parts;
  if (finite(extra.points)) {
    let s = `${extra.points} points`;
    if (finite(extra.comments)) s += ` \u00b7 ${extra.comments} comments`;
    parts.push(s);
  } else if (finite(extra.comments)) {
    parts.push(`${extra.comments} comments`);
  }
  if (finite(extra.votes)) parts.push(`${extra.votes} votes`);
  if (nonEmpty(extra.batch)) {
    parts.push(batchText(extra.batch));
    if (nonEmpty(extra.location)) parts.push(extra.location);
  }
  if (nonEmpty(extra.investmentType) || finite(extra.moneyRaisedUsd)) {
    const bits = [];
    if (nonEmpty(extra.investmentType)) bits.push(String(extra.investmentType).replace(/_/g, ' '));
    if (finite(extra.moneyRaisedUsd)) bits.push(`$${compactMoney(extra.moneyRaisedUsd)}`);
    parts.push(bits.join(' \u00b7 '));
  }
  if (nonEmpty(extra.author)) parts.push(`by ${extra.author}`);
  return parts;
}

/** The Hacker News discussion URL when it exists and differs from the item's own url, else null. */
export function hnDiscussion(item) {
  const hn = safeHttpUrl(item?.extra?.hnUrl);
  if (!hn) return null;
  return hn === safeHttpUrl(item?.url) ? null : hn;
}

/**
 * Rows for the detail drawer's description list, only for fields that exist:
 * Array<{ label, value, href? }> (`href` only on the Source and Website rows).
 */
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
  if (finite(extra.points)) rows.push({ label: 'HN points', value: String(extra.points) });
  if (finite(extra.comments)) rows.push({ label: 'HN comments', value: String(extra.comments) });
  if (nonEmpty(extra.author)) rows.push({ label: 'HN author', value: extra.author });
  if (finite(extra.votes)) rows.push({ label: 'PH votes', value: String(extra.votes) });
  if (nonEmpty(extra.batch)) rows.push({ label: 'YC batch', value: batchText(extra.batch) });
  if (nonEmpty(extra.location)) rows.push({ label: 'Location', value: extra.location });
  if (nonEmpty(extra.industry)) rows.push({ label: 'Industry', value: extra.industry });
  if (nonEmpty(extra.teamSize) || finite(extra.teamSize)) rows.push({ label: 'Team size', value: String(extra.teamSize) });
  if (nonEmpty(extra.status)) rows.push({ label: 'Status', value: extra.status });
  if (nonEmpty(extra.investmentType)) rows.push({ label: 'Round type', value: String(extra.investmentType).replace(/_/g, ' ') });
  if (finite(extra.moneyRaisedUsd)) rows.push({ label: 'Amount', value: `$${compactMoney(extra.moneyRaisedUsd)}` });
  if (nonEmpty(extra.organization)) rows.push({ label: 'Organization', value: extra.organization });
  const website = safeHttpUrl(extra.website);
  if (website && website !== url) rows.push({ label: 'Website', value: hostnameOf(website), href: website });
  return rows;
}
