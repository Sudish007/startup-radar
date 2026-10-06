import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, buildFtsQuery } from '../src/db.js';
import { normalizeItem } from '../src/lib/normalize.js';

const NOW = '2026-10-02T12:00:00.000Z';
const HN = { id: 'hn_show', kind: 'launch', region: 'global' };
const TC = { id: 'techcrunch', kind: 'news', region: 'usa' };

function row(source, overrides) {
  return normalizeItem({ title: 'Item', url: 'https://example.com/x', ...overrides }, source, NOW);
}

describe('db', () => {
  let db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  test('schema creates and starts empty', () => {
    assert.equal(db.countItems(), 0);
    assert.equal(db.lastRefresh(), null);
    assert.equal(typeof db.ftsAvailable, 'boolean');
  });

  test('utm variant of the same url dedupes to one row', () => {
    const a = row(HN, { url: 'https://acme.io/launch' });
    const b = row(HN, { url: 'https://acme.io/launch?utm_source=x', title: 'Item v2' });
    const r = db.upsertItems('hn_show', [a, b]);
    assert.equal(r.attempted, 2);
    assert.equal(db.countItems(), 1);
    assert.equal(db.queryItems({}).items[0].title, 'Item v2');
  });

  test('same url from another source is ignored (first source wins)', () => {
    db.upsertItems('hn_show', [row(HN, { url: 'https://acme.io/a', title: 'From HN' })]);
    db.upsertItems('techcrunch', [row(TC, { url: 'https://acme.io/a', title: 'From TC' })]);
    assert.equal(db.countItems(), 1);
    const item = db.queryItems({}).items[0];
    assert.equal(item.title, 'From HN');
    assert.equal(item.source.id, 'hn_show');
  });

  test('same-source refresh updates mutable fields including extra_json', () => {
    db.upsertItems('hn_show', [row(HN, { url: 'https://acme.io/a', extra: { points: 1 } })]);
    db.upsertItems('hn_show', [row(HN, { url: 'https://acme.io/a', extra: { points: 50 }, summary: 'new' })]);
    assert.equal(db.countItems(), 1);
    const item = db.queryItems({}).items[0];
    assert.equal(item.extra.points, 50);
    assert.equal(item.summary, 'new');
  });

  test('upsertItems only accepts rows for the given source', () => {
    const r = db.upsertItems('hn_show', [row(TC, { url: 'https://acme.io/b' })]);
    assert.equal(r.attempted, 0);
    assert.equal(db.countItems(), 0);
  });

  test('queryItems filters, orders and paginates', () => {
    db.upsertItems('hn_show', [
      row(HN, { url: 'https://a.io/1', title: 'Launch one', publishedAt: '2026-10-02T10:00:00Z' }),
      row(HN, { url: 'https://a.io/2', title: 'Launch two', publishedAt: '2026-10-01T10:00:00Z' }),
    ]);
    db.upsertItems('techcrunch', [
      row(TC, { url: 'https://t.io/1', title: 'Acme raises $5M seed', publishedAt: '2026-10-02T11:00:00Z' }),
      row(TC, { url: 'https://t.io/2', title: 'Berlin startup grows', publishedAt: '2026-09-20T11:00:00Z' }),
    ]);
    assert.equal(db.countItems(), 4);

    const all = db.queryItems({});
    assert.equal(all.total, 4);
    assert.deepEqual(all.items.map((i) => i.title), ['Acme raises $5M seed', 'Launch one', 'Launch two', 'Berlin startup grows']);

    assert.equal(db.queryItems({ kind: 'funding' }).total, 1);
    assert.equal(db.queryItems({ kind: 'launch' }).total, 2);
    assert.equal(db.queryItems({ region: 'usa' }).total, 1);
    const world = db.queryItems({ region: 'world' });
    assert.equal(world.total, 3);
    assert.ok(world.items.every((i) => i.region !== 'usa'));
    assert.equal(db.queryItems({ region: 'europe' }).total, 1);
    assert.equal(db.queryItems({ sources: ['techcrunch'] }).total, 2);
    assert.equal(db.queryItems({ sources: ['techcrunch', 'hn_show'] }).total, 4);
    assert.equal(db.queryItems({ since: '2026-10-02T00:00:00.000Z' }).total, 2);

    const p1 = db.queryItems({ page: 1, limit: 3 });
    assert.equal(p1.items.length, 3);
    assert.equal(p1.total, 4);
    const p2 = db.queryItems({ page: 2, limit: 3 });
    assert.equal(p2.items.length, 1);
    assert.equal(p2.items[0].title, 'Berlin startup grows');
  });

  test('search finds a title word (FTS or LIKE)', () => {
    db.upsertItems('hn_show', [
      row(HN, { url: 'https://a.io/1', title: 'Show HN: Spreadsheet copilot' }),
      row(HN, { url: 'https://a.io/2', title: 'Show HN: Terminal multiplexer', summary: 'A tiny copilot for your shell' }),
      row(HN, { url: 'https://a.io/3', title: 'Unrelated' }),
    ]);
    const r = db.queryItems({ q: 'copilot' });
    assert.equal(r.total, 2);
    assert.equal(db.queryItems({ q: 'multiplexer' }).total, 1);
    assert.equal(db.queryItems({ q: 'nothing-here' }).total, 0);
    // quotes and operators must not break the query
    assert.equal(db.queryItems({ q: '"copilot" OR NEAR(' }).total >= 0, true);
  });

  test('search really uses FTS5: word-prefix AND semantics, no LIKE fallback, no warning', () => {
    const warnings = [];
    const fts = openDb(':memory:', { warn: (m) => warnings.push(m) });
    try {
      assert.equal(fts.ftsAvailable, true, 'FTS5 must be compiled into better-sqlite3');
      fts.upsertItems('hn_show', [
        row(HN, { url: 'https://a.io/1', title: 'Brainstorm app for teams', summary: 'Shows ideas as a map' }),
        row(HN, { url: 'https://a.io/2', title: 'Heavy rain forecast', summary: 'Weather for showcases' }),
        row(HN, { url: 'https://a.io/3', title: 'AI pilots for planes' }),
      ]);
      // mid-word substrings: LIKE '%storm%' / '%pilot%' would match, prefix FTS must not
      assert.equal(fts.queryItems({ q: 'storm' }).total, 0);
      assert.equal(fts.queryItems({ q: 'ain' }).total, 0);
      // word prefixes match ("Show" -> Shows, showcases; "ai" -> AI but not rain)
      assert.deepEqual(fts.queryItems({ q: 'Show' }).items.map((i) => i.url).sort(), ['https://a.io/1', 'https://a.io/2']);
      assert.deepEqual(fts.queryItems({ q: 'ai' }).items.map((i) => i.url), ['https://a.io/3']);
      assert.equal(fts.queryItems({ q: 'brain' }).total, 1);
      // every term is required
      assert.equal(fts.queryItems({ q: 'brain team' }).total, 1);
      assert.equal(fts.queryItems({ q: 'brain rain' }).total, 0);
      // arbitrary punctuation / operators never raise an FTS syntax error (and never fall back)
      for (const q of ['"brain" OR NEAR(', 'brain*', '(rain) -ai', 'a:b', '^ai', '"', 'NOT AND OR']) {
        assert.equal(typeof fts.queryItems({ q }).total, 'number', q);
      }
      assert.deepEqual(warnings, []);
    } finally {
      fts.close();
    }
  });

  test('LIKE fallback logs one warning with the SQLite error', () => {
    const warnings = [];
    const d = openDb(':memory:', { warn: (m) => warnings.push(m) });
    try {
      d.upsertItems('hn_show', [row(HN, { url: 'https://a.io/1', title: 'Brainstorm app' })]);
      d._sqlite.exec('DROP TABLE items_fts');
      assert.equal(d.queryItems({ q: 'storm' }).total, 1); // LIKE substring hit
      assert.equal(d.queryItems({ q: 'storm' }).total, 1);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /falling back to LIKE/);
      assert.match(warnings[0], /no such table: items_fts/);
    } finally {
      d.close();
    }
  });

  test('buildFtsQuery sanitizes tokens into quoted prefixes', () => {
    assert.equal(buildFtsQuery('a "b" c'), '"a"* "b"* "c"*');
    assert.equal(buildFtsQuery('Fin AI-powered'), '"fin"* "ai"* "powered"*');
    assert.equal(buildFtsQuery('"x" OR NEAR( ^ -'), '"x"* "or"* "near"*');
    assert.equal(buildFtsQuery('   '), null);
    assert.equal(buildFtsQuery('"" ()'), null);
    assert.equal(buildFtsQuery('1 2 3 4 5 6 7 8 9 10').split(' ').length, 8);
  });

  test('setSourceStatus keeps last_success_at on failure and lastRefresh reflects it', () => {
    db.setSourceStatus('hn_show', {
      last_run_at: '2026-10-02T10:00:00.000Z',
      last_success_at: '2026-10-02T10:00:00.000Z',
      last_error: null,
      last_duration_ms: 120,
      last_item_count: 50,
    });
    db.setSourceStatus('hn_show', {
      last_run_at: '2026-10-02T10:30:00.000Z',
      last_success_at: null,
      last_error: 'HTTP 503',
      last_duration_ms: 20,
      last_item_count: null,
    });
    const st = db.getSourceStatuses().get('hn_show');
    assert.equal(st.last_success_at, '2026-10-02T10:00:00.000Z');
    assert.equal(st.last_run_at, '2026-10-02T10:30:00.000Z');
    assert.equal(st.last_error, 'HTTP 503');
    assert.equal(st.last_item_count, 50);
    assert.equal(db.lastRefresh(), '2026-10-02T10:00:00.000Z');
  });

  test('getStats aggregates counts', () => {
    const recent = new Date(Date.now() - 3600_000).toISOString();
    db.upsertItems('hn_show', [row(HN, { url: 'https://a.io/1', publishedAt: recent })]);
    db.upsertItems('techcrunch', [row(TC, { url: 'https://t.io/1', publishedAt: '2020-01-01T00:00:00Z' })]);
    const stats = db.getStats();
    assert.equal(stats.items, 2);
    assert.equal(stats.last24h, 1);
    assert.equal(stats.last7d, 1);
    assert.deepEqual(stats.bySource, { hn_show: 1, techcrunch: 1 });
    assert.deepEqual(stats.byKind, { launch: 1, news: 1 });
    assert.deepEqual(stats.byRegion, { global: 1, usa: 1 });
    assert.equal(stats.lastRefresh, null);
    assert.deepEqual(db.itemCountsBySource(), { hn_show: 1, techcrunch: 1 });
  });

  test('listItems filters by sourceId, alone and combined with since', () => {
    db.upsertItems('hn_show', [
      row(HN, { url: 'https://a.io/1', title: 'HN new', publishedAt: '2026-10-02T10:00:00Z' }),
      row(HN, { url: 'https://a.io/2', title: 'HN old', publishedAt: '2020-01-01T00:00:00Z' }),
    ]);
    db.upsertItems('techcrunch', [row(TC, { url: 'https://t.io/1', title: 'TC new', publishedAt: '2026-10-02T11:00:00Z' })]);
    assert.deepEqual(db.listItems({ sourceId: 'hn_show' }).map((i) => i.title), ['HN new', 'HN old']);
    assert.deepEqual(db.listItems({ sourceId: 'techcrunch' }).map((i) => i.title), ['TC new']);
    assert.deepEqual(db.listItems({ sourceId: 'hn_show', since: '2026-01-01T00:00:00Z' }).map((i) => i.title), ['HN new']);
    assert.deepEqual(db.listItems({ sourceId: 'hn_show', limit: 1 }).map((i) => i.title), ['HN new']);
    assert.deepEqual(db.listItems({ sourceId: 'nope' }), []);
    assert.equal(db.listItems({}).length, 3, 'no sourceId -> every source');
    assert.equal(db.listItems({ sourceId: undefined }).length, 3);
  });
});
