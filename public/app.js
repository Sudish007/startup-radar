// Startup Radar home page (vanilla ES module, strict CSP: DOM via ui.js el(), textContent only). Data from
// ./data/*.json (filtering in ./filter.js); drawer (?item=<key>), keyboard map, filter sheet, stats polling, radar.

import { SINCE_VALUES, filterItems, itemKey, pointsOf, sortItems } from './filter.js';
import { KIND_LABELS, REGION_LABELS, absoluteTime, detailRows, hnDiscussion, hostnameOf, kindLabel, metaParts, pluralize, pointsText, regionLabel, relativeTime, safeHttpUrl, votesText } from './format.js';
import { afterExit, clear, createStatusLine, el, extLink, fetchJson, fillHelp, icon, initHelp, initTheme, moveToastsInto, observeSticky, openHelp, pollStats, reduceMotion, restoreToasts, scrollLock, startPwa, startTicker, tickTimes, toast, toggleTheme } from './ui.js';
import { fitPlates, initRadar, radarCount, renderRadar, MAX_BLIPS } from './radar.js';

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
// The keyboard map (shown in the help dialog; onKeydown implements exactly these rows)
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
const IDS = 'subtitle search-form q filters kind region sort sources-filter source-list reset result-count offline-note results load-more filter-panel filter-panel-title filters-open filters-close filters-apply view-grid view-list stat-feed stat-24h stat-7d stat-sources radar-panel radar-title detail new-items new-items-btn';
const els = Object.fromEntries(IDS.split(' ').map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(id)]));
Object.assign(els, {
  scopeButtons: Array.from(document.querySelectorAll('button.scope')), chipButtons: Array.from(document.querySelectorAll('button.chip')),
  sourcesSummary: q1('#sources-filter > summary'), sortNote: q1('.sort-note'), countBadge: q1('#filters-open .count-badge'), scrim: q1('.scrim'),
  radarSvg: q1('svg.radar'), radarTip: q1('.radar-tip'), detailPanel: q1('#detail .detail-panel'), newItemsDismiss: q1('#new-items .pill-dismiss'),
});

const BASE_TITLE = document.title;
const supportsAnimate = typeof Element.prototype.animate === 'function';
const radarMq = matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)');
const sheetMq = matchMedia('(max-width: 639.98px)');
const wideMq = matchMedia('(min-width: 640px)');

const state = { kind: '', region: '', sources: [], q: '', since: '', sort: '', page: 1, highlightKey: null, view: readView() };
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
const detail = { key: null, item: null, returnTo: null, ownsEntry: false, ignoreNextPop: false, fromHistory: false, closing: false };
const sheet = { isOpen: false, pillSuppressed: false, inertEls: [] };
let knownSources = [];
let lastView = null;
let firstRender = true;
let refetchFailStreak = 0;
let statsFailStreak = 0;
let platesFitted = false;
let historyBroken = false;
let pendingDeepKey = null; // ?item= at boot, kept in the URL until the drawer opened (or missed)
const statusLine = createStatusLine();
const keyCache = new WeakMap();

function keyOf(item) {
  let k = keyCache.get(item);
  if (!k) { k = itemKey(item.url); keyCache.set(item, k); }
  return k;
}
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
  state.page = 1;
}

/** The single URL builder (pathname + params + item=<key>; never a leading slash). */
function buildUrl(st, openKey = null) {
  const p = new URLSearchParams();
  if (st.kind) p.set('kind', st.kind);
  if (st.region) p.set('region', st.region);
  if (st.sources.length) p.set('source', st.sources.join(','));
  if (st.q) p.set('q', st.q);
  if (st.since) p.set('since', st.since);
  if (st.sort) p.set('sort', st.sort);
  if (openKey) p.set('item', openKey);
  const qs = p.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
}

function historyCall(fn) {
  if (historyBroken) return false;
  try { fn(); return true; } catch (err) { historyBroken = true; console.warn('[radar] history unavailable:', err?.message ?? err); return false; }
}
const replaceUrl = (url) => historyCall(() => history.replaceState(null, '', url));
const syncLocation = () => replaceUrl(buildUrl(state, els.detail.open ? detail.key : pendingDeepKey));
const dropItemParam = () => { if (itemParam() !== null) replaceUrl(buildUrl(state, null)); };

// -- controls --

