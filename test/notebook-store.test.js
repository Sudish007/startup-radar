import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, VERSION, addItem, emptyNotebook, listItems, load, removeItem, save, savedItem, setNote, setTags } from '../public/notebook-store.js';
import { CANVAS_FIELDS, fromJson, listCanvases, merge, removeCanvas, search, toJson, toMarkdown, upsertCanvas } from '../public/notebook-tools.js';
import { itemKey } from '../public/filter.js';

const T0 = '2026-10-05T10:00:00.000Z';
const T1 = '2026-10-05T11:00:00.000Z';
const T2 = '2026-10-05T12:00:00.000Z';

const feedItem = {
  id: 7, title: 'Acme raises $4M for LLM copilots # banks | lenders', url: 'https://acme.test/round', source: { id: 'hn_show', name: 'Hacker News' },
  kind: 'funding', region: 'usa', summary: 'Copilots for community banks.', publishedAt: '2026-10-04T09:00:00.000Z', sectors: ['ai', 'fintech'], extra: { points: 12 },
};
const KEY = itemKey(feedItem.url);

describe('notebook-store: items', () => {
  test('emptyNotebook shape and constants', () => {
    assert.deepEqual(emptyNotebook(), { version: 1, items: {}, canvases: {} });
    assert.equal(VERSION, 1);
    assert.equal(STORAGE_KEY, 'sr:notebook:v1');
    assert.deepEqual(CANVAS_FIELDS, ['title', 'problem', 'who', 'whyNow', 'existing', 'distribution', 'moat', 'firstTen']);
  });

  test('addItem stores the documented fields (no extra/points), keys by itemKey(url), does not mutate', () => {
    const nb0 = emptyNotebook();
    const nb1 = addItem(nb0, feedItem, T0);
    assert.deepEqual(nb0, emptyNotebook(), 'input untouched');
    assert.deepEqual(Object.keys(nb1.items), [KEY]);
    assert.deepEqual(nb1.items[KEY], {
      key: KEY, title: feedItem.title, url: feedItem.url, source: { id: 'hn_show', name: 'Hacker News' }, kind: 'funding', region: 'usa',
      publishedAt: feedItem.publishedAt, summary: feedItem.summary, sectors: ['ai', 'fintech'], savedAt: T0, note: '', tags: [],
    });
    assert.equal('extra' in nb1.items[KEY], false);
    assert.equal(savedItem({ ...feedItem, key: 'abc' }, T0).key, 'abc', 'an explicit key wins');
  });

  test('re-adding keeps note, tags and savedAt; remove/setNote/setTags are no-ops for unknown keys', () => {
    let nb = addItem(emptyNotebook(), feedItem, T0);
    nb = setNote(nb, KEY, 'call them');
    nb = setTags(nb, KEY, ['bank', ' bank ', '', 'ai']);
    assert.deepEqual(nb.items[KEY].tags, ['bank', 'ai']);
    const again = addItem(nb, { ...feedItem, title: 'Renamed' }, T1);
    assert.equal(again.items[KEY].title, 'Renamed');
    assert.equal(again.items[KEY].note, 'call them');
    assert.deepEqual(again.items[KEY].tags, ['bank', 'ai']);
    assert.equal(again.items[KEY].savedAt, T0);
    assert.equal(removeItem(nb, 'nope'), nb);
    assert.equal(setNote(nb, 'nope', 'x'), nb);
    assert.equal(setTags(nb, 'nope', ['x']), nb);
    assert.deepEqual(removeItem(nb, KEY).items, {});
    assert.equal(Object.keys(nb.items).length, 1, 'remove did not mutate');
  });

  test('listItems newest-saved first; search prefixes every token over title/summary/note/tags/source', () => {
    let nb = addItem(emptyNotebook(), feedItem, T0);
    nb = addItem(nb, { ...feedItem, url: 'https://beta.test', title: 'Beta climate sensors', summary: '', sectors: ['climate'] }, T1);
    nb = setTags(nb, itemKey('https://beta.test'), ['hardware']);
    assert.deepEqual(listItems(nb).map((i) => i.title), ['Beta climate sensors', feedItem.title]);
    assert.equal(search(nb, 'cli sens').items.length, 1);
    assert.equal(search(nb, 'hardw').items[0].title, 'Beta climate sensors');
    assert.equal(search(nb, 'hacker').items.length, 2);
    assert.equal(search(nb, 'copilot bank').items.length, 1);
    assert.equal(search(nb, 'zzz').items.length, 0);
    assert.equal(search(nb, '').items.length, 2);
  });
});

