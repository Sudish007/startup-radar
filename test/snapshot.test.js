import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { normalizeItem } from '../src/lib/normalize.js';
import { HttpError } from '../src/lib/http.js';
import { itemsPayload } from '../src/export.js';
import { fetchSnapshot, importSnapshotItems, importSnapshotStatuses } from '../src/snapshot.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const FETCHED = '2026-09-30T08:00:00.000Z';
const HN = { id: 'hn_show', name: 'Hacker News: Show HN', homepage: 'https://news.ycombinator.com/show', kind: 'launch', region: 'global', enabled: () => true, requires: null };
const TC = { id: 'techcrunch', name: 'TechCrunch', homepage: 'https://techcrunch.com/', kind: 'news', region: 'usa', enabled: () => true, requires: null };
const SOURCES = [HN, TC];

function daysAgo(n) {
  return new Date(NOW.getTime() - n * 24 * 3600_000).toISOString();
}

function seed(db) {
  db.upsertItems('hn_show', [
    normalizeItem({ title: 'Show HN: Copilot for sheets', url: 'https://a.io/1', summary: 'A tool', publishedAt: daysAgo(1), extra: { points: 12 } }, HN, FETCHED),
    normalizeItem({ title: 'Show HN: Terminal thing', url: 'https://a.io/2', publishedAt: daysAgo(3) }, HN, FETCHED),
  ]);
  db.upsertItems('techcrunch', [
    normalizeItem({ title: 'Acme raises $5M seed in Berlin', url: 'https://t.io/1', publishedAt: daysAgo(2) }, TC, FETCHED),
  ]);
}

describe('importSnapshotItems', () => {
  test('round trip A -> itemsPayload -> B preserves counts, classification and fetchedAt', () => {
    const a = openDb(':memory:');
    const b = openDb(':memory:');
    try {
      seed(a);
      const { items } = itemsPayload({ db: a, sources: SOURCES, now: NOW });
      assert.equal(items.length, 3);

      const logs = [];
      const r = importSnapshotItems(b, SOURCES, items, { log: (l) => logs.push(l), nowIso: NOW.toISOString(), url: 'https://x.test/data/items.json' });
      assert.deepEqual(r, { imported: 3, invalid: 0, unknownSource: 0 });
      assert.equal(logs.length, 1);
      assert.equal(logs[0], '[build] snapshot: imported 3 items (0 invalid, 0 unknown source) from https://x.test/data/items.json');

      const back = itemsPayload({ db: b, sources: SOURCES, now: NOW }).items;
      assert.equal(back.length, 3);
      assert.deepEqual(back.map((i) => i.title), items.map((i) => i.title));
      assert.deepEqual(back.map((i) => i.kind), items.map((i) => i.kind));
      assert.deepEqual(back.map((i) => i.region), items.map((i) => i.region));
      assert.deepEqual(back.map((i) => i.publishedAt), items.map((i) => i.publishedAt));
      assert.deepEqual(back.map((i) => i.source.id), items.map((i) => i.source.id));
      assert.ok(back.every((i) => i.fetchedAt === FETCHED));
      assert.equal(back.find((i) => i.url === 'https://a.io/1').extra.points, 12);
      assert.equal(back.find((i) => i.url === 'https://t.io/1').kind, 'funding');
      assert.equal(back.find((i) => i.url === 'https://t.io/1').region, 'europe');
    } finally {
      a.close();
      b.close();
    }
  });

  test('skips unknown sources, counts invalid rows, defaults fetchedAt', () => {
    const db = openDb(':memory:');
    try {
      const r = importSnapshotItems(
        db,
        SOURCES,
        [
          { title: 'Known', url: 'https://a.io/1', source: { id: 'hn_show' }, publishedAt: daysAgo(1), fetchedAt: 'garbage' },
          { title: 'Ghost', url: 'https://g.io/1', source: { id: 'gone_source' }, publishedAt: daysAgo(1) },
          { title: 'No url', source: { id: 'hn_show' }, publishedAt: daysAgo(1) },
          { title: 'No source', url: 'https://a.io/3' },
          null,
        ],
        { log: () => {}, nowIso: NOW.toISOString() },
      );
      assert.deepEqual(r, { imported: 1, invalid: 1, unknownSource: 3 });
      const items = db.listItems();
      assert.equal(items.length, 1);
      assert.equal(items[0].title, 'Known');
      assert.equal(items[0].fetchedAt, NOW.toISOString());
    } finally {
      db.close();
    }
  });

  test('tolerates null input', () => {
    const db = openDb(':memory:');
    try {
      assert.deepEqual(importSnapshotItems(db, SOURCES, null, { log: () => {} }), { imported: 0, invalid: 0, unknownSource: 0 });
    } finally {
      db.close();
    }
  });

  test('a later same-source upsert updates the imported title (live wins)', () => {
    const db = openDb(':memory:');
    try {
      importSnapshotItems(db, SOURCES, [
        { title: 'Old title', url: 'https://a.io/1', source: { id: 'hn_show' }, publishedAt: daysAgo(1), fetchedAt: FETCHED },
      ], { log: () => {} });
      db.upsertItems('hn_show', [normalizeItem({ title: 'New title', url: 'https://a.io/1', publishedAt: daysAgo(1) }, HN, NOW.toISOString())]);
      const items = db.listItems();
      assert.equal(items.length, 1);
      assert.equal(items[0].title, 'New title');
      assert.equal(items[0].fetchedAt, NOW.toISOString());
    } finally {
      db.close();
    }
  });
});

