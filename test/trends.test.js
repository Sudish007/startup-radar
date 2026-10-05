import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { itemKey } from '../public/filter.js';
import { buildTrends, itemTerms, MIN_SUPPORT, MAX_TERMS, MAX_EXAMPLES, TRENDS_WEEKS, PRIOR_WEEKS } from '../src/trends.js';
import { isoWeekId, isoWeekStart, lastWeeks } from '../src/lib/weeks.js';

const NOW = new Date('2026-10-07T15:00:00.000Z'); // Wednesday, 2026-W41
const WEEKS = lastWeeks(NOW, TRENDS_WEEKS);

let seq = 0;
/** An item published `daysAgo` days before NOW. */
function item(title, daysAgo, overrides = {}) {
  seq += 1;
  return {
    id: seq,
    title,
    summary: '',
    url: `https://x.test/${seq}`,
    kind: 'launch',
    region: 'global',
    publishedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    ...overrides,
  };
}

/** `n` items with `title` published inside the ISO week `weekId` (Monday noon). */
function inWeek(title, weekId, n, overrides = {}) {
  const t = isoWeekStart(weekId).getTime() + 12 * 3600_000;
  return Array.from({ length: n }, () => {
    seq += 1;
    return { id: seq, title, summary: '', url: `https://x.test/${seq}`, kind: 'launch', region: 'global', publishedAt: new Date(t).toISOString(), ...overrides };
  });
}

describe('itemTerms', () => {
  test('collects distinct tokens and bigrams across title and summary', () => {
    const terms = itemTerms({ title: 'Robot robots for banks', summary: 'Robot vision' });
    assert.deepEqual([...terms].sort(), ['b:robot bank', 'b:robot robot', 'b:robot vision', 't:bank', 't:robot', 't:vision']);
  });
});

