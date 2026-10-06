// Startup Radar notebook page (plan §2.4 item 12, D11). Everything here is read from and written to
// localStorage['sr:notebook:v1'] through ./notebook-store.js (items) and ./notebook-tools.js (canvases, search,
// export, import, merge); nothing is sent anywhere. DOM via ui.js el() only (strict CSP); saved items open in the
// shared drawer because they carry the full saved item shape.

import { METHOD_LABELS, absoluteTime, pluralize, sectorLabels } from './format.js';
import { badge, button, clear, el, timeEl, toast } from './ui.js';
import { listItems, load, removeItem, save, setNote, setTags } from './notebook-store.js';
import { CANVAS_FIELDS, fromJson, listCanvases, merge, removeCanvas, search, toJson, toMarkdown, upsertCanvas } from './notebook-tools.js';
import { createLensPage, itemLink, wireOpeners } from './lens.js';

const DEBOUNCE_MS = 300;
const SECTOR_TITLE = `${METHOD_LABELS.sectors} (title + summary)`;

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), search: $('nb-search'), itemsCount: $('nb-items-count'), items: $('nb-items'), itemsEmpty: $('nb-items-empty'),
  canvasList: $('nb-canvas-list'), canvasEmpty: $('nb-canvas-empty'), form: $('nb-canvas-form'), formTitle: $('nb-canvas-form-title'),
  canvasSaved: $('nb-canvas-saved'), linkedGrid: $('nb-linked-grid'), linkedEmpty: $('nb-linked-empty'), importFile: $('nb-import-file'),
};
const fields = Object.fromEntries(CANVAS_FIELDS.map((f) => [f, $(`cv-${f}`)]));

let nb = load();
let sectorLabel = {}; // id -> label from stats.json (ids travel on saved items)
let visibleItems = []; // saved items currently listed (drawer prev/next order)
let canvasId = null; // the canvas open in the editor
const timers = new Map();

const buildUrl = (key) => (key ? `${location.pathname}?item=${key}` : location.pathname);
const lens = createLensPage({ page: 'notebook', getList: () => visibleItems, findItem: (key) => nb.items[key] ?? null, buildUrl, sections: [sectorsSection] });

// -- persistence --

/** Apply `fn` to a fresh read of storage (the feed page may have written since boot) and persist the result;
 * a storage failure keeps the in-memory copy and reports it (never silent). */
function commit(fn) {
  nb = fn(load());
  try {
    save(nb);
    return true;
  } catch (err) {
    toast(err.message, { variant: 'error' });
    return false;
  }
}

function debounce(id, fn) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { timers.delete(id); fn(); }, DEBOUNCE_MS));
}

const splitTags = (text) => String(text).split(',').map((t) => t.trim()).filter(Boolean);

// -- status --

function renderStatus() {
  const n = Object.keys(nb.items).length;
  const m = Object.keys(nb.canvases).length;
  els.status.textContent = `${pluralize(n, 'saved item', 'saved items')} \u00b7 ${pluralize(m, 'canvas', 'canvases')} \u00b7 stored in this browser only`;
}

// -- saved items --

function sectorBadges(item) {
  const row = el('span', { className: 'badge-row', title: SECTOR_TITLE });
  for (const id of Array.isArray(item.sectors) ? item.sectors : []) row.append(badge(sectorLabel[id] || id, 'badge-sector'));
  return row;
}

/** Drawer section: the saved item's sectors (labels from stats.json) and when it was saved. */
function sectorsSection(item) {
  const dl = el('dl', { className: 'detail-meta detail-sectors' });
  if (Array.isArray(item.sectors) && item.sectors.length) dl.append(el('dt', { text: 'Sectors' }), el('dd', { title: SECTOR_TITLE }, [sectorBadges(item)]));
  if (item.savedAt) dl.append(el('dt', { text: 'Saved' }), el('dd', { text: `${absoluteTime(item.savedAt)} \u00b7 in this browser` }));
  return dl.childElementCount ? dl : null;
}

function tagChips(tags) {
  const row = el('div', { className: 'badge-row nb-tag-row' });
  for (const t of tags) row.append(badge(t, 'badge-tag'));
  return row;
}

