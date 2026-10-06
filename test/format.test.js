import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND_LABELS,
  REGION_LABELS,
  kindLabel,
  regionLabel,
  relativeTime,
  absoluteTime,
  compactMoney,
  pluralize,
  safeHttpUrl,
  hostnameOf,
  pointsText,
  commentsText,
  votesText,
  metaParts,
  hnDiscussion,
  rowLabel,
  detailRows,
  METHOD_LABELS,
  sectorLabels,
} from '../public/format.js';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');

function item(overrides = {}) {
  return {
    id: 1,
    title: 'Acme launches',
    url: 'https://www.acme.test/launch',
    source: { id: 'hn_show', name: 'Hacker News \u2014 Show HN' },
    kind: 'launch',
    region: 'usa',
    summary: 'A thing.',
    publishedAt: '2026-10-03T10:00:00.000Z',
    fetchedAt: '2026-10-03T10:05:00.000Z',
    extra: {},
    ...overrides,
  };
}

const labels = (rows) => rows.map((r) => r.label);

describe('labels', () => {
  test('kind and region labels fall back to the raw value', () => {
    assert.equal(kindLabel('launch'), 'Launch');
    assert.equal(kindLabel('bogus'), 'bogus');
    assert.equal(regionLabel('latam'), 'Latin America');
    assert.equal(regionLabel(undefined), '');
    assert.deepEqual(Object.keys(KIND_LABELS), ['launch', 'funding', 'news', 'accelerator']);
    assert.deepEqual(Object.keys(REGION_LABELS), ['usa', 'europe', 'asia', 'india', 'latam', 'africa', 'global']);
  });
});

describe('METHOD_LABELS / sectorLabels (honesty wording, plan D12)', () => {
  test('the shared method strings', () => {
    assert.deepEqual(METHOD_LABELS, {
      sectors: 'keyword-tagged',
      headline: 'parsed from headline',
      summary: 'parsed from summary',
      usd: 'approx. USD at static rates \u2014 see table',
      related: 'token overlap in the 90-day window',
    });
    for (const v of Object.values(METHOD_LABELS)) assert.doesNotMatch(v, /\b(score|index)\b/i);
  });

  test('sectorLabels maps stats.sectors to { id: label } and ignores bad entries', () => {
    const stats = { sectors: [{ id: 'ai', label: 'AI/ML', count: 3 }, { id: 'fintech', label: 'Fintech', count: 0 }, { id: 7, label: 'x' }, null, { id: 'health' }] };
    assert.deepEqual(sectorLabels(stats), { ai: 'AI/ML', fintech: 'Fintech' });
    assert.deepEqual(sectorLabels({}), {});
    assert.deepEqual(sectorLabels(null), {});
    assert.deepEqual(sectorLabels({ sectors: 'nope' }), {});
  });
});

describe('relativeTime', () => {
  test('relativeTime with a fixed now', () => {
    assert.equal(relativeTime('2026-10-03T11:59:40.000Z', NOW), 'just now');
    assert.equal(relativeTime('2026-10-03T11:48:00.000Z', NOW), '12 min ago');
    assert.equal(relativeTime('2026-10-03T09:00:00.000Z', NOW), '3 h ago');
    assert.equal(relativeTime('2026-09-28T12:00:00.000Z', NOW), '5 d ago');
    const old = relativeTime('2026-08-01T12:00:00.000Z', NOW);
    assert.match(old, /2026/);
    assert.ok(!/ago/.test(old));
    const future = relativeTime('2026-12-01T12:00:00.000Z', NOW);
    assert.match(future, /2026/);
    assert.equal(relativeTime('nope', NOW), '');
    assert.equal(relativeTime(undefined, NOW), '');
  });
});

describe('absoluteTime', () => {
  test('absoluteTime', () => {
    assert.equal(absoluteTime('2026-10-03T10:00:00.000Z'), new Date('2026-10-03T10:00:00.000Z').toLocaleString());
    assert.equal(absoluteTime('garbage'), '');
    assert.equal(absoluteTime(null), '');
  });
});