describe('importSnapshotStatuses', () => {
  test('seeds lastSuccessAt and a later failure keeps it', () => {
    const db = openDb(':memory:');
    try {
      const r = importSnapshotStatuses(db, SOURCES, {
        sources: [
          { id: 'hn_show', lastRunAt: '2026-10-02T10:00:00.000Z', lastSuccessAt: '2026-10-02T10:00:00.000Z', lastError: null, lastDurationMs: 300, lastItemCount: 40 },
          { id: 'unknown', lastRunAt: '2026-10-02T10:00:00.000Z', lastSuccessAt: '2026-10-02T10:00:00.000Z' },
          null,
        ],
      });
      assert.deepEqual(r, { seeded: 1 });
      let st = db.getSourceStatuses().get('hn_show');
      assert.equal(st.last_success_at, '2026-10-02T10:00:00.000Z');
      assert.equal(st.last_item_count, 40);
      assert.equal(db.getSourceStatuses().has('unknown'), false);
      assert.equal(db.lastRefresh(), '2026-10-02T10:00:00.000Z');

      db.setSourceStatus('hn_show', { last_run_at: '2026-10-02T11:00:00.000Z', last_success_at: null, last_error: 'HTTP 503', last_duration_ms: 5, last_item_count: null });
      st = db.getSourceStatuses().get('hn_show');
      assert.equal(st.last_success_at, '2026-10-02T10:00:00.000Z');
      assert.equal(st.last_error, 'HTTP 503');
      assert.equal(st.last_run_at, '2026-10-02T11:00:00.000Z');
    } finally {
      db.close();
    }
  });

  test('tolerates null and malformed input', () => {
    const db = openDb(':memory:');
    try {
      assert.deepEqual(importSnapshotStatuses(db, SOURCES, null), { seeded: 0 });
      assert.deepEqual(importSnapshotStatuses(db, SOURCES, { sources: 'nope' }), { seeded: 0 });
      assert.equal(db.getSourceStatuses().size, 0);
    } finally {
      db.close();
    }
  });
});

