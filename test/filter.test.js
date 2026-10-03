import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SINCE_VALUES,
  MAX_QUERY_TOKENS,
  sinceToIso,
  tokenize,
  queryTokens,
  matchesQuery,
  compareNewestFirst,
  filterItems,
  itemKey,
  pointsOf,
  comparePoints,
  sortItems,
} from '../public/filter.js';

const NOW = new Date('2026-10-03T12:34:56.000Z');

function item(id, overrides = {}) {
  return {
    id,
    title: `Item ${id}`,
    url: `https://example.test/${id}`,
    source: { id: 'hn_show', name: 'HN Show' },
    kind: 'launch',
    region: 'usa',
    summary: '',
    publishedAt: '2026-10-01T00:00:00.000Z',
    fetchedAt: '2026-10-01T00:00:00.000Z',
    extra: {},
    ...overrides,
  };
}

const ITEMS = [
  item(1, { title: 'Acme launches Copilot for lawyers', kind: 'launch', region: 'usa', publishedAt: '2026-10-03T10:00:00.000Z' }),
  item(2, { title: 'Beta raises $5M seed', kind: 'funding', region: 'europe', source: { id: 'tech_eu', name: 'Tech.eu' }, publishedAt: '2026-10-03T01:00:00.000Z' }),
  item(3, { title: 'Gamma ships AI-powered copilots', summary: 'An assistant for sales teams', kind: 'launch', region: 'india', source: { id: 'inc42', name: 'Inc42' }, publishedAt: '2026-09-30T00:00:00.000Z' }),
  item(4, { title: 'Delta joins YC', kind: 'accelerator', region: 'global', source: { id: 'yc', name: 'Y Combinator' }, publishedAt: '2026-09-20T00:00:00.000Z' }),
  item(5, { title: 'Epsilon news', kind: 'news', region: 'usa', publishedAt: '2026-08-20T00:00:00.000Z' }),
  item(6, { title: 'Zeta same instant', kind: 'news', region: 'latam', publishedAt: '2026-10-03T01:00:00.000Z' }),
];

const ids = (list) => list.map((i) => i.id);

describe('sinceToIso', () => {
  test('exports the chip values', () => {
    assert.deepEqual([...SINCE_VALUES], ['today', '7d', '30d', '']);
  });

  test('today = UTC midnight, 7d/30d = now - N days, empty = null', () => {
    assert.equal(sinceToIso('today', NOW), '2026-10-03T00:00:00.000Z');
    assert.equal(sinceToIso('7d', NOW), '2026-09-26T12:34:56.000Z');
    assert.equal(sinceToIso('30d', NOW), '2026-09-03T12:34:56.000Z');
    assert.equal(sinceToIso('', NOW), null);
    assert.equal(sinceToIso('bogus', NOW), null);
  });
});

describe('tokenize / matchesQuery', () => {
  test('lowercases and splits on punctuation', () => {
    assert.deepEqual(tokenize('AI-powered Copilots!'), ['ai', 'powered', 'copilots']);
    assert.deepEqual(tokenize('  '), []);
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize(null), []);
  });

  test('folds diacritics like FTS5 unicode61', () => {
    assert.deepEqual(tokenize('Café résumé'), ['cafe', 'resume']);
  });

  test('word or word-prefix match: copilot matches copilots, but not mid-word', () => {
    assert.equal(matchesQuery(ITEMS[0], tokenize('copilot')), true);
    assert.equal(matchesQuery(ITEMS[2], tokenize('copilot')), true); // prefix of "copilots"
    assert.equal(matchesQuery(ITEMS[2], tokenize('copilots')), true);
    assert.equal(matchesQuery(ITEMS[0], tokenize('copilots')), false); // longer than the word
    assert.equal(matchesQuery(ITEMS[0], tokenize('pilot')), false); // mid-word is not a prefix
    assert.equal(matchesQuery({ title: 'Heavy rain today' }, tokenize('ai')), false);
    assert.equal(matchesQuery({ title: 'AI for rain' }, tokenize('ai')), true);
  });

  test('matches in the summary and requires every token', () => {
    assert.equal(matchesQuery(ITEMS[2], tokenize('sales teams')), true);
    assert.equal(matchesQuery(ITEMS[2], tokenize('sal tea')), true);
    assert.equal(matchesQuery(ITEMS[2], tokenize('sales lawyers')), false);
    assert.equal(matchesQuery(ITEMS[2], []), true);
  });

  test('queryTokens caps at MAX_QUERY_TOKENS like the server', () => {
    assert.equal(MAX_QUERY_TOKENS, 8);
    assert.equal(queryTokens('1 2 3 4 5 6 7 8 9 10').length, 8);
    assert.deepEqual(queryTokens('"Show" OR NEAR('), ['show', 'or', 'near']);
  });
});

