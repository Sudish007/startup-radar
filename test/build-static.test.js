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
    const dataSize = (name) => fs.statSync(path.join(outDir, 'data', name)).size;
    assert.deepEqual(r.counts, {
      imported: 1, live: 2, sourcesOk: 1, sourcesEnabled: 2, exported: 3,
      items: 3, itemsBytes: dataSize('items.json'), archive: 0, archiveBytes: 0,
      trendsBytes: dataSize('trends.json'), fundingBytes: dataSize('funding.json'), ycBytes: dataSize('yc.json'),
      signalsBytes: dataSize('signals.json'), digestBytes: dataSize('digest.json'), feedBytes: fs.statSync(path.join(outDir, 'feed.xml')).size,
    });

    assert.ok(fs.existsSync(path.join(outDir, '.nojekyll')));
    assert.equal(fs.readFileSync(path.join(outDir, '.nojekyll'), 'utf8'), '');
    assert.equal(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), '<h1>Startup Radar</h1>');
    assert.ok(fs.existsSync(path.join(outDir, 'app.js')));
    assert.equal(fs.existsSync(path.join(outDir, 'data', 'archive.json')), false);

    const items = readJson(path.join(outDir, 'data', 'items.json'));
    assert.deepEqual(items.map((i) => i.title), ['Live one', 'Snapshot item', 'Live two']);
    assert.ok(items.every((i) => i.source.name === 'Stub OK'));
    assert.ok(items.every((i) => Array.isArray(i.sectors)), 'every exported item carries sectors');

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
    assert.equal(stats.sectors.length, 15);
    assert.ok(stats.sectors.every((s) => typeof s.id === 'string' && typeof s.label === 'string' && Number.isInteger(s.count)));

    const trends = readJson(path.join(outDir, 'data', 'trends.json'));
    assert.equal(trends.generatedAt, NOW.toISOString());
    assert.ok(Array.isArray(trends.terms));
    assert.equal(trends.weeks.length, 12);
    assert.equal(trends.bySector.length, 15);
    assert.equal(trends.thisWeek.partial, true);
    const funding = readJson(path.join(outDir, 'data', 'funding.json'));
    assert.deepEqual(funding.items, []);
    assert.deepEqual(funding.coverage, { items: 0, withAmount: 0, withStage: 0 });
    assert.equal(typeof funding.fx.asOf, 'string');
    assert.equal(funding.totals.bySector.length, 15);
    const yc = readJson(path.join(outDir, 'data', 'yc.json'));
    assert.deepEqual(yc.companies, []);
    assert.equal(yc.attribution, 'Source: yc-oss open API mirror of ycombinator.com. This page is rebuilt on an hourly schedule; GitHub runs it a few times a day in practice - see the generated time above.');
    assert.equal(/refreshed hourly/i.test(yc.attribution), false, 'no "refreshed hourly" promise (the schedule is not honoured hourly in practice)');
    assert.equal(yc.teamSize.buckets.length, 7);
    assert.ok(logs.some((l) => /^\[build\] derived trends\.json [\d.]+ KB, funding\.json [\d.]+ KB, yc\.json [\d.]+ KB$/.test(l)), 'derived size line');
    assert.ok(logs.some((l) => /^\[build\] derived signals\.json [\d.]+ KB, digest\.json [\d.]+ KB, feed\.xml [\d.]+ KB$/.test(l)), 'phase-2 size line');

    const signals = readJson(path.join(outDir, 'data', 'signals.json'));
    assert.deepEqual(signals, { generatedAt: NOW.toISOString(), signals: [] }, 'no signals passed -> empty payload, still written');
    const digest = readJson(path.join(outDir, 'data', 'digest.json'));
    assert.equal(digest.generatedAt, NOW.toISOString());
    assert.equal(digest.weeks.length, 12);
    assert.equal(digest.weeks.at(-1).partial, true);
    const feed = fs.readFileSync(path.join(outDir, 'feed.xml'), 'utf8');
    assert.ok(feed.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
    assert.equal((feed.match(/<entry>/g) ?? []).length, 12);
    assert.ok(feed.includes('<id>http://localhost:3000/feed.xml</id>'), 'publicUrl falls back to localhost when env.PUBLIC_URL is unset');
    assert.equal(logs.some((l) => l.startsWith('signal ')), false, 'no signals table without signals');

    assert.ok(logs.some((l) => l === `[build] snapshot: imported 1 items (0 invalid, 1 unknown source) from ${SNAPSHOT_URL}`));
    assert.ok(logs.some((l) => l.startsWith('source ') && l.includes('| status')));
    assert.ok(logs.some((l) => l.startsWith('stub_fail') && l.includes('FAIL') && l.includes('boom 503')));
    assert.ok(logs.some((l) => l === '1/2 enabled sources OK in ' + r.summary.durationMs + ' ms'));
    const final = logs.at(-1);
    assert.match(final, /^\[build\] imported 1 from snapshot, fetched 2 live \(1 sources OK of 2 enabled\), exported 3 items \(items\.json 3 items \/ [\d.]+ KB\)$/);
  });

  test('without public/sw.js no sw-version line is logged', async () => {
    const r = await build();
    assert.equal(r.exitCode, 0);
    assert.equal(fs.existsSync(path.join(outDir, 'sw.js')), false);
    assert.equal(logs.filter((l) => l.startsWith('[build] sw version')).length, 0);
  });

  test('replaces __BUILD_VERSION__ in dist/sw.js and logs the sw version before the summary', async () => {
    fs.writeFileSync(path.join(publicDir, 'sw.js'), "const VERSION = '__BUILD_VERSION__';\nconst CACHE = `sr-shell-${VERSION}`; // __BUILD_VERSION__\n");
    const r = await build({ buildVersion: 'abc123' });
    assert.equal(r.exitCode, 0);
    const sw = fs.readFileSync(path.join(outDir, 'sw.js'), 'utf8');
    assert.ok(sw.includes("const VERSION = 'abc123'"));
    assert.ok(!sw.includes('__BUILD_VERSION__'), 'every occurrence replaced');
    const versionLines = logs.filter((l) => l.startsWith('[build] sw version'));
    assert.deepEqual(versionLines, ['[build] sw version abc123']);
    assert.ok(logs.indexOf('[build] sw version abc123') < logs.length - 1, 'logged before the final summary');
    assert.match(logs.at(-1), /^\[build\] imported 1 from snapshot, fetched 2 live \(1 sources OK of 2 enabled\), exported 3 items \(items\.json 3 items \/ [\d.]+ KB\)$/);
    assert.equal(fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8').includes('__BUILD_VERSION__'), true, 'the source file is untouched');
  });

  test('buildVersion defaults to GITHUB_SHA (12 chars) or the timestamp of `now`', async () => {
    fs.writeFileSync(path.join(publicDir, 'sw.js'), "const VERSION = '__BUILD_VERSION__';");
    let r = await build({ env: { GITHUB_SHA: 'abcdef0123456789abcdef0123456789abcdef01' } });
    assert.equal(r.exitCode, 0);
    assert.ok(logs.includes('[build] sw version abcdef012345'));
    logs = [];
    r = await build({ env: {} });
    assert.equal(r.exitCode, 0);
    assert.ok(logs.includes('[build] sw version 20261002120000'), logs.filter((l) => l.startsWith('[build] sw')).join());
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

  test('yc.json above the size limit -> exit 1 after logging the sizes', async () => {
    const bigYc = {
      id: 'yc', name: 'YC stub', homepage: 'https://yc.test/', kind: 'accelerator', region: 'usa', enabled: () => true, requires: null,
      async fetch() {
        return Array.from({ length: 1500 }, (_, i) => ({
          title: `Company ${i}`,
          url: `https://yc.test/companies/c${i}`,
          summary: 'x'.repeat(120),
          publishedAt: daysAgo(1),
          extra: { batch: 'Fall 2026', oneLiner: 'y'.repeat(120), tags: ['a', 'b', 'c', 'd', 'e'], teamSize: 4, status: 'Active', stage: 'Early', industry: 'B2B' },
        }));
      },
    };
    const r = await build({ sources: [bigYc], http: notFoundHttp() });
    assert.equal(r.exitCode, 1);
    assert.ok(logs.some((l) => l.startsWith('[build] derived trends.json')));
    assert.ok(logs.some((l) => /^\[build\] FAIL: yc\.json is \d+ bytes \(limit 300000\)$/.test(l)), logs.at(-1));
  });

  const okSignal = {
    id: 'sig_ok', name: 'Sig OK', homepage: 'https://sig.test/', description: 'counts', enabled: () => true, requires: null,
    async fetch() { return { posts: [{ title: 'a' }, { title: 'b' }] }; },
  };
  const failSignal = {
    id: 'sig_fail', name: 'Sig Fail', homepage: 'https://fail.test/topics', description: 'counts', enabled: () => true, requires: null,
    async fetch() { throw new HttpError(403, 'https://fail.test/api'); },
  };
  const gatedSignal = {
    id: 'sig_gated', name: 'Sig Gated', homepage: 'https://gated.test/', description: 'counts', enabled: (env) => Boolean(env.SIG_TOKEN), requires: 'SIG_TOKEN',
    async fetch() { return { topics: [] }; },
  };

  test('signals: data/signals.json is written with every signal, failures carry the snapshot payload and never change the exit code', async () => {
    const PREVIOUS = {
      generatedAt: daysAgo(1),
      signals: [{ id: 'sig_fail', ok: true, lastSuccessAt: daysAgo(1), unavailableSince: null, data: { solicitations: [{ title: 'old' }] } }],
    };
    const http = {
      fetchText: async (url) => {
        if (url === SNAPSHOT_URL) return { text: JSON.stringify(SNAPSHOT_ITEMS) };
        if (url.endsWith('signals.json')) return { text: JSON.stringify(PREVIOUS) };
        throw new HttpError(404, url);
      },
    };
    const r = await build({ http, signals: [okSignal, failSignal, gatedSignal], env: { PUBLIC_URL: 'https://x.test/startup-radar' } });
    assert.equal(r.exitCode, 0);
    const signals = readJson(path.join(outDir, 'data', 'signals.json'));
    assert.equal(signals.generatedAt, NOW.toISOString());
    assert.deepEqual(signals.signals.map((s) => [s.id, s.enabled, s.ok]), [['sig_ok', true, true], ['sig_fail', true, false], ['sig_gated', false, false]]);
    const ok = signals.signals[0];
    assert.deepEqual(Object.keys(ok), ['id', 'name', 'homepage', 'description', 'requires', 'enabled', 'ok', 'fetchedAt', 'lastSuccessAt', 'error', 'unavailableSince', 'data', 'durationMs']);
    assert.deepEqual(ok.data, { posts: [{ title: 'a' }, { title: 'b' }] });
    const fail = signals.signals[1];
    assert.equal(fail.error, 'HTTP 403 for https://fail.test/api');
    assert.equal(fail.unavailableSince, NOW.toISOString(), 'first failure after a good snapshot -> now');
    assert.equal(fail.lastSuccessAt, daysAgo(1));
    assert.deepEqual(fail.data, { solicitations: [{ title: 'old' }] }, 'previous payload carried over');
    const gated = signals.signals[2];
    assert.equal(gated.error, 'not configured (SIG_TOKEN)');
    assert.equal(gated.data, null);

    assert.ok(logs.some((l) => l.startsWith('signal ') && l.includes('| status')), 'signals table header');
    assert.ok(logs.some((l) => l.startsWith('sig_fail') && l.includes('FAIL (previous kept)') && l.includes('HTTP 403')));
    assert.ok(logs.some((l) => l.startsWith('sig_gated') && l.includes('not configured (SIG_TOKEN)')));
    assert.ok(logs.includes('1/2 enabled signals OK'));

    const feed = fs.readFileSync(path.join(outDir, 'feed.xml'), 'utf8');
    assert.ok(feed.includes('<id>https://x.test/startup-radar/feed.xml</id>'));
    assert.ok(feed.includes('href="https://x.test/startup-radar/digest.html"'));
  });

  test('signals: every signal throwing still exits 0 and writes signals.json', async () => {
    const r = await build({ signals: [failSignal, { ...failSignal, id: 'sig_fail2' }] });
    assert.equal(r.exitCode, 0);
    const signals = readJson(path.join(outDir, 'data', 'signals.json'));
    assert.equal(signals.signals.length, 2);
    assert.ok(signals.signals.every((s) => s.enabled && !s.ok && s.data === null && s.unavailableSince === NOW.toISOString()));
    assert.ok(logs.includes('0/2 enabled signals OK'));
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
