import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapHnHit } from '../src/lib/hn.js';
import hnShow from '../src/sources/hn_show.js';
import yc, { pickNewestBatches, mapYcCompany } from '../src/sources/yc.js';
import techcrunch from '../src/sources/techcrunch.js';
import hnLaunch, { mapLaunchHit } from '../src/sources/hn_launch.js';
import producthunt, { mapAtomItem, mapGraphqlNode } from '../src/sources/producthunt.js';
import reddit, { stripRedditBoilerplate, mapRedditItem } from '../src/sources/reddit.js';
import crunchbase, { mapFundingRound, compactMoney } from '../src/sources/crunchbase.js';
import betalist, { mapBetalistItem } from '../src/sources/betalist.js';
import { parseFeed, fetchFeed, feedItemToRaw } from '../src/lib/rss.js';
import { KINDS, REGIONS } from '../src/lib/classify.js';
import { loadSources, sourceMap } from '../src/sources/index.js';

const PH_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Product Hunt</title>
  <updated>2026-10-02T22:04:40Z</updated>
  <entry>
    <id>tag:www.producthunt.com,2005:Post/1264587</id>
    <title>Gauth Unlimited Digital Canvas </title>
    <link rel="alternate" type="text/html" href="https://www.producthunt.com/products/gauth-ai-course"/>
    <published>2026-09-29T05:33:13-07:00</published>
    <updated>2026-10-02T15:04:40-07:00</updated>
    <author><name>Aleksandar Blazhev</name></author>
    <content type="html">
          &lt;p&gt;
            An AI tutor on an infinite whiteboard, not a chat thread
          &lt;/p&gt;
          &lt;p&gt;
            &lt;a href="https://www.producthunt.com/products/gauth-ai-course?utm_campaign=feed"&gt;Discussion&lt;/a&gt;
            |
            &lt;a href="https://www.producthunt.com/r/p/1264587?app_id=339"&gt;Link&lt;/a&gt;
          &lt;/p&gt;
    </content>
  </entry>
</feed>`;

const BETALIST_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>BetaList</title>
  <entry>
    <id>https://betalist.com/startups/acme</id>
    <title>Acme</title>
    <link rel="alternate" type="text/html" href="https://betalist.com/startups/acme?utm_campaign=startup-in-feed&amp;utm_source=feedburner"/>
    <published>2026-10-01T10:00:00Z</published>
    <updated>2026-10-01T10:00:00Z</updated>
    <content type="html">&lt;p&gt;Invoices on autopilot&lt;/p&gt;</content>
  </entry>
</feed>`;

const REDDIT_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>newest submissions : SideProject</title>
  <entry>
    <author><name>/u/builder</name><uri>https://www.reddit.com/user/builder</uri></author>
    <id>t3_abc123</id>
    <link href="https://www.reddit.com/r/SideProject/comments/abc123/i_built_a_thing/"/>
    <published>2026-10-02T12:00:00+00:00</published>
    <updated>2026-10-02T12:00:00+00:00</updated>
    <title>I built a thing</title>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;It does &amp;amp; things.&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;
    &amp;#32; submitted by &amp;#32; &lt;a href="https://www.reddit.com/user/builder"&gt; /u/builder &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href="https://thing.dev"&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href="https://www.reddit.com/r/SideProject/comments/abc123/"&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content>
  </entry>
