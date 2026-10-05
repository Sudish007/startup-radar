const META_URL = 'https://yc-oss.github.io/api/meta.json';
const SEASON_RANK = { winter: 0, spring: 1, summer: 2, fall: 3 };
const SLUG_RE = /^(winter|spring|summer|fall)-(\d{4})$/;
const MIN_BATCH_SIZE = 20;
/** Newest real batches fetched per refresh (3 => ~534 companies, ~230 KB slim yc.json; plan §0.1). */
const BATCH_COUNT = 3;

/**
 * Pick the newest `n` real batches from meta.json's `batches` map.
 * Returns [slug, apiUrl] pairs; tiny placeholder batches (count < 20) are ignored.
 */
export function pickNewestBatches(batchesMap, n = BATCH_COUNT) {
  const ranked = [];
  for (const [slug, info] of Object.entries(batchesMap ?? {})) {
    const m = SLUG_RE.exec(slug);
    if (!m) continue;
    if (!info || typeof info.api !== 'string') continue;
    if ((info.count ?? 0) < MIN_BATCH_SIZE) continue;
    const rank = Number(m[2]) * 4 + SEASON_RANK[m[1]];
    ranked.push({ slug, api: info.api, rank });
  }
  ranked.sort((a, b) => b.rank - a.rank);
  return ranked.slice(0, n).map((b) => [b.slug, b.api]);
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function stringOrOmit(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function numberOrOmit(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * YC company -> raw adapter item. `extra` keeps the slim lens fields only (plan §0.1);
 * `long_description` is used as a summary fallback and never stored.
 */
export function mapYcCompany(company) {
  const slug = company.slug;
  const launchedMs = numberOrOmit(company.launched_at) ? company.launched_at * 1000 : null;
  const tags = Array.isArray(company.tags) ? company.tags.filter((t) => typeof t === 'string' && t !== '').slice(0, 5) : [];
  return {
    title: company.name,
    url: company.url || `https://www.ycombinator.com/companies/${slug}`,
    summary: company.one_liner || company.long_description || '',
    publishedAt: launchedMs,
    extra: compact({
      batch: stringOrOmit(company.batch),
      website: stringOrOmit(company.website),
      location: stringOrOmit(company.all_locations),
      industry: stringOrOmit(company.industry),
      subindustry: stringOrOmit(company.subindustry),
      tags: tags.length ? tags : undefined,
      teamSize: numberOrOmit(company.team_size),
      status: stringOrOmit(company.status),
      stage: stringOrOmit(company.stage),
      launchedAt: launchedMs ? new Date(launchedMs).toISOString() : undefined,
      oneLiner: stringOrOmit(company.one_liner),
    }),
  };
}

export default {
  id: 'yc',
  name: 'Y Combinator \u2014 newest batches',
  homepage: 'https://www.ycombinator.com/companies',
  kind: 'accelerator',
  region: 'usa',
  enabled: () => true,
  requires: null,
  async fetch(ctx) {
    const meta = await ctx.http.fetchJson(META_URL, { signal: ctx.signal });
    const picked = pickNewestBatches(meta.batches, BATCH_COUNT);
    if (picked.length === 0) throw new Error('no YC batches found in meta.json');
    const lists = await Promise.all(picked.map(([, api]) => ctx.http.fetchJson(api, { signal: ctx.signal })));
    return lists.flat().map(mapYcCompany);
  },
};
