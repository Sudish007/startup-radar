import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { normalizeItem } from '../src/lib/normalize.js';
import { EXPLORE_MORE } from '../src/explore.js';
import { EXPORT_LIMITS, itemsPayload, statsPayload, sourcesPayload, buildSnapshot } from '../src/export.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const HN = { id: 'hn_show', name: 'Hacker News: Show HN', homepage: 'https://news.ycombinator.com/show', kind: 'launch', region: 'global', enabled: () => true, requires: null };
const TC = { id: 'techcrunch', name: 'TechCrunch', homepage: 'https://techcrunch.com/', kind: 'news', region: 'usa', enabled: () => false, requires: 'TOKEN' };
const SOURCES = [HN, TC];

function daysAgo(n) {
  return new Date(NOW.getTime() - n * 24 * 3600_000).toISOString();
}

function row(source, overrides) {
  return normalizeItem({ title: 'Item', url: 'https://example.com/x', ...overrides }, source, NOW.toISOString());
}

describe('db.listItems', () => {
  let db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertItems('hn_show', [
      row(HN, { url: 'https://a.io/1', title: 'One', publishedAt: daysAgo(1) }),
      row(HN, { url: 'https://a.io/2', title: 'Two', publishedAt: daysAgo(2) }),
      row(HN, { url: 'https://a.io/3', title: 'Three', publishedAt: daysAgo(3) }),
    ]);
  });
  afterEach(() => db.close());

  test('orders newest first and is not clamped to 100 by default', () => {
    const items = db.listItems();
    assert.deepEqual(items.map((i) => i.title), ['One', 'Two', 'Three']);
    assert.equal(items[0].source.name, 'hn_show');
  });

  test('respects limit', () => {
    assert.deepEqual(db.listItems({ limit: 2 }).map((i) => i.title), ['One', 'Two']);
  });

  test('respects since', () => {
    assert.deepEqual(db.listItems({ since: daysAgo(2) }).map((i) => i.title), ['One', 'Two']);
  });

  test('breaks ties on id descending', () => {
    const same = daysAgo(1);
    db.upsertItems('hn_show', [row(HN, { url: 'https://a.io/4', title: 'Four', publishedAt: same })]);
    const items = db.listItems();
    assert.deepEqual(items.slice(0, 2).map((i) => i.title), ['Four', 'One']);
  });
});

describe('itemsPayload', () => {
  let db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  test('drops items older than maxDays and fills source.name', () => {
    db.upsertItems('hn_show', [
      row(HN, { url: 'https://a.io/recent', title: 'Recent', publishedAt: daysAgo(5) }),
      row(HN, { url: 'https://a.io/old', title: 'Old', publishedAt: daysAgo(100) }),
    ]);
    db.upsertItems('techcrunch', [row(TC, { url: 'https://t.io/1', title: 'TC', publishedAt: daysAgo(1) })]);
    const { items, archive } = itemsPayload({ db, sources: SOURCES, now: NOW });
    assert.equal(archive, null);
    assert.deepEqual(items.map((i) => i.title), ['TC', 'Recent']);
    assert.equal(items[0].source.name, 'TechCrunch');
    assert.equal(items[1].source.name, 'Hacker News: Show HN');
  });

  test('falls back to the source id when the registry does not know it', () => {
    db.upsertItems('hn_show', [row(HN, { url: 'https://a.io/1', publishedAt: daysAgo(1) })]);
    const { items } = itemsPayload({ db, sources: [], now: NOW });
    assert.equal(items[0].source.name, 'hn_show');
  });

  test('respects maxItems', () => {
    db.upsertItems('hn_show', Array.from({ length: 5 }, (_, i) => row(HN, { url: `https://a.io/${i}`, title: `T${i}`, publishedAt: daysAgo(i) })));
    const { items } = itemsPayload({ db, sources: SOURCES, now: NOW, limits: { ...EXPORT_LIMITS, maxItems: 3 } });
    assert.deepEqual(items.map((i) => i.title), ['T0', 'T1', 'T2']);
  });

  test('splits into primary + archive when the payload exceeds primaryMaxBytes', () => {
    db.upsertItems('hn_show', Array.from({ length: 5 }, (_, i) => row(HN, { url: `https://a.io/${i}`, title: `T${i}`, publishedAt: daysAgo(i) })));
    const limits = { maxDays: 90, maxItems: 10, primaryMaxItems: 2, primaryMaxBytes: 10 };
    const { items, archive } = itemsPayload({ db, sources: SOURCES, now: NOW, limits });
    assert.deepEqual(items.map((i) => i.title), ['T0', 'T1']);
    assert.deepEqual(archive.map((i) => i.title), ['T2', 'T3', 'T4']);
  });

  test('uses the default limits when none are passed', () => {
    assert.deepEqual(EXPORT_LIMITS, { maxDays: 90, maxItems: 3000, primaryMaxItems: 800, primaryMaxBytes: 600_000 });
    db.upsertItems('hn_show', [row(HN, { url: 'https://a.io/1', publishedAt: daysAgo(89) })]);
    assert.equal(itemsPayload({ db, sources: SOURCES, now: NOW }).items.length, 1);
  });
});

