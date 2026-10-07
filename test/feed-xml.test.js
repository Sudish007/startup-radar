import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from '../src/digest.js';
import { buildAtom, esc, weekHtml } from '../src/feed-xml.js';
import { buildFunding } from '../src/funding.js';

const NOW = new Date('2026-10-07T15:00:00.000Z');
const PUBLIC_URL = 'https://sudish007.github.io/startup-radar';

function at(daysAgo) {
  return new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
}

let seq = 0;
function item(title, overrides = {}) {
  seq += 1;
  return { id: seq, title, summary: '', url: `https://x.test/${seq}`, kind: 'news', region: 'global', publishedAt: at(1), source: { id: 's', name: 'S' }, extra: {}, ...overrides };
}

function digestWithContent() {
  const items = [
    item('Acme <Beta> & Co raises $4M seed', { kind: 'funding', publishedAt: at(1), url: 'https://x.test/a?b=1&c=2' }),
    item('Show HN: "Quoted" \'tool\'', { kind: 'launch', extra: { points: 42 } }),
    item('Old launch', { kind: 'launch', extra: { votes: 3 }, publishedAt: at(20) }),
  ];
  const funding = buildFunding(items, { now: NOW });
  const yc = { companies: [{ key: 'k', name: 'Yc & Sons', url: 'https://www.ycombinator.com/companies/yc', batch: 'Fall 2026', oneLiner: '<b>bold</b>', launchedAt: at(2) }] };
  const signals = { generatedAt: NOW.toISOString(), signals: [
    { id: 'github_new_repos', data: { label: 'stars since creation (<= 7 days)', repos: [{ fullName: 'o/r', url: 'https://github.com/o/r', stars: 7 }] } },
    { id: 'hf_trending', data: { models: [{ id: 'org/m', url: 'https://huggingface.co/org/m', likes: 3, downloads: 9 }] } },
  ] };
  return buildDigest({ items, funding, yc, signals, now: NOW });
}

describe('esc', () => {
  test('escapes & < > " \' and stringifies null/undefined to empty', () => {
    assert.equal(esc('Acme <Beta> & Co "q" \'s\''), 'Acme &lt;Beta&gt; &amp; Co &quot;q&quot; &#39;s&#39;');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(12), '12');
    assert.equal(esc('&amp;'), '&amp;amp;', 'no double-unescape magic: raw text in, escaped out');
  });
});