describe('compareNewestFirst', () => {
  test('publishedAt desc, then id desc', () => {
    const sorted = [...ITEMS].sort(compareNewestFirst);
    assert.deepEqual(ids(sorted), [1, 6, 2, 3, 4, 5]);
  });
});

describe('filterItems', () => {
  test('no filters returns everything newest first', () => {
    assert.deepEqual(ids(filterItems(ITEMS, {}, NOW)), [1, 6, 2, 3, 4, 5]);
    assert.deepEqual(ids(filterItems(ITEMS, { q: '   ' }, NOW)), [1, 6, 2, 3, 4, 5]);
  });

  test('does not mutate the input', () => {
    const copy = [...ITEMS];
    filterItems(ITEMS, { kind: 'news' }, NOW);
    assert.deepEqual(ITEMS, copy);
  });

  test('kind', () => {
    assert.deepEqual(ids(filterItems(ITEMS, { kind: 'launch' }, NOW)), [1, 3]);
    assert.deepEqual(ids(filterItems(ITEMS, { kind: 'funding' }, NOW)), [2]);
    assert.deepEqual(ids(filterItems(ITEMS, { kind: 'nope' }, NOW)), []);
  });

  test('region and the USA / world scopes', () => {
    assert.deepEqual(ids(filterItems(ITEMS, { region: 'europe' }, NOW)), [2]);
    assert.deepEqual(ids(filterItems(ITEMS, { region: 'usa' }, NOW)), [1, 5]);
    assert.deepEqual(ids(filterItems(ITEMS, { region: 'world' }, NOW)), [6, 2, 3, 4]);
  });

  test('sources (empty = all)', () => {
    assert.deepEqual(ids(filterItems(ITEMS, { sources: [] }, NOW)), [1, 6, 2, 3, 4, 5]);
    assert.deepEqual(ids(filterItems(ITEMS, { sources: ['yc', 'inc42'] }, NOW)), [3, 4]);
    assert.deepEqual(ids(filterItems(ITEMS, { sources: ['unknown'] }, NOW)), []);
  });

  test('each since value against a fixed now', () => {
    assert.deepEqual(ids(filterItems(ITEMS, { since: 'today' }, NOW)), [1, 6, 2]);
    assert.deepEqual(ids(filterItems(ITEMS, { since: '7d' }, NOW)), [1, 6, 2, 3]);
    assert.deepEqual(ids(filterItems(ITEMS, { since: '30d' }, NOW)), [1, 6, 2, 3, 4]);
    assert.deepEqual(ids(filterItems(ITEMS, { since: '' }, NOW)), [1, 6, 2, 3, 4, 5]);
  });

  test('search: word prefix, case-insensitive, punctuation split, multi-token AND', () => {
    assert.deepEqual(ids(filterItems(ITEMS, { q: 'copilot' }, NOW)), [1, 3]);
    assert.deepEqual(ids(filterItems(ITEMS, { q: 'COPILOTS' }, NOW)), [3]);
    assert.deepEqual(ids(filterItems(ITEMS, { q: 'pilot' }, NOW)), []);
    assert.deepEqual(ids(filterItems(ITEMS, { q: 'cop law' }, NOW)), [1]);
    assert.deepEqual(ids(filterItems(ITEMS, { q: 'AI-powered' }, NOW)), [3]);
    assert.deepEqual(ids(filterItems(ITEMS, { q: 'powered ai' }, NOW)), [3]);
    assert.deepEqual(ids(filterItems(ITEMS, { q: 'copilot lawyers' }, NOW)), [1]);
    assert.deepEqual(ids(filterItems(ITEMS, { q: 'copilot seed' }, NOW)), []);
  });

  test('filters combine', () => {
    assert.deepEqual(ids(filterItems(ITEMS, { kind: 'news', region: 'world', since: 'today' }, NOW)), [6]);
    assert.deepEqual(ids(filterItems(ITEMS, { kind: 'news', region: 'usa', since: 'today' }, NOW)), []);
  });
});

