import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { itemKey } from '../public/filter.js';
import { buildDigest, DIGEST_WEEKS, MAX_HIGHLIGHTS, MAX_LAUNCHES, MAX_ROUNDS, MAX_TERMS, ROUNDS_METRIC } from '../src/digest.js';
import { buildFunding } from '../src/funding.js';
import { isoWeekEnd, isoWeekId, isoWeekStart, lastWeeks } from '../src/lib/weeks.js';

// Wednesday 2026-10-07 -> current ISO week 2026-W41 (Mon 05 .. Sun 11).
const NOW = new Date('2026-10-07T15:00:00.000Z');
const DAY = 86_400_000;

function at(daysAgo, hour = 10) {
  const d = new Date(NOW.getTime() - daysAgo * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

let seq = 0;
function item(title, overrides = {}) {
  seq += 1;
  return { id: seq, title, summary: '', url: `https://x.test/${seq}`, kind: 'news', region: 'global', publishedAt: at(1), source: { id: 's', name: 'S' }, extra: {}, ...overrides };
}

const SIGNALS = {
  generatedAt: NOW.toISOString(),
  signals: [
    { id: 'github_new_repos', ok: true, data: { label: 'stars since creation (<= 7 days)', repos: [
      { fullName: 'a/low', url: 'https://github.com/a/low', stars: 5 },
      { fullName: 'b/high', url: 'https://github.com/b/high', stars: 900 },
      { fullName: 'c/mid', url: 'https://github.com/c/mid', stars: 50 },
      { fullName: 'd/mid2', url: 'https://github.com/d/mid2', stars: 50 },
      { fullName: 'e/x', url: 'https://github.com/e/x', stars: 1 },
      { fullName: 'f/y', url: 'https://github.com/f/y', stars: 0 },
    ] } },
    { id: 'hf_trending', ok: true, data: { models: Array.from({ length: 7 }, (_, i) => ({ id: `org/m${i}`, url: `https://huggingface.co/org/m${i}`, likes: 10 - i, downloads: 100 * i })), spaces: [] } },
    { id: 'sbir', ok: false, data: null },
  ],
};

describe('buildDigest', () => {
  test('empty input -> 12 ISO weeks oldest first, last one partial, every section present and empty', () => {
    const d = buildDigest({ now: NOW });
    assert.equal(d.generatedAt, NOW.toISOString());
    assert.equal(typeof d.method, 'string');
    assert.equal(d.weeks.length, DIGEST_WEEKS);
    assert.equal(DIGEST_WEEKS, 12);
    assert.deepEqual(d.weeks.map((w) => w.week), lastWeeks(NOW, 12));
    assert.equal(d.weeks.at(-1).week, '2026-W41');
    assert.equal(d.weeks[0].week, '2026-W30');
    for (const [i, w] of d.weeks.entries()) {
      assert.deepEqual(Object.keys(w), ['week', 'from', 'to', 'partial', 'rounds', 'launches', 'ycNew', 'risingTerms', 'signalHighlights']);
      assert.equal(w.from, isoWeekStart(w.week).toISOString());
      assert.equal(w.to, isoWeekEnd(w.week).toISOString());
      assert.equal(w.partial, i === d.weeks.length - 1);
      assert.deepEqual([w.rounds, w.launches, w.ycNew, w.risingTerms], [[], [], [], []]);
    }
    assert.deepEqual(d.weeks.at(-1).signalHighlights, { repos: [], models: [], github: null, huggingface: null });
    assert.ok(d.weeks.slice(0, -1).every((w) => w.signalHighlights === null), 'highlights only in the current week');
  });

  test('rounds: funding items of the week ordered by usdApprox desc, top 10, original currency kept, metric label stated', () => {
    const items = [];
    for (let i = 0; i < 12; i += 1) items.push(item(`Co${i} raises $${i + 1}M seed`, { kind: 'funding', publishedAt: at(1) }));
    items.push(item('Euro raises EUR 50M Series B', { kind: 'funding', publishedAt: at(1) }));
    items.push(item('Mystery closes undisclosed round', { kind: 'funding', publishedAt: at(1) }));
    items.push(item('LastWeek raises $100M', { kind: 'funding', publishedAt: at(8) }));
    const funding = buildFunding(items, { now: NOW });
    const d = buildDigest({ items, funding, now: NOW });
    const cur = d.weeks.at(-1);
    assert.equal(cur.rounds.length, MAX_ROUNDS);
    assert.equal(MAX_ROUNDS, 10);
    assert.equal(cur.rounds[0].title, 'Euro raises EUR 50M Series B');
    assert.equal(cur.rounds[0].currency, 'EUR');
    assert.equal(cur.rounds[0].amount, 50_000_000);
    assert.equal(cur.rounds[0].amountText, 'EUR 50M');
    assert.equal(cur.rounds[0].stage, 'series b');
    assert.ok(cur.rounds[0].usdApprox > 50_000_000);
    assert.ok(cur.rounds.every((r) => r.metric === ROUNDS_METRIC));
    assert.equal(ROUNDS_METRIC, 'approx. USD at static rates');
    assert.deepEqual(cur.rounds.slice(1).map((r) => r.usdApprox), [12e6, 11e6, 10e6, 9e6, 8e6, 7e6, 6e6, 5e6, 4e6]);
    assert.equal(cur.rounds.some((r) => r.title.startsWith('Mystery')), false, 'no amount -> cannot be ordered -> excluded');
    assert.equal(cur.rounds[0].key, itemKey(cur.rounds[0].url));
    assert.deepEqual(Object.keys(cur.rounds[0]), ['key', 'title', 'url', 'source', 'publishedAt', 'amount', 'currency', 'amountText', 'stage', 'usdApprox', 'metric']);
    const prev = d.weeks.at(-2);
    assert.deepEqual(prev.rounds.map((r) => r.title), ['LastWeek raises $100M']);
    assert.equal(d.weeks.at(-3).rounds.length, 0);
  });

  test('launches: launch-kind items with points/votes, top 10 by value, metric HN points | PH votes', () => {
    const items = [];
    for (let i = 0; i < 11; i += 1) items.push(item(`Show HN: tool ${i}`, { kind: 'launch', extra: { points: i * 10 } }));
    items.push(item('PH launch', { kind: 'launch', extra: { votes: 55 } }));
    items.push(item('No metric launch', { kind: 'launch', extra: {} }));
    items.push(item('News with points', { kind: 'news', extra: { points: 999 } }));
    const d = buildDigest({ items, now: NOW });
    const l = d.weeks.at(-1).launches;
    assert.equal(l.length, MAX_LAUNCHES);
    assert.equal(l[0].title, 'Show HN: tool 10');
    assert.deepEqual([l[0].metric, l[0].value], ['HN points', 100]);
    const ph = l.find((x) => x.title === 'PH launch');
    assert.deepEqual([ph.metric, ph.value], ['PH votes', 55]);
    assert.equal(l.some((x) => x.title === 'No metric launch'), false);
    assert.equal(l.some((x) => x.title === 'News with points'), false);
    assert.ok(l.every((x, i) => i === 0 || l[i - 1].value >= x.value), 'descending');
    assert.deepEqual(Object.keys(l[0]), ['key', 'title', 'url', 'source', 'publishedAt', 'metric', 'value']);
  });

  test('ycNew: companies whose launchedAt falls in the week, by launch date then name', () => {
    const yc = { companies: [
      { key: 'k1', name: 'Zeta', url: 'https://yc/zeta', batch: 'Fall 2026', oneLiner: 'z', launchedAt: at(1), extra: 'dropped' },
      { key: 'k2', name: 'Alpha', url: 'https://yc/alpha', batch: 'Fall 2026', oneLiner: 'a', launchedAt: at(1) },
      { key: 'k3', name: 'Old', url: 'https://yc/old', batch: 'Spring 2026', oneLiner: 'o', launchedAt: at(9) },
      { key: 'k4', name: 'Ancient', url: 'https://yc/ancient', batch: 'W20', oneLiner: null, launchedAt: '2020-01-01T00:00:00.000Z' },
      { key: 'k5', name: 'NoDate', url: 'https://yc/nd', batch: null, oneLiner: null, launchedAt: null },
    ] };
    const d = buildDigest({ yc, now: NOW });
    assert.deepEqual(d.weeks.at(-1).ycNew.map((c) => c.name), ['Alpha', 'Zeta']);
    assert.deepEqual(Object.keys(d.weeks.at(-1).ycNew[0]), ['key', 'name', 'url', 'batch', 'oneLiner', 'launchedAt']);
    assert.deepEqual(d.weeks.at(-2).ycNew.map((c) => c.name), ['Old']);
    assert.equal(d.weeks.flatMap((w) => w.ycNew).length, 3);
    const asArray = buildDigest({ yc: yc.companies, now: NOW });
    assert.deepEqual(asArray.weeks.at(-1).ycNew, d.weeks.at(-1).ycNew, 'accepts the companies array directly');
  });

  test('risingTerms: per week, trends over items published up to the week end, <= 15 terms with counts', () => {
    const items = [];
    for (let i = 0; i < 6; i += 1) items.push(item(`Quantum ledger ${i}`, { publishedAt: at(1) }));
    for (let i = 0; i < 6; i += 1) items.push(item(`Solar battery ${i}`, { publishedAt: at(8) }));
    const d = buildDigest({ items, now: NOW });
    const cur = d.weeks.at(-1).risingTerms;
    assert.ok(cur.length > 0 && cur.length <= MAX_TERMS);
    assert.equal(MAX_TERMS, 15);
    assert.deepEqual(Object.keys(cur[0]), ['term', 'kind', 'thisWeek', 'priorWeeklyAvg', 'rise']);
    assert.ok(cur.some((t) => t.term === 'quantum'), 'this week\'s items');
    assert.equal(cur.some((t) => t.term === 'solar'), false, 'last week\'s items are prior, not rising this week');
    assert.equal(cur.find((t) => t.term === 'quantum').thisWeek, 6);
    const prev = d.weeks.at(-2).risingTerms;
    assert.ok(prev.some((t) => t.term === 'solar'), 'computed as of that week\'s end');
    assert.equal(prev.some((t) => t.term === 'quantum'), false, 'later items are not visible from an earlier week');
    assert.ok(cur.every((t, i) => i === 0 || cur[i - 1].rise >= t.rise), 'ordered by rise');
  });

  test('signalHighlights: current week only, top 5 repos by stars, first 5 models in API order, never trendingScore', () => {
    const d = buildDigest({ signals: SIGNALS, now: NOW });
    const h = d.weeks.at(-1).signalHighlights;
    assert.equal(h.repos.length, MAX_HIGHLIGHTS);
    assert.equal(MAX_HIGHLIGHTS, 5);
    assert.deepEqual(h.repos.map((r) => r.fullName), ['b/high', 'c/mid', 'd/mid2', 'a/low', 'e/x']);
    assert.deepEqual(h.repos[0], { fullName: 'b/high', url: 'https://github.com/b/high', stars: 900, label: 'stars since creation (<= 7 days)' });
    assert.deepEqual(h.models.map((m) => m.id), ['org/m0', 'org/m1', 'org/m2', 'org/m3', 'org/m4']);
    assert.deepEqual(h.models[0], { id: 'org/m0', url: 'https://huggingface.co/org/m0', likes: 10, downloads: 0, position: 1 });
    assert.equal(JSON.stringify(d).includes('trendingScore'), false);
    assert.ok(d.weeks.slice(0, -1).every((w) => w.signalHighlights === null));
    assert.deepEqual(Object.keys(h), ['repos', 'models', 'github', 'huggingface']);
    assert.deepEqual(h.github, { ok: true, fetchedAt: null, lastSuccessAt: null, unavailableSince: null }, 'fixture rows carry no times');
    assert.deepEqual(h.huggingface, { ok: true, fetchedAt: null, lastSuccessAt: null, unavailableSince: null });
    const empty = { repos: [], models: [], github: null, huggingface: null };
    assert.deepEqual(buildDigest({ signals: { generatedAt: null, signals: [] }, now: NOW }).weeks.at(-1).signalHighlights, empty);
    assert.deepEqual(buildDigest({ signals: null, now: NOW }).weeks.at(-1).signalHighlights, empty);
  });

  test('signalHighlights: a carried-over payload (ok: false) keeps its fetch state so the page and feed can label it', () => {
    const stale = {
      generatedAt: NOW.toISOString(),
      signals: [
        { ...SIGNALS.signals[0], ok: false, fetchedAt: NOW.toISOString(), lastSuccessAt: '2026-10-05T10:00:00.000Z', unavailableSince: '2026-10-06T10:00:00.000Z', error: 'HTTP 403' },
        { ...SIGNALS.signals[1], ok: true, fetchedAt: NOW.toISOString(), lastSuccessAt: NOW.toISOString(), unavailableSince: null, error: null },
      ],
    };
    const h = buildDigest({ signals: stale, now: NOW }).weeks.at(-1).signalHighlights;
    assert.equal(h.repos.length, MAX_HIGHLIGHTS, 'the carried-over rows are still listed');
    assert.deepEqual(h.github, { ok: false, fetchedAt: NOW.toISOString(), lastSuccessAt: '2026-10-05T10:00:00.000Z', unavailableSince: '2026-10-06T10:00:00.000Z' });
    assert.deepEqual(h.huggingface, { ok: true, fetchedAt: NOW.toISOString(), lastSuccessAt: NOW.toISOString(), unavailableSince: null });
    assert.equal(JSON.stringify(h).includes('HTTP 403'), false, 'the error text stays on the signals page');
    const nullData = buildDigest({ signals: { generatedAt: NOW.toISOString(), signals: [{ id: 'github_new_repos', ok: false, data: null, fetchedAt: NOW.toISOString(), lastSuccessAt: null, unavailableSince: NOW.toISOString() }] }, now: NOW }).weeks.at(-1).signalHighlights;
    assert.deepEqual(nullData.repos, []);
    assert.deepEqual(nullData.github, { ok: false, fetchedAt: NOW.toISOString(), lastSuccessAt: null, unavailableSince: NOW.toISOString() });
    assert.equal(nullData.huggingface, null);
  });

  test('deterministic: the same input (in any order) gives byte-identical output; partial flag follows now', () => {
    const items = [
      item('Acme raises $4M seed', { kind: 'funding', publishedAt: at(1) }),
      item('Beta raises $4M seed', { kind: 'funding', publishedAt: at(1) }),
      item('Show HN: a', { kind: 'launch', extra: { points: 5 } }),
      item('Show HN: b', { kind: 'launch', extra: { points: 5 } }),
    ];
    const funding = buildFunding(items, { now: NOW });
    const a = JSON.stringify(buildDigest({ items, funding, signals: SIGNALS, now: NOW }));
    const b = JSON.stringify(buildDigest({ items: [...items].reverse(), funding: { ...funding, items: [...funding.items].reverse() }, signals: SIGNALS, now: NOW }));
    assert.equal(a, b);
    const cur = JSON.parse(a).weeks.at(-1);
    assert.deepEqual(cur.rounds.map((r) => r.title), ['Acme raises $4M seed', 'Beta raises $4M seed'], 'ties broken by title');
    assert.deepEqual(cur.launches.map((l) => l.title), ['Show HN: a', 'Show HN: b']);

    const sunday = new Date('2026-10-11T23:59:59.999Z');
    const d2 = buildDigest({ items, now: sunday });
    assert.equal(d2.weeks.at(-1).week, '2026-W41');
    assert.equal(d2.weeks.at(-1).partial, true, 'the week containing now is always flagged partial');
    assert.equal(isoWeekId(sunday), '2026-W41');
    const monday = new Date('2026-10-12T00:00:00.000Z');
    const d3 = buildDigest({ items, now: monday });
    assert.equal(d3.weeks.at(-1).week, '2026-W42');
    assert.equal(d3.weeks.at(-2).week, '2026-W41');
    assert.equal(d3.weeks.at(-2).partial, false);
    assert.equal(d3.weeks.at(-2).launches.length, 2, 'last week\'s content moves to the completed week');
  });
});
