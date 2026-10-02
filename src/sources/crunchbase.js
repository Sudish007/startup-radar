// Crunchbase API v4 (keyed; only runs when CRUNCHBASE_API_KEY is set).
// Response shape follows the v4 docs (`entities[].properties`) and is NOT
// live-verified: the endpoint answered 401 "LA401 Unauthorized user_key"
// without a key during verification (2026-10-02). Never scraped.
const SEARCH_URL = 'https://api.crunchbase.com/api/v4/searches/funding_rounds';
const FIELD_IDS = ['identifier', 'announced_on', 'investment_type', 'money_raised', 'funded_organization_identifier'];

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

/** 1500000 -> "1.5M", 20000000 -> "20M", 1200000000 -> "1.2B". */
export function compactMoney(n) {
  const units = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [div, suffix] of units) {
    if (n >= div) {
      const v = n / div;
      return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${suffix}`;
    }
  }
  return String(n);
}

/** v4 search entity -> raw item. */
export function mapFundingRound(entity) {
  const p = entity.properties ?? {};
  const org = p.funded_organization_identifier?.value ?? 'Unknown company';
  const type = p.investment_type ?? 'funding round';
  const money = p.money_raised?.value_usd;
  const permalink = p.identifier?.permalink ?? entity.uuid ?? p.identifier?.uuid;
  return {
    title: money ? `${org} raises $${compactMoney(money)} (${type})` : `${org} \u2014 ${type}`,
    url: `https://www.crunchbase.com/funding_round/${permalink}`,
    summary: '',
    publishedAt: p.announced_on ?? null,
    extra: compact({
      moneyRaisedUsd: money,
      currency: p.money_raised?.currency,
      investmentType: type,
      organization: org,
    }),
  };
}

export default {
  id: 'crunchbase',
  name: 'Crunchbase \u2014 funding rounds (API)',
  homepage: 'https://www.crunchbase.com/',
  kind: 'funding',
  region: 'global',
  enabled: (env) => Boolean(env.CRUNCHBASE_API_KEY),
  requires: 'CRUNCHBASE_API_KEY',
  async fetch(ctx) {
    const body = await ctx.http.fetchJson(SEARCH_URL, {
      method: 'POST',
      headers: {
        'X-cb-user-key': ctx.env.CRUNCHBASE_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        field_ids: FIELD_IDS,
        order: [{ field_id: 'announced_on', sort: 'desc' }],
        limit: 50,
      }),
      signal: ctx.signal,
    });
    return (body.entities ?? []).map(mapFundingRound);
  },
};
