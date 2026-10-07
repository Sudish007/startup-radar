// Derived data: data/funding.json (plan §2.1 item 5, D6). Items of kind 'funding' from the 90-day
// window, unchanged (the drawer renders them as-is) plus `funding` (parsed from headline) and
// `usdApprox` (static FX table, sorting/sums only). Totals state their coverage: `items` is the
// number of funding items, `withAmount` how many had a parseable amount, `sumUsd` sums only those.
// A figure the text calls a valuation travels as `funding.valuation*` and is never an amount, so a
// valuation-only headline has usdApprox null and is neither ranked nor summed.

import { FX, toUsd } from './lib/fx-rates.js';
import { parseFunding } from './lib/funding-parse.js';
import { SECTORS, tagSectors } from './lib/sectors.js';

export const FUNDING_METHOD =
  'Amounts and stages are parsed from the headline (then the summary) with text rules; a figure the text calls a ' +
  'valuation is kept apart as a valuation and never counted as an amount; ' +
  `USD figures are approximate conversions at static ${FX.source} of ${FX.asOf}.`;

export const STAGE_ORDER = ['pre-seed', 'seed', 'series a', 'series b', 'series c', 'series d', 'series e', 'series f', 'series g', 'series h', 'bridge', 'growth', 'debt', 'grant'];

function sectorsOf(item) {
  return Array.isArray(item.sectors) ? item.sectors : tagSectors(item.title, item.summary);
}

function newTotal(extra) {
  return { ...extra, items: 0, withAmount: 0, sumUsd: 0 };
}

function add(total, usd) {
  total.items += 1;
  if (usd !== null) {
    total.withAmount += 1;
    total.sumUsd += usd;
  }
}

/**
 * buildFunding(items, { now }) -> {
 *   generatedAt, method, fx: FX,
 *   items: [item + { funding: { amount, currency, amountText, stage, amountFrom, stageFrom, parsedFrom,
 *                              valuation, valuationCurrency, valuationText, valuationFrom }, usdApprox }],
 *   totals: { bySector: [{ id, label, items, withAmount, sumUsd }], byStage: [{ stage, items, withAmount, sumUsd }] },
 *   coverage: { items, withAmount, withStage } }
 * `byStage` lists only stages that occur, in STAGE_ORDER, with an 'unknown' row last when any item lacks a stage.
 */
export function buildFunding(items, { now = new Date() } = {}) {
  const bySector = new Map(SECTORS.map((s) => [s.id, newTotal({ id: s.id, label: s.label })]));
  const byStage = new Map();
  const coverage = { items: 0, withAmount: 0, withStage: 0 };
  const out = [];

  for (const item of items) {
    if (item.kind !== 'funding') continue;
    const funding = parseFunding(item.title, item.summary);
    const usdApprox = funding.amount !== null ? toUsd(funding.amount, funding.currency) : null;
    out.push({ ...item, funding, usdApprox });

    coverage.items += 1;
    if (usdApprox !== null) coverage.withAmount += 1;
    if (funding.stage) coverage.withStage += 1;

    for (const id of sectorsOf(item)) {
      const total = bySector.get(id);
      if (total) add(total, usdApprox);
    }
    const stageKey = funding.stage ?? 'unknown';
    if (!byStage.has(stageKey)) byStage.set(stageKey, newTotal({ stage: stageKey }));
    add(byStage.get(stageKey), usdApprox);
  }

  const stageRows = [...STAGE_ORDER, 'unknown'].filter((s) => byStage.has(s)).map((s) => byStage.get(s));

  return {
    generatedAt: now.toISOString(),
    method: FUNDING_METHOD,
    fx: FX,
    items: out,
    totals: { bySector: [...bySector.values()], byStage: stageRows },
    coverage,
  };
}
