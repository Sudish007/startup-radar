import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../src/lib/http.js';
import { runBuild } from '../src/build-static.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const SNAPSHOT_URL = 'https://x.test/startup-radar/data/items.json';

function daysAgo(n) {
  return new Date(NOW.getTime() - n * 24 * 3600_000).toISOString();
}

const okSource = {
  id: 'stub_ok',
  name: 'Stub OK',
  homepage: 'https://ok.test/',
  kind: 'launch',
  region: 'global',
  enabled: () => true,
  requires: null,
  async fetch() {
    return [
      { title: 'Live one', url: 'https://ok.test/one', publishedAt: daysAgo(0) },
      { title: 'Live two', url: 'https://ok.test/two', publishedAt: daysAgo(2) },
    ];
  },
};

const failingSource = {
  id: 'stub_fail',
  name: 'Stub Fail',
  homepage: 'https://fail.test/',
  kind: 'news',
  region: 'usa',
  enabled: () => true,
  requires: null,
  async fetch() {
    throw new Error('boom 503');
  },
};

const SNAPSHOT_ITEMS = [
  { id: 1, title: 'Snapshot item', url: 'https://ok.test/old', source: { id: 'stub_ok', name: 'Stub OK' }, kind: 'launch', region: 'global', summary: '', publishedAt: daysAgo(1), fetchedAt: daysAgo(1), extra: {} },
  { id: 2, title: 'Ghost item', url: 'https://ghost.test/1', source: { id: 'ghost', name: 'Ghost' }, kind: 'launch', region: 'global', summary: '', publishedAt: daysAgo(1), fetchedAt: daysAgo(1), extra: {} },
];

function snapshotHttp() {
  return {
    fetchText: async (url) => {
      if (url === SNAPSHOT_URL) return { text: JSON.stringify(SNAPSHOT_ITEMS) };
      throw new HttpError(404, url);
    },
  };
}

function notFoundHttp() {
  return { fetchText: async (url) => { throw new HttpError(404, url); } };
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('runBuild', () => {
  let tmp;
  let outDir;
  let publicDir;
  let logs;
  const log = (l) => logs.push(l);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-radar-test-'));
    outDir = path.join(tmp, 'dist');
    publicDir = path.join(tmp, 'public');
    fs.mkdirSync(publicDir);
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>Startup Radar</h1>');
    fs.writeFileSync(path.join(publicDir, 'app.js'), 'export {};');
    logs = [];
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function build(overrides = {}) {
    return runBuild({
      sources: [failingSource, okSource],
      http: snapshotHttp(),
      env: {},
      log,
      outDir,
      publicDir,
      dbPath: ':memory:',
      snapshotUrl: SNAPSHOT_URL,
      now: NOW,
      ...overrides,
    });
  }

  test('imports the snapshot, runs the live cycle and writes dist/', async () => {
    const r = await build();
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.counts, {
      imported: 1, live: 2, sourcesOk: 1, sourcesEnabled: 2, exported: 3,
      items: 3, itemsBytes: fs.statSync(path.join(outDir, 'data', 'items.json')).size, archive: 0, archiveBytes: 0,
    });

    assert.ok(fs.existsSync(path.join(outDir, '.nojekyll')));
    assert.equal(fs.readFileSync(path.join(outDir, '.nojekyll'), 'utf8'), '');
    assert.equal(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), '<h1>Startup Radar</h1>');
    assert.ok(fs.existsSync(path.join(outDir, 'app.js')));
    assert.equal(fs.existsSync(path.join(outDir, 'data', 'archive.json')), false);

    const items = readJson(path.join(outDir, 'data', 'items.json'));
    assert.deepEqual(items.map((i) => i.title), ['Live one', 'Snapshot item', 'Live two']);
    assert.ok(items.every((i) => i.source.name === 'Stub OK'));

    const sources = readJson(path.join(outDir, 'data', 'sources.json'));
    assert.equal(sources.sources.length, 2);
    const fail = sources.sources.find((s) => s.id === 'stub_fail');
    assert.equal(fail.lastError, 'boom 503');
    assert.equal(fail.lastSuccessAt, null);
    assert.equal(sources.sources.find((s) => s.id === 'stub_ok').itemCount, 3);
    assert.ok(Array.isArray(sources.exploreMore));

    const stats = readJson(path.join(outDir, 'data', 'stats.json'));
    assert.equal(stats.generatedAt, NOW.toISOString());
    assert.equal(stats.archiveItems, 0);
    assert.equal(stats.items, 3);
    assert.equal(typeof stats.lastRefresh, 'string');

    assert.ok(logs.some((l) => l === `[build] snapshot: imported 1 items (0 invalid, 1 unknown source) from ${SNAPSHOT_URL}`));
    assert.ok(logs.some((l) => l.startsWith('source ') && l.includes('| status')));
    assert.ok(logs.some((l) => l.startsWith('stub_fail') && l.includes('FAIL') && l.includes('boom 503')));
    assert.ok(logs.some((l) => l === '1/2 enabled sources OK in ' + r.summary.durationMs + ' ms'));
    const final = logs.at(-1);
    assert.match(final, /^\[build\] imported 1 from snapshot, fetched 2 live \(1 sources OK of 2 enabled\), exported 3 items \(items\.json 3 items \/ [\d.]+ KB\)$/);
  });

  test('snapshot 404 -> exit 0 with only live items', async () => {
    const r = await build({ http: notFoundHttp() });
    assert.equal(r.exitCode, 0);
    assert.equal(r.counts.imported, 0);
    const items = readJson(path.join(outDir, 'data', 'items.json'));
    assert.deepEqual(items.map((i) => i.title), ['Live one', 'Live two']);
    assert.ok(logs.includes(`[build] snapshot: none (HTTP 404 for ${SNAPSHOT_URL})`));
    assert.ok(logs.at(-1).startsWith('[build] imported 0 from snapshot, fetched 2 live'));
  });

  test('no snapshot URL -> logs the empty start', async () => {
    const r = await build({ snapshotUrl: null, http: {} });
    assert.equal(r.exitCode, 0);
    assert.ok(logs.includes('[build] snapshot: PREVIOUS_SNAPSHOT_URL not set, starting empty'));
  });

  test('all sources failing -> exit 1 and nothing written', async () => {
    const r = await build({ sources: [failingSource], http: notFoundHttp() });
    assert.equal(r.exitCode, 1);
    assert.equal(fs.existsSync(outDir), false);
    assert.ok(logs.includes('[build] FAIL: no source returned items'));
  });

  test('replaces a stale outDir', async () => {
    fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'stale.txt'), 'old');
    fs.writeFileSync(path.join(outDir, 'data', 'archive.json'), '[]');
    const r = await build();
    assert.equal(r.exitCode, 0);
    assert.equal(fs.existsSync(path.join(outDir, 'stale.txt')), false);
    assert.equal(fs.existsSync(path.join(outDir, 'data', 'archive.json')), false);
  });
});
