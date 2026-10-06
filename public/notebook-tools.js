// Startup Radar notebook tools (plan D11; notebook page only, not in the home budget): idea canvases, search,
// Markdown / JSON export, strict JSON import and merge over the ./notebook-store.js notebook shape. DOM-free.

import { tokenize } from './filter.js';
import { CANVAS_FIELDS, VERSION, canvasRecord, emptyNotebook, fromStored, isObject, iso, listItems, str, strList } from './notebook-store.js';

export { CANVAS_FIELDS };
const CANVAS_LABELS = { problem: 'Problem', who: 'Who has it', whyNow: 'Why now', existing: 'Existing solutions', distribution: 'Distribution', moat: 'Moat', firstTen: 'First ten customers' };
const byNewest = (field) => (a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0);

/** Insert or update an idea canvas; a missing id is generated from `now` and the canvas count. */
export function upsertCanvas(nb, canvas, now = Date.now()) {
  const at = iso(now);
  const id = typeof canvas.id === 'string' && canvas.id ? canvas.id : `c-${Date.parse(at).toString(36)}-${Object.keys(nb.canvases).length + 1}`;
  const prev = nb.canvases[id];
  const next = { id, createdAt: prev?.createdAt ?? at, updatedAt: at, linkedKeys: strList(canvas.linkedKeys) };
  for (const f of CANVAS_FIELDS) next[f] = str(canvas[f] ?? prev?.[f] ?? '');
  return { ...nb, canvases: { ...nb.canvases, [id]: next } };
}

export function removeCanvas(nb, id) {
  if (!(id in nb.canvases)) return nb;
  const canvases = { ...nb.canvases };
  delete canvases[id];
  return { ...nb, canvases };
}

export const listCanvases = (nb) => Object.values(nb.canvases).sort(byNewest('updatedAt'));

const itemText = (it) => [it.title, it.summary, it.note, ...it.tags, it.source?.name].join(' ');
const canvasText = (c) => CANVAS_FIELDS.map((f) => c[f]).join(' ');

/** Every query token must prefix a word of the record (same rule as the feed search). */
export function search(nb, q) {
  const tokens = tokenize(q);
  const hit = (text) => { const have = tokenize(text); return tokens.every((t) => have.some((w) => w.startsWith(t))); };
  return { items: listItems(nb).filter((it) => hit(itemText(it))), canvases: listCanvases(nb).filter((c) => hit(canvasText(c))) };
}

const esc = (s) => str(s).replace(/[\\#|[\]*_`]/g, (c) => `\\${c}`).replace(/\s*\n\s*/g, ' ');

export function toMarkdown(nb) {
  const out = ['# Startup Radar notebook', '', `Exported ${iso(Date.now())}. Saved in the browser only; this file is the copy.`, '', '## Saved items', ''];
  const items = listItems(nb);
  if (!items.length) out.push('_No saved items._', '');
  for (const it of items) {
    const meta = [it.source?.name, it.kind, it.region, it.publishedAt ? it.publishedAt.slice(0, 10) : '', it.sectors.length ? `sectors (keyword-tagged): ${it.sectors.join(', ')}` : ''].filter(Boolean).map(esc).join(' \u00b7 ');
    out.push(`- [${esc(it.title) || '(untitled)'}](${it.url}) \u2014 ${meta}`);
    if (it.tags.length) out.push(`  - tags: ${it.tags.map(esc).join(', ')}`);
    if (it.note) out.push(`  - note: ${esc(it.note)}`);
  }
  out.push('', '## Idea canvases', '');
  const canvases = listCanvases(nb);
  if (!canvases.length) out.push('_No canvases._', '');
  for (const c of canvases) {
    out.push(`### ${esc(c.title) || '(untitled canvas)'}`, '', `Updated ${c.updatedAt}`, '');
    for (const f of CANVAS_FIELDS.slice(1)) out.push(`- **${CANVAS_LABELS[f]}:** ${esc(c[f]) || '\u2014'}`);
    if (c.linkedKeys.length) out.push(`- **Linked items:** ${c.linkedKeys.map((k) => (nb.items[k] ? `[${esc(nb.items[k].title)}](${nb.items[k].url})` : esc(k))).join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}

export const toJson = (nb) => JSON.stringify(nb, null, 2);

/** Parse + validate an export; throws a readable Error on anything that is not a version-1 notebook object. */
export function fromJson(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('Not valid JSON'); }
  if (!isObject(raw)) throw new Error('Not a notebook (expected an object)');
  if (raw.version !== VERSION) throw new Error(`Unsupported notebook version ${JSON.stringify(raw.version ?? null)} (expected ${VERSION})`);
  if (!isObject(raw.items) || !isObject(raw.canvases)) throw new Error('Not a notebook (items and canvases must be objects)');
  const nb = { ...fromStored(raw), canvases: {} };
  for (const [id, c] of Object.entries(raw.canvases)) {
    if (!isObject(c)) throw new Error(`Canvas ${JSON.stringify(id)} is malformed`);
    nb.canvases[id] = canvasRecord(c, id); // import is strict (throws above); the record shape is the store's
  }
  return nb;
}

/** Union of two notebooks; on a shared key the entry with the later savedAt / updatedAt wins, tags are unioned. */
export function merge(a, b) {
  const items = { ...a.items };
  for (const [key, it] of Object.entries(b.items)) {
    const prev = items[key];
    if (!prev) { items[key] = it; continue; }
    const newer = it.savedAt > prev.savedAt ? it : prev;
    const older = newer === it ? prev : it;
    items[key] = { ...newer, note: newer.note || older.note, tags: strList([...prev.tags, ...it.tags]), savedAt: older.savedAt < newer.savedAt ? older.savedAt : newer.savedAt };
  }
  const canvases = { ...a.canvases };
  for (const [id, c] of Object.entries(b.canvases)) {
    if (!canvases[id] || c.updatedAt > canvases[id].updatedAt) canvases[id] = c;
  }
  return { ...emptyNotebook(), items, canvases };
}
