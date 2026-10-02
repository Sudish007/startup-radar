import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapHnHit } from '../src/lib/hn.js';
import hnShow from '../src/sources/hn_show.js';
import yc, { pickNewestBatches, mapYcCompany } from '../src/sources/yc.js';
import techcrunch from '../src/sources/techcrunch.js';
import { loadSources, sourceMap } from '../src/sources/index.js';

describe('hn_show', () => {
  test('mapHnHit falls back to the HN item link when url is null', () => {
    const raw = mapHnHit({
      objectID: '123',
      title: 'Show HN: Thing',
      url: null,
      story_text: '<p>Hello &amp; welcome</p>',
      points: 42,
      num_comments: 7,
      author: 'pg',
      created_at: '2026-10-02T01:02:03.000Z',
    });
    assert.equal(raw.url, 'https://news.ycombinator.com/item?id=123');
    assert.equal(raw.summary, 'Hello & welcome');
    assert.equal(raw.extra.points, 42);
    assert.equal(raw.extra.comments, 7);
    assert.equal(raw.extra.author, 'pg');
    assert.equal(raw.extra.hnUrl, 'https://news.ycombinator.com/item?id=123');
    assert.equal(raw.publishedAt, '2026-10-02T01:02:03.000Z');
  });

  test('mapHnHit keeps the external url and omits null numbers', () => {
    const raw = mapHnHit({ objectID: '9', title: 'Show HN: X', url: 'https://x.dev', points: null, num_comments: undefined });
    assert.equal(raw.url, 'https://x.dev');
    assert.equal('points' in raw.extra, false);
    assert.equal('comments' in raw.extra, false);
  });

  test('adapter fetches Algolia and maps hits', async () => {
    const items = await hnShow.fetch({
      http: {
        fetchJson: async (url) => {
          assert.match(url, /hn\.algolia\.com.*tags=show_hn/);
          return { hits: [{ objectID: '1', title: 'Show HN: A', url: 'https://a.dev', created_at: '2026-01-01T00:00:00Z' }] };
        },
      },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Show HN: A');
    assert.equal(hnShow.kind, 'launch');
    assert.equal(hnShow.region, 'global');
  });
});

describe('yc', () => {
  const meta = {
    'winter-2027': { api: 'https://yc-oss.github.io/api/batches/winter-2027.json', count: 1 },
    'summer-2027': { api: 'https://yc-oss.github.io/api/batches/summer-2027.json', count: 1 },
    unspecified: { api: 'https://yc-oss.github.io/api/batches/unspecified.json', count: 1 },
    'fall-2026': { api: 'https://yc-oss.github.io/api/batches/fall-2026.json', count: 108 },
    'summer-2026': { api: 'https://yc-oss.github.io/api/batches/summer-2026.json', count: 231 },
    'spring-2026': { api: 'https://yc-oss.github.io/api/batches/spring-2026.json', count: 140 },
    'winter-2026': { api: 'https://yc-oss.github.io/api/batches/winter-2026.json', count: 160 },
  };

  test('pickNewestBatches ignores tiny batches and sorts by season', () => {
    const picked = pickNewestBatches(meta, 2);
    assert.deepEqual(picked.map(([slug]) => slug), ['fall-2026', 'summer-2026']);
    assert.equal(picked[0][1], 'https://yc-oss.github.io/api/batches/fall-2026.json');
  });

  test('pickNewestBatches handles n larger than available', () => {
    assert.equal(pickNewestBatches(meta, 10).length, 4);
    assert.deepEqual(pickNewestBatches({}, 2), []);
  });

  test('mapYcCompany uses launched_at and the YC profile url fallback', () => {
    const raw = mapYcCompany({
      name: 'Acme',
      slug: 'acme',
      url: null,
      website: 'https://acme.io',
      one_liner: 'Invoices on autopilot',
      launched_at: 1700000000,
      batch: 'Fall 2026',
      all_locations: 'San Francisco, CA, USA',
      industry: 'B2B',
      team_size: 3,
      status: 'Active',
    });
    assert.equal(raw.url, 'https://www.ycombinator.com/companies/acme');
    assert.equal(raw.publishedAt, 1700000000000);
    assert.equal(raw.extra.batch, 'Fall 2026');
    assert.equal(raw.extra.teamSize, 3);
    assert.equal(raw.extra.location, 'San Francisco, CA, USA');
  });

  test('adapter fetches meta then the two newest batches concurrently', async () => {
    const urls = [];
    const items = await yc.fetch({
      http: {
        fetchJson: async (url) => {
          urls.push(url);
          if (url.endsWith('meta.json')) return { batches: meta };
          return [{ name: url.includes('fall') ? 'F' : 'S', slug: 'x', url: 'https://www.ycombinator.com/companies/x' }];
        },
      },
    });
    assert.deepEqual(urls, [
      'https://yc-oss.github.io/api/meta.json',
      'https://yc-oss.github.io/api/batches/fall-2026.json',
      'https://yc-oss.github.io/api/batches/summer-2026.json',
    ]);
    assert.deepEqual(items.map((i) => i.title), ['F', 'S']);
    assert.equal(yc.kind, 'accelerator');
  });
});

describe('registry', () => {
  test('loadSources discovers the adapters and validates them', async () => {
    const sources = await loadSources();
    const ids = sources.map((s) => s.id);
    assert.deepEqual(ids, [...ids].sort());
    for (const id of ['hn_show', 'techcrunch', 'yc']) assert.ok(ids.includes(id), id);
    for (const s of sources) {
      assert.equal(typeof s.enabled, 'function');
      assert.equal(typeof s.fetch, 'function');
      assert.ok('requires' in s);
    }
    const map = sourceMap(sources);
    assert.equal(map.get('techcrunch'), sources.find((s) => s.id === 'techcrunch'));
  });

  test('techcrunch is an RSS source for the startups category', () => {
    assert.equal(techcrunch.feedUrl, 'https://techcrunch.com/category/startups/feed/');
    assert.equal(techcrunch.kind, 'news');
    assert.equal(techcrunch.region, 'usa');
  });
});
