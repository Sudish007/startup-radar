// Startup Radar home page (strict CSP: DOM via ui.js el(), textContent only; ./data/*.json filtered by ./filter.js).

import { SINCE_VALUES, filterItems, pointsOf, sortItems } from './filter.js';
import { KIND_LABELS, METHOD_LABELS, REGION_LABELS, absoluteTime, hostnameOf, metaParts, pluralize, pointsText, regionLabel, relativeTime, safeHttpUrl, sectorLabels, votesText } from './format.js';
import { badge, button, clear, createStatusLine, el, extLink, fetchJson, icon, kindBadge, openHelp, pollStats, reduceMotion, regionBadge, scrollLock, sourceBadge, startPwa, startTicker, tickTimes, timeEl, toast, toggleTheme } from './ui.js';
import { fitPlates, initRadar, radarCount, renderRadar, MAX_BLIPS } from './radar.js';
import { mountShell } from './shell.js';
import { createDrawer, keyOf, openExternal } from './drawer.js';
import * as notebook from './notebook-store.js';

const PAGE_SIZE = 30;
const DEBOUNCE_MS = 300;
const Q_MAX = 200;
const KEY_RE = /^[0-9a-z]{1,13}$/;
const KINDS = Object.keys(KIND_LABELS);
const REGIONS = Object.keys(REGION_LABELS);
// = --ease-out / --ease-in-out in styles.css (WAAPI cannot read CSS variables)
const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';
const EASE_IN_OUT = 'cubic-bezier(.4,0,.2,1)';
const FLIP_MAX = 60;
const TEXT_ENTRY = 'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="tel"], input[type="number"], input[type="password"]';
const INERT_SELECTOR = 'header.site-header, section.hero, main > :not(#filter-panel):not(.scrim), footer.site-footer, #new-items, #toasts';
// Help-dialog rows; onKeydown implements exactly these
const SHORTCUTS = [
  [['/'], 'Focus the search field'],
  [['j', '\u2193'], 'Next card (at the last card: load more)'],
  [['k', '\u2191'], 'Previous card'],
  [['Home', 'End'], 'First / last card'],
  [['Enter'], 'Open the highlighted card in the detail panel'],
  [['o'], 'Open the original page in a new tab'],
  [['Esc'], 'Close the top layer (help, detail panel, filter sheet, sources list) or clear the highlight'],
  [['t'], 'Toggle dark / light theme'],
  [['?'], 'Show this list'],
  [['j', '\u2192'], 'In the detail panel: next item'],
  [['k', '\u2190'], 'In the detail panel: previous item'],
];
const ITEMS_URL = './data/items.json';
const ARCHIVE_URL = './data/archive.json';
const SOURCES_URL = './data/sources.json';
const STATS_URL = './data/stats.json';

const $ = (id) => document.getElementById(id);
const q1 = (sel) => document.querySelector(sel);
const tx = (s) => document.createTextNode(s);
const itemParam = () => new URLSearchParams(location.search).get('item');
// els.<camelCase id> for every id below, plus the class-based lookups.
const IDS = 'subtitle search-form q filters kind region sort sources-filter source-list reset result-count offline-note results load-more filter-panel filter-panel-title filters-open filters-close filters-apply view-grid view-list stat-feed stat-24h stat-7d stat-sources radar-panel radar-title new-items new-items-btn sector-chips';
const els = Object.fromEntries(IDS.split(' ').map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(id)]));
Object.assign(els, {
  scopeButtons: Array.from(document.querySelectorAll('button.scope')), chipButtons: Array.from(document.querySelectorAll('button.chip')),
  sourcesSummary: q1('#sources-filter > summary'), sortNote: q1('.sort-note'), countBadge: q1('#filters-open .count-badge'), scrim: q1('.scrim'),
  radarSvg: q1('svg.radar'), radarTip: q1('.radar-tip'), newItemsDismiss: q1('#new-items .pill-dismiss'),
});

const BASE_TITLE = document.title;
const supportsAnimate = typeof Element.prototype.animate === 'function';
const radarMq = matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)');
const sheetMq = matchMedia('(max-width: 639.98px)');
const wideMq = matchMedia('(min-width: 640px)');

const state = { kind: '', region: '', sources: [], sectors: [], q: '', since: '', sort: '', page: 1, highlightKey: null, view: readView() };
const data = {
  primary: [],
  archive: null, // null = not loaded yet; [] = loaded (or none exists)
  archiveItems: 0, // from stats.json
  archiveLoading: null, // single-flight promise
  archiveError: '',
  loadError: '', // items.json failed
  stats: null,
  seenRefresh: null, // lastRefresh seen at load / last applied refresh
  pending: null, // { items, stats, at } behind the new-items pill
  allSources: null, // sources.json payload (null = failed)
};
const sheet = { isOpen: false, pillSuppressed: false, inertEls: [] };
let drawer = null; // createDrawer() result (init)
let knownSources = [];
let knownSectors = []; // stats.sectors ids (chip order)
let sectorLabel = {}; // id -> label from stats.json
let nb = notebook.emptyNotebook(); // the browser-only notebook (localStorage)
let relatedMod = null; // lazy ./related.js
let lastView = null;
let firstRender = true;
let refetchFailStreak = 0;
let statsFailStreak = 0;
let platesFitted = false;
let historyBroken = false;
let pendingDeepKey = null; // ?item= at boot, kept in the URL until the drawer opened (or missed)
const statusLine = createStatusLine();

