import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, stripHtml, truncate, toIso, normalizeItem } from '../src/lib/normalize.js';

describe('normalizeUrl', () => {
  test('strips utm_*, ref and fbclid but keeps other params', () => {
    assert.equal(
      normalizeUrl('https://Example.com/a/?utm_source=x&UTM_medium=y&ref=hn&fbclid=123&id=7'),
      'https://example.com/a?id=7',
    );
  });

  test('drops fragment and trailing slash, lowercases host', () => {
    assert.equal(normalizeUrl('https://WWW.Example.COM/path/#section'), 'https://www.example.com/path');
  });

  test('keeps the root slash', () => {
    assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
    assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
  });

  test('removes default ports only', () => {
    assert.equal(normalizeUrl('https://example.com:443/x'), 'https://example.com/x');
    assert.equal(normalizeUrl('http://example.com:80/x'), 'http://example.com/x');
    assert.equal(normalizeUrl('http://example.com:8080/x'), 'http://example.com:8080/x');
  });

  test('utm variant and clean URL normalize identically', () => {
    assert.equal(normalizeUrl('https://acme.io/launch?utm_source=x'), normalizeUrl('https://acme.io/launch'));
  });

  test('rejects non-http schemes and garbage', () => {
    assert.equal(normalizeUrl('javascript:alert(1)'), null);
    assert.equal(normalizeUrl('mailto:a@b.co'), null);
    assert.equal(normalizeUrl('not a url'), null);
    assert.equal(normalizeUrl(''), null);
    assert.equal(normalizeUrl(null), null);
  });
});

describe('stripHtml', () => {
  test('removes tags and decodes entities', () => {
    assert.equal(stripHtml('<p>Tom &amp; Jerry&#8217;s <b>show</b></p>'), 'Tom & Jerry\u2019s show');
  });

  test('drops script/style blocks and collapses whitespace', () => {
    assert.equal(stripHtml('<style>p{}</style>a<script>x()</script>\n\n b   c'), 'a b c');
  });

  test('decodes numeric and hex entities', () => {
    assert.equal(stripHtml('&#169; &#xA9; &quot;q&quot; &nbsp;z'), '\u00A9 \u00A9 "q" z');
  });
});

describe('truncate', () => {
  test('returns short text unchanged', () => {
    assert.equal(truncate('hello world', 300), 'hello world');
  });

  test('cuts at a word boundary and appends an ellipsis', () => {
    const out = truncate('alpha beta gamma delta', 12);
    assert.equal(out, 'alpha beta\u2026');
    assert.ok(out.length <= 13);
  });
});

describe('toIso', () => {
  test('accepts Date, ISO strings, RFC 822 strings and unix seconds', () => {
    assert.equal(toIso(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
    assert.equal(toIso('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z');
    assert.equal(toIso('Thu, 02 Oct 2026 10:00:00 +0000'), '2026-10-02T10:00:00.000Z');
    assert.equal(toIso(1700000000), '2023-11-14T22:13:20.000Z');
    assert.equal(toIso(1700000000000), '2023-11-14T22:13:20.000Z');
  });

  test('returns null for junk', () => {
    assert.equal(toIso('yesterday-ish'), null);
    assert.equal(toIso(null), null);
    assert.equal(toIso(undefined), null);
  });
});

describe('normalizeItem', () => {
  const source = { id: 'techcrunch', kind: 'news', region: 'usa' };
  const now = '2026-10-02T12:00:00.000Z';

  test('returns null on missing title or invalid url', () => {
    assert.equal(normalizeItem({ title: '', url: 'https://x.com/a' }, source, now), null);
    assert.equal(normalizeItem({ title: 'ok', url: 'ftp://x.com/a' }, source, now), null);
    assert.equal(normalizeItem({ title: 'x'.repeat(301), url: 'https://x.com/a' }, source, now), null);
    assert.equal(normalizeItem(null, source, now), null);
  });

  test('fills kind, region and published_at', () => {
    const row = normalizeItem(
      {
        title: 'Acme raises $5M seed',
        url: 'https://techcrunch.com/2026/10/02/acme/?utm_source=rss',
        summary: '<p>Bengaluru-based Acme has raised money.</p>',
        publishedAt: 'Fri, 02 Oct 2026 09:00:00 +0000',
        extra: { author: 'Jane' },
      },
      source,
      now,
    );
    assert.equal(row.url_norm, 'https://techcrunch.com/2026/10/02/acme');
    assert.equal(row.url, 'https://techcrunch.com/2026/10/02/acme/?utm_source=rss');
    assert.equal(row.kind, 'funding');
    assert.equal(row.region, 'india');
    assert.equal(row.published_at, '2026-10-02T09:00:00.000Z');
    assert.equal(row.fetched_at, now);
    assert.equal(row.summary, 'Bengaluru-based Acme has raised money.');
    assert.equal(row.source_id, 'techcrunch');
    assert.deepEqual(JSON.parse(row.extra_json), { author: 'Jane' });
  });

  test('falls back to nowIso when publishedAt is missing', () => {
    const row = normalizeItem({ title: 'T', url: 'https://x.com/a' }, { id: 'hn_show', kind: 'launch', region: 'global' }, now);
    assert.equal(row.published_at, now);
    assert.equal(row.kind, 'launch');
    assert.equal(row.region, 'global');
    assert.equal(row.extra_json, '{}');
  });

  test('uses extra.location for region detection', () => {
    const row = normalizeItem(
      { title: 'Foo', url: 'https://ycombinator.com/companies/foo', extra: { location: 'London, England, United Kingdom' } },
      { id: 'yc', kind: 'accelerator', region: 'usa' },
      now,
    );
    assert.equal(row.region, 'europe');
  });
});
