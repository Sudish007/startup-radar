import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createRefresh } from '../src/refresh.js';

const stubSource = {
  id: 'stub',
  name: 'Stub Source',
  homepage: 'https://stub.test/',
  kind: 'launch',
  region: 'global',
  enabled: () => true,
  requires: null,
  async fetch() {
    return [
      { title: 'Stub one', url: 'https://stub.test/one', publishedAt: '2026-10-02T10:00:00Z' },
      { title: 'Stub two', url: 'https://stub.test/two', publishedAt: '2026-10-01T10:00:00Z' },
    ];
  },
};

function boot({ adminToken = null, swVersion = 'test-v1' } = {}) {
  const db = openDb(':memory:');
  const sources = [stubSource];
  const config = { adminToken, userAgent: 'test', fetchTimeoutMs: 1000, maxBodyBytes: 1000 };
  const refresh = createRefresh({ db, http: {}, sources, env: {}, log: () => {} });
  // swVersion: null -> let createApp pick its default (a fresh ISO timestamp)
  const app = createApp({ db, sources, config, refresh, env: {}, ...(swVersion === null ? {} : { swVersion }) });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ db, server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function shutdown(ctx) {
  return new Promise((resolve) => ctx.server.close(() => { ctx.db.close(); resolve(); }));
}

describe('app without ADMIN_TOKEN', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(() => shutdown(ctx));

  test('GET /health returns the status shape', async () => {
    const res = await fetch(`${ctx.base}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body, { ok: true, items: 0, lastRefresh: null });
  });

  test('serves the HTML pages', async () => {
    for (const p of ['/', '/sources']) {
      const res = await fetch(`${ctx.base}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const text = await res.text();
      assert.match(text, /<h1>/);
    }
  });

  test('security headers are present and x-powered-by is not', async () => {
    const res = await fetch(`${ctx.base}/health`);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('GET /api/items clamps limit and validates enums', async () => {
    const ok = await fetch(`${ctx.base}/api/items?limit=500`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.limit, 100);
    assert.equal(body.page, 1);
    assert.deepEqual(body.items, []);
    assert.equal(body.total, 0);
    assert.equal(body.hasMore, false);

    const bad = await fetch(`${ctx.base}/api/items?kind=bogus`);
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get('content-type'), /application\/json/);
    assert.equal(typeof (await bad.json()).error, 'string');

    assert.equal((await fetch(`${ctx.base}/api/items?region=mars`)).status, 400);
    assert.equal((await fetch(`${ctx.base}/api/items?source=nope`)).status, 400);
    assert.equal((await fetch(`${ctx.base}/api/items?since=notadate`)).status, 400);
    assert.equal((await fetch(`${ctx.base}/api/items?region=world&source=stub&since=2020-01-01`)).status, 200);
  });

  test('GET /api/sources lists the stub with status fields and exploreMore', async () => {
    const res = await fetch(`${ctx.base}/api/sources`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sources.length, 1);
    const s = body.sources[0];
    assert.equal(s.id, 'stub');
    assert.equal(s.name, 'Stub Source');
    assert.equal(s.enabled, true);
    assert.equal(s.requires, null);
    assert.equal(s.itemCount, 0);
    assert.equal(s.lastSuccessAt, null);
    assert.ok(Array.isArray(body.exploreMore) && body.exploreMore.length >= 10);
  });

  test('GET /api/stats returns counts', async () => {
    const res = await fetch(`${ctx.base}/api/stats`);
    const body = await res.json();
    assert.equal(body.items, 0);
    assert.deepEqual(body.bySource, {});
  });

  test('GET /data/*.json serve the static-export payloads with no-store', async () => {
    const items = await fetch(`${ctx.base}/data/items.json`);
    assert.equal(items.status, 200);
    assert.equal(items.headers.get('cache-control'), 'no-store');
    assert.match(items.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await items.json(), []);

    const stats = await fetch(`${ctx.base}/data/stats.json`);
    assert.equal(stats.status, 200);
    assert.equal(stats.headers.get('cache-control'), 'no-store');
    const statsBody = await stats.json();
    assert.equal(typeof statsBody.generatedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(statsBody.generatedAt)));
    assert.equal(statsBody.archiveItems, 0);
    assert.equal(statsBody.items, 0);

    const sources = await fetch(`${ctx.base}/data/sources.json`);
    assert.equal(sources.status, 200);
    assert.equal(sources.headers.get('cache-control'), 'no-store');
    const apiSources = await (await fetch(`${ctx.base}/api/sources`)).json();
    assert.deepEqual(await sources.json(), apiSources);

    const archive = await fetch(`${ctx.base}/data/archive.json`);
    assert.equal(archive.status, 404);
    assert.equal(archive.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await archive.json(), { error: 'not found' });
  });

  test('unknown /api path is a JSON 404', async () => {
    const res = await fetch(`${ctx.base}/api/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });

  test('GET /sw.js replaces the version token with no-cache', async () => {
    const res = await fetch(`${ctx.base}/sw.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/javascript/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const body = await res.text();
    assert.ok(!body.includes('__BUILD_VERSION__'));
    assert.ok(body.includes("const VERSION = 'test-v1'"));
    assert.ok(!/['"]\/api\//.test(body) && !/['"]\/data\//.test(body), 'no leading-slash literals in sw.js');
  });

  test('default swVersion differs per createApp', async () => {
    const a = await boot({ swVersion: null });
    await new Promise((r) => setTimeout(r, 2));
    const b = await boot({ swVersion: null });
    try {
      const va = /const VERSION = '([^']+)'/.exec(await (await fetch(`${a.base}/sw.js`)).text())[1];
      const vb = /const VERSION = '([^']+)'/.exec(await (await fetch(`${b.base}/sw.js`)).text())[1];
      assert.ok(!Number.isNaN(Date.parse(va)), `ISO timestamp: ${va}`);
      assert.notEqual(va, vb);
    } finally {
      await shutdown(a);
      await shutdown(b);
    }
  });

  test('GET /manifest.webmanifest has no id', async () => {
    const res = await fetch(`${ctx.base}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
    const manifest = JSON.parse(await res.text());
    assert.equal('id' in manifest, false);
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.icons.length, 3);
  });

  test('GET /icons/icon-192.png is image/png', async () => {
    const res = await fetch(`${ctx.base}/icons/icon-192.png`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/png/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.readUInt32BE(16), 192);
    assert.equal(bytes.readUInt32BE(20), 192);
  });

  test('POST /api/refresh is 404 when no admin token is configured', async () => {
    const res = await fetch(`${ctx.base}/api/refresh`, { method: 'POST', headers: { Authorization: 'Bearer anything' } });
    assert.equal(res.status, 404);
  });
});

describe('app with ADMIN_TOKEN', () => {
  let ctx;
  before(async () => { ctx = await boot({ adminToken: 'secret' }); });
  after(() => shutdown(ctx));

  test('401 without header, 401 with wrong token', async () => {
    assert.equal((await fetch(`${ctx.base}/api/refresh`, { method: 'POST' })).status, 401);
    const wrong = await fetch(`${ctx.base}/api/refresh`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } });
    assert.equal(wrong.status, 401);
    const longer = await fetch(`${ctx.base}/api/refresh`, { method: 'POST', headers: { Authorization: 'Bearer secret-but-longer' } });
    assert.equal(longer.status, 401);
  });

  test('200 with the correct token and items appear afterwards', async () => {
    const res = await fetch(`${ctx.base}/api/refresh`, { method: 'POST', headers: { Authorization: 'Bearer secret' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].id, 'stub');
    assert.equal(body.sources[0].ok, true);
    assert.equal(body.sources[0].count, 2);

    const items = await (await fetch(`${ctx.base}/api/items`)).json();
    assert.equal(items.total, 2);
    assert.equal(items.items[0].title, 'Stub one');
    assert.equal(items.items[0].source.name, 'Stub Source');

    const health = await (await fetch(`${ctx.base}/health`)).json();
    assert.equal(health.items, 2);
    assert.equal(typeof health.lastRefresh, 'string');

    const sources = await (await fetch(`${ctx.base}/api/sources`)).json();
    assert.equal(sources.sources[0].itemCount, 2);
    assert.equal(sources.sources[0].lastItemCount, 2);

    const dataItems = await (await fetch(`${ctx.base}/data/items.json`)).json();
    assert.ok(Array.isArray(dataItems));
    assert.equal(dataItems.length, 2);
    assert.equal(dataItems[0].title, 'Stub one');
    assert.equal(dataItems[0].source.name, 'Stub Source');
    assert.equal(dataItems[1].title, 'Stub two');

    const dataStats = await (await fetch(`${ctx.base}/data/stats.json`)).json();
    assert.equal(dataStats.items, 2);
    assert.equal(dataStats.archiveItems, 0);
    assert.equal(typeof dataStats.generatedAt, 'string');
    assert.equal(typeof dataStats.lastRefresh, 'string');

    const dataSources = await (await fetch(`${ctx.base}/data/sources.json`)).json();
    assert.deepEqual(dataSources, sources);
  });
});