describe('notebook-store: canvases', () => {
  test('upsertCanvas generates an id, fills every field as a string, keeps createdAt on update', () => {
    let nb = upsertCanvas(emptyNotebook(), { title: 'Bank copilots', problem: 'Slow loan ops', linkedKeys: [KEY, KEY, ''] }, T0);
    const [c] = listCanvases(nb);
    assert.match(c.id, /^c-[0-9a-z]+-1$/);
    assert.equal(c.createdAt, T0);
    assert.equal(c.updatedAt, T0);
    assert.deepEqual(c.linkedKeys, [KEY]);
    for (const f of CANVAS_FIELDS) assert.equal(typeof c[f], 'string');
    assert.equal(c.who, '');
    nb = upsertCanvas(nb, { id: c.id, who: 'Community banks' }, T1);
    assert.equal(nb.canvases[c.id].createdAt, T0);
    assert.equal(nb.canvases[c.id].updatedAt, T1);
    assert.equal(nb.canvases[c.id].problem, 'Slow loan ops', 'omitted fields keep their value');
    assert.equal(nb.canvases[c.id].who, 'Community banks');
    assert.deepEqual(removeCanvas(nb, c.id).canvases, {});
    assert.equal(removeCanvas(nb, 'nope'), nb);
    assert.equal(search(nb, 'loan').canvases.length, 1);
  });
});