const allItems = () => (data.archive ? data.primary.concat(data.archive) : data.primary);
const currentList = () => sortItems(filterItems(allItems(), state), state.sort);
const findItem = (key) => allItems().find((it) => keyOf(it) === key) ?? null;
const cardFor = (key) => (key ? els.results.querySelector(`article.card[data-key="${key}"]`) : null);
const validKey = (v) => (typeof v === 'string' && KEY_RE.test(v) ? v : null);
const finiteNumber = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const effectiveView = () => (state.view === 'list' && wideMq.matches ? 'list' : 'grid');

function readView() {
  try { return localStorage.getItem('sr:view') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
}

function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

// -- state <-> URL --

function readStateFromLocation() {
  const p = new URLSearchParams(location.search);
  const kind = p.get('kind') || '';
  state.kind = KINDS.includes(kind) ? kind : '';
  const region = p.get('region') || '';
  state.region = REGIONS.includes(region) || region === 'world' ? region : '';
  state.q = (p.get('q') || '').trim().slice(0, Q_MAX);
  const since = p.get('since') || '';
  state.since = SINCE_VALUES.has(since) ? since : '';
  state.sort = p.get('sort') === 'points' ? 'points' : '';
  const src = p.get('source') || '';
  state.sources = src ? src.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (knownSources.length) {
    const known = new Set(knownSources.map((s) => s.id));
    state.sources = state.sources.filter((id) => known.has(id));
  }
  const sec = p.get('sector') || '';
  state.sectors = sec ? [...new Set(sec.split(',').map((s) => s.trim()).filter(Boolean))] : [];
  if (knownSectors.length) state.sectors = state.sectors.filter((id) => knownSectors.includes(id));
  state.page = 1;
}

/** The single URL builder (pathname + params + item=<key>; never a leading slash). */
function buildUrl(st, openKey = null) {
  const p = new URLSearchParams();
  if (st.kind) p.set('kind', st.kind);
  if (st.region) p.set('region', st.region);
  if (st.sources.length) p.set('source', st.sources.join(','));
  if (st.sectors.length) p.set('sector', st.sectors.join(','));
  if (st.q) p.set('q', st.q);
  if (st.since) p.set('since', st.since);
  if (st.sort) p.set('sort', st.sort);
  if (openKey) p.set('item', openKey);
  const qs = p.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
}

function replaceUrl(url) {
  if (historyBroken) return;
  try { history.replaceState(null, '', url); } catch (err) { historyBroken = true; console.warn('[radar] history unavailable:', err?.message ?? err); }
}
const syncLocation = () => replaceUrl(buildUrl(state, drawer?.isOpen() ? drawer.key() : pendingDeepKey));

// -- controls --

const activeFilterCount = () => (state.kind ? 1 : 0) + (state.region ? 1 : 0) + (state.since ? 1 : 0) + (state.sources.length ? 1 : 0) + (state.sectors.length ? 1 : 0) + (state.q ? 1 : 0);

function syncControls() {
  els.q.value = state.q;
  els.kind.value = state.kind;
  els.region.value = REGIONS.includes(state.region) ? state.region : '';
  els.sort.value = state.sort;
  for (const btn of els.scopeButtons) {
    const scope = btn.dataset.scope;
    btn.setAttribute('aria-pressed', (scope === '' ? state.region === '' : state.region === scope) ? 'true' : 'false');
  }
  for (const btn of els.chipButtons) btn.setAttribute('aria-pressed', btn.dataset.since === state.since ? 'true' : 'false');
  for (const btn of els.sectorChips.querySelectorAll('button.chip-sector')) btn.setAttribute('aria-pressed', state.sectors.includes(btn.dataset.sector) ? 'true' : 'false');
  for (const box of els.sourceList.querySelectorAll('input[type="checkbox"]')) {
    box.checked = state.sources.includes(box.value);
    box.closest('label')?.classList.toggle('checked', box.checked);
  }
  syncIndicators();
}

/** State indicators that never rewrite an input the user may be typing in. */
function syncIndicators() {
  els.sourcesSummary.textContent = state.sources.length ? `Sources \u00b7 ${state.sources.length}` : 'Sources';
  const active = activeFilterCount();
  const resetActive = active > 0 || Boolean(state.sort);
  els.reset.classList.toggle('btn-ghost', !resetActive);
  els.reset.classList.toggle('btn-secondary', resetActive);
  els.countBadge.textContent = String(active);
  els.countBadge.hidden = active === 0;
  els.filtersOpen.setAttribute('aria-label', active ? `Filters, ${active} active` : 'Filters');
  els.viewGrid.setAttribute('aria-pressed', state.view === 'grid' ? 'true' : 'false');
  els.viewList.setAttribute('aria-pressed', state.view === 'list' ? 'true' : 'false');
  els.sortNote.hidden = state.sort !== 'points';
}

// -- cards --

const SECTOR_TITLE = `${METHOD_LABELS.sectors} (title + summary)`;
const CARD_SECTORS = 3;
const titleLink = (item, key) => el('h2', {}, [el('a', { className: 'card-link', href: `?item=${key}`, text: item.title || '(untitled)' })]);
const sectorBadge = (id) => badge(sectorLabel[id] || id, 'badge-sector', SECTOR_TITLE);
const itemSectors = (item) => (Array.isArray(item.sectors) ? item.sectors.filter((id) => typeof id === 'string') : []);

/** <= CARD_SECTORS sector badges + "+N". */
function sectorBadges(item, max = CARD_SECTORS) {
  const ids = itemSectors(item);
  const out = ids.slice(0, max).map(sectorBadge);
  if (ids.length > max) out.push(badge(`+${ids.length - max}`, 'badge-sector', ids.slice(max).map((id) => sectorLabel[id] || id).join(', ')));
  return out;
}

function extButton(item) {
  const url = safeHttpUrl(item.url);
  if (!url) return null;
  const a = extLink(url, '', { className: 'card-ext', ariaLabel: `Open original on ${hostnameOf(url)} (new tab)` });
  a.append(icon('external'));
  return a;
}

function renderCard(item, view) {
  const key = keyOf(item);
  const actions = el('div', { className: 'card-actions' }, [saveButton(item, key, 'card-save btn-ghost icon-btn'), extButton(item)]);
  if (view === 'list') {
    const line = el('p', { className: 'meta meta-line' }, [sourceBadge(item), tx(' \u00b7 '), regionBadge(item)]);
    if (item.publishedAt) line.append(tx(' \u00b7 '), timeEl(item.publishedAt));
    const points = pointsOf(item);
    if (points !== null) line.append(tx(` \u00b7 ${typeof item.extra?.points === 'number' ? pointsText(points) : votesText(points)}`));
    for (const b of sectorBadges(item)) line.append(tx(' \u00b7 '), b);
    line.title = line.textContent;
    return el('article', { className: 'card card-row', dataset: { key } }, [kindBadge(item), el('div', { className: 'card-main' }, [titleLink(item, key), line]), actions]);
  }
  const top = el('div', { className: 'card-top' }, [sourceBadge(item), kindBadge(item)]);
  if (item.publishedAt) top.append(timeEl(item.publishedAt));
  const parts = metaParts(item.extra);
  const bottom = el('div', { className: 'card-bottom' }, [regionBadge(item), ...sectorBadges(item), parts.length ? el('p', { className: 'meta', text: parts.join(' \u00b7 ') }) : null, actions]);
  const children = [top, titleLink(item, key)];
  if (item.summary && String(item.summary).trim()) children.push(el('p', { className: 'summary', text: item.summary }));
  children.push(bottom);
  return el('article', { className: 'card', dataset: { key } }, children);
}

// -- bookmarks (./notebook-store.js; save buttons carry data-save-key) --

const isSaved = (key) => Boolean(nb.items[key]);

function paintSave(btn) {
  const saved = isSaved(btn.dataset.saveKey);
  btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
  btn.setAttribute('aria-label', saved ? 'Saved \u2014 remove from notebook' : 'Save to notebook');
  const label = btn.querySelector('span');
  if (label) label.textContent = saved ? 'Saved' : 'Save to notebook';
}

function saveButton(item, key, className, withText = false) {
  const b = button({ className, dataset: { saveKey: key } }, [icon('bookmark'), withText ? el('span') : null], () => toggleSaved(item, key));
  paintSave(b);
  return b;
}

function syncSaveButtons(key) {
  for (const b of document.querySelectorAll(`button[data-save-key="${key}"]`)) paintSave(b);
}

function toggleSaved(item, key) {
  const next = isSaved(key) ? notebook.removeItem(nb, key) : notebook.addItem(nb, { ...item, key });
  try {
    notebook.save(next);
  } catch (err) {
    toast(err.message, { variant: 'error' });
    return;
  }
  nb = next;
  syncSaveButtons(key);
  toast(isSaved(key) ? 'Saved to notebook \u00b7 stored in this browser only' : 'Removed from notebook');
}

function emptyState() {
  return el('div', { className: 'empty' }, [
    icon('radar', 'icon icon-lg'),
    el('p', { className: 'empty-title', text: 'Nothing on the radar for these filters.' }),
    el('p', { text: 'Try a wider time range, another region, or reset the filters.' }),
    button({ id: 'empty-reset', className: 'btn-secondary', text: 'Reset filters' }, [], resetFilters),
  ]);
}

const alertBox = (message, retryId, onRetry) => el('div', { className: 'alert', role: 'alert' }, [icon('alert'), el('p', { text: message }), button({ id: retryId, className: 'btn-primary', text: 'Retry' }, [], onRetry)]);

function applyHighlight() {
  for (const c of els.results.querySelectorAll('article.card.is-active')) c.classList.remove('is-active');
  cardFor(state.highlightKey)?.classList.add('is-active');
}

function markOpenCard() {
  for (const c of els.results.querySelectorAll('article.card.is-open')) c.classList.remove('is-open');
  cardFor(drawer?.key())?.classList.add('is-open');
}

function updateApplyLabel(total) {
  els.filtersApply.textContent = total === 0 ? 'No items match' : `Show ${total} items`;
}

function renderError() {
  clear(els.results);
  els.results.append(alertBox(`Could not load items: ${data.loadError}`, 'retry-items', async () => { await loadItems(); render(); updateTiles(); renderRadarNow(); }));
  els.resultCount.textContent = '';
  els.loadMore.hidden = true;
  updateApplyLabel(0);
  els.results.setAttribute('aria-busy', 'false');
}

/** Synchronous redraw (DOM, count and URL final on return); FLIP + stagger layered on afterwards. */
function render({ animate = true } = {}) {
  if (data.loadError) { renderError(); return; }
  const view = effectiveView();
  const list = currentList();
  const total = list.length;
  const shownItems = list.slice(0, state.page * PAGE_SIZE);
  const shown = shownItems.length;
  const archivePending = data.archive === null && data.archiveItems > 0;
  const motion = animate && supportsAnimate && !reduceMotion.matches;
  const canFlip = motion && !firstRender && view === lastView && window.innerWidth >= 640;
  const prevKeys = new Set();
  const prevRects = new Map();
  for (const card of els.results.querySelectorAll('article.card[data-key]')) {
    prevKeys.add(card.dataset.key);
    if (canFlip) prevRects.set(card.dataset.key, card.getBoundingClientRect());
  }

  const frag = document.createDocumentFragment();
  if (data.archiveError) frag.append(alertBox(`Could not load older items: ${data.archiveError}`, 'retry-archive', () => { ensureArchive(); }));
  const cards = shownItems.map((item) => renderCard(item, view));
  frag.append(...cards);
  if (total === 0) frag.append(emptyState());
  clear(els.results);
  els.results.classList.toggle('view-list', view === 'list');
  els.results.append(frag);

  let count = total === 0 ? 'No items match these filters.'
    : archivePending ? `${total} recent items \u00b7 showing ${shown} \u00b7 older items load on demand` : `${total} items \u00b7 showing ${shown}`;
  if (state.sort === 'points' && total > 0) count += ' \u00b7 sorted by points/votes';
  els.resultCount.textContent = count;
  els.loadMore.textContent = shown >= total && archivePending ? 'Load older items' : 'Load more';
  els.loadMore.hidden = !(shown < total || archivePending);
  updateApplyLabel(total);
  applyHighlight();
  markOpenCard();
  els.results.setAttribute('aria-busy', data.archiveLoading ? 'true' : 'false');

  if (canFlip) {
    const survivors = cards.filter((c) => prevRects.has(c.dataset.key));
    if (survivors.length <= FLIP_MAX) {
      for (const card of survivors) {
        const before = prevRects.get(card.dataset.key);
        const after = card.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (dx || dy) card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 300, easing: EASE_IN_OUT });
      }
    }
  }
  if (motion) {
    cards.filter((c) => !prevKeys.has(c.dataset.key)).forEach((card, i) => {
      card.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: EASE_OUT, delay: Math.min(i, 10) * 12, fill: 'backwards' });
    });
  }
  lastView = view;
  firstRender = false;
}