describe('compactMoney', () => {
  test('compactMoney', () => {
    assert.equal(compactMoney(950), '950');
    assert.equal(compactMoney(1500), '1.5K');
    assert.equal(compactMoney(12_000_000), '12M');
    assert.equal(compactMoney(2_500_000_000), '2.5B');
    assert.equal(compactMoney(1_000_000), '1M');
    assert.equal(compactMoney('12'), '');
    assert.equal(compactMoney(Number.POSITIVE_INFINITY), '');
  });
});

describe('pluralize', () => {
  test('pluralize', () => {
    assert.equal(pluralize(1, 'item', 'items'), '1 item');
    assert.equal(pluralize(0, 'item', 'items'), '0 items');
    assert.equal(pluralize(3, 'new item', 'new items'), '3 new items');
  });

  test('points / comments / votes: singular only for exactly 1', () => {
    assert.equal(pointsText(1), '1 point');
    assert.equal(pointsText(0), '0 points');
    assert.equal(pointsText(142), '142 points');
    assert.equal(commentsText(1), '1 comment');
    assert.equal(commentsText(0), '0 comments');
    assert.equal(votesText(1), '1 vote');
    assert.equal(votesText(312), '312 votes');
  });
});

describe('rowLabel', () => {
  test('source-branded labels only for the matching source id', () => {
    assert.equal(rowLabel('author', 'Author', 'hn_show'), 'HN author');
    assert.equal(rowLabel('author', 'Author', 'hn_launch'), 'HN author');
    assert.equal(rowLabel('author', 'Author', 'techcabal'), 'Author');
    assert.equal(rowLabel('author', 'Author', 'producthunt'), 'Author');
    assert.equal(rowLabel('author', 'Author', undefined), 'Author');
    assert.equal(rowLabel('points', 'Points', 'hn_show'), 'HN points');
    assert.equal(rowLabel('comments', 'Comments', 'hn_launch'), 'HN comments');
    assert.equal(rowLabel('points', 'Points', 'reddit'), 'Points');
    assert.equal(rowLabel('votes', 'Votes', 'producthunt'), 'PH votes');
    assert.equal(rowLabel('votes', 'Votes', 'hn_show'), 'Votes');
    assert.equal(rowLabel('batch', 'Batch', 'yc'), 'Batch', 'the value already reads "YC <batch>"');
    assert.equal(rowLabel('location', 'Location', 'yc'), 'Location');
  });
});

describe('safeHttpUrl / hostnameOf', () => {
  test('safeHttpUrl rejects javascript:, data:, relative, malformed', () => {
    assert.equal(safeHttpUrl('https://x.test/a?b=1'), 'https://x.test/a?b=1');
    assert.equal(safeHttpUrl('http://x.test'), 'http://x.test/');
    assert.equal(safeHttpUrl('javascript:alert(1)'), null);
    assert.equal(safeHttpUrl('data:text/html,hi'), null);
    assert.equal(safeHttpUrl('/relative/path'), null);
    assert.equal(safeHttpUrl('./sources.html'), null);
    assert.equal(safeHttpUrl('not a url'), null);
    assert.equal(safeHttpUrl('ftp://x.test/f'), null);
    assert.equal(safeHttpUrl(''), null);
    assert.equal(safeHttpUrl(undefined), null);
    assert.equal(safeHttpUrl(42), null);
  });

  test('hostnameOf strips www and falls back', () => {
    assert.equal(hostnameOf('https://www.x.test/a'), 'x.test');
    assert.equal(hostnameOf('https://news.ycombinator.com/item?id=1'), 'news.ycombinator.com');
    assert.equal(hostnameOf('garbage'), 'unknown host');
    assert.equal(hostnameOf(null), 'unknown host');
    assert.equal(hostnameOf('javascript:alert(1)'), 'unknown host');
  });
});