const activeFilterCount = () => (state.kind ? 1 : 0) + (state.region ? 1 : 0) + (state.since ? 1 : 0) + (state.sources.length ? 1 : 0) + (state.q ? 1 : 0);

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

const badge = (text, className, title = null) => el('span', { className: `badge ${className}`, text, title });
const sourceBadge = (item) => badge(item.source?.name || item.source?.id || 'Unknown source', 'badge-source');
const kindBadge = (item) => badge(kindLabel(item.kind), `badge-${item.kind}`, 'Kind assigned by Startup Radar from the source and the text');
const timeEl = (iso) => el('time', { datetime: iso, title: absoluteTime(iso), 'data-rel': '', text: relativeTime(iso) });
const titleLink = (item, key) => el('h2', {}, [el('a', { className: 'card-link', href: `?item=${key}`, text: item.title || '(untitled)' })]);

function regionBadge(item) {
  const region = REGIONS.includes(item.region) ? item.region : 'global';
  return el('span', { className: 'badge badge-region' }, [el('span', { className: `dot dot-${region}`, 'aria-hidden': 'true' }), tx(regionLabel(item.region))]);
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
  if (view === 'list') {
    const line = el('p', { className: 'meta meta-line' }, [sourceBadge(item), tx(' \u00b7 '), regionBadge(item)]);
    if (item.publishedAt) line.append(tx(' \u00b7 '), timeEl(item.publishedAt));
    const points = pointsOf(item);
    if (points !== null) line.append(tx(` \u00b7 ${typeof item.extra?.points === 'number' ? pointsText(points) : votesText(points)}`));
    line.title = line.textContent;
    return el('article', { className: 'card card-row', dataset: { key } }, [kindBadge(item), el('div', { className: 'card-main' }, [titleLink(item, key), line]), extButton(item)]);
  }
  const top = el('div', { className: 'card-top' }, [sourceBadge(item), kindBadge(item)]);
  if (item.publishedAt) top.append(timeEl(item.publishedAt));
  const parts = metaParts(item.extra);
  const bottom = el('div', { className: 'card-bottom' }, [regionBadge(item), parts.length ? el('p', { className: 'meta', text: parts.join(' \u00b7 ') }) : null, extButton(item)]);
  const children = [top, titleLink(item, key)];
  if (item.summary && String(item.summary).trim()) children.push(el('p', { className: 'summary', text: item.summary }));
  children.push(bottom);
  return el('article', { className: 'card', dataset: { key } }, children);
}

function button(props, children, onClick) {
  const b = el('button', { type: 'button', ...props }, children);
  b.addEventListener('click', onClick);
  return b;
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
  if (els.detail.open) cardFor(detail.key)?.classList.add('is-open');
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
  renderRadar(els.radarSvg, data.primary, now, els.detail.open ? detail.key : null);
  const items = pluralize(n, 'item', 'items');
  els.radarTitle.textContent = `Last 48 h \u00b7 ${items}${n > MAX_BLIPS ? ` \u00b7 showing newest ${MAX_BLIPS}` : ''}`;
  els.radarSvg.setAttribute('aria-label', `Radar of the ${items} published in the last 48 hours; newest nearest the centre. Hover or click a dot, or browse the same items in the feed below.`);
  if (!platesFitted) platesFitted = fitPlates(els.radarSvg);
}