describe('buildAtom', () => {
  test('well-formed Atom skeleton: xml prolog, feed id/self/alternate from publicUrl, one entry per week newest first', () => {
    const digest = buildDigest({ now: NOW });
    const xml = buildAtom({ digest, publicUrl: PUBLIC_URL, now: NOW });
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">'));
    assert.ok(xml.trimEnd().endsWith('</feed>'));
    assert.ok(xml.includes(`<id>${PUBLIC_URL}/feed.xml</id>`));
    assert.ok(xml.includes(`<link rel="self" type="application/atom+xml" href="${PUBLIC_URL}/feed.xml"/>`));
    assert.ok(xml.includes(`<link rel="alternate" type="text/html" href="${PUBLIC_URL}/digest.html"/>`));
    assert.ok(xml.includes(`<updated>${NOW.toISOString()}</updated>`));
    assert.equal((xml.match(/<entry>/g) ?? []).length, digest.weeks.length);
    assert.equal((xml.match(/<\/entry>/g) ?? []).length, 12);
    const ids = [...xml.matchAll(/<entry>\s*<id>([^<]+)<\/id>/g)].map((m) => m[1]);
    assert.deepEqual(ids, [...digest.weeks].reverse().map((w) => `${PUBLIC_URL}/digest.html?week=${w.week}`));
    assert.ok(xml.includes('<title>Startup Radar digest — week 2026-W41</title>'));
    assert.ok(xml.includes(`<link rel="alternate" type="text/html" href="${PUBLIC_URL}/digest.html?week=2026-W41"/>`));
    assert.equal(xml.includes('__'), false, 'no leftover template tokens');
    assert.equal(xml.includes('undefined'), false);
    assert.equal(xml.includes('null'), false);
    // Every <updated>/<published> value parses as a date.
    for (const m of xml.matchAll(/<(updated|published)>([^<]+)<\/\1>/g)) assert.ok(!Number.isNaN(Date.parse(m[2])), m[2]);
    // Entry updated: completed weeks use the week end, the partial one uses the digest time.
    const entryUpdated = [...xml.matchAll(/<entry>[\s\S]*?<updated>([^<]+)<\/updated>/g)].map((m) => m[1]);
    assert.equal(entryUpdated[0], NOW.toISOString());
    assert.equal(entryUpdated[1], digest.weeks.at(-2).to);
  });

  test('titles and hrefs are escaped; the html content is double-escaped and every href is absolute from publicUrl', () => {
    const digest = digestWithContent();
    const xml = buildAtom({ digest, publicUrl: `${PUBLIC_URL}/`, now: NOW });
    assert.ok(xml.includes(`<id>${PUBLIC_URL}/feed.xml</id>`), 'trailing slash on publicUrl is trimmed');
    assert.equal(/<[^>]*[^&]</.test(xml.replace(/<content type="html">[\s\S]*?<\/content>/g, '')) && xml.includes('Acme <Beta>'), false, 'no raw < from a title leaks into the XML');
    assert.ok(xml.includes('Acme &amp;lt;Beta&amp;gt; &amp;amp; Co raises $4M seed'), 'title: html-escaped once for the <li>, once more as Atom text');
    assert.ok(xml.includes('href=&quot;https://x.test/a?b=1&amp;amp;c=2&quot;'), 'href & escaped in html then as Atom text');
    assert.ok(xml.includes('&amp;quot;Quoted&amp;quot; &amp;#39;tool&amp;#39;'));
    assert.ok(xml.includes('Yc &amp;amp; Sons'));
    assert.ok(xml.includes('&amp;lt;b&amp;gt;bold&amp;lt;/b&amp;gt;'), 'the YC one-liner cannot inject markup');
    assert.equal(xml.includes('<b>bold</b>'), false);

    const html = weekHtml(digest.weeks.at(-1), PUBLIC_URL);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 5, `found ${hrefs.length} hrefs`);
    assert.ok(hrefs.every((h) => h.startsWith('http://') || h.startsWith('https://')), hrefs.join('\n'));
    assert.ok(hrefs.some((h) => h.startsWith(`${PUBLIC_URL}/digest.html?week=2026-W41`)));
    assert.equal(hrefs.some((h) => h.startsWith('./') || h.startsWith('/')), false, 'no relative hrefs in a feed');
    assert.ok(html.includes('<h2>Funding rounds (ordered by approx. USD at static rates)</h2>'));
    assert.ok(html.includes('42 HN points'));
    assert.ok(html.includes('GitHub: new repositories (stars since creation, &lt;= 7 days)'));
    assert.ok(html.includes('7 stars'));
    assert.ok(html.includes('#1, 3 likes'));
    assert.ok(html.includes('partial week'));
    const old = weekHtml(digest.weeks.at(-4), PUBLIC_URL);
    assert.ok(old.includes('3 PH votes'));
    assert.equal(old.includes('GitHub'), false, 'no highlights in completed weeks');
    assert.equal(old.includes('<h2>Funding'), false, 'empty sections are omitted');
    const content = /<content type="html">([\s\S]*?)<\/content>/.exec(xml)[1];
    assert.equal(content.includes('<'), false, 'content is text, not markup');
    assert.equal(content, esc(html));
  });

  test('tolerates a missing digest and falls back to now', () => {
    const xml = buildAtom({ digest: null, publicUrl: PUBLIC_URL, now: NOW });
    assert.equal((xml.match(/<entry>/g) ?? []).length, 0);
    assert.ok(xml.includes(`<updated>${NOW.toISOString()}</updated>`));
  });
});
