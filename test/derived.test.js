import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { itemKey } from '../public/filter.js';
import { openDb } from '../src/db.js';
import { normalizeItem } from '../src/lib/normalize.js';
import { FX } from '../src/lib/fx-rates.js';
import { buildFunding, STAGE_ORDER } from '../src/funding.js';
import { buildYcLens, teamSizeBucket, batchRank, toCompany, TEAM_SIZE_BUCKETS, YC_ATTRIBUTION } from '../src/yc-lens.js';
import { buildDerived } from '../src/derived.js';
import yc, { mapYcCompany } from '../src/sources/yc.js';

const NOW = new Date('2026-10-07T15:00:00.000Z');

function daysAgo(n) {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

let seq = 0;
function item(title, overrides = {}) {
  seq += 1;
  return { id: seq, title, summary: '', url: `https://x.test/${seq}`, kind: 'funding', region: 'global', publishedAt: daysAgo(1), source: { id: 's', name: 'S' }, extra: {}, ...overrides };
}

describe('buildFunding', () => {
  test('empty -> zero totals with the full shape', () => {
    const f = buildFunding([], { now: NOW });
    assert.equal(f.generatedAt, NOW.toISOString());
    assert.equal(f.fx, FX);
    assert.ok(f.method.includes('parsed from the headline'));
    assert.deepEqual(f.items, []);
    assert.equal(f.totals.bySector.length, 15);
    assert.deepEqual(f.totals.bySector[0], { id: 'ai', label: 'AI/ML', items: 0, withAmount: 0, sumUsd: 0 });
    assert.deepEqual(f.totals.byStage, []);
    assert.deepEqual(f.coverage, { items: 0, withAmount: 0, withStage: 0 });
  });

  test('keeps funding items unchanged plus funding + usdApprox; skips other kinds', () => {
    const items = [
      item('Acme raises $4M seed for AI copilots', { region: 'usa' }),
      item('Beta secures Rs 50 crore Series A for fintech lending'),
      item('Gamma closes undisclosed round'),
      item('Delta launches a game', { kind: 'launch' }),
      item('Epsilon news $9M', { kind: 'news' }),
    ];
    const f = buildFunding(items, { now: NOW });
    assert.equal(f.items.length, 3);
    const [acme, beta, gamma] = f.items;
    assert.equal(acme.title, items[0].title);
    assert.equal(acme.url, items[0].url);
    assert.equal(acme.region, 'usa');
    assert.deepEqual(acme.funding, { amount: 4_000_000, currency: 'USD', amountText: '$4M', stage: 'seed', amountFrom: 'title', stageFrom: 'title', parsedFrom: 'title' });
    assert.equal(acme.usdApprox, 4_000_000);
    assert.equal(beta.funding.amount, 500_000_000);
    assert.equal(beta.funding.currency, 'INR');
    assert.equal(beta.usdApprox, Math.round(500_000_000 * FX.rates.INR));
    assert.equal(beta.funding.stage, 'series a');
    assert.deepEqual(gamma.funding, { amount: null, currency: null, amountText: null, stage: null, amountFrom: null, stageFrom: null, parsedFrom: null });
    assert.equal(gamma.usdApprox, null);
    assert.deepEqual(f.coverage, { items: 3, withAmount: 2, withStage: 2 });
  });

  test('totals by sector and by stage state items, withAmount and sumUsd honestly', () => {
    const items = [
      item('Acme raises $4M seed for AI copilots'),
      item('Beta raises $6M seed for AI banks'),
      item('Gamma bags EUR 4M pre-seed for solar'),
      item('Delta closes a round for robots'),
    ];
    const f = buildFunding(items, { now: NOW });
    const sector = (id) => f.totals.bySector.find((s) => s.id === id);
    assert.deepEqual(sector('ai'), { id: 'ai', label: 'AI/ML', items: 2, withAmount: 2, sumUsd: 10_000_000 });
    assert.deepEqual(sector('fintech'), { id: 'fintech', label: 'Fintech', items: 1, withAmount: 1, sumUsd: 6_000_000 });
    assert.deepEqual(sector('climate'), { id: 'climate', label: 'Climate & Energy', items: 1, withAmount: 1, sumUsd: Math.round(4_000_000 * FX.rates.EUR) });
    assert.deepEqual(sector('hardware'), { id: 'hardware', label: 'Hardware & Robotics', items: 1, withAmount: 0, sumUsd: 0 });
    assert.deepEqual(f.totals.byStage, [
      { stage: 'pre-seed', items: 1, withAmount: 1, sumUsd: Math.round(4_000_000 * FX.rates.EUR) },
      { stage: 'seed', items: 2, withAmount: 2, sumUsd: 10_000_000 },
      { stage: 'unknown', items: 1, withAmount: 0, sumUsd: 0 },
    ]);
    assert.deepEqual(f.coverage, { items: 4, withAmount: 3, withStage: 3 });
    assert.deepEqual(STAGE_ORDER.slice(0, 3), ['pre-seed', 'seed', 'series a']);
  });

  test('uses item.sectors when already decorated', () => {
    const f = buildFunding([item('x raises $1M', { sectors: ['gaming'] })], { now: NOW });
    assert.equal(f.totals.bySector.find((s) => s.id === 'gaming').items, 1);
    assert.equal(f.totals.bySector.find((s) => s.id === 'ai').items, 0);
  });
});

describe('buildYcLens', () => {
  const ycItem = (name, extra, overrides = {}) => item(name, { kind: 'accelerator', region: 'usa', source: { id: 'yc', name: 'YC' }, url: `https://www.ycombinator.com/companies/${name.toLowerCase()}`, summary: extra.oneLiner ?? '', extra, ...overrides });

  test('teamSizeBucket and batchRank', () => {
    assert.deepEqual([0, 1, 2, 5, 6, 10, 11, 25, 26, 50, 51, 400, null, undefined, 'x', Number.NaN].map(teamSizeBucket),
      ['unknown', '1', '2-5', '2-5', '6-10', '6-10', '11-25', '11-25', '26-50', '26-50', '51+', '51+', 'unknown', 'unknown', 'unknown', 'unknown']);
    assert.ok(batchRank('Fall 2026') > batchRank('Summer 2026'));
    assert.ok(batchRank('Summer 2026') > batchRank('Spring 2026'));
    assert.ok(batchRank('Spring 2026') > batchRank('Winter 2026'));
    assert.ok(batchRank('Winter 2026') > batchRank('Fall 2025'));
    assert.equal(batchRank('unknown'), -1);
  });

  test('toCompany maps the slim fields, nulls the missing ones and never carries long text', () => {
    const c = toCompany(ycItem('Acme', { batch: 'Fall 2026', website: 'https://acme.io', oneLiner: 'Invoices', status: 'Active', stage: 'Early', industry: 'B2B', subindustry: 'B2B -> Finance', tags: ['Fintech'], teamSize: 3, location: 'SF', launchedAt: '2026-09-01T00:00:00.000Z' }));
    assert.deepEqual(c, {
      key: itemKey('https://www.ycombinator.com/companies/acme'), name: 'Acme', url: 'https://www.ycombinator.com/companies/acme', website: 'https://acme.io', oneLiner: 'Invoices',
      batch: 'Fall 2026', status: 'Active', stage: 'Early', industry: 'B2B', subindustry: 'B2B -> Finance', tags: ['Fintech'], teamSize: 3, location: 'SF', launchedAt: '2026-09-01T00:00:00.000Z',
    });
    const bare = toCompany(ycItem('Bare', {}, { summary: 'from summary', publishedAt: '2026-08-01T00:00:00.000Z' }));
    assert.equal(bare.oneLiner, 'from summary');
    assert.equal(bare.launchedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(bare.website, null);
    assert.deepEqual(bare.tags, []);
    assert.equal(bare.teamSize, null);
    assert.deepEqual(Object.keys(bare), ['key', 'name', 'url', 'website', 'oneLiner', 'batch', 'status', 'stage', 'industry', 'subindustry', 'tags', 'teamSize', 'location', 'launchedAt']);
  });

  test('groups by batch (newest first), industry, status, tag frequency (top 40) and team size buckets', () => {
    const items = [
      ycItem('A1', { batch: 'Spring 2026', industry: 'B2B', status: 'Active', tags: ['AI', 'SaaS'], teamSize: 1 }),
      ycItem('A2', { batch: 'Fall 2026', industry: 'Healthcare', status: 'Active', tags: ['AI'], teamSize: 4 }),
      ycItem('A3', { batch: 'Fall 2026', industry: 'B2B', status: 'Inactive', tags: ['Fintech', 'AI'], teamSize: 12 }),
      ycItem('A4', { batch: 'Summer 2026', industry: 'B2B', status: 'Acquired', tags: [] }),
    ];
    for (let i = 0; i < 50; i += 1) items.push(ycItem(`T${i}`, { batch: 'Summer 2026', industry: 'Consumer', status: 'Active', tags: [`tag${i}`], teamSize: 60 }));
    const y = buildYcLens(items, { now: NOW });
    assert.equal(y.generatedAt, NOW.toISOString());
    assert.equal(y.attribution, YC_ATTRIBUTION);
    assert.equal(y.companies.length, 54);
    assert.deepEqual(y.batches, [{ batch: 'Fall 2026', count: 2 }, { batch: 'Summer 2026', count: 51 }, { batch: 'Spring 2026', count: 1 }]);
    assert.deepEqual(y.byIndustry, [{ industry: 'Consumer', count: 50 }, { industry: 'B2B', count: 3 }, { industry: 'Healthcare', count: 1 }]);
    assert.deepEqual(y.byStatus, [{ status: 'Active', count: 52 }, { status: 'Acquired', count: 1 }, { status: 'Inactive', count: 1 }]);
    assert.equal(y.tagFrequency.length, 40);
    assert.deepEqual(y.tagFrequency[0], { tag: 'AI', count: 3 });
    assert.deepEqual(y.tagFrequency.slice(1, 3), [{ tag: 'Fintech', count: 1 }, { tag: 'SaaS', count: 1 }]);
    assert.deepEqual(y.teamSize.buckets, TEAM_SIZE_BUCKETS);
    assert.deepEqual(y.teamSize.counts, [1, 1, 0, 1, 0, 50, 1]);
    assert.equal(y.teamSize.counts.reduce((a, b) => a + b, 0), y.companies.length);
    assert.equal(JSON.stringify(y).includes('long_description'), false);
  });
});

describe('buildDerived', () => {
  let db;
  const HN = { id: 'hn_show', name: 'Hacker News: Show HN', homepage: 'https://news.ycombinator.com/show', kind: 'launch', region: 'global', enabled: () => true, requires: null };
  const TC = { id: 'techcrunch', name: 'TechCrunch', homepage: 'https://techcrunch.com/', kind: 'news', region: 'usa', enabled: () => true, requires: null };
  const SOURCES = [HN, TC, yc];
  const row = (source, raw) => normalizeItem(raw, source, NOW.toISOString());

  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertItems('hn_show', [
      row(HN, { title: 'Show HN: AI copilots for banks', url: 'https://a.io/1', publishedAt: daysAgo(1) }),
      row(HN, { title: 'Show HN: old item', url: 'https://a.io/2', publishedAt: daysAgo(200) }),
    ]);
    db.upsertItems('techcrunch', [
      row(TC, { title: 'Acme raises $4M seed for robots', url: 'https://t.io/1', publishedAt: daysAgo(2) }),
      row(TC, { title: 'Plain news', url: 'https://t.io/2', publishedAt: daysAgo(3) }),
    ]);
    db.upsertItems('yc', [
      row(yc, mapYcCompany({ name: 'Fresh', slug: 'fresh', url: 'https://www.ycombinator.com/companies/fresh', batch: 'Fall 2026', launched_at: Math.floor((NOW.getTime() - 5 * 86_400_000) / 1000), team_size: 2, status: 'Active', stage: 'Early', industry: 'B2B', subindustry: 'B2B -> Infrastructure', tags: ['Devtools'], one_liner: 'Fast builds', long_description: 'never stored' })),
      row(yc, mapYcCompany({ name: 'Older', slug: 'older', url: 'https://www.ycombinator.com/companies/older', batch: 'Spring 2026', launched_at: Math.floor((NOW.getTime() - 400 * 86_400_000) / 1000), team_size: 30, status: 'Active', stage: 'Growth', industry: 'Consumer', tags: ['Social'] })),
    ]);
  });
  afterEach(() => db.close());

  test('returns { trends, funding, yc, signals, digest, feedXml } over the window (trends/funding) and every yc item (yc)', () => {
    const d = buildDerived({ db, sources: SOURCES, env: {}, now: NOW });
    assert.deepEqual(Object.keys(d), ['trends', 'funding', 'yc', 'signals', 'digest', 'feedXml']);
    assert.deepEqual(d.signals, { generatedAt: null, signals: [] }, 'nothing in kv -> empty shape');
    assert.equal(d.digest.weeks.length, 12);
    assert.equal(d.digest.weeks.at(-1).rounds.length, 1, 'the $4M round (Monday) falls in the current week (NOW is Wednesday)');
    assert.equal(d.digest.weeks.at(-1).rounds[0].metric, 'approx. USD at static rates');
    assert.ok(d.feedXml.startsWith('<?xml'));
    assert.ok(d.feedXml.includes('http://localhost:3000/feed.xml'), 'no PUBLIC_URL -> localhost fallback');

    db.kvSet('signals', { generatedAt: NOW.toISOString(), signals: [{ id: 'github_new_repos', data: { label: 'stars since creation (<= 7 days)', repos: [{ fullName: 'a/b', url: 'https://github.com/a/b', stars: 9 }] } }] });
    const d2 = buildDerived({ db, sources: SOURCES, env: { PUBLIC_URL: 'https://x.test/sr/' }, now: NOW });
    assert.equal(d2.signals.signals[0].id, 'github_new_repos', 'kv payload is picked up');
    assert.deepEqual(d2.digest.weeks.at(-1).signalHighlights.repos, [{ fullName: 'a/b', url: 'https://github.com/a/b', stars: 9, label: 'stars since creation (<= 7 days)' }]);
    assert.ok(d2.feedXml.includes('<id>https://x.test/sr/feed.xml</id>'), 'trailing slash trimmed');

    assert.equal(d.trends.items, 4, 'window items: 2 hn (one is 200 days old -> excluded), 2 tc, 1 yc = 4');
    assert.equal(d.trends.generatedAt, NOW.toISOString());
    assert.equal(d.trends.bySector.find((s) => s.id === 'ai').counts.reduce((a, b) => a + b, 0), 1);

    assert.equal(d.funding.items.length, 1);
    assert.equal(d.funding.items[0].title, 'Acme raises $4M seed for robots');
    assert.equal(d.funding.items[0].kind, 'funding', 'classifyKind promoted the TechCrunch headline');
    assert.equal(d.funding.items[0].source.name, 'TechCrunch');
    assert.deepEqual(d.funding.items[0].sectors, ['hardware']);
    assert.equal(d.funding.items[0].usdApprox, 4_000_000);
    assert.deepEqual(d.funding.coverage, { items: 1, withAmount: 1, withStage: 1 });

    assert.equal(d.yc.companies.length, 2, 'yc lens is not window-limited');
    assert.deepEqual(d.yc.batches, [{ batch: 'Fall 2026', count: 1 }, { batch: 'Spring 2026', count: 1 }]);
    const fresh = d.yc.companies.find((c) => c.name === 'Fresh');
    assert.equal(fresh.subindustry, 'B2B -> Infrastructure');
    assert.equal(fresh.oneLiner, 'Fast builds');
    assert.equal(fresh.stage, 'Early');
    assert.deepEqual(fresh.tags, ['Devtools']);
    assert.equal(fresh.key, itemKey('https://www.ycombinator.com/companies/fresh'));
    assert.equal(JSON.stringify(d.yc).includes('never stored'), false);
    assert.deepEqual(d.yc.teamSize.counts, [0, 1, 0, 0, 1, 0, 0]);
  });

  test('payloads are JSON-serialisable and compact', () => {
    const d = buildDerived({ db, sources: SOURCES, env: {}, now: NOW });
    assert.equal(typeof d.feedXml, 'string');
    for (const [name, value] of Object.entries(d)) {
      if (name === 'feedXml') continue;
      const text = JSON.stringify(value);
      assert.deepEqual(JSON.parse(text), value, name);
      assert.ok(Buffer.byteLength(text) < 20_000, `${name} is ${Buffer.byteLength(text)} bytes`);
    }
    // ~534 slim companies must stay under the 250 KB target: measure the per-company cost here.
    const perCompany = Buffer.byteLength(JSON.stringify(d.yc.companies[0]));
    assert.ok(perCompany < 480, `one slim company is ${perCompany} bytes`);
  });
});