</feed>`;

function rssCtx(textByUrl, env = {}) {
  const calls = [];
  const http = {
    fetchText: async (url, opts) => {
      calls.push({ url, opts });
      const t = textByUrl[url];
      if (t instanceof Error) throw t;
      if (t === undefined) throw new Error(`unexpected url ${url}`);
      return { status: 200, text: t, url };
    },
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const t = textByUrl[url];
      if (t instanceof Error) throw t;
      if (t === undefined) throw new Error(`unexpected url ${url}`);
      return typeof t === 'string' ? JSON.parse(t) : t;
    },
  };
  return { calls, ctx: { http, rss: { fetchFeed, parseFeed, feedItemToRaw }, env, signal: undefined, log: () => {} } };
}

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

describe('hn_launch', () => {
  test('mapLaunchHit strips the prefix and extracts the YC batch', () => {
    const raw = mapLaunchHit({
      objectID: '77',
      title: 'Launch HN: Acme (YC S25) \u2013 Invoices on autopilot',
      url: 'https://acme.io',
      points: 120,
      num_comments: 33,
      author: 'founder',
      created_at: '2026-10-02T01:02:03.000Z',
    });
    assert.equal(raw.title, 'Acme (YC S25) \u2013 Invoices on autopilot');
    assert.equal(raw.extra.batch, 'S25');
    assert.equal(raw.extra.points, 120);
    assert.equal(raw.extra.comments, 33);
    assert.equal(raw.url, 'https://acme.io');
  });

  test('mapLaunchHit omits batch when there is no YC tag', () => {
    const raw = mapLaunchHit({ objectID: '1', title: 'launch hn: Bare', url: null });
    assert.equal(raw.title, 'Bare');
    assert.equal('batch' in raw.extra, false);
    assert.equal(raw.url, 'https://news.ycombinator.com/item?id=1');
  });

  test('adapter keeps only "Launch HN:" stories', async () => {
    const { ctx, calls } = rssCtx({
      'https://hn.algolia.com/api/v1/search_by_date?query=%22Launch%20HN%22&tags=story&hitsPerPage=50': {
        hits: [
          { objectID: '1', title: 'Launch HN: Real (YC W26)', url: 'https://real.dev' },
          { objectID: '2', title: 'Ask HN: mentions Launch HN', url: 'https://other.dev' },
        ],
      },
    });
    const items = await hnLaunch.fetch(ctx);
    assert.equal(calls.length, 1);
    assert.deepEqual(items.map((i) => i.title), ['Real (YC W26)']);
    assert.equal(items[0].extra.batch, 'W26');
    assert.equal(hnLaunch.kind, 'launch');
    assert.equal(hnLaunch.region, 'global');
  });
});

describe('producthunt', () => {
  test('Atom mapping uses <published> (not <updated>) and the first <p> as summary', async () => {
    const feed = await parseFeed(PH_ATOM);
    const raw = mapAtomItem(feed.items[0]);
    assert.equal(raw.title, 'Gauth Unlimited Digital Canvas');
    assert.equal(raw.url, 'https://www.producthunt.com/products/gauth-ai-course');
    assert.equal(raw.summary, 'An AI tutor on an infinite whiteboard, not a chat thread');
    assert.equal(new Date(raw.publishedAt).toISOString(), '2026-09-29T12:33:13.000Z');
    assert.equal(raw.extra.author, 'Aleksandar Blazhev');
    assert.equal(raw.extra.via, 'atom');
  });

  test('without PRODUCTHUNT_TOKEN the adapter fetches the Atom feed through ctx.rss', async () => {
    const { ctx, calls } = rssCtx({ 'https://www.producthunt.com/feed': PH_ATOM });
    const items = await producthunt.fetch(ctx);
    assert.equal(calls[0].url, 'https://www.producthunt.com/feed');
    assert.equal(items.length, 1);
    assert.equal(items[0].summary, 'An AI tutor on an infinite whiteboard, not a chat thread');
  });

  test('with PRODUCTHUNT_TOKEN the adapter POSTs GraphQL and maps votesCount', async () => {
    const { ctx, calls } = rssCtx(
      {
        'https://api.producthunt.com/v2/api/graphql': {
          data: {
            posts: {
              edges: [
                {
                  node: {
                    id: '1',
                    name: 'Acme',
                    tagline: 'Invoices on autopilot',
                    url: 'https://www.producthunt.com/posts/acme',
                    votesCount: 321,
                    createdAt: '2026-10-02T07:01:02Z',
                    website: 'https://acme.io',
                  },
                },
              ],
            },
          },
        },
      },
      { PRODUCTHUNT_TOKEN: 'tok' },
    );
    const items = await producthunt.fetch(ctx);
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok');
    assert.match(calls[0].opts.body, /posts\(order: NEWEST, first: 50\)/);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Acme');
    assert.equal(items[0].summary, 'Invoices on autopilot');
    assert.equal(items[0].extra.votes, 321);
    assert.equal(items[0].extra.website, 'https://acme.io');
  });

  test('GraphQL body.errors is thrown, never silently downgraded to Atom', async () => {
    const { ctx, calls } = rssCtx(
      { 'https://api.producthunt.com/v2/api/graphql': { errors: [{ message: 'invalid_oauth_token' }] } },
      { PRODUCTHUNT_TOKEN: 'bad' },
    );
    await assert.rejects(producthunt.fetch(ctx), /invalid_oauth_token/);
    assert.equal(calls.length, 1);
  });

  test('mapGraphqlNode omits undefined extras', () => {
    const raw = mapGraphqlNode({ name: 'X', url: 'https://x', tagline: '', createdAt: '2026-01-01T00:00:00Z' });
    assert.deepEqual(raw.extra, {});
    assert.equal(raw.summary, '');
  });
});

describe('reddit', () => {
  test('stripRedditBoilerplate removes the "submitted by" trailer', () => {
    const html =
      '<!-- SC_OFF --><div class="md"><p>It does &amp; things.</p></div><!-- SC_ON --> ' +
      '&#32; submitted by &#32; <a href="https://www.reddit.com/user/builder"> /u/builder </a> <br/> ' +
      '<span><a href="https://thing.dev">[link]</a></span> &#32; <span><a href="https://www.reddit.com/r/x/">[comments]</a></span>';
    assert.equal(stripRedditBoilerplate(html), 'It does & things.');
    assert.equal(stripRedditBoilerplate(''), '');
  });

  test('mapRedditItem adds author and subreddit', async () => {
    const feed = await parseFeed(REDDIT_ATOM);
    const raw = mapRedditItem(feed.items[0], 'SideProject');
    assert.equal(raw.title, 'I built a thing');
    assert.equal(raw.url, 'https://www.reddit.com/r/SideProject/comments/abc123/i_built_a_thing/');
    assert.equal(raw.summary, 'It does & things.');
    assert.equal(raw.extra.author, '/u/builder');
    assert.equal(raw.extra.subreddit, 'SideProject');
  });

  test('is disabled unless ENABLE_REDDIT=true', () => {
    assert.equal(reddit.enabled({}), false);
    assert.equal(reddit.enabled({ ENABLE_REDDIT: 'false' }), false);
    assert.equal(reddit.enabled({ ENABLE_REDDIT: 'true' }), true);
    assert.equal(reddit.requires, 'ENABLE_REDDIT=true');
    assert.equal(reddit.kind, 'launch');
  });

  test('one failing subreddit does not fail the source; both failing throws the first error', async () => {
    const ok = rssCtx({
      'https://www.reddit.com/r/SideProject/new.rss?limit=50': REDDIT_ATOM,
      'https://www.reddit.com/r/startups/new.rss?limit=50': new Error('HTTP 429'),
    });
    const items = await reddit.fetch(ok.ctx);
    assert.equal(items.length, 1);
    assert.equal(items[0].extra.subreddit, 'SideProject');

    const bad = rssCtx({
      'https://www.reddit.com/r/SideProject/new.rss?limit=50': new Error('HTTP 403'),
      'https://www.reddit.com/r/startups/new.rss?limit=50': new Error('HTTP 429'),
    });
    await assert.rejects(reddit.fetch(bad.ctx), /HTTP 403/);
  });
});

describe('crunchbase', () => {
  const withMoney = {
    uuid: 'r1',
    properties: {
      identifier: { permalink: 'acme-series-a--r1', value: 'Series A - Acme', uuid: 'r1' },
      announced_on: '2026-10-01',
      investment_type: 'series_a',
      money_raised: { value: 15000000, currency: 'USD', value_usd: 15000000 },
      funded_organization_identifier: { permalink: 'acme', value: 'Acme', uuid: 'o1' },
    },
  };
  const withoutMoney = {
    uuid: 'r2',
    properties: {
      identifier: { permalink: 'beta-seed--r2', value: 'Seed Round - Beta', uuid: 'r2' },
      announced_on: '2026-09-30',
      investment_type: 'seed',
      funded_organization_identifier: { permalink: 'beta', value: 'Beta', uuid: 'o2' },
    },
  };

  test('compactMoney formats USD amounts', () => {
    assert.equal(compactMoney(15000000), '15M');
    assert.equal(compactMoney(1500000), '1.5M');
    assert.equal(compactMoney(1200000000), '1.2B');
    assert.equal(compactMoney(750000), '750K');
    assert.equal(compactMoney(900), '900');
  });

  test('mapFundingRound with money_raised', () => {
    const raw = mapFundingRound(withMoney);
    assert.equal(raw.title, 'Acme raises $15M (series_a)');
    assert.equal(raw.url, 'https://www.crunchbase.com/funding_round/acme-series-a--r1');
    assert.equal(raw.publishedAt, '2026-10-01');
    assert.deepEqual(raw.extra, {
      moneyRaisedUsd: 15000000,
      currency: 'USD',
      investmentType: 'series_a',
      organization: 'Acme',
    });
  });

  test('mapFundingRound without money_raised', () => {
    const raw = mapFundingRound(withoutMoney);
    assert.equal(raw.title, 'Beta \u2014 seed');
    assert.equal(raw.url, 'https://www.crunchbase.com/funding_round/beta-seed--r2');
    assert.equal('moneyRaisedUsd' in raw.extra, false);
    assert.equal(raw.extra.investmentType, 'seed');
  });

  test('is keyed on CRUNCHBASE_API_KEY and POSTs the search body with X-cb-user-key', async () => {
    assert.equal(crunchbase.enabled({}), false);
    assert.equal(crunchbase.enabled({ CRUNCHBASE_API_KEY: 'k' }), true);
    assert.equal(crunchbase.requires, 'CRUNCHBASE_API_KEY');
    assert.equal(crunchbase.kind, 'funding');
    const { ctx, calls } = rssCtx(
      { 'https://api.crunchbase.com/api/v4/searches/funding_rounds': { entities: [withMoney, withoutMoney] } },
      { CRUNCHBASE_API_KEY: 'k' },
    );
    const items = await crunchbase.fetch(ctx);
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['X-cb-user-key'], 'k');
    const body = JSON.parse(calls[0].opts.body);
    assert.deepEqual(body.order, [{ field_id: 'announced_on', sort: 'desc' }]);
    assert.equal(body.limit, 50);
    assert.ok(body.field_ids.includes('money_raised'));
    assert.equal(items.length, 2);
  });
});

describe('betalist', () => {
  test('uses the clean entry id as url instead of the utm-tagged link', async () => {
    const feed = await parseFeed(BETALIST_ATOM);
    const raw = mapBetalistItem(feed.items[0]);
    assert.equal(raw.url, 'https://betalist.com/startups/acme');
    assert.equal(raw.title, 'Acme');
    assert.equal(raw.summary, 'Invoices on autopilot');
  });

  test('keeps the link when the id is not a betalist URL', () => {
    const raw = mapBetalistItem({ id: 'tag:betalist,2005:1', link: 'https://betalist.com/startups/x?utm=1', title: 'X' });
    assert.equal(raw.url, 'https://betalist.com/startups/x?utm=1');
  });

  test('is a FeedBurner Atom launch source', () => {
    assert.equal(betalist.feedUrl, 'https://feeds.feedburner.com/BetaList');
    assert.equal(betalist.kind, 'launch');
    assert.equal(betalist.region, 'global');
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

  test('loads 21 adapters with unique ids, valid kinds/regions and the expected enabled flags', async () => {
    const sources = await loadSources();
    assert.equal(sources.length, 21);
    assert.equal(new Set(sources.map((s) => s.id)).size, 21);
    assert.deepEqual(
      sources.map((s) => s.id),
      [
        'betalist', 'crunchbase', 'crunchbase_news', 'disrupt_africa', 'eu_startups', 'hn_launch', 'hn_show',
        'inc42', 'latamlist', 'launchingnext', 'producthunt', 'reddit', 'sifted', 'tech_collective', 'tech_eu',
        'techcabal', 'techcrunch', 'techcrunch_venture', 'vulcanpost', 'yc', 'yourstory',
      ],
    );
    for (const s of sources) {
      assert.ok(KINDS.includes(s.kind), `${s.id} kind`);
      assert.ok(REGIONS.includes(s.region), `${s.id} region`);
    }
    const map = sourceMap(sources);
    assert.equal(map.get('reddit').enabled({}), false);
    assert.equal(map.get('reddit').enabled({ ENABLE_REDDIT: 'true' }), true);
    assert.equal(map.get('crunchbase').enabled({}), false);
    const enabledByDefault = sources.filter((s) => s.enabled({}));
    assert.equal(enabledByDefault.length, 19);
    const regions = new Set(sources.map((s) => s.region));
    for (const r of ['usa', 'europe', 'india', 'asia', 'africa', 'latam', 'global']) assert.ok(regions.has(r), r);
  });

  test('techcrunch is an RSS source for the startups category', () => {
    assert.equal(techcrunch.feedUrl, 'https://techcrunch.com/category/startups/feed/');
    assert.equal(techcrunch.kind, 'news');
    assert.equal(techcrunch.region, 'usa');
  });
});