describe('metaParts', () => {
  test('metaParts (HN/PH/YC incl. location/Crunchbase)', () => {
    assert.deepEqual(metaParts({ points: 142, comments: 37, author: 'pg', hnUrl: 'https://news.ycombinator.com/item?id=1' }), ['142 points \u00b7 37 comments', 'by pg']);
    assert.deepEqual(metaParts({ points: 1, comments: 0, author: 'pg' }), ['1 point \u00b7 0 comments', 'by pg'], 'singular point, plural zero comments');
    assert.deepEqual(metaParts({ comments: 4 }), ['4 comments']);
    assert.deepEqual(metaParts({ comments: 1 }), ['1 comment']);
    assert.deepEqual(metaParts({ votes: 312 }), ['312 votes']);
    assert.deepEqual(metaParts({ votes: 1 }), ['1 vote']);
    assert.deepEqual(metaParts({ author: 'Emmanuel Nwosu' }), ['by Emmanuel Nwosu'], 'a generic author line for RSS sources');
    assert.deepEqual(metaParts({ batch: 'W26', location: 'San Francisco', industry: 'B2B' }), ['YC W26', 'San Francisco']);
    assert.deepEqual(metaParts({ batch: 'YC S25' }), ['YC S25']);
    assert.deepEqual(metaParts({ location: 'Berlin' }), [], 'location only follows a batch');
    assert.deepEqual(metaParts({ investmentType: 'series_a', moneyRaisedUsd: 12_000_000, organization: 'Acme' }), ['series a \u00b7 $12M']);
    assert.deepEqual(metaParts({ moneyRaisedUsd: 500_000 }), ['$500K']);
    assert.deepEqual(metaParts({}), []);
    assert.deepEqual(metaParts(null), []);
    assert.deepEqual(metaParts('x'), []);
  });
});

describe('hnDiscussion', () => {
  test('returns hnUrl only when it differs from the item url', () => {
    assert.equal(hnDiscussion(item({ extra: { hnUrl: 'https://news.ycombinator.com/item?id=9' } })), 'https://news.ycombinator.com/item?id=9');
    assert.equal(hnDiscussion(item({ url: 'https://news.ycombinator.com/item?id=9', extra: { hnUrl: 'https://news.ycombinator.com/item?id=9' } })), null);
    assert.equal(hnDiscussion(item({ extra: { hnUrl: 'javascript:void(0)' } })), null);
    assert.equal(hnDiscussion(item()), null);
    assert.equal(hnDiscussion(null), null);
  });
});