function itemCard(item) {
  const key = item.key;
  const noteId = `nb-note-${key}`;
  const tagsId = `nb-tags-${key}`;
  const meta = el('p', { className: 'meta nb-item-meta' }, [
    el('span', { text: item.source?.name || item.source?.id || 'Unknown source' }),
    document.createTextNode(' \u00b7 saved '),
    timeEl(item.savedAt),
  ]);
  if (item.publishedAt) meta.append(document.createTextNode(' \u00b7 published '), timeEl(item.publishedAt));
  const note = el('textarea', { id: noteId, className: 'nb-note', rows: '2', placeholder: 'Why it matters to you' });
  note.value = item.note;
  note.addEventListener('input', () => debounce(noteId, () => { commit((cur) => setNote(cur, key, note.value)); }));
  let chips = tagChips(item.tags);
  const tags = el('input', { type: 'text', id: tagsId, className: 'nb-input nb-tags', autocomplete: 'off', placeholder: 'idea, follow-up, competitor' });
  tags.value = item.tags.join(', ');
  tags.addEventListener('input', () => debounce(tagsId, () => {
    commit((cur) => setTags(cur, key, splitTags(tags.value)));
    const next = tagChips(nb.items[key]?.tags ?? []);
    chips.replaceWith(next);
    chips = next;
  }));
  const remove = button({ className: 'btn-secondary nb-danger', 'aria-label': `Remove "${item.title || '(untitled)'}" from the notebook` }, [el('span', { text: 'Remove' })], () => {
    if (!confirm(`Remove "${item.title || '(untitled)'}" from the notebook? Its note and tags go with it.`)) return;
    commit((cur) => removeItem(cur, key));
    toast('Removed from notebook');
    renderAll();
  });
  const card = el('article', { className: 'nb-item', dataset: { key } }, [
    el('h3', {}, [itemLink(key, item.title || '(untitled)')]),
    meta,
    sectorBadges(item),
    el('div', { className: 'nb-field' }, [el('label', { className: 'select-label', for: noteId, text: 'Note' }), note]),
    el('div', { className: 'nb-field' }, [el('label', { className: 'select-label', for: tagsId, text: 'Tags (comma-separated)' }), tags]),
    el('div', { className: 'nb-item-foot' }, [chips, remove]),
  ]);
  return card;
}

function renderItems() {
  const q = els.search.value.trim();
  const all = listItems(nb);
  visibleItems = q ? search(nb, q).items : all;
  clear(els.items);
  for (const item of visibleItems) els.items.append(itemCard(item));
  els.itemsEmpty.hidden = visibleItems.length > 0;
  els.itemsEmpty.textContent = all.length ? `No saved item matches "${q}".` : 'Nothing saved yet. Use the bookmark button on a feed card to save it here.';
  els.itemsCount.textContent = q ? `${visibleItems.length} of ${pluralize(all.length, 'saved item', 'saved items')} match` : pluralize(all.length, 'saved item', 'saved items');
  if (lens.drawer.isOpen()) lens.drawer.rerender();
}

// -- canvases --

/** Patch the open canvas over a fresh read (fields outside `patch` keep their stored value). */
const patchCanvas = (patch) => commit((cur) => upsertCanvas(cur, { ...(cur.canvases[canvasId] ?? nb.canvases[canvasId]), ...patch }));

/** Add a canvas and return its id (the one key the fresh read did not have). */
function addCanvas(record) {
  let before = null;
  if (!commit((cur) => { before = new Set(Object.keys(cur.canvases)); return upsertCanvas(cur, record); })) return null;
  return Object.keys(nb.canvases).find((id) => !before.has(id)) ?? null;
}

function canvasRow(c) {
  const b = button({ className: 'nb-canvas-row', dataset: { canvasId: c.id }, 'aria-pressed': c.id === canvasId ? 'true' : 'false' }, [
    el('span', { className: 'nb-canvas-title', text: c.title || '(untitled canvas)' }),
    el('span', { className: 'meta', text: pluralize(c.linkedKeys.length, 'linked item', 'linked items') }),
  ], () => { canvasId = c.id; renderCanvases(); fillForm(); });
  return el('li', {}, [b]);
}

function renderCanvases() {
  const list = listCanvases(nb);
  clear(els.canvasList);
  for (const c of list) els.canvasList.append(canvasRow(c));
  els.canvasEmpty.hidden = list.length > 0;
  if (canvasId && !nb.canvases[canvasId]) canvasId = null;
  els.form.hidden = !canvasId;
}

function renderLinked(c) {
  clear(els.linkedGrid);
  const items = listItems(nb);
  els.linkedEmpty.hidden = items.length > 0;
  for (const it of items) {
    const box = el('input', { type: 'checkbox', id: `link-${it.key}`, dataset: { linkKey: it.key } });
    box.checked = c.linkedKeys.includes(it.key);
    box.addEventListener('change', () => {
      const cur = nb.canvases[canvasId];
      if (!cur) return;
      const linkedKeys = box.checked ? [...cur.linkedKeys, it.key] : cur.linkedKeys.filter((k) => k !== it.key);
      patchCanvas({ linkedKeys });
      renderCanvases();
      markSaved();
    });
    els.linkedGrid.append(el('label', { className: 'source-option', for: box.id }, [box, el('span', { className: 'source-name', text: it.title || '(untitled)' })]));
  }
}

function markSaved() {
  const c = nb.canvases[canvasId];
  els.canvasSaved.textContent = c ? `Saved ${absoluteTime(c.updatedAt)} \u00b7 in this browser` : '';
}