function initRadarPanel() {
  if (!els.radarSvg) return;
  q1('.radar-legend').append(...REGIONS.map((r) => el('li', {}, [el('span', { className: `dot dot-${r}` }), tx(regionLabel(r))])));
  initRadar({ panel: els.radarPanel, svg: els.radarSvg, tip: els.radarTip, onOpen: (key) => openDetail(key, { push: true, from: 'radar' }) });
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
  } catch {
    data.stats = null;
    statusLine.fail();
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

// -- detail drawer --

const setTitle = (item) => { document.title = item ? `${item.title || '(untitled)'} \u2014 Startup Radar` : BASE_TITLE; };

function renderDetail(item) {
  const panel = els.detailPanel;
  clear(panel);
  const key = keyOf(item);
  const head = el('header', { className: 'detail-head' }, [
    el('div', { className: 'detail-badges' }, [sourceBadge(item), kindBadge(item), regionBadge(item)]),
    button({ id: 'detail-close', className: 'btn-ghost icon-btn', 'aria-label': 'Close' }, [icon('close')], closeDetail),
  ]);
  const body = el('div', { className: 'detail-body' }, [el('h2', { id: 'detail-title', tabindex: '-1', text: item.title || '(untitled)' })]);
  // relative time only (title = absolute); the absolute "Published" value lives in the metadata table below
  if (item.publishedAt && absoluteTime(item.publishedAt)) body.append(el('p', { className: 'detail-time' }, [timeEl(item.publishedAt)]));
  const summary = item.summary && String(item.summary).trim();
  body.append(summary ? el('p', { id: 'detail-summary', className: 'detail-summary', text: item.summary }) : el('p', { id: 'detail-summary', className: 'detail-empty', text: 'No summary provided by the source.' }));
  const rows = detailRows(item);
  if (rows.length) {
    const dl = el('dl', { className: 'detail-meta' });
    for (const row of rows) {
      let value;
      if (row.href && row.label === 'Website') value = extLink(row.href, row.value, { ariaLabel: `${row.value} (opens in a new tab)` });
      else if (row.href) value = el('a', { href: row.href, text: row.value });
      dl.append(el('dt', { text: row.label }), el('dd', { className: row.label === 'Destination' ? 'mono' : null, text: value ? null : row.value }, [value]));
    }
    body.append(dl);
  }
  const actions = el('div', { className: 'detail-actions' });
  const url = safeHttpUrl(item.url);
  if (url) {
    const host = hostnameOf(url);
    const open = extLink(url, '', { className: 'btn btn-primary', ariaLabel: `Open original on ${host} (opens in a new tab)` });
    open.append(el('span', { text: `Open on ${host}` }), icon('external'));
    actions.append(open);
  }
  const hn = hnDiscussion(item);
  if (hn) actions.append(extLink(hn, 'Discussion on Hacker News', { className: 'btn btn-ghost' }));
  actions.append(button({ id: 'detail-copy', className: 'btn-secondary' }, [icon('copy'), el('span', { text: 'Copy link' })], () => copyLink(key)));
  body.append(actions);

  const list = currentList();
  const index = list.findIndex((it) => keyOf(it) === key);
  const prev = button({ id: 'detail-prev', className: 'btn-secondary' }, [icon('chevron-left'), el('span', { text: 'Previous' })], () => stepDetail(-1));
  const next = button({ id: 'detail-next', className: 'btn-secondary' }, [el('span', { text: 'Next' }), icon('chevron-right')], () => stepDetail(1));
  prev.disabled = index <= 0;
  next.disabled = index < 0 || index >= list.length - 1;
  const pos = el('span', { className: 'detail-pos', text: `${index >= 0 ? index + 1 : '\u2014'} of ${list.length}` });
  panel.append(head, body, el('footer', { className: 'detail-nav' }, [prev, pos, next]));
}

async function openDetail(key, { push = false, from = 'card' } = {}) {
  let item = findItem(key);
  if (!item && data.archiveItems > 0 && data.archive === null && !data.loadError) {
    await ensureArchive();
    item = findItem(key);
  }
  if (!item) {
    if (from === 'deeplink' || from === 'history') { toast('That item is no longer in the feed'); dropItemParam(); }
    return false;
  }
  const wasOpen = els.detail.open;
  detail.key = key;
  detail.item = item;
  if (!wasOpen) detail.returnTo = from;
  renderDetail(item);
  if (!wasOpen) {
    try { els.detail.showModal(); } catch { /* already open: content re-rendered in place */ }
    moveToastsInto(els.detail);
  }
  setTitle(item);
  if (push) detail.ownsEntry = historyCall(() => history.pushState({ sr: 'item', key }, '', buildUrl(state, key)));
  else detail.ownsEntry = from === 'history';
  markOpenCard();
  renderRadarNow();
  $('detail-title')?.focus();
  return true;
}

function stepDetail(dir) {
  if (!els.detail.open || !detail.key) return;
  const list = currentList();
  const index = list.findIndex((it) => keyOf(it) === detail.key);
  const nextIndex = index + dir;
  if (index < 0 || nextIndex < 0 || nextIndex >= list.length) return;
  const item = list[nextIndex];
  const key = keyOf(item);
  const focusedId = document.activeElement?.id;
  detail.key = key;
  detail.item = item;
  if (nextIndex >= state.page * PAGE_SIZE) {
    state.page = Math.ceil((nextIndex + 1) / PAGE_SIZE);
    render({ animate: false });
  }
  renderDetail(item);
  if (supportsAnimate && !reduceMotion.matches) els.detailPanel.querySelector('.detail-body')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: EASE_OUT });
  replaceUrl(buildUrl(state, key));
  setTitle(item);
  markOpenCard();
  renderRadarNow();
  const wanted = focusedId === 'detail-prev' || focusedId === 'detail-next' ? $(focusedId) : null;
  const other = focusedId === 'detail-prev' ? $('detail-next') : $('detail-prev');
  (wanted && !wanted.disabled ? wanted : wanted && !other.disabled ? other : $('detail-title')).focus();
}