// -- hero tiles --

const counted = new WeakSet();

function countUp(node, target) {
  if (counted.has(node) || reduceMotion.matches || target === 0) { counted.add(node); node.textContent = String(target); return; }
  counted.add(node);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 600);
    node.textContent = String(t < 1 ? Math.round(target * (1 - (1 - t) ** 3)) : target);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function setTile(li, value, label, asOf) {
  const n = li.querySelector('.stat-n');
  const l = li.querySelector('.stat-l');
  if (value === null) { n.textContent = '\u2014'; l.textContent = `${label} \u00b7 unavailable`; } else {
    if (typeof value === 'number') countUp(n, value); else n.textContent = value;
    l.textContent = label;
  }
  if (asOf) li.title = asOf; else li.removeAttribute('title');
}

function updateTiles() {
  const s = data.stats;
  const asOf = s?.generatedAt ? `As of ${absoluteTime(s.generatedAt)}` : '';
  setTile(els.statFeed, s && !data.loadError ? data.primary.length + (finiteNumber(s.archiveItems) ?? 0) : null, 'Items \u00b7 90 days', asOf);
  setTile(els.stat24h, s ? finiteNumber(s.last24h) : null, 'Last 24 hours', asOf);
  setTile(els.stat7d, s ? finiteNumber(s.last7d) : null, 'Last 7 days', asOf);
  els.statSources.hidden = !data.allSources;
  if (data.allSources) {
    const enabled = data.allSources.filter((x) => x.enabled);
    setTile(els.statSources, `${enabled.filter((x) => !x.lastError).length}/${enabled.length}`, 'Sources OK / enabled', asOf);
  }
}

