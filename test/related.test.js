import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_SHARED, RELATED_METHOD, relatedItems, sharedCount, tokensOf } from '../public/related.js';

let n = 0;
function item(title, { summary = '', sectors = [], publishedAt = '2026-10-01T00:00:00.000Z', url = null } = {}) {
  n += 1;
  return { id: n, title, summary, sectors, publishedAt, url: url ?? `https://example.test/${n}` };
}

const base = item('Acme launches an LLM copilot for community banks', { sectors: ['ai', 'fintech'], publishedAt: '2026-10-03T00:00:00.000Z' });
const twoShared = item('Beta copilot for credit unions and community lenders', { sectors: [], publishedAt: '2026-10-02T00:00:00.000Z' }); // copilot + community
const twoSharedOlder = item('Gamma community copilot', { sectors: [], publishedAt: '2026-09-20T00:00:00.000Z' });
const sectorOne = item('Delta bank app', { sectors: ['fintech'], publishedAt: '2026-10-01T00:00:00.000Z' }); // bank + shared sector
const oneOnly = item('Epsilon bank statement parser', { sectors: ['devtools'] }); // bank only, no shared sector
const stopOnly = item('Zeta raises $4M seed round to launch a startup', { sectors: ['ai'] }); // stopwords only
const three = item('Eta: an LLM copilot for banks everywhere', { sectors: ['ai'], publishedAt: '2026-09-01T00:00:00.000Z' }); // llm copilot bank
const dupUrl = { ...item('Same url as base, different object with copilot banks'), url: base.url };
const ALL = [base, twoShared, twoSharedOlder, sectorOne, oneOnly, stopOnly, three, dupUrl];

describe('related.js', () => {
  test('tokensOf drops stopwords/short/numbers and de-pluralises; sharedCount counts the overlap', () => {
    assert.deepEqual([...tokensOf(base)], ['acme', 'llm', 'copilot', 'community', 'bank']);
    assert.equal(sharedCount(base, twoShared), 2);
    assert.equal(sharedCount(base, three), 3);
    assert.equal(sharedCount(base, stopOnly), 0);
    assert.equal(sharedCount(base, sectorOne), 1);
    assert.equal(MIN_SHARED, 2);
  });

  test('related = >= 2 shared tokens or a shared sector + 1 token; self and same-url excluded; count is honest', () => {
    const { count, items } = relatedItems(base, ALL);
    assert.equal(count, 4);
    assert.deepEqual(items.map((i) => i.title.split(' ')[0]), ['Eta:', 'Beta', 'Gamma', 'Delta']);
    assert.ok(!items.includes(base) && !items.includes(dupUrl) && !items.includes(oneOnly) && !items.includes(stopOnly));
  });

  test('sorted by shared tokens desc, then newest first; max caps items but not count', () => {
    const { count, items } = relatedItems(base, ALL, { max: 2 });
    assert.equal(count, 4);
    assert.deepEqual(items.map((i) => i.id), [three.id, twoShared.id]);
    assert.equal(relatedItems(base, ALL, { max: 0 }).items.length, 0);
    assert.equal(relatedItems(base, ALL, { max: 0 }).count, 4);
  });

  test('empty window and items without sectors/summary are safe', () => {
    assert.deepEqual(relatedItems(base, []), { count: 0, items: [] });
    assert.deepEqual(relatedItems({ title: 'Lonely', url: 'https://x.test' }, [base, twoShared]), { count: 0, items: [] });
    assert.deepEqual(relatedItems({ title: '', url: null }, [base]), { count: 0, items: [] });
  });

  test('the method sentence is the one the drawer shows (no score/index wording)', () => {
    assert.ok(RELATED_METHOD.startsWith('method: token overlap'));
    assert.doesNotMatch(RELATED_METHOD, /\b(score|index)\b/i);
  });
});
