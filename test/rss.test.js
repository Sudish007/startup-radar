import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, feedItemToRaw, makeRssSource } from '../src/lib/rss.js';

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Product Hunt</title>
  <updated>2026-10-02T10:00:00Z</updated>
  <entry>
    <id>https://www.producthunt.com/posts/acme-ai</id>
    <title>Acme AI</title>
    <link rel="alternate" type="text/html" href="https://www.producthunt.com/posts/acme-ai?utm_campaign=feed"/>
    <published>2026-10-02T07:01:02Z</published>
    <updated>2026-10-02T09:00:00Z</updated>
    <author><name>jane</name></author>
    <content type="html">&lt;p&gt;Your &amp;amp; AI co-pilot for &lt;b&gt;spreadsheets&lt;/b&gt;&lt;/p&gt;</content>
  </entry>
</feed>`;

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Startups | TechCrunch</title>
    <item>
      <title>Acme raises $5M seed to automate invoices</title>
      <link>https://techcrunch.com/2026/10/02/acme-raises-5m/</link>
      <dc:creator><![CDATA[John Doe]]></dc:creator>
      <pubDate>Fri, 02 Oct 2026 08:30:00 +0000</pubDate>
      <guid isPermaLink="false">https://techcrunch.com/?p=1</guid>
      <description><![CDATA[<p>Acme, a Berlin-based startup, has raised a $5M seed round.</p>]]></description>
    </item>
  </channel>
</rss>`;

describe('feedItemToRaw', () => {
  test('maps an Atom entry (Product Hunt style)', async () => {
    const feed = await parseFeed(ATOM);
    assert.equal(feed.items.length, 1);
    const raw = feedItemToRaw(feed.items[0]);
    assert.equal(raw.title, 'Acme AI');
    assert.equal(raw.url, 'https://www.producthunt.com/posts/acme-ai?utm_campaign=feed');
    assert.equal(raw.summary, 'Your & AI co-pilot for spreadsheets');
    assert.equal(new Date(raw.publishedAt).toISOString(), '2026-10-02T07:01:02.000Z');
    assert.equal(raw.extra.author, 'jane');
  });

  test('maps an RSS 2.0 item (TechCrunch style)', async () => {
    const feed = await parseFeed(RSS2);
    assert.equal(feed.items.length, 1);
    const raw = feedItemToRaw(feed.items[0]);
    assert.equal(raw.title, 'Acme raises $5M seed to automate invoices');
    assert.equal(raw.url, 'https://techcrunch.com/2026/10/02/acme-raises-5m/');
    assert.equal(raw.summary, 'Acme, a Berlin-based startup, has raised a $5M seed round.');
    assert.equal(new Date(raw.publishedAt).toISOString(), '2026-10-02T08:30:00.000Z');
    assert.equal(raw.extra.author, 'John Doe');
  });

  test('omits extra.author when absent', () => {
    const raw = feedItemToRaw({ title: ' T ', link: 'https://x.com/a' });
    assert.equal(raw.title, 'T');
    assert.equal(raw.summary, '');
    assert.equal(raw.publishedAt, null);
    assert.deepEqual(raw.extra, {});
  });
});

describe('makeRssSource', () => {
  test('builds an adapter that fetches through ctx.http', async () => {
    const calls = [];
    const src = makeRssSource({
      id: 'demo',
      name: 'Demo',
      homepage: 'https://demo.test/',
      feedUrl: 'https://demo.test/feed',
      kind: 'news',
      region: 'usa',
    });
    assert.equal(src.id, 'demo');
    assert.equal(src.enabled({}), true);
    assert.equal(src.requires, null);
    const items = await src.fetch({
      http: {
        fetchText: async (url, opts) => {
          calls.push({ url, opts });
          return { status: 200, text: RSS2 };
        },
      },
      signal: undefined,
    });
    assert.equal(calls[0].url, 'https://demo.test/feed');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Acme raises $5M seed to automate invoices');
  });
});