describe('fetchSnapshot', () => {
  const BASE = 'https://x.test/startup-radar/data/items.json';

  function fakeHttp(handler) {
    const calls = [];
    return {
      calls,
      fetchText: async (url, opts) => {
        calls.push({ url, opts });
        return handler(url);
      },
    };
  }

  test('404 for every file -> all null, no throw, no retry', async () => {
    const http = fakeHttp((url) => { throw new HttpError(404, url); });
    const logs = [];
    const snap = await fetchSnapshot(BASE, { http, log: (l) => logs.push(l), retryDelayMs: 0 });
    assert.deepEqual(snap, { items: null, archive: null, sources: null, signals: null });
    assert.equal(http.calls.length, 4);
    assert.deepEqual(http.calls.map((c) => c.url), [
      BASE,
      'https://x.test/startup-radar/data/archive.json',
      'https://x.test/startup-radar/data/sources.json',
      'https://x.test/startup-radar/data/signals.json',
    ]);
    assert.equal(logs[0], `[build] snapshot: none (HTTP 404 for ${BASE})`);
    assert.deepEqual(http.calls[0].opts, { timeoutMs: 15000, maxBytes: 20_000_000 });
  });

  test('persistent timeout -> null after 3 attempts per file', async () => {
    const http = fakeHttp(() => { throw new Error('The operation was aborted due to timeout'); });
    const logs = [];
    const snap = await fetchSnapshot(BASE, { http, log: (l) => logs.push(l), retryDelayMs: 1 });
    assert.deepEqual(snap, { items: null, archive: null, sources: null, signals: null });
    assert.equal(http.calls.length, 12);
    assert.ok(logs.some((l) => l.includes('giving up') && l.includes(BASE)));
  });

  test('transient failure then success returns the parsed payload', async () => {
    let n = 0;
    const http = fakeHttp((url) => {
      if (url === BASE && n++ === 0) throw new HttpError(503, url);
      if (url.endsWith('items.json')) return { text: JSON.stringify([{ title: 'a' }]) };
      throw new HttpError(404, url);
    });
    const snap = await fetchSnapshot(BASE, { http, log: () => {}, retryDelayMs: 0 });
    assert.deepEqual(snap.items, [{ title: 'a' }]);
    assert.equal(snap.archive, null);
    assert.equal(snap.sources, null);
    assert.equal(snap.signals, null, 'a 404 on signals.json (first Phase-2 build) is tolerated');
    assert.equal(http.calls.filter((c) => c.url === BASE).length, 2);
  });

  test('success -> arrays and sources object; bad shapes and bad JSON -> null', async () => {
    const http = fakeHttp((url) => {
      if (url.endsWith('items.json')) return { text: JSON.stringify([{ title: 'a' }, { title: 'b' }]) };
      if (url.endsWith('archive.json')) return { text: JSON.stringify([{ title: 'c' }]) };
      if (url.endsWith('signals.json')) return { text: JSON.stringify({ generatedAt: '2026-10-01T00:00:00.000Z', signals: [{ id: 'ask_hn', ok: true, data: { posts: [] } }] }) };
      return { text: JSON.stringify({ sources: [{ id: 'hn_show' }], exploreMore: [] }) };
    });
    const snap = await fetchSnapshot(BASE, { http, log: () => {}, retryDelayMs: 0 });
    assert.equal(snap.items.length, 2);
    assert.equal(snap.archive.length, 1);
    assert.deepEqual(snap.sources.sources, [{ id: 'hn_show' }]);
    assert.equal(snap.signals.signals[0].id, 'ask_hn');

    const bad = fakeHttp((url) => {
      if (url.endsWith('items.json')) return { text: '{"not":"an array"}' };
      if (url.endsWith('archive.json')) return { text: 'not json' };
      if (url.endsWith('signals.json')) return { text: JSON.stringify({ signals: 'nope' }) };
      return { text: '[]' };
    });
    const logs = [];
    const snap2 = await fetchSnapshot(BASE, { http: bad, log: (l) => logs.push(l), retryDelayMs: 0 });
    assert.deepEqual(snap2, { items: null, archive: null, sources: null, signals: null });
    assert.equal(bad.calls.length, 4);
    assert.ok(logs.some((l) => l.includes('unexpected shape') && l.endsWith('signals.json')), 'signals.json with a non-array signals field is rejected');
    assert.ok(logs.some((l) => l.includes('unexpected shape')));
    assert.ok(logs.some((l) => l.includes('invalid JSON')));
  });
});