// -- radar --

function renderRadarNow() {
  if (!els.radarSvg || !radarMq.matches) return;
  const now = Date.now();
  const n = radarCount(data.primary, now);
  renderRadar(els.radarSvg, data.primary, now, drawer?.key() ?? null);
  const items = pluralize(n, 'item', 'items');
  els.radarTitle.textContent = `Last 48 h \u00b7 ${items}${n > MAX_BLIPS ? ` \u00b7 showing newest ${MAX_BLIPS}` : ''}`;
  els.radarSvg.setAttribute('aria-label', `Radar of the ${items} published in the last 48 hours; newest nearest the centre. Hover or click a dot, or browse the same items in the feed below.`);
  if (!platesFitted) platesFitted = fitPlates(els.radarSvg);
}

function initRadarPanel() {
  if (!els.radarSvg) return;
  q1('.radar-legend').append(...REGIONS.map((r) => el('li', {}, [el('span', { className: `dot dot-${r}` }), tx(regionLabel(r))])));
  initRadar({ panel: els.radarPanel, svg: els.radarSvg, tip: els.radarTip, onOpen: (key) => drawer.open(key, { push: true, from: 'radar' }) });
  document.fonts?.ready.then(() => { if (radarMq.matches) platesFitted = fitPlates(els.radarSvg) || platesFitted; });
  radarMq.addEventListener('change', (e) => { if (e.matches) { platesFitted = fitPlates(els.radarSvg); renderRadarNow(); } });
}

// -- data loading --