describe('notebook-store: export / import', () => {
  function sample() {
    let nb = addItem(emptyNotebook(), feedItem, T0);
    nb = setNote(nb, KEY, 'note with # and | and *stars*');
    nb = setTags(nb, KEY, ['bank|loans']);
    nb = upsertCanvas(nb, { id: 'c1', title: '# Not a heading', problem: 'cell | pipe', linkedKeys: [KEY] }, T1);
    return nb;
  }

  test('toMarkdown escapes # and | (and other inline markers) in user text, labels sectors keyword-tagged, states browser-only storage', () => {
    const md = toMarkdown(sample());
    assert.match(md, /^# Startup Radar notebook\n/);
    assert.ok(md.includes('Saved in the browser only'));
    assert.ok(md.includes('- [Acme raises $4M for LLM copilots \\# banks \\| lenders](https://acme.test/round)'));
    assert.ok(md.includes('sectors (keyword-tagged): ai, fintech'));
    assert.ok(md.includes('note: note with \\# and \\| and \\*stars\\*'));
    assert.ok(md.includes('tags: bank\\|loans'));
    assert.ok(md.includes('### \\# Not a heading'));
    assert.ok(md.includes('**Problem:** cell \\| pipe'));
    assert.ok(md.includes('**Linked items:** [Acme raises'));
    assert.doesNotMatch(md, /\n# Not a heading/);
    const empty = toMarkdown(emptyNotebook());
    assert.ok(empty.includes('_No saved items._') && empty.includes('_No canvases._'));
  });

  test('toJson -> fromJson round-trips', () => {
    const nb = sample();
    assert.deepEqual(fromJson(toJson(nb)), nb);
  });

  test('fromJson rejects non-notebooks with readable errors', () => {
    assert.throws(() => fromJson('not json'), /Not valid JSON/);
    assert.throws(() => fromJson('[]'), /expected an object/);
    assert.throws(() => fromJson('"text"'), /expected an object/);
    assert.throws(() => fromJson('null'), /expected an object/);
    assert.throws(() => fromJson('{"items":{},"canvases":{}}'), /version null/);
    assert.throws(() => fromJson('{"version":2,"items":{},"canvases":{}}'), /version 2/);
    assert.throws(() => fromJson('{"version":1,"items":[],"canvases":{}}'), /must be objects/);
    assert.throws(() => fromJson('{"version":1,"items":{"k":{"title":"no url"}},"canvases":{}}'), /Saved item "k" is malformed/);
    assert.throws(() => fromJson('{"version":1,"items":{},"canvases":{"c":"x"}}'), /Canvas "c" is malformed/);
  });

  test('fromJson normalises loose but valid input (missing note/tags, bad savedAt)', () => {
    const nb = fromJson(JSON.stringify({ version: 1, items: { k: { url: 'https://x.test', title: 'X', savedAt: 'garbage', tags: 'nope' } }, canvases: { c: { title: 'C' } } }));
    assert.equal(nb.items.k.key, 'k');
    assert.equal(nb.items.k.note, '');
    assert.deepEqual(nb.items.k.tags, []);
    assert.deepEqual(nb.items.k.sectors, []);
    assert.ok(!Number.isNaN(Date.parse(nb.items.k.savedAt)));
    assert.equal(nb.canvases.c.id, 'c');
    assert.deepEqual(nb.canvases.c.linkedKeys, []);
  });

  test('merge unions items (later savedAt wins the record, tags unioned, earliest savedAt kept) and canvases (later updatedAt wins)', () => {
    const a = setTags(addItem(emptyNotebook(), feedItem, T0), KEY, ['x']);
    const b = setNote(setTags(addItem(emptyNotebook(), { ...feedItem, title: 'Newer title' }, T2), KEY, ['y']), KEY, 'from b');
    const other = addItem(emptyNotebook(), { ...feedItem, url: 'https://other.test' }, T1);
    const m = merge(merge(a, b), other);
    assert.equal(Object.keys(m.items).length, 2);
    assert.equal(m.items[KEY].title, 'Newer title');
    assert.equal(m.items[KEY].note, 'from b');
    assert.deepEqual(m.items[KEY].tags, ['x', 'y']);
    assert.equal(m.items[KEY].savedAt, T0);
    const ca = upsertCanvas(emptyNotebook(), { id: 'c', title: 'old' }, T0);
    const cb = upsertCanvas(emptyNotebook(), { id: 'c', title: 'new' }, T2);
    assert.equal(merge(ca, cb).canvases.c.title, 'new');
    assert.equal(merge(cb, ca).canvases.c.title, 'new');
    assert.equal(merge(a, emptyNotebook()).version, 1);
  });
});

describe('notebook-store: storage adapter', () => {
  const fakeStorage = (store = {}) => ({ getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, store });

  test('load returns an empty notebook for nothing / garbage / wrong shape and the parsed one otherwise; save writes compact JSON', () => {
    const s = fakeStorage();
    assert.deepEqual(load(s), emptyNotebook());
    s.setItem(STORAGE_KEY, '{bad');
    assert.deepEqual(load(s), emptyNotebook());
    s.setItem(STORAGE_KEY, '[]');
    assert.deepEqual(load(s), emptyNotebook());
    s.setItem(STORAGE_KEY, '{"version":2,"items":{},"canvases":{}}');
    assert.deepEqual(load(s), emptyNotebook());
    const nb = addItem(emptyNotebook(), feedItem, T0);
    save(nb, s);
    assert.equal(s.store[STORAGE_KEY], JSON.stringify(nb));
    assert.deepEqual(load(s), nb);
  });

  test('load coerces stored canvases like items (missing linkedKeys / fields, bad timestamps; non-objects dropped)', () => {
    const s = fakeStorage();
    s.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items: {}, canvases: { a: { title: 'Hand-edited', updatedAt: 'nope' }, b: 'junk', c: { id: 'c', title: 'Full', problem: 7, linkedKeys: ['k', 'k', 3, ''], createdAt: T0, updatedAt: T1 } } }));
    const nb = load(s);
    assert.deepEqual(Object.keys(nb.canvases).sort(), ['a', 'c']);
    const a = nb.canvases.a;
    assert.equal(a.id, 'a');
    assert.deepEqual(a.linkedKeys, []);
    for (const f of CANVAS_FIELDS) assert.equal(typeof a[f], 'string', `${f} is a string`);
    assert.ok(!Number.isNaN(Date.parse(a.createdAt)) && !Number.isNaN(Date.parse(a.updatedAt)));
    assert.deepEqual(nb.canvases.c, { id: 'c', createdAt: T0, updatedAt: T1, linkedKeys: ['k', '3'], title: 'Full', problem: '7', who: '', whyNow: '', existing: '', distribution: '', moat: '', firstTen: '' });
    assert.equal(toMarkdown(nb).includes('### Hand-edited'), true, 'export works on the loaded notebook');
  });

  test('load drops a malformed saved item and keeps the valid ones and the canvases (import stays strict)', () => {
    const s = fakeStorage();
    const good = addItem(emptyNotebook(), feedItem, T0).items[KEY];
    const stored = { version: 1, items: { [KEY]: good, bad: 'x', nourl: { title: 'no url' } }, canvases: { c: { id: 'c', title: 'Keep me', createdAt: T0, updatedAt: T1 } } };
    s.setItem(STORAGE_KEY, JSON.stringify(stored));
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let nb;
    try { nb = load(s); } finally { console.warn = warn; }
    assert.deepEqual(Object.keys(nb.items), [KEY]);
    assert.deepEqual(nb.items[KEY], good);
    assert.equal(nb.canvases.c.title, 'Keep me');
    assert.equal(warnings.length, 2, 'one warning per dropped item');
    assert.ok(warnings.every((w) => w.includes('malformed saved item')), warnings.join('; '));
    save(nb, s);
    assert.deepEqual(load(s), nb, 'the next save keeps the valid records');
    assert.throws(() => fromJson(JSON.stringify(stored)), /Saved item "bad" is malformed/, 'an import of the same object is still rejected');
  });

  test('save throws a readable Error on quota / unavailable storage', () => {
    const quota = { setItem: () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } };
    assert.throws(() => save(emptyNotebook(), quota), /Could not save to this browser.s storage \(it is full\)/);
    assert.throws(() => save(emptyNotebook(), { setItem: () => { throw new Error('denied'); } }), /blocked or unavailable/);
    assert.throws(() => save(emptyNotebook(), null), /blocked or unavailable/);
  });
});