describe('statsPayload and sourcesPayload', () => {
  let db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  test('statsPayload adds an ISO generatedAt and archiveItems to getStats', () => {
    db.upsertItems('hn_show', [row(HN, { url: 'https://a.io/1', publishedAt: daysAgo(1) })]);
    const stats = statsPayload({ db, now: NOW, archiveItems: 7 });
    assert.equal(stats.generatedAt, '2026-10-02T12:00:00.000Z');
    assert.equal(stats.archiveItems, 7);
    assert.equal(stats.items, 1);
    assert.deepEqual(stats.bySource, { hn_show: 1 });
    assert.equal(statsPayload({ db }).archiveItems, 0);
  });

  test('sourcesPayload has the /api/sources key set and exploreMore', () => {
    db.setSourceStatus('hn_show', { last_run_at: '2026-10-02T10:00:00.000Z', last_success_at: '2026-10-02T10:00:00.000Z', last_error: null, last_duration_ms: 12, last_item_count: 1 });
    db.upsertItems('hn_show', [row(HN, { url: 'https://a.io/1' })]);
    const payload = sourcesPayload({ db, sources: SOURCES, env: {} });
    assert.equal(payload.exploreMore, EXPLORE_MORE);
    assert.equal(payload.sources.length, 2);
    assert.deepEqual(Object.keys(payload.sources[0]), [
      'id', 'name', 'homepage', 'kind', 'region', 'enabled', 'requires',
      'lastRunAt', 'lastSuccessAt', 'lastError', 'lastDurationMs', 'lastItemCount', 'itemCount',
    ]);
    assert.deepEqual(payload.sources[0], {
      id: 'hn_show', name: 'Hacker News: Show HN', homepage: 'https://news.ycombinator.com/show', kind: 'launch', region: 'global',
      enabled: true, requires: null, lastRunAt: '2026-10-02T10:00:00.000Z', lastSuccessAt: '2026-10-02T10:00:00.000Z',
      lastError: null, lastDurationMs: 12, lastItemCount: 1, itemCount: 1,
    });
    assert.equal(payload.sources[1].enabled, false);
    assert.equal(payload.sources[1].requires, 'TOKEN');
    assert.equal(payload.sources[1].itemCount, 0);
    assert.equal(payload.sources[1].lastSuccessAt, null);
  });

  test('buildSnapshot bundles items, archive, sources and stats', () => {
    db.upsertItems('hn_show', [row(HN, { url: 'https://a.io/1', publishedAt: daysAgo(1) })]);
    const snap = buildSnapshot({ db, sources: SOURCES, env: {}, now: NOW });
    assert.equal(snap.items.length, 1);
    assert.equal(snap.archive, null);
    assert.equal(snap.sources.sources.length, 2);
    assert.equal(snap.stats.generatedAt, NOW.toISOString());
    assert.equal(snap.stats.archiveItems, 0);

    const split = buildSnapshot({ db, sources: SOURCES, env: {}, now: NOW, limits: { maxDays: 90, maxItems: 10, primaryMaxItems: 0, primaryMaxBytes: 1 } });
    assert.equal(split.items.length, 0);
    assert.equal(split.archive.length, 1);
    assert.equal(split.stats.archiveItems, 1);
  });
});