function noteCacheStatus(res) {
  if (res.headers.get('X-Startup-Radar-Cache') === 'fallback') {
    const at = res.headers.get('X-Startup-Radar-Cached-At');
    els.offlineNote.textContent = `Offline \u2014 showing data cached ${(at && relativeTime(at)) || 'earlier'}`;
    els.offlineNote.hidden = false;
  } else {
    els.offlineNote.hidden = true;
  }
}

async function loadItems() {
  els.results.setAttribute('aria-busy', 'true');
  try {
    const items = await fetchJson(ITEMS_URL, { onResponse: noteCacheStatus });
    if (!Array.isArray(items)) throw new Error('unexpected response');
    data.primary = items.filter((it) => it && typeof it === 'object');
    data.loadError = '';
  } catch (err) {
    data.primary = [];
    data.loadError = err.message;
  }
}

/** Load archive.json once; 404 = no archive; a network error shows an inline alert + Retry. */
function ensureArchive({ revalidate = false } = {}) {
  if (data.archive !== null || data.archiveItems === 0 || data.loadError) return Promise.resolve();
  if (data.archiveLoading) return data.archiveLoading;
  data.archiveError = '';
  els.results.setAttribute('aria-busy', 'true');
  els.loadMore.disabled = true;
  data.archiveLoading = (async () => {
    try {
      const res = await fetch(ARCHIVE_URL, { headers: { Accept: 'application/json' }, cache: revalidate ? 'no-cache' : 'default' });
      noteCacheStatus(res);
      if (!res.ok) { data.archive = []; data.archiveItems = 0; return; }
      const body = await res.json().catch(() => null);
      data.archive = Array.isArray(body) ? body : [];
      if (!Array.isArray(body)) data.archiveItems = 0;
    } catch (err) {
      data.archiveError = err.message;
    } finally {
      data.archiveLoading = null;
      els.loadMore.disabled = false;
      render();
    }
  })();
  return data.archiveLoading;
}

/** Adopt a newer archive split (forget a loaded one); returns whether one had been loaded. */
function adoptArchiveFrom(stats) {
  const next = finiteNumber(stats.archiveItems) ?? 0;
  if (data.archive === null && data.archiveItems === next) return false;
  const hadArchive = data.archive !== null;
  data.archive = null;
  data.archiveItems = next;
  return hadArchive;
}

async function loadStats() {
  try {
    const stats = await fetchJson(STATS_URL, { onResponse: noteCacheStatus });
    if (!stats || typeof stats !== 'object') throw new Error('unexpected response');
    data.stats = stats;
    data.archiveItems = finiteNumber(stats.archiveItems) ?? 0;
    data.seenRefresh = stats.lastRefresh ?? stats.generatedAt ?? null;
    statusLine.update(stats);
    adoptSectors(stats);
  } catch {
    data.stats = null;
    statusLine.fail();
  }
}

/** stats.sectors -> labels + the chip row (real 90-day counts). */
function adoptSectors(stats) {
  const list = Array.isArray(stats?.sectors) ? stats.sectors.filter((s) => s && typeof s.id === 'string') : [];
  if (!list.length) return;
  sectorLabel = sectorLabels(stats);
  knownSectors = list.map((s) => s.id);
  for (const s of list) {
    const text = `${s.label} \u00b7 ${finiteNumber(s.count) ?? 0}`;
    const existing = els.sectorChips.querySelector(`button[data-sector="${s.id}"]`);
    if (existing) { existing.textContent = text; continue; }
    els.sectorChips.append(button({ className: 'chip chip-sector', dataset: { sector: s.id }, 'aria-pressed': 'false', text }, [], () => {
      state.sectors = state.sectors.includes(s.id) ? state.sectors.filter((id) => id !== s.id) : [...state.sectors, s.id];
      applyChange();
    }));
  }
}

async function loadSources() {
  try {
    const payload = await fetchJson(SOURCES_URL, { onResponse: noteCacheStatus });
    if (!payload || !Array.isArray(payload.sources)) throw new Error('unexpected response');
    data.allSources = payload.sources;
    knownSources = payload.sources.filter((s) => s.enabled);
    renderSourceOptions(knownSources);
    els.subtitle.textContent = `Newly launched and newly funded startups from ${pluralize(knownSources.length, 'public source', 'public sources')}, refreshed automatically.`;
  } catch {
    data.allSources = null; // keep the static subtitle; the checklist stays empty
  }
}

function renderSourceOptions(sources) {
  clear(els.sourceList);
  const grid = el('div', { className: 'source-grid' });
  for (const s of sources) {
    const id = `src-${s.id}`;
    const input = el('input', { type: 'checkbox', id, value: s.id, name: 'source' });
    input.checked = state.sources.includes(s.id);
    grid.append(el('label', { className: `source-option${input.checked ? ' checked' : ''}`, for: id }, [
      input, el('span', { className: 'source-name', text: s.name }), el('span', { className: 'region-note', text: `(${regionLabel(s.region)})` }),
    ]));
  }
  els.sourceList.append(el('legend', { text: 'Limit to these sources' }), grid);
}

// -- live data: polling, new-items pill --

function showPill(count) {
  els.newItemsBtn.querySelector('.pill-text').textContent = `${pluralize(count, 'new item', 'new items')} \u00b7 Refresh`;
  if (sheet.isOpen) { sheet.pillSuppressed = true; return; }
  els.newItems.hidden = false;
}

function hidePill() {
  els.newItems.hidden = true;
  sheet.pillSuppressed = false;
}