describe('detailRows', () => {
  test('detailRows emits only present fields', () => {
    const rows = detailRows(item());
    assert.deepEqual(labels(rows), ['Destination', 'Source', 'Kind', 'Region', 'Published']);
    assert.deepEqual(rows[0], { label: 'Destination', value: 'acme.test' });
    assert.deepEqual(rows[1], { label: 'Source', value: 'Hacker News \u2014 Show HN', href: './sources.html' });
    assert.deepEqual(rows[2], { label: 'Kind', value: 'Launch' });
    assert.deepEqual(rows[3], { label: 'Region', value: 'USA' });
    assert.equal(rows[4].value, absoluteTime('2026-10-03T10:00:00.000Z'));
    for (const r of rows) assert.equal(typeof r.value, 'string');

    const hn = detailRows(item({ extra: { points: 142, comments: 37, author: 'pg', hnUrl: 'https://news.ycombinator.com/item?id=1' } }));
    assert.deepEqual(labels(hn).slice(5), ['HN points', 'HN comments', 'HN author']);
    assert.deepEqual(hn.slice(5).map((r) => r.value), ['142', '37', 'pg']);

    // the same fields from a non-HN source carry generic labels (TechCabal's RSS author is not an "HN author")
    const rss = detailRows(item({ source: { id: 'techcabal', name: 'TechCabal' }, kind: 'news', region: 'africa', extra: { author: 'Emmanuel Nwosu' } }));
    assert.deepEqual(labels(rss).slice(5), ['Author']);
    assert.equal(rss.at(-1).value, 'Emmanuel Nwosu');
    assert.ok(!labels(rss).some((l) => /\bHN\b|\bPH\b|\bYC\b/.test(l)), 'no source brand leaks into another source');
    const redditLike = detailRows(item({ source: { id: 'reddit', name: 'Reddit' }, extra: { points: 3, comments: 1, author: 'u' } }));
    assert.deepEqual(labels(redditLike).slice(5), ['Points', 'Comments', 'Author']);

    const ph = detailRows(item({ source: { id: 'producthunt', name: 'Product Hunt' }, extra: { votes: 312, author: 'Bin Liu', via: 'atom' } }));
    assert.deepEqual(labels(ph).slice(5), ['Author', 'PH votes']);
    assert.deepEqual(labels(detailRows(item({ extra: { votes: 312 } }))).slice(5), ['Votes'], 'votes without the Product Hunt source are just votes');

    const yc = detailRows(item({ source: { id: 'yc', name: 'Y Combinator' }, kind: 'accelerator', extra: { batch: 'W26', location: 'San Francisco', industry: 'B2B', teamSize: 4, status: 'Active', website: 'https://acme.test/' } }));
    assert.deepEqual(labels(yc).slice(5), ['Batch', 'Location', 'Industry', 'Team size', 'Status', 'Website']);
    assert.deepEqual(yc.find((r) => r.label === 'Batch').value, 'YC W26');
    assert.deepEqual(yc.find((r) => r.label === 'Team size').value, '4');
    assert.equal(detailRows(item({ source: { id: 'hn_launch', name: 'Launch HN' }, extra: { batch: 'S25' } })).at(-1).value, 'YC S25', 'Launch HN batches read "YC S25" under the generic Batch label');

    const cb = detailRows(item({ extra: { investmentType: 'series_a', moneyRaisedUsd: 12_000_000, organization: 'Acme Inc' } }));
    assert.deepEqual(labels(cb).slice(5), ['Round type', 'Amount', 'Organization']);
    assert.deepEqual(cb.slice(5).map((r) => r.value), ['series a', '$12M', 'Acme Inc']);

    const bare = detailRows({ title: 'x' });
    assert.deepEqual(bare, []);
    const noDate = detailRows(item({ publishedAt: undefined, extra: null }));
    assert.deepEqual(labels(noDate), ['Destination', 'Source', 'Kind', 'Region']);
    assert.deepEqual(labels(detailRows(item({ url: 'not a url' }))), ['Source', 'Kind', 'Region', 'Published'], 'no Destination for an unparsable url');
  });

  test('detailRows omits Discussion when hnUrl === url', () => {
    const same = item({ url: 'https://news.ycombinator.com/item?id=9', extra: { hnUrl: 'https://news.ycombinator.com/item?id=9', points: 1 } });
    assert.ok(!labels(detailRows(same)).some((l) => /discussion/i.test(l)));
    assert.equal(hnDiscussion(same), null);
    assert.ok(!detailRows(same).some((r) => r.href === same.url), 'no second row pointing at the same url');
  });

  test('detailRows Website only for http(s) !== url', () => {
    const ok = detailRows(item({ extra: { website: 'https://www.acme.test/' } }));
    assert.deepEqual(ok.at(-1), { label: 'Website', value: 'acme.test', href: 'https://www.acme.test/' });
    assert.ok(!labels(detailRows(item({ extra: { website: 'https://www.acme.test/launch' } }))).includes('Website'), 'equal to url');
    assert.ok(!labels(detailRows(item({ extra: { website: 'javascript:alert(1)' } }))).includes('Website'));
    assert.ok(!labels(detailRows(item({ extra: { website: 'acme.test' } }))).includes('Website'));
    assert.ok(!labels(detailRows(item({ extra: { website: 42 } }))).includes('Website'));
    assert.ok(!labels(detailRows(item({ extra: { website: 'ftp://acme.test/' } }))).includes('Website'));
    const hrefs = detailRows(item({ extra: { website: 'https://other.test' } })).filter((r) => r.href);
    assert.deepEqual(hrefs.map((r) => r.label), ['Source', 'Website']);
  });
});
