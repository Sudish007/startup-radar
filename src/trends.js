// Derived data: data/trends.json (plan §2.1 item 5). Pure function over the 90-day window items.
// Every number is a real count of items; "rise" is this week's item count minus the prior-4-week
// weekly average. Nothing here is a score.

import { itemKey } from '../public/filter.js';
import { KIND_LABELS, REGION_LABELS } from '../public/format.js';
import { bigrams, significantTokens } from '../public/text.js';
import { KINDS, REGIONS } from './lib/classify.js';
import { SECTORS, tagSectors } from './lib/sectors.js';
import { isoWeekEnd, isoWeekId, isoWeekStart, lastWeeks } from './lib/weeks.js';

export const TRENDS_WEEKS = 12;
export const PRIOR_WEEKS = 4;
export const MIN_SUPPORT = 5;
export const MAX_TERMS = 60;
export const MAX_EXAMPLES = 5;

export const TRENDS_METHOD =
  'Each term is a word or adjacent word pair from item titles and summaries (stopwords removed); ' +
  `"this week" counts items in the current ISO week that mention it at least once (minimum ${MIN_SUPPORT}), ` +
  `"prior" is the average per week over the ${PRIOR_WEEKS} preceding ISO weeks, and rise is their difference.`;

/** Distinct terms (tokens + bigrams) of one item. */
export function itemTerms(item) {
  const terms = new Set();
  for (const field of [item.title, item.summary]) {
    const tokens = significantTokens(field ?? '');
    for (const t of tokens) terms.add(`t:${t}`);
    for (const b of bigrams(tokens)) terms.add(`b:${b}`);
  }
  return terms;
}

function emptySeries(n) {
  return Array.from({ length: n }, () => 0);
}

function sectorsOf(item) {
  return Array.isArray(item.sectors) ? item.sectors : tagSectors(item.title, item.summary);
}

/**
 * buildTrends(items, { now }) -> {
 *   generatedAt, method, thisWeek: { id, from, to, partial: true }, prior: { from, to, weeks: 4 },
 *   terms: [{ term, kind: 'token'|'bigram', thisWeek, priorWeeklyAvg, rise, ratio|null, examples: [itemKey, ...] }],
 *   weeks: [12 ids, oldest first, last = current (partial) week], partialWeek: id,
 *   bySector: [{ id, label, counts: [12] }], byKind: [{ id, label, counts }], byRegion: [{ id, label, counts }],
 *   items: number }
 */
export function buildTrends(items, { now = new Date() } = {}) {
  const weeks = lastWeeks(now, TRENDS_WEEKS);
  const weekIndex = new Map(weeks.map((id, i) => [id, i]));
  const currentId = weeks.at(-1);
  const priorIds = new Set(weeks.slice(-1 - PRIOR_WEEKS, -1));

  const bySector = new Map(SECTORS.map((s) => [s.id, emptySeries(weeks.length)]));
  const byKind = new Map(KINDS.map((k) => [k, emptySeries(weeks.length)]));
  const byRegion = new Map(REGIONS.map((r) => [r, emptySeries(weeks.length)]));

  // term -> { thisWeek, prior, examples }
  const termStats = new Map();

  for (const item of items) {
    const t = Date.parse(item.publishedAt);
    if (Number.isNaN(t)) continue;
    const weekId = isoWeekId(new Date(t));
    const wi = weekIndex.get(weekId);
    if (wi !== undefined) {
      for (const id of sectorsOf(item)) {
        const series = bySector.get(id);
        if (series) series[wi] += 1;
      }
      if (byKind.has(item.kind)) byKind.get(item.kind)[wi] += 1;
      if (byRegion.has(item.region)) byRegion.get(item.region)[wi] += 1;
    }

    const inCurrent = weekId === currentId;
    const inPrior = priorIds.has(weekId);
    if (!inCurrent && !inPrior) continue;
    for (const term of itemTerms(item)) {
      let s = termStats.get(term);
      if (!s) {
        s = { thisWeek: 0, prior: 0, examples: [] };
        termStats.set(term, s);
      }
      if (inCurrent) {
        s.thisWeek += 1;
        if (s.examples.length < MAX_EXAMPLES) s.examples.push(itemKey(item.url));
      } else {
        s.prior += 1;
      }
    }
  }

  const terms = [];
  for (const [key, s] of termStats) {
    if (s.thisWeek < MIN_SUPPORT) continue;
    const priorWeeklyAvg = s.prior / PRIOR_WEEKS;
    terms.push({
      term: key.slice(2),
      kind: key.startsWith('b:') ? 'bigram' : 'token',
      thisWeek: s.thisWeek,
      priorWeeklyAvg: Math.round(priorWeeklyAvg * 100) / 100,
      rise: Math.round((s.thisWeek - priorWeeklyAvg) * 100) / 100,
      ratio: priorWeeklyAvg > 0 ? Math.round((s.thisWeek / priorWeeklyAvg) * 100) / 100 : null,
      examples: s.examples,
    });
  }
  terms.sort((a, b) => {
    if (b.rise !== a.rise) return b.rise - a.rise;
    const ra = a.ratio ?? Number.POSITIVE_INFINITY; // never seen before this week sorts first among equal rises
    const rb = b.ratio ?? Number.POSITIVE_INFINITY;
    if (rb !== ra) return rb - ra;
    return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
  });

  const priorFirst = weeks[weeks.length - 1 - PRIOR_WEEKS];
  const priorLast = weeks[weeks.length - 2];
  return {
    generatedAt: now.toISOString(),
    method: TRENDS_METHOD,
    thisWeek: { id: currentId, from: isoWeekStart(currentId).toISOString(), to: isoWeekEnd(currentId).toISOString(), partial: true },
    prior: { from: isoWeekStart(priorFirst).toISOString(), to: isoWeekEnd(priorLast).toISOString(), weeks: PRIOR_WEEKS },
    terms: terms.slice(0, MAX_TERMS),
    weeks,
    partialWeek: currentId,
    bySector: SECTORS.map((s) => ({ id: s.id, label: s.label, counts: bySector.get(s.id) })),
    byKind: KINDS.map((k) => ({ id: k, label: KIND_LABELS[k], counts: byKind.get(k) })),
    byRegion: REGIONS.map((r) => ({ id: r, label: REGION_LABELS[r], counts: byRegion.get(r) })),
    items: items.length,
  };
}
