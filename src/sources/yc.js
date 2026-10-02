const META_URL = 'https://yc-oss.github.io/api/meta.json';
const SEASON_RANK = { winter: 0, spring: 1, summer: 2, fall: 3 };
const SLUG_RE = /^(winter|spring|summer|fall)-(\d{4})$/;
const MIN_BATCH_SIZE = 20;

/**
 * Pick the newest `n` real batches from meta.json's `batches` map.
 * Returns [slug, apiUrl] pairs; tiny placeholder batches (count < 20) are ignored.
 */
export function pickNewestBatches(batchesMap, n = 2) {
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

export function mapYcCompany(company) {
  const slug = company.slug;
  return {
    title: company.name,
    url: company.url || `https://www.ycombinator.com/companies/${slug}`,
    summary: company.one_liner || company.long_description || '',
    publishedAt: company.launched_at ? company.launched_at * 1000 : null,
    extra: {
      batch: company.batch,
      website: company.website,
      location: company.all_locations,
      industry: company.industry,
      teamSize: company.team_size,
      status: company.status,
    },
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
    const picked = pickNewestBatches(meta.batches, 2);
    if (picked.length === 0) throw new Error('no YC batches found in meta.json');
    const lists = await Promise.all(picked.map(([, api]) => ctx.http.fetchJson(api, { signal: ctx.signal })));
    return lists.flat().map(mapYcCompany);
  },
};
