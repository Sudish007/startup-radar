// Derived data: data/yc.json (plan §2.1 item 5, §0.1). Built from every stored 'yc' item (not the
// 90-day window: older batches' launched_at falls outside it). Slim fields only - never long_description.

import { itemKey } from '../public/filter.js';

export const YC_ATTRIBUTION =
  'Source: yc-oss open API mirror of ycombinator.com. This page is rebuilt on an hourly schedule; GitHub runs it a few times a day in practice - see the generated time above.';
export const TEAM_SIZE_BUCKETS = ['1', '2-5', '6-10', '11-25', '26-50', '51+', 'unknown'];
export const MAX_TAGS = 40;

const SEASON_RANK = { winter: 0, spring: 1, summer: 2, fall: 3 };

/** 'Fall 2026' -> 2026*4+3; unknown strings rank lowest. */
export function batchRank(batch) {
  const m = /^(winter|spring|summer|fall)\s+(\d{4})$/i.exec(String(batch ?? '').trim());
  if (!m) return -1;
  return Number(m[2]) * 4 + SEASON_RANK[m[1].toLowerCase()];
}

export function teamSizeBucket(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return 'unknown';
  if (n <= 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 10) return '6-10';
  if (n <= 25) return '11-25';
  if (n <= 50) return '26-50';
  return '51+';
}

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** API item from the yc adapter -> lens company row. */
export function toCompany(item) {
  const extra = item.extra && typeof item.extra === 'object' ? item.extra : {};
  return {
    key: itemKey(item.url),
    name: item.title,
    url: item.url,
    website: str(extra.website),
    oneLiner: str(extra.oneLiner) ?? str(item.summary),
    batch: str(extra.batch),
    status: str(extra.status),
    stage: str(extra.stage),
    industry: str(extra.industry),
    subindustry: str(extra.subindustry),
    tags: Array.isArray(extra.tags) ? extra.tags.filter((t) => typeof t === 'string') : [],
    teamSize: typeof extra.teamSize === 'number' && Number.isFinite(extra.teamSize) ? extra.teamSize : null,
    location: str(extra.location),
    launchedAt: str(extra.launchedAt) ?? str(item.publishedAt),
  };
}

function countBy(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

function sortedRows(counts, key) {
  return [...counts.entries()]
    .map(([value, count]) => ({ [key]: value, count }))
    .sort((a, b) => b.count - a.count || (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}

/**
 * buildYcLens(ycItems, { now }) -> {
 *   generatedAt, attribution, batches: [{ batch, count }] newest first,
 *   companies: [{ key, name, url, website, oneLiner, batch, status, stage, industry, subindustry, tags, teamSize, location, launchedAt }],
 *   byIndustry: [{ industry, count }], tagFrequency: [{ tag, count }] (top 40),
 *   teamSize: { buckets: ['1','2-5','6-10','11-25','26-50','51+','unknown'], counts: [7] },
 *   byStatus: [{ status, count }] }
 */
export function buildYcLens(ycItems, { now = new Date() } = {}) {
  const companies = ycItems.map(toCompany);

  const batches = sortedRows(countBy(companies.map((c) => c.batch ?? 'unknown')), 'batch')
    .sort((a, b) => batchRank(b.batch) - batchRank(a.batch) || b.count - a.count);

  const bucketCounts = TEAM_SIZE_BUCKETS.map(() => 0);
  for (const c of companies) bucketCounts[TEAM_SIZE_BUCKETS.indexOf(teamSizeBucket(c.teamSize))] += 1;

  return {
    generatedAt: now.toISOString(),
    attribution: YC_ATTRIBUTION,
    batches,
    companies,
    byIndustry: sortedRows(countBy(companies.map((c) => c.industry ?? 'unknown')), 'industry'),
    tagFrequency: sortedRows(countBy(companies.flatMap((c) => c.tags)), 'tag').slice(0, MAX_TAGS),
    teamSize: { buckets: TEAM_SIZE_BUCKETS, counts: bucketCounts },
    byStatus: sortedRows(countBy(companies.map((c) => c.status ?? 'unknown')), 'status'),
  };
}
