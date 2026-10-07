// Derived data: data/digest.json (plan §3.1 item 16). Twelve ISO weeks (oldest first, last = the current,
// partial week); each week lists real items of that week with the metric they are ordered by stated per row.
// Deterministic for a given input: no Date.now(), stable tie-breaks.

import { itemKey } from '../public/filter.js';
import { isoWeekEnd, isoWeekId, isoWeekStart, lastWeeks } from './lib/weeks.js';
import { buildTrends } from './trends.js';

export const DIGEST_WEEKS = 12;
export const MAX_ROUNDS = 10;
export const MAX_LAUNCHES = 10;
export const MAX_TERMS = 15;
export const MAX_HIGHLIGHTS = 5;
export const ROUNDS_METRIC = 'approx. USD at static rates';
export const DIGEST_METHOD =
  'Each week lists the funding items ordered by their headline amount converted to USD at static rates, ' +
  'the launches ordered by Hacker News points or Product Hunt votes, the YC companies whose launch date falls ' +
  `in the week, and the ${MAX_TERMS} terms with the largest rise in that week versus the 4 preceding weeks (trends method). ` +
  'Signal highlights (GitHub stars, Hugging Face trending order) are available for the current week only.';

function byText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function weekOf(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : isoWeekId(new Date(t));
}

function pick(item) {
  return {
    key: itemKey(item.url),
    title: item.title,
    url: item.url,
    source: item.source?.name ?? item.source?.id ?? null,
    publishedAt: item.publishedAt,
  };
}

function launchMetric(item) {
  const extra = item.extra && typeof item.extra === 'object' ? item.extra : {};
  if (typeof extra.points === 'number' && Number.isFinite(extra.points)) return { metric: 'HN points', value: extra.points };
  if (typeof extra.votes === 'number' && Number.isFinite(extra.votes)) return { metric: 'PH votes', value: extra.votes };
  return null;
}

function roundsOf(fundingItems) {
  return fundingItems
    .filter((f) => typeof f.usdApprox === 'number' && Number.isFinite(f.usdApprox))
    .sort((a, b) => b.usdApprox - a.usdApprox || byText(a.title, b.title))
    .slice(0, MAX_ROUNDS)
    .map((f) => ({
      ...pick(f),
      amount: f.funding?.amount ?? null,
      currency: f.funding?.currency ?? null,
      amountText: f.funding?.amountText ?? null,
      stage: f.funding?.stage ?? null,
      usdApprox: f.usdApprox,
      metric: ROUNDS_METRIC,
    }));
}

function launchesOf(items) {
  return items
    .filter((i) => i.kind === 'launch')
    .map((i) => ({ item: i, m: launchMetric(i) }))
    .filter((x) => x.m !== null)
    .sort((a, b) => b.m.value - a.m.value || byText(a.item.title, b.item.title))
    .slice(0, MAX_LAUNCHES)
    .map(({ item, m }) => ({ ...pick(item), metric: m.metric, value: m.value }));
}

function ycNewOf(companies) {
  return companies
    .sort((a, b) => byText(a.launchedAt, b.launchedAt) || byText(a.name, b.name))
    .map((c) => ({ key: c.key, name: c.name, url: c.url, batch: c.batch, oneLiner: c.oneLiner, launchedAt: c.launchedAt }));
}

function signalData(signals, id) {
  const row = (Array.isArray(signals?.signals) ? signals.signals : []).find((s) => s?.id === id);
  return row?.data ?? null;
}

function highlightsOf(signals) {
  const gh = signalData(signals, 'github_new_repos');
  const hf = signalData(signals, 'hf_trending');
  const repos = (Array.isArray(gh?.repos) ? [...gh.repos] : [])
    .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || byText(a.fullName, b.fullName))
    .slice(0, MAX_HIGHLIGHTS)
    .map((r) => ({ fullName: r.fullName, url: r.url, stars: r.stars, label: gh?.label ?? null }));
  const models = (Array.isArray(hf?.models) ? hf.models : [])
    .slice(0, MAX_HIGHLIGHTS)
    .map((m, i) => ({ id: m.id, url: m.url, likes: m.likes, downloads: m.downloads, position: i + 1 }));
  return { repos, models };
}

/**
 * buildDigest({ items, funding, yc, signals, now }) -> { generatedAt, method, weeks: [12 × {
 *   week, from, to, partial, rounds, launches, ycNew, risingTerms, signalHighlights|null }] }
 * `items` = window items (as exported), `funding` = buildFunding() output (or its items array),
 * `yc` = buildYcLens() output (or its companies array), `signals` = runSignals() output or null.
 */
export function buildDigest({ items = [], funding = null, yc = null, signals = null, now = new Date() } = {}) {
  const weeks = lastWeeks(now, DIGEST_WEEKS);
  const current = weeks.at(-1);
  const fundingItems = Array.isArray(funding) ? funding : Array.isArray(funding?.items) ? funding.items : [];
  const companies = Array.isArray(yc) ? yc : Array.isArray(yc?.companies) ? yc.companies : [];

  const itemsByWeek = new Map(weeks.map((w) => [w, []]));
  for (const item of items) {
    const w = weekOf(item.publishedAt);
    if (itemsByWeek.has(w)) itemsByWeek.get(w).push(item);
  }
  const fundingByWeek = new Map(weeks.map((w) => [w, []]));
  for (const f of fundingItems) {
    const w = weekOf(f.publishedAt);
    if (fundingByWeek.has(w)) fundingByWeek.get(w).push(f);
  }
  const ycByWeek = new Map(weeks.map((w) => [w, []]));
  for (const c of companies) {
    const w = weekOf(c.launchedAt);
    if (ycByWeek.has(w)) ycByWeek.get(w).push(c);
  }

  const sortedItems = [...items].sort((a, b) => byText(a.publishedAt, b.publishedAt));

  const out = weeks.map((week) => {
    const end = isoWeekEnd(week);
    const endMs = end.getTime();
    const upTo = sortedItems.filter((i) => {
      const t = Date.parse(i.publishedAt);
      return !Number.isNaN(t) && t <= endMs;
    });
    const terms = buildTrends(upTo, { now: end }).terms.slice(0, MAX_TERMS)
      .map(({ term, kind, thisWeek, priorWeeklyAvg, rise }) => ({ term, kind, thisWeek, priorWeeklyAvg, rise }));
    return {
      week,
      from: isoWeekStart(week).toISOString(),
      to: end.toISOString(),
      partial: week === current,
      rounds: roundsOf(fundingByWeek.get(week)),
      launches: launchesOf(itemsByWeek.get(week)),
      ycNew: ycNewOf(ycByWeek.get(week)),
      risingTerms: terms,
      signalHighlights: week === current ? highlightsOf(signals) : null,
    };
  });

  return { generatedAt: now.toISOString(), method: DIGEST_METHOD, weeks: out };
}