async function checkNewItems(stats, at) {
  let fresh;
  try {
    fresh = await fetchJson(ITEMS_URL, { noCache: true, onResponse: noteCacheStatus });
    if (!Array.isArray(fresh)) throw new Error('unexpected response');
    refetchFailStreak = 0;
  } catch (err) {
    if (++refetchFailStreak === 1) {
      console.warn('[radar] items re-fetch failed:', err?.message ?? err);
      toast('Checking for new items failed', { variant: 'error' });
    }
    return;
  }
  const known = new Set(allItems().map(keyOf));
  fresh = fresh.filter((it) => it && typeof it === 'object');
  const newCount = fresh.filter((it) => !known.has(keyOf(it))).length;
  if (newCount > 0) {
    data.pending = { items: fresh, stats, at };
    showPill(newCount);
  } else { // nothing new: replace silently (items may have aged out), keep the cards, refresh the tiles
    data.primary = fresh;
    data.seenRefresh = at;
    const hadArchive = adoptArchiveFrom(stats);
    updateTiles();
    renderRadarNow();
    if (hadArchive) ensureArchive({ revalidate: true });
  }
}

function applyPending() {
  const pending = data.pending;
  if (!pending) return;
  data.pending = null;
  data.primary = pending.items;
  data.seenRefresh = pending.at;
  const hadArchive = adoptArchiveFrom(pending.stats);
  adoptSectors(pending.stats);
  state.page = 1;
  render();
  updateTiles();
  renderRadarNow();
  if (hadArchive || state.q || state.since === '30d' || state.since === '') ensureArchive({ revalidate: true });
  if (els.results.getBoundingClientRect().top < 0) els.results.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  hidePill();
}

async function onStatsPolled(stats) {
  statsFailStreak = 0;
  data.stats = stats;
  statusLine.update(stats);
  updateTiles();
  const at = stats.lastRefresh ?? stats.generatedAt ?? null;
  if (at && data.seenRefresh && at !== data.seenRefresh && !data.loadError) await checkNewItems(stats, at);
  else if (!data.seenRefresh) data.seenRefresh = at;
}

function onStatsError(err) {
  if (++statsFailStreak === 1) console.warn('[radar] stats poll failed:', err?.message ?? err);
  statusLine.fail();
}

function tick() {
  tickTimes(document);
  statusLine.tick();
  renderRadarNow();
}

// -- detail drawer (./drawer.js; this page wires its hooks) --

const setTitle = (item) => { document.title = item ? `${item.title || '(untitled)'} \u2014 Startup Radar` : BASE_TITLE; };

/** findItem + the archive fallback. */
async function findItemOrArchive(key) {
  let item = findItem(key);
  if (!item && data.archiveItems > 0 && data.archive === null && !data.loadError) {
    await ensureArchive();
    item = findItem(key);
  }
  return item;
}

/** Drawer section: Sectors row (keyword-tagged). */
function sectorsSection(item) {
  const ids = itemSectors(item);
  if (!ids.length) return null;
  return el('dl', { className: 'detail-meta detail-sectors' }, [
    el('dt', { text: 'Sectors' }),
    el('dd', { title: SECTOR_TITLE }, [el('span', { className: 'badge-row' }, ids.map(sectorBadge))]),
  ]);
}

/** Drawer section: related items (lazy ./related.js; real count over the loaded window). */
function relatedSection(item, { drawer: d }) {
  const box = el('section', { className: 'related', 'aria-labelledby': 'related-title' }, [el('h3', { id: 'related-title', text: 'Related \u00b7 \u2026' })]);
  const fill = (mod) => {
    const { count, items } = mod.relatedItems(item, allItems(), { max: 5 });
    box.querySelector('h3').textContent = `Related \u00b7 ${pluralize(count, 'related item', 'related items')} in 90 days`;
    if (items.length) {
      box.append(el('div', { className: 'related-list' }, items.map((it) => {
        const k = keyOf(it);
        return button({ className: 'related-item', title: it.title || '(untitled)' }, [
          el('span', { className: 'related-title', text: it.title || '(untitled)' }),
          el('span', { className: 'related-src', text: it.source?.name || it.source?.id || '' }),
        ], () => d.open(k, { push: true, from: 'related' }));
      })));
    }
    box.append(el('p', { className: 'method', text: mod.RELATED_METHOD }));
  };
  if (relatedMod) fill(relatedMod);
  else {
    import('./related.js').then((mod) => { relatedMod = mod; fill(mod); }).catch(() => { box.querySelector('h3').textContent = 'Related \u00b7 unavailable'; });
  }
  return box;
}

function initDrawer(dialog) {
  drawer = createDrawer({
    dialog,
    getList: currentList,
    findItem: findItemOrArchive,
    buildUrl: (key) => buildUrl(state, key),
    sections: [sectorsSection, relatedSection],
    actions: [(item, { key }) => saveButton(item, key, 'btn-secondary', true)],
    ensureIndexVisible: (index) => {
      if (index >= state.page * PAGE_SIZE) {
        state.page = Math.ceil((index + 1) / PAGE_SIZE);
        render({ animate: false });
      }
    },
    onOpen: ({ item }) => { setTitle(item); markOpenCard(); renderRadarNow(); },
    onClose: ({ lastKey, returnTo }) => {
      setTitle(null);
      markOpenCard();
      const card = cardFor(lastKey);
      if (returnTo === 'radar' && radarMq.matches) {
        els.radarPanel.focus();
      } else if (card) {
        state.highlightKey = lastKey;
        applyHighlight();
        card.scrollIntoView({ block: 'nearest' });
        card.querySelector('.card-link')?.focus();
      } else {
        (radarMq.matches ? els.radarPanel : els.results).focus();
      }
      renderRadarNow();
    },
  });
}