describe('itemKey', () => {
  test('itemKey is deterministic base-36 (1-13 chars) and coerces non-strings', () => {
    const keys = ITEMS.map((i) => itemKey(i.url));
    for (const k of keys) {
      assert.match(k, /^[0-9a-z]{1,13}$/);
    }
    assert.equal(new Set(keys).size, ITEMS.length, 'distinct for the fixture URLs');
    assert.equal(itemKey('https://example.test/1'), itemKey('https://example.test/1'));
    assert.notEqual(itemKey('https://example.test/1'), itemKey('https://example.test/2'));
    assert.equal(itemKey(undefined), itemKey(''));
    assert.equal(itemKey(null), itemKey(''));
    assert.equal(itemKey(42), itemKey('42'));
    assert.doesNotThrow(() => itemKey({}));
    assert.doesNotThrow(() => itemKey(Symbol('x')));
    assert.doesNotThrow(() => itemKey(['a', 'b']));
    // 64-bit FNV-1a of the empty string is the offset basis, in base 36.
    assert.equal(itemKey(''), (0xcbf29ce484222325n).toString(36));
    // UTF-8 bytes, not UTF-16 code units.
    assert.notEqual(itemKey('caf\u00e9'), itemKey('cafe'));
  });
});

describe('pointsOf / comparePoints / sortItems', () => {
  const hn = item(10, { extra: { points: 142, comments: 37 }, publishedAt: '2026-10-01T00:00:00.000Z' });
  const hnLow = item(11, { extra: { points: 3 }, publishedAt: '2026-10-03T00:00:00.000Z' });
  const ph = item(12, { extra: { votes: 50 }, publishedAt: '2026-10-02T00:00:00.000Z' });
  const both = item(13, { extra: { points: 50, votes: 999 }, publishedAt: '2026-09-01T00:00:00.000Z' });
  const none = item(14, { extra: { author: 'pg' }, publishedAt: '2026-10-03T06:00:00.000Z' });
  const noneOlder = item(15, { extra: {}, publishedAt: '2026-10-02T06:00:00.000Z' });

  test('pointsOf prefers points over votes', () => {
    assert.equal(pointsOf(hn), 142);
    assert.equal(pointsOf(ph), 50);
    assert.equal(pointsOf(both), 50);
    assert.equal(pointsOf(none), null);
    assert.equal(pointsOf({ extra: { points: 'many' } }), null);
    assert.equal(pointsOf({ extra: { points: Number.NaN, votes: 7 } }), 7);
    assert.equal(pointsOf({}), null);
    assert.equal(pointsOf(null), null);
  });

  test('comparePoints orders valued items desc then newest-first', () => {
    const sorted = [none, noneOlder, hnLow, ph, hn, both].sort(comparePoints);
    assert.deepEqual(ids(sorted), [10, 12, 13, 11, 14, 15]);
    // ties on the value fall back to newest-first (ph and both have 50)
    assert.ok(comparePoints(ph, both) < 0);
    assert.ok(comparePoints(none, noneOlder) < 0);
    assert.equal(comparePoints(hn, hn), 0);
  });

  test("sortItems('') keeps order; sortItems('points') is stable", () => {
    const list = filterItems([...ITEMS, hn, ph, none], {}, NOW);
    assert.equal(sortItems(list, ''), list);
    assert.deepEqual(ids(sortItems(list, 'bogus')), ids(list));
    const byPoints = sortItems(list, 'points');
    assert.notEqual(byPoints, list, 'returns a new array');
    assert.deepEqual(ids(list), ids(filterItems([...ITEMS, hn, ph, none], {}, NOW)), 'input not mutated');
    assert.deepEqual(ids(byPoints).slice(0, 2), [10, 12]);
    assert.deepEqual(ids(byPoints).slice(2), ids(list).filter((id) => id !== 10 && id !== 12));
    assert.deepEqual(ids(sortItems(byPoints, 'points')), ids(byPoints), 'idempotent');
  });
});
