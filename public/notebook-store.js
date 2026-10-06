// Startup Radar notebook store (plan D11): pure functions over { version: 1, items: { key -> saved item }, canvases }
// + the localStorage adapter ('sr:notebook:v1', this browser only). Search/export/import/merge: ./notebook-tools.js.

import { itemKey } from './filter.js';

export const STORAGE_KEY = 'sr:notebook:v1';
export const VERSION = 1;
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
export const iso = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
export const strList = (v) => (Array.isArray(v) ? [...new Set(v.map((t) => str(t).trim()).filter(Boolean))] : []);
export const validIso = (v, fallback) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback);
export const CANVAS_FIELDS = ['title', 'problem', 'who', 'whyNow', 'existing', 'distribution', 'moat', 'firstTen'];
const byNewest = (field) => (a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0);

/** Loose canvas object -> record (string fields, clean linkedKeys, valid timestamps). */
export function canvasRecord(c, id, now = Date.now()) {
  const at = iso(now);
  const out = { id, createdAt: validIso(c.createdAt, at), updatedAt: validIso(c.updatedAt, at), linkedKeys: strList(c.linkedKeys) };
  for (const f of CANVAS_FIELDS) out[f] = str(c[f] ?? '');
  return out;
}

export function emptyNotebook() {
  return { version: VERSION, items: {}, canvases: {} };
}

/** Feed item -> saved record. */
export function savedItem(item, now = Date.now()) {
  const key = typeof item.key === 'string' && item.key ? item.key : itemKey(item.url);
  const source = isObject(item.source) ? { id: str(item.source.id), name: str(item.source.name) } : { id: '', name: str(item.source) };
  return {
    key, title: str(item.title), url: str(item.url), source, kind: str(item.kind), region: str(item.region),
    publishedAt: str(item.publishedAt), summary: str(item.summary), sectors: strList(item.sectors), savedAt: iso(now), note: '', tags: [],
  };
}

/** Add (or refresh) an item; an existing entry keeps its note, tags and savedAt. */
export function addItem(nb, item, now = Date.now()) {
  const saved = savedItem(item, now);
  const prev = nb.items[saved.key];
  const next = prev ? { ...saved, note: prev.note, tags: prev.tags, savedAt: prev.savedAt } : saved;
  return { ...nb, items: { ...nb.items, [saved.key]: next } };
}

export function removeItem(nb, key) {
  if (!(key in nb.items)) return nb;
  const items = { ...nb.items };
  delete items[key];
  return { ...nb, items };
}

export function setNote(nb, key, text) {
  const prev = nb.items[key];
  return prev ? { ...nb, items: { ...nb.items, [key]: { ...prev, note: str(text) } } } : nb;
}

export function setTags(nb, key, tags) {
  const prev = nb.items[key];
  return prev ? { ...nb, items: { ...nb.items, [key]: { ...prev, tags: strList(tags) } } } : nb;
}

export const listItems = (nb) => Object.values(nb.items).sort(byNewest('savedAt'));

/** Stored object -> notebook (shape checked, records coerced; throws on a non-notebook). */
export function fromStored(raw) {
  if (!isObject(raw) || raw.version !== VERSION || !isObject(raw.items) || !isObject(raw.canvases)) throw new Error('Not a version-1 notebook');
  const nb = emptyNotebook();
  for (const [key, it] of Object.entries(raw.items)) {
    if (!isObject(it) || typeof it.url !== 'string' || !it.url) throw new Error(`Saved item ${JSON.stringify(key)} is malformed`);
    nb.items[key] = { ...savedItem({ ...it, key }, validIso(it.savedAt, Date.now())), note: str(it.note), tags: strList(it.tags) };
  }
  for (const [id, c] of Object.entries(raw.canvases)) if (isObject(c)) nb.canvases[id] = canvasRecord(c, id); // a non-object canvas is dropped
  return nb;
}

// -- localStorage adapter (browser only) --

/** The stored notebook, or an empty one when nothing readable is stored. */
export function load(storage = globalThis.localStorage) {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    return text ? fromStored(JSON.parse(text)) : emptyNotebook();
  } catch (err) {
    console.warn('[radar] notebook unreadable, starting empty:', err?.message ?? err);
    return emptyNotebook();
  }
}

/** Persist; throws a readable Error when storage is unavailable or full. */
export function save(nb, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(nb));
  } catch (err) {
    throw new Error(`Could not save to this browser\u2019s storage (${err?.name === 'QuotaExceededError' ? 'it is full' : 'blocked or unavailable'})`);
  }
}