// -- phone filter sheet --

function openSheet() {
  if (!sheetMq.matches || sheet.isOpen) return;
  sheet.isOpen = true;
  els.filterPanel.hidden = false;
  els.filterPanel.setAttribute('role', 'dialog');
  els.filterPanel.setAttribute('aria-modal', 'true');
  els.scrim.hidden = false;
  scrollLock(true);
  for (const node of document.querySelectorAll(INERT_SELECTOR)) { node.inert = true; sheet.inertEls.push(node); }
  if (!els.newItems.hidden) { els.newItems.hidden = true; sheet.pillSuppressed = true; }
  updateApplyLabel(currentList().length);
  els.filterPanelTitle.focus();
}

function closeSheet() {
  if (!sheet.isOpen) return;
  sheet.isOpen = false;
  for (const node of sheet.inertEls) node.inert = false;
  sheet.inertEls = [];
  els.sourcesFilter.open = false;
  els.scrim.hidden = true;
  scrollLock(false);
  els.filterPanel.removeAttribute('role');
  els.filterPanel.removeAttribute('aria-modal');
  els.filterPanel.hidden = sheetMq.matches;
  if (sheet.pillSuppressed) { sheet.pillSuppressed = false; if (data.pending) els.newItems.hidden = false; }
  (els.filtersOpen.offsetParent !== null ? els.filtersOpen : els.q).focus();
}

function syncSheetMode() {
  if (sheetMq.matches) { if (!sheet.isOpen) els.filterPanel.hidden = true; } else { if (sheet.isOpen) closeSheet(); els.filterPanel.hidden = false; }
}

// -- keyboard --

const cardLinks = () => Array.from(els.results.querySelectorAll('article.card[data-key] a.card-link'));

function focusCardLink(link) {
  const card = link.closest('article.card');
  state.highlightKey = card.dataset.key;
  applyHighlight();
  card.scrollIntoView({ block: 'nearest' });
  link.focus();
}

function moveHighlight(where) {
  let links = cardLinks();
  if (!links.length) return;
  let index = links.findIndex((a) => a.closest('article.card').dataset.key === state.highlightKey);
  if (index < 0) {
    const focused = document.activeElement?.closest?.('article.card[data-key]');
    if (focused) index = links.findIndex((a) => a.closest('article.card') === focused);
  }
  if (where === 'first') { focusCardLink(links[0]); return; }
  if (where === 'last') { focusCardLink(links[links.length - 1]); return; }
  const target = index < 0 ? 0 : index + where;
  if (target >= links.length) {
    if (els.loadMore.hidden || els.loadMore.disabled) return;
    els.loadMore.click(); // synchronous render: move only if a card appeared
    links = cardLinks();
    if (target >= links.length) return;
  }
  if (target >= 0) focusCardLink(links[target]);
}