function closeDetail() {
  if (!els.detail.open || detail.closing) return;
  detail.closing = true;
  els.detail.classList.add('closing');
  afterExit(els.detailPanel, () => { if (els.detail.open) els.detail.close(); });
}

/** The dialog `close` event is the single cleanup path for every close route. */
function onDetailClosed() {
  els.detail.classList.remove('closing');
  detail.closing = false;
  setTitle(null);
  restoreToasts();
  const { key: lastKey, returnTo, fromHistory } = detail;
  if (detail.ownsEntry && !fromHistory && !historyBroken) {
    detail.ownsEntry = false;
    detail.ignoreNextPop = true;
    history.back();
  } else if (!detail.ownsEntry) {
    dropItemParam();
  }
  Object.assign(detail, { fromHistory: false, ownsEntry: false, key: null, item: null, returnTo: null });
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
}

async function copyLink(key) {
  const url = `${location.origin}${location.pathname}?item=${key}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied', { duration: 3000 });
  } catch {
    let field = $('detail-copy-field');
    if (!field) {
      field = el('input', { type: 'text', id: 'detail-copy-field', readonly: true, 'aria-label': 'Link to this item' });
      els.detailPanel.querySelector('.detail-actions')?.after(field);
    }
    field.value = url;
    field.focus();
    field.select();
    toast('Couldn\u2019t copy automatically \u2014 press Ctrl+C / \u2318C');
  }
}

/** `o`: a transient extLink() anchor, never window.open. */
function openExternal(item) {
  const url = item ? safeHttpUrl(item.url) : null;
  if (!url) return;
  const a = extLink(url, '');
  a.hidden = true;
  (q1('dialog[open]') ?? document.body).append(a);
  a.click();
  a.remove();
}

async function openDeepLink() {
  const key = pendingDeepKey;
  if (!key) return;
  const opened = await openDetail(key, { push: false, from: 'deeplink' });
  pendingDeepKey = null;
  if (!opened) dropItemParam();
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
    if (dialogOpen === els.detail) {
      if (key === 'j' || key === 'ArrowRight') { e.preventDefault(); stepDetail(1); return; }
      if (key === 'k' || key === 'ArrowLeft') { e.preventDefault(); stepDetail(-1); return; }
      if (key === 'o') { e.preventDefault(); openExternal(detail.item); return; }
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
  Object.assign(state, { kind: '', region: '', sources: [], q: '', since: '', sort: '' });
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
    openDetail(card.dataset.key, { push: true, from: 'card' });
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

  els.detail.addEventListener('cancel', (e) => { e.preventDefault(); closeDetail(); });
  els.detail.addEventListener('close', onDetailClosed);
  els.detail.addEventListener('click', (e) => { if (e.target === els.detail) closeDetail(); });
  window.addEventListener('popstate', () => {
    if (detail.ignoreNextPop) { detail.ignoreNextPop = false; syncLocation(); return; }
    const key = validKey(itemParam());
    if (els.detail.open && !key) { detail.fromHistory = true; detail.ownsEntry = false; closeDetail(); return; }
    if (!els.detail.open && key) { openDetail(key, { push: false, from: 'history' }); return; }
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
  initTheme();
  fillHelp(SHORTCUTS);
  initHelp();
  observeSticky();
  syncSheetMode();
  initRadarPanel();
  pendingDeepKey = validKey(itemParam());
  readStateFromLocation();
  syncControls();
  wireEvents();
  await shellPainted();
  await Promise.allSettled([loadSources(), loadStats(), loadItems()]);
  readStateFromLocation(); // drops unknown source ids
  syncControls();
  syncLocation();
  render();
  updateTiles();
  renderRadarNow();
  if (state.q || state.since === '30d') ensureArchive();
  await openDeepLink();
  pollStats({ url: STATS_URL, onStats: onStatsPolled, onError: onStatsError });
  startTicker(tick);
  startPwa();
}

init();