describe('buildTrends', () => {
  test('empty input -> empty series with the full shape', () => {
    const t = buildTrends([], { now: NOW });
    assert.equal(t.generatedAt, NOW.toISOString());
    assert.equal(typeof t.method, 'string');
    assert.ok(t.method.length > 40);
    assert.deepEqual(t.weeks, WEEKS);
    assert.equal(t.weeks.length, 12);
    assert.equal(t.partialWeek, '2026-W41');
    assert.deepEqual(t.thisWeek, { id: '2026-W41', from: '2026-10-05T00:00:00.000Z', to: '2026-10-11T23:59:59.999Z', partial: true });
    assert.deepEqual(t.prior, { from: '2026-09-07T00:00:00.000Z', to: '2026-10-04T23:59:59.999Z', weeks: PRIOR_WEEKS });
    assert.deepEqual(t.terms, []);
    assert.equal(t.bySector.length, 15);
    assert.ok(t.bySector.every((s) => s.counts.length === 12 && s.counts.every((c) => c === 0)));
    assert.deepEqual(t.byKind.map((k) => k.id), ['launch', 'funding', 'news', 'accelerator']);
    assert.deepEqual(t.byKind.map((k) => k.label), ['Launch', 'Funding', 'News', 'Accelerator']);
    assert.deepEqual(t.byRegion.map((r) => r.id), ['usa', 'europe', 'asia', 'india', 'latam', 'africa', 'global']);
    assert.equal(t.items, 0);
  });

  test('min support: a term needs at least 5 items this week', () => {
    const items = [...inWeek('Quantum sensors', '2026-W41', MIN_SUPPORT - 1), ...inWeek('Fusion reactors', '2026-W41', MIN_SUPPORT)];
    const t = buildTrends(items, { now: NOW });
    const names = t.terms.map((x) => x.term);
    assert.ok(!names.includes('quantum'));
    assert.ok(names.includes('fusion'));
    assert.ok(names.includes('reactor'), 'de-pluralised token');
    assert.ok(names.includes('fusion reactor'), 'bigram');
    assert.equal(t.terms.find((x) => x.term === 'fusion reactor').kind, 'bigram');
    assert.equal(t.terms.find((x) => x.term === 'fusion').kind, 'token');
  });

  test('rise = thisWeek - prior weekly average; ratio null when never seen before; ordering', () => {
    const items = [
      ...inWeek('Alpha thing', '2026-W41', 10), // new this week: rise 10, ratio null
      ...inWeek('Beta thing', '2026-W41', 8), ...inWeek('Beta thing', '2026-W40', 4), ...inWeek('Beta thing', '2026-W38', 4), // prior avg 2 -> rise 6, ratio 4
      ...inWeek('Gamma thing', '2026-W41', 6), ...inWeek('Gamma thing', '2026-W39', 8), // prior avg 2 -> rise 4, ratio 3
      ...inWeek('Delta thing', '2026-W41', 5), ...inWeek('Delta thing', '2026-W37', 40), // prior avg 10 -> rise -5
      ...inWeek('Delta thing', '2026-W36', 100), // outside the prior window: ignored for terms
    ];
    const t = buildTrends(items, { now: NOW });
    const byTerm = Object.fromEntries(t.terms.map((x) => [x.term, x]));
    assert.deepEqual({ ...byTerm.alpha, examples: byTerm.alpha.examples.length }, { term: 'alpha', kind: 'token', thisWeek: 10, priorWeeklyAvg: 0, rise: 10, ratio: null, examples: MAX_EXAMPLES });
    assert.deepEqual({ ...byTerm.beta, examples: undefined }, { term: 'beta', kind: 'token', thisWeek: 8, priorWeeklyAvg: 2, rise: 6, ratio: 4, examples: undefined });
    assert.equal(byTerm.gamma.rise, 4);
    assert.equal(byTerm.gamma.ratio, 3);
    assert.equal(byTerm.delta.thisWeek, 5);
    assert.equal(byTerm.delta.priorWeeklyAvg, 10);
    assert.equal(byTerm.delta.rise, -5);
    assert.equal(byTerm.delta.ratio, 0.5);
    // "thing" appears in all: 29 this week, prior (4+4+8+40)/4 = 14 -> rise 15
    assert.equal(byTerm.thing.thisWeek, 29);
    assert.equal(byTerm.thing.priorWeeklyAvg, 14);
    assert.equal(byTerm.thing.rise, 15);
    // sorted by rise desc
    const rises = t.terms.map((x) => x.rise);
    assert.deepEqual(rises, [...rises].sort((a, b) => b - a));
    assert.equal(t.terms[0].term, 'thing');
    assert.equal(t.terms[1].term, 'alpha');
  });

  test('equal rise: higher ratio first, never-seen (null ratio) before any finite ratio, then term asc', () => {
    const items = [
      ...inWeek('Zeta', '2026-W41', 5), // rise 5, ratio null
      ...inWeek('Eta', '2026-W41', 7), ...inWeek('Eta', '2026-W40', 8), // prior avg 2 -> rise 5, ratio 3.5
      ...inWeek('Theta', '2026-W41', 9), ...inWeek('Theta', '2026-W40', 16), // prior avg 4 -> rise 5, ratio 2.25
      ...inWeek('Iota', '2026-W41', 5), // rise 5, ratio null
    ];
    const t = buildTrends(items, { now: NOW });
    assert.deepEqual(t.terms.map((x) => x.term), ['iota', 'zeta', 'eta', 'theta']);
  });

  test('examples hold at most 5 item keys from this week', () => {
    const items = inWeek('Kappa', '2026-W41', 9);
    const t = buildTrends(items, { now: NOW });
    const kappa = t.terms.find((x) => x.term === 'kappa');
    assert.equal(kappa.examples.length, MAX_EXAMPLES);
    assert.deepEqual(kappa.examples, items.slice(0, 5).map((i) => itemKey(i.url)));
  });

  test('a term is counted once per item even when repeated', () => {
    const items = inWeek('Lambda lambda lambda', '2026-W41', 5);
    const t = buildTrends(items, { now: NOW });
    assert.equal(t.terms.find((x) => x.term === 'lambda').thisWeek, 5);
    assert.equal(t.terms.find((x) => x.term === 'lambda lambda').thisWeek, 5);
  });

  test('at most 60 terms', () => {
    const items = [];
    for (let i = 0; i < 80; i += 1) items.push(...inWeek(`word${i}x`, '2026-W41', MIN_SUPPORT));
    const t = buildTrends(items, { now: NOW });
    assert.equal(t.terms.length, MAX_TERMS);
  });

  test('12-week series: bySector/byKind/byRegion sums equal the items inside the 12 weeks', () => {
    const items = [
      item('AI copilots for banks', 1, { kind: 'funding', region: 'usa' }), // W41
      item('AI robots', 8, { kind: 'news', region: 'europe' }), // W40
      item('Solar wind', 30, { kind: 'launch', region: 'india' }), // W37
      item('Untagged', 60, { kind: 'accelerator', region: 'asia' }), // W32
      item('AI far away', 100, { kind: 'news', region: 'usa' }), // older than 12 weeks: not in the series
      { ...item('Bad date', 1), publishedAt: 'not-a-date' },
    ];
    const t = buildTrends(items, { now: NOW });
    const sum = (rows) => rows.reduce((n, r) => n + r.counts.reduce((a, b) => a + b, 0), 0);
    assert.equal(sum(t.byKind), 4);
    assert.equal(sum(t.byRegion), 4);
    assert.equal(sum(t.bySector), 2 + 2 + 1, 'sector-item pairs: ai+fintech, ai+hardware, climate');
    const idx = (weekId) => WEEKS.indexOf(weekId);
    assert.equal(t.byKind.find((k) => k.id === 'funding').counts[idx('2026-W41')], 1);
    assert.equal(t.byKind.find((k) => k.id === 'news').counts[idx('2026-W40')], 1);
    assert.equal(t.byRegion.find((r) => r.id === 'india').counts[idx(isoWeekId(items[2].publishedAt))], 1);
    assert.equal(t.bySector.find((s) => s.id === 'ai').counts[idx('2026-W41')], 1);
    assert.equal(t.bySector.find((s) => s.id === 'ai').counts[idx('2026-W40')], 1);
    assert.equal(t.items, 6, 'items reports the input length');
  });

  test('uses item.sectors when present instead of re-tagging', () => {
    const items = [item('plain title', 1, { sectors: ['gaming'] })];
    const t = buildTrends(items, { now: NOW });
    assert.equal(t.bySector.find((s) => s.id === 'gaming').counts.at(-1), 1);
  });
});