function fillForm() {
  const c = nb.canvases[canvasId];
  if (!c) { els.form.hidden = true; return; }
  els.form.hidden = false;
  els.formTitle.textContent = c.title || '(untitled canvas)';
  for (const f of CANVAS_FIELDS) fields[f].value = c[f];
  renderLinked(c);
  markSaved();
}

function wireForm() {
  for (const f of CANVAS_FIELDS) {
    fields[f].addEventListener('input', () => debounce(`cv-${f}`, () => {
      if (!nb.canvases[canvasId]) return;
      patchCanvas({ [f]: fields[f].value });
      if (f === 'title') els.formTitle.textContent = fields[f].value || '(untitled canvas)';
      renderCanvases();
      markSaved();
    }));
  }
  els.form.addEventListener('submit', (e) => e.preventDefault());
  $('nb-canvas-new').addEventListener('click', () => {
    const id = addCanvas({ title: '' });
    if (!id) return;
    canvasId = id;
    renderStatus();
    renderCanvases();
    fillForm();
    fields.title.focus();
  });
  $('nb-canvas-duplicate').addEventListener('click', () => {
    const cur = nb.canvases[canvasId];
    if (!cur) return;
    const { id, createdAt, updatedAt, ...rest } = cur;
    const copy = addCanvas({ ...rest, title: `${cur.title || '(untitled canvas)'} (copy)` });
    if (!copy) return;
    canvasId = copy;
    toast('Canvas duplicated');
    renderStatus();
    renderCanvases();
    fillForm();
  });
  $('nb-canvas-delete').addEventListener('click', () => {
    const cur = nb.canvases[canvasId];
    if (!cur || !confirm(`Delete the canvas "${cur.title || '(untitled canvas)'}"? This cannot be undone.`)) return;
    commit((cur) => removeCanvas(cur, canvasId));
    canvasId = null;
    toast('Canvas deleted');
    renderStatus();
    renderCanvases();
  });
}

// -- export / import / delete everything --

/** Blob download through a transient a[download] (el(), then revoked). */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

function wireTools() {
  $('nb-export-md').addEventListener('click', () => download(`startup-radar-notebook-${stamp()}.md`, toMarkdown(nb), 'text/markdown;charset=utf-8'));
  $('nb-export-json').addEventListener('click', () => download(`startup-radar-notebook-${stamp()}.json`, toJson(nb), 'application/json;charset=utf-8'));
  $('nb-import').addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files?.[0];
    els.importFile.value = '';
    if (!file) return;
    let incoming;
    try {
      incoming = fromJson(await file.text());
    } catch (err) {
      toast(`Import failed: ${err.message}`, { variant: 'error' });
      return;
    }
    let beforeItems = 0;
    let beforeCanvases = 0;
    if (!commit((cur) => { beforeItems = Object.keys(cur.items).length; beforeCanvases = Object.keys(cur.canvases).length; return merge(cur, incoming); })) return;
    const n = Object.keys(incoming.items).length;
    const m = Object.keys(incoming.canvases).length;
    toast(`Imported ${pluralize(n, 'saved item', 'saved items')} and ${pluralize(m, 'canvas', 'canvases')} (${Object.keys(nb.items).length - beforeItems} new items, ${Object.keys(nb.canvases).length - beforeCanvases} new canvases; the rest merged)`);
    renderAll();
  });
  $('nb-delete-all').addEventListener('click', () => {
    const n = Object.keys(nb.items).length;
    const m = Object.keys(nb.canvases).length;
    if (!confirm(`Delete everything in this notebook (${pluralize(n, 'saved item', 'saved items')}, ${pluralize(m, 'canvas', 'canvases')})? Export first if you want to keep it.`)) return;
    commit((cur) => ({ ...cur, items: {}, canvases: {} }));
    canvasId = null;
    toast('Notebook emptied');
    renderAll();
  });
  els.search.addEventListener('input', () => debounce('search', renderItems));
  $('nb-search-form').addEventListener('submit', (e) => e.preventDefault());
}

function renderAll() {
  renderStatus();
  renderItems();
  renderCanvases();
  if (canvasId) fillForm();
}

async function init() {
  wireTools();
  wireForm();
  wireOpeners($('main'), lens.open);
  // another tab (or the feed page) changed the notebook: re-read it
  window.addEventListener('storage', (e) => { if (e.key === 'sr:notebook:v1') { nb = load(); renderAll(); } });
  window.addEventListener('pageshow', (e) => { if (e.persisted) { nb = load(); renderAll(); } }); // bfcache Back from the feed page
  renderAll();
  const stats = await lens.loadStats();
  sectorLabel = sectorLabels(stats);
  renderItems();
  $('main').dataset.ready = '';
  await lens.start();
}

init();