function onKeydown(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const target = e.target instanceof Element ? e.target : document.body;
  const key = e.key;
  const inText = Boolean(target.closest(TEXT_ENTRY));
  if (inText && key !== 'Escape') return;
  if (!inText && target.closest('select') && key !== 'Escape') return;
  const dialogOpen = q1('dialog[open]');

  if (key === 'Escape') { // topmost layer only; dialogs close themselves via `cancel`
    if (dialogOpen) return;
    if (sheet.isOpen) { e.preventDefault(); closeSheet(); return; }
    if (els.sourcesFilter.open) { e.preventDefault(); els.sourcesFilter.open = false; els.sourcesSummary.focus(); return; }
    if (state.highlightKey && !inText) {
      e.preventDefault();
      state.highlightKey = null;
      applyHighlight();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    return; // not handled: #q keeps the native Esc-clears-field
  }
  if (dialogOpen) {
    if (dialogOpen === drawer.dialog) {
      if (key === 'j' || key === 'ArrowRight') { e.preventDefault(); drawer.step(1); return; }
      if (key === 'k' || key === 'ArrowLeft') { e.preventDefault(); drawer.step(-1); return; }
      if (key === 'o') { e.preventDefault(); openExternal(drawer.item()); return; }
    }
    if (key === 't') { e.preventDefault(); toggleTheme(); }
    return;
  }
  if (sheet.isOpen) {
    if (key === 't') { e.preventDefault(); toggleTheme(); }
    return;
  }
  switch (key) {
    case '/': e.preventDefault(); els.q.focus(); els.q.select(); return;
    case '?': e.preventDefault(); openHelp(target instanceof HTMLElement ? target : null); return;
    case 't': e.preventDefault(); toggleTheme(); return;
    case 'j': case 'ArrowDown': e.preventDefault(); moveHighlight(1); return;
    case 'k': case 'ArrowUp': e.preventDefault(); moveHighlight(-1); return;
    case 'Home': if (state.highlightKey) { e.preventDefault(); moveHighlight('first'); } return;
    case 'End': if (state.highlightKey) { e.preventDefault(); moveHighlight('last'); } return;
    case 'o': if (state.highlightKey) { e.preventDefault(); openExternal(findItem(state.highlightKey)); } return;
    default:
  }
}

// -- events --

function applyChange() {
  syncControls();
  state.page = 1;
  syncLocation();
  render();
}

function resetFilters() {
  Object.assign(state, { kind: '', region: '', sources: [], sectors: [], q: '', since: '', sort: '' });
  applyChange();
}

function wireEvents() {
  const debouncedSearch = debounce(() => { // must not rewrite #q while typing
    state.q = els.q.value.trim().slice(0, Q_MAX);
    state.page = 1;
    syncIndicators();
    syncLocation();
    render();
    if (state.q) ensureArchive();
  }, DEBOUNCE_MS);
  els.q.addEventListener('input', debouncedSearch);
  els.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    debouncedSearch.cancel();
    state.q = els.q.value.trim().slice(0, Q_MAX);
    applyChange();
    if (state.q) ensureArchive();
  });
  els.filters.addEventListener('submit', (e) => { e.preventDefault(); closeSheet(); });
  els.kind.addEventListener('change', () => { state.kind = els.kind.value; applyChange(); });
  els.region.addEventListener('change', () => { state.region = els.region.value; applyChange(); });
  els.sort.addEventListener('change', () => { state.sort = els.sort.value === 'points' ? 'points' : ''; applyChange(); });
  for (const btn of els.scopeButtons) btn.addEventListener('click', () => { state.region = btn.dataset.scope; applyChange(); });
  for (const btn of els.chipButtons) {
    btn.addEventListener('click', () => {
      state.since = btn.dataset.since;
      applyChange();
      if (state.since === '30d' || state.since === '') ensureArchive();
    });
  }
  els.sourceList.addEventListener('change', (e) => {
    if (!(e.target instanceof HTMLInputElement) || e.target.type !== 'checkbox') return;
    state.sources = Array.from(els.sourceList.querySelectorAll('input[type="checkbox"]:checked')).map((b) => b.value);
    applyChange();
  });
  els.reset.addEventListener('click', resetFilters);
  els.loadMore.addEventListener('click', () => {
    const exhausted = els.results.querySelectorAll('article.card').length >= currentList().length;
    state.page += 1;
    render();
    if (exhausted) ensureArchive();
  });

  // Delegated card click opens the drawer; modifier clicks and text selections pass through.
  els.results.addEventListener('click', (e) => {
    const card = e.target instanceof Element ? e.target.closest('article.card[data-key]') : null;
    if (!card || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const interactive = e.target.closest('a, button');
    if (interactive && !interactive.classList.contains('card-link')) return;
    if (e.detail > 0 && document.getSelection()?.toString()) return;
    e.preventDefault();
    drawer.open(card.dataset.key, { push: true, from: 'card' });
  });
  els.results.addEventListener('focusin', (e) => {
    const card = e.target instanceof Element && e.target.matches('a.card-link') ? e.target.closest('article.card') : null;
    if (!card) return;
    card.classList.add('has-focus');
    state.highlightKey = card.dataset.key;
    applyHighlight();
  });
  els.results.addEventListener('focusout', (e) => {
    if (e.target instanceof Element && e.target.matches('a.card-link')) e.target.closest('article.card')?.classList.remove('has-focus');
  });

  window.addEventListener('popstate', () => {
    if (drawer.handlePopstate(validKey(itemParam()))) return;
    readStateFromLocation();
    syncControls();
    render();
  });

  els.filtersOpen.addEventListener('click', openSheet);
  els.filtersClose.addEventListener('click', closeSheet);
  els.filtersApply.addEventListener('click', closeSheet);
  els.scrim.addEventListener('click', closeSheet);
  sheetMq.addEventListener('change', syncSheetMode);
  document.addEventListener('pointerdown', (e) => { // outside click closes the desktop sources popover
    if (els.sourcesFilter.open && !sheetMq.matches && !(e.target instanceof Node && els.sourcesFilter.contains(e.target))) els.sourcesFilter.open = false;
  });

  const setView = (view) => {
    state.view = view;
    try { localStorage.setItem('sr:view', view); } catch { /* session only */ }
    syncControls();
    render({ animate: false });
  };
  els.viewGrid.addEventListener('click', () => setView('grid'));
  els.viewList.addEventListener('click', () => setView('list'));
  wideMq.addEventListener('change', () => { if (effectiveView() !== lastView) render({ animate: false }); });
  els.newItemsBtn.addEventListener('click', applyPending);
  els.newItemsDismiss.addEventListener('click', hidePill);
  document.addEventListener('keydown', onKeydown);
}

// -- boot --

/** Resolves at first-contentful-paint (or after 300 ms): the shell paints before data fetch + render. */
function shellPainted() {
  return new Promise((resolve) => {
    setTimeout(resolve, 300);
    if (!PerformanceObserver.supportedEntryTypes?.includes('paint')) return resolve();
    new PerformanceObserver((list) => { if (list.getEntriesByName('first-contentful-paint').length) resolve(); }).observe({ type: 'paint', buffered: true });
  });
}

async function init() {
  const shell = mountShell({ page: 'feed', drawer: true, help: SHORTCUTS });
  initDrawer(shell.detail);
  nb = notebook.load();
  syncSheetMode();
  initRadarPanel();
  pendingDeepKey = validKey(itemParam());
  readStateFromLocation();
  syncControls();
  wireEvents();
  await shellPainted();
  await Promise.allSettled([loadSources(), loadStats(), loadItems()]);
  readStateFromLocation(); // drops unknown source / sector ids
  syncControls();
  syncLocation();
  render();
  updateTiles();
  renderRadarNow();
  if (state.q || state.since === '30d') ensureArchive();
  await drawer.openDeepLink(pendingDeepKey);
  pendingDeepKey = null;
  pollStats({ url: STATS_URL, onStats: onStatsPolled, onError: onStatsError });
  startTicker(tick);
  startPwa();
}

init();
