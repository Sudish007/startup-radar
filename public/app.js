// Startup Radar home page. Vanilla ES module; all DOM built with
// createElement/textContent through ui.js el() (strict CSP, no inline scripts
// or HTML strings). Data comes from ./data/items.json, ./data/sources.json and
// ./data/stats.json (Express or GitHub Pages, both relative to this page);
// filtering, search, sorting and paging run in the browser (./filter.js).
// ./data/archive.json (older items) is loaded on demand only.
//
// Layers on top of the feed: an in-app detail drawer (?item=<key> deep links,
// one history entry per open, focus return), a keyboard map, the phone filter
// sheet, 5-minute stats polling with a real new-items diff, the desktop radar
// panel and the theme/view preferences.

import { SINCE_VALUES, filterItems, itemKey, pointsOf, sortItems } from './filter.js';
import {
  KIND_LABELS, REGION_LABELS, absoluteTime, detailRows, hnDiscussion, hostnameOf, kindLabel, metaParts, pluralize, regionLabel, relativeTime, safeHttpUrl,
} from './format.js';
import {
  clear, createStatusLine, el, extLink, fetchJson, icon, initHelp, initInstallPrompt, initTheme, moveToastsInto, observeSticky, openHelp,
  pollStats, reduceMotion, registerServiceWorker, restoreToasts, scrollLock, startTicker, tickTimes, toast, toggleTheme,
} from './ui.js';
import { fitPlates, initRadar, radarCount, renderRadar, MAX_BLIPS } from './radar.js';

const PAGE_SIZE = 30;
const DEBOUNCE_MS = 300;
const Q_MAX = 200;
const KEY_RE = /^[0-9a-z]{1,13}$/;
const KINDS = Object.keys(KIND_LABELS);
const REGIONS = Object.keys(REGION_LABELS);
// Same curves as --ease-out / --ease-in-out in styles.css (WAAPI cannot read CSS variables).
const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';
const EASE_IN_OUT = 'cubic-bezier(.4,0,.2,1)';
const FLIP_MAX = 60;
const TEXT_ENTRY = 'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="tel"], input[type="number"], input[type="password"]';

const ITEMS_URL = './data/items.json';
const ARCHIVE_URL = './data/archive.json';
const SOURCES_URL = './data/sources.json';
const STATS_URL = './data/stats.json';

const $ = (id) => document.getElementById(id);
const els = {
  subtitle: $('subtitle'),
  searchForm: $('search-form'),
  q: $('q'),
  form: $('filters'),
  kind: $('kind'),
  region: $('region'),
  sort: $('sort'),
  scopeButtons: Array.from(document.querySelectorAll('button.scope')),
  chipButtons: Array.from(document.querySelectorAll('button.chip')),
  sourcesFilter: $('sources-filter'),
  sourcesSummary: document.querySelector('#sources-filter > summary'),
  sourceList: $('source-list'),
  reset: $('reset'),
  resultCount: $('result-count'),
  sortNote: document.querySelector('.sort-note'),
  offline: $('offline-note'),
  results: $('results'),
  loadMore: $('load-more'),
  panel: $('filter-panel'),
  panelTitle: $('filter-panel-title'),
  filtersOpen: $('filters-open'),
  filtersClose: $('filters-close'),
  filtersApply: $('filters-apply'),
  countBadge: document.querySelector('#filters-open .count-badge'),
  scrim: document.querySelector('.scrim'),
  viewGrid: $('view-grid'),
  viewList: $('view-list'),
  statFeed: $('stat-feed'),
  stat24h: $('stat-24h'),
  stat7d: $('stat-7d'),
  statSources: $('stat-sources'),
  radarPanel: $('radar-panel'),
  radarTitle: $('radar-title'),
  radarSvg: document.querySelector('svg.radar'),
  radarTip: document.querySelector('.radar-tip'),
  detail: $('detail'),
  detailPanel: document.querySelector('#detail .detail-panel'),
  newItems: $('new-items'),
  newItemsBtn: $('new-items-btn'),
  newItemsDismiss: document.querySelector('#new-items .pill-dismiss'),
};

const BASE_TITLE = document.title;
const supportsAnimate = typeof Element.prototype.animate === 'function';
const radarMq = matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)');
const sheetMq = matchMedia('(max-width: 639.98px)');
const wideMq = matchMedia('(min-width: 640px)');

const state = {
  kind: '',
  region: '',
  sources: [],
  q: '',
  since: '',
  sort: '',
  page: 1,
  highlightKey: null,
  view: readView(),
};

const data = {
  primary: [],
  archive: null, // null = not loaded yet; [] = loaded (or no archive exists)
  archiveItems: 0, // from stats.json; > 0 means an archive.json exists
  archiveLoading: null, // in-flight promise (single flight)
  archiveError: '', // last network error while loading the archive
  loadError: '', // items.json could not be loaded
  stats: null,
  statsFailed: false,
  seenRefresh: null, // lastRefresh ?? generatedAt seen at load / last applied refresh
  pending: null, // { items, stats, at } waiting behind the new-items pill
  allSources: null, // sources.json payload (null = failed / not loaded)
};

let knownSources = [];
let lastView = null;
let firstRender = true;
let refetchFailStreak = 0;
let platesFitted = false;
const statusLine = createStatusLine();
const keyCache = new WeakMap();

// ---------- helpers ----------

function keyOf(item) {
  let k = keyCache.get(item);
  if (!k) {
    k = itemKey(item.url);
    keyCache.set(item, k);
  }
  return k;
}

function allItems() {
  return data.archive ? data.primary.concat(data.archive) : data.primary;
}

function currentList() {
  return sortItems(filterItems(allItems(), state), state.sort);
}

function findItem(key) {
  return allItems().find((it) => keyOf(it) === key) ?? null;
}

function cardFor(key) {
  return key ? els.results.querySelector(`article.card[data-key="${key}"]`) : null;
}

function readView() {
  try {
    return localStorage.getItem('sr:view') === 'list' ? 'list' : 'grid';
  } catch { return 'grid'; }
}

function effectiveView() {
  return state.view === 'list' && wideMq.matches ? 'list' : 'grid';
}

function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

function validKey(v) {
  return typeof v === 'string' && KEY_RE.test(v) ? v : null;
}

// ---------- state <-> URL ----------

function readStateFromLocation() {
  const params = new URLSearchParams(location.search);
  const kind = params.get('kind') || '';
  state.kind = KINDS.includes(kind) ? kind : '';
  const region = params.get('region') || '';
  state.region = REGIONS.includes(region) || region === 'world' ? region : '';
  state.q = (params.get('q') || '').trim().slice(0, Q_MAX);
  const since = params.get('since') || '';
  state.since = SINCE_VALUES.has(since) ? since : '';
  state.sort = params.get('sort') === 'points' ? 'points' : '';
  const src = params.get('source') || '';
  state.sources = src ? src.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (knownSources.length) {
    const known = new Set(knownSources.map((s) => s.id));
    state.sources = state.sources.filter((id) => known.has(id));
  }
  state.page = 1;
}

/** The single URL builder: location.pathname + the active params (+ item=<key>) — never a leading slash. */
function buildUrl(st, openKey = null) {
  const params = new URLSearchParams();
  if (st.kind) params.set('kind', st.kind);
  if (st.region) params.set('region', st.region);
  if (st.sources.length) params.set('source', st.sources.join(','));
  if (st.q) params.set('q', st.q);
  if (st.since) params.set('since', st.since);
  if (st.sort) params.set('sort', st.sort);
  if (openKey) params.set('item', openKey);
  const qs = params.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
}

let historyBroken = false;
function replaceUrl(url, stateObj = null) {
  if (historyBroken) return;
  try { history.replaceState(stateObj, '', url); } catch (err) { historyBroken = true; console.warn('[radar] history unavailable:', err?.message ?? err); }
}

let pendingDeepKey = null; // ?item= read at boot, kept in the URL until the drawer has opened (or missed)

function syncLocation() {
  replaceUrl(buildUrl(state, els.detail.open ? detail.key : pendingDeepKey));
}

// ---------- controls ----------

function activeFilterCount() {
  return (state.kind ? 1 : 0) + (state.region ? 1 : 0) + (state.since ? 1 : 0) + (state.sources.length ? 1 : 0) + (state.q ? 1 : 0);
}

function syncControls() {
  els.q.value = state.q;
  els.kind.value = state.kind;
  els.region.value = REGIONS.includes(state.region) ? state.region : '';
  els.sort.value = state.sort;
  for (const btn of els.scopeButtons) {
    const scope = btn.dataset.scope;
    const pressed = scope === '' ? state.region === '' : state.region === scope;
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
  for (const btn of els.chipButtons) {
    btn.setAttribute('aria-pressed', btn.dataset.since === state.since ? 'true' : 'false');
  }
  for (const box of els.sourceList.querySelectorAll('input[type="checkbox"]')) {
    box.checked = state.sources.includes(box.value);
    box.closest('label')?.classList.toggle('checked', box.checked);
  }
  els.sourcesSummary.textContent = state.sources.length ? `Sources \u00b7 ${state.sources.length}` : 'Sources';
  const active = activeFilterCount();
  els.reset.classList.toggle('btn-ghost', active === 0 && !state.sort);
  els.reset.classList.toggle('btn-secondary', active > 0 || Boolean(state.sort));
  els.countBadge.textContent = String(active);
  els.countBadge.hidden = active === 0;
  els.filtersOpen.setAttribute('aria-label', active ? `Filters, ${active} active` : 'Filters');
  els.viewGrid.setAttribute('aria-pressed', state.view === 'grid' ? 'true' : 'false');
  els.viewList.setAttribute('aria-pressed', state.view === 'list' ? 'true' : 'false');
  els.sortNote.hidden = state.sort !== 'points';
}

// ---------- cards ----------

function badge(text, className, title = null) {
  return el('span', { className: `badge ${className}`, text, title });
}

function regionBadge(item) {
  const region = REGIONS.includes(item.region) ? item.region : 'global';
  return el('span', { className: 'badge badge-region' }, [
    el('span', { className: `dot dot-${region}`, 'aria-hidden': 'true' }),
    document.createTextNode(regionLabel(item.region)),
  ]);
}

function kindBadge(item) {
  return badge(kindLabel(item.kind), `badge-${item.kind}`, 'Kind assigned by Startup Radar from the source and the text');
}

function sourceBadge(item) {
  return badge(item.source?.name || item.source?.id || 'Unknown source', 'badge-source');
}

function timeEl(iso) {
  return el('time', { datetime: iso, title: absoluteTime(iso), 'data-rel': '', text: relativeTime(iso) });
}

function extButton(item) {
  const url = safeHttpUrl(item.url);
  if (!url) return null;
  const a = extLink(url, '', { className: 'card-ext', ariaLabel: `Open original on ${hostnameOf(url)} (new tab)` });
  a.append(icon('external'));
  return a;
}

function titleLink(item, key) {
  return el('h2', {}, [el('a', { className: 'card-link', href: `?item=${key}`, text: item.title || '(untitled)' })]);
}

function renderCard(item, view) {
  const key = keyOf(item);
  const parts = metaParts(item.extra);
  if (view === 'list') {
    const line = el('p', { className: 'meta meta-line' });
    line.append(sourceBadge(item), document.createTextNode(' \u00b7 '), regionBadge(item));
    if (item.publishedAt) line.append(document.createTextNode(' \u00b7 '), timeEl(item.publishedAt));
    const points = pointsOf(item);
    if (points !== null) line.append(document.createTextNode(` \u00b7 ${points} ${typeof item.extra?.points === 'number' ? 'points' : 'votes'}`));
    line.title = line.textContent;
    return el('article', { className: 'card card-row', dataset: { key } }, [
      kindBadge(item),
      el('div', { className: 'card-main' }, [titleLink(item, key), line]),
      extButton(item),
    ]);
  }
  const top = el('div', { className: 'card-top' }, [sourceBadge(item), kindBadge(item)]);
  if (item.publishedAt) top.append(timeEl(item.publishedAt));
  const bottom = el('div', { className: 'card-bottom' }, [regionBadge(item)]);
  if (parts.length) bottom.append(el('p', { className: 'meta', text: parts.join(' \u00b7 ') }));
  bottom.append(extButton(item));
  const children = [top, titleLink(item, key)];
  if (item.summary && String(item.summary).trim()) children.push(el('p', { className: 'summary', text: item.summary }));
  children.push(bottom);
  return el('article', { className: 'card', dataset: { key } }, children);
}

function emptyState() {
  const btn = el('button', { type: 'button', id: 'empty-reset', className: 'btn-secondary', text: 'Reset filters' });
  btn.addEventListener('click', resetFilters);
  return el('div', { className: 'empty' }, [
    icon('radar', 'icon icon-lg'),
    el('p', { className: 'empty-title', text: 'Nothing on the radar for these filters.' }),
    el('p', { text: 'Try a wider time range, another region, or reset the filters.' }),
    btn,
  ]);
}

function alertBox(message, retryId, onRetry) {
  const btn = el('button', { type: 'button', id: retryId, className: 'btn-primary', text: 'Retry' });
  btn.addEventListener('click', onRetry);
  return el('div', { className: 'alert', role: 'alert' }, [icon('alert'), el('p', { text: message }), btn]);
}

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
  els.results.append(alertBox(`Could not load items: ${data.loadError}`, 'retry-items', async () => {
    await loadItems();
    render();
    updateTiles();
    renderRadarNow();
  }));
  els.resultCount.textContent = '';
  els.loadMore.hidden = true;
  updateApplyLabel(0);
  els.results.setAttribute('aria-busy', 'false');
}

/** Filter + sort + page the loaded items and redraw the list, count and Load-more button (synchronously). */
function render({ animate = true } = {}) {
  if (data.loadError) {
    renderError();
    return;
  }
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
  if (data.archiveError) {
    frag.append(alertBox(`Could not load older items: ${data.archiveError}`, 'retry-archive', () => { ensureArchive(); }));
  }
  const newCards = [];
  const cards = [];
  for (const item of shownItems) {
    const card = renderCard(item, view);
    cards.push(card);
    if (!prevKeys.has(card.dataset.key)) newCards.push(card);
    frag.append(card);
  }
  if (total === 0) frag.append(emptyState());

  clear(els.results);
  els.results.classList.toggle('view-list', view === 'list');
  els.results.append(frag);

  if (total === 0) {
    els.resultCount.textContent = 'No items match these filters.';
  } else if (archivePending) {
    els.resultCount.textContent = `${total} recent items \u00b7 showing ${shown} \u00b7 older items load on demand`;
  } else {
    els.resultCount.textContent = `${total} items \u00b7 showing ${shown}`;
  }
  if (state.sort === 'points' && total > 0) els.resultCount.textContent += ' \u00b7 sorted by points/votes';

  if (shown < total) {
    els.loadMore.textContent = 'Load more';
    els.loadMore.hidden = false;
  } else if (archivePending) {
    els.loadMore.textContent = 'Load older items';
    els.loadMore.hidden = false;
  } else {
    els.loadMore.textContent = 'Load more';
    els.loadMore.hidden = true;
  }
  updateApplyLabel(total);
  applyHighlight();
  markOpenCard();
  els.results.setAttribute('aria-busy', data.archiveLoading ? 'true' : 'false');

  // Motion is layered on after the synchronous DOM update (FLIP for survivors, stagger for newcomers).
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
    newCards.forEach((card, i) => {
      card.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: EASE_OUT, delay: Math.min(i, 10) * 12, fill: 'backwards' });
    });
  }
  lastView = view;
  firstRender = false;
}

// ---------- hero tiles ----------

const counted = new WeakSet();

function countUp(node, value) {
  const target = Number(value);
  if (!Number.isFinite(target)) { node.textContent = '\u2014'; return; }
  if (counted.has(node) || reduceMotion.matches || target === 0) {
    counted.add(node);
    node.textContent = String(target);
    return;
  }
  counted.add(node);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 600);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = String(Math.round(target * eased));
    if (t < 1) requestAnimationFrame(step);
    else node.textContent = String(target);
  };
  requestAnimationFrame(step);
}

function setTile(li, value, label, asOf) {
  if (!li) return;
  const n = li.querySelector('.stat-n');
  const l = li.querySelector('.stat-l');
  if (value === null) {
    n.textContent = '\u2014';
    l.textContent = `${label} \u00b7 unavailable`;
  } else {
    if (typeof value === 'number') countUp(n, value);
    else n.textContent = value;
    l.textContent = label;
  }
  if (asOf) li.title = asOf;
  else li.removeAttribute('title');
}

function finiteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function updateTiles() {
  const s = data.stats;
  const asOf = s?.generatedAt ? `As of ${absoluteTime(s.generatedAt)}` : '';
  const archive = s ? finiteNumber(s.archiveItems) ?? 0 : null;
  setTile(els.statFeed, s && !data.loadError ? data.primary.length + archive : null, 'Items \u00b7 90 days', asOf);
  setTile(els.stat24h, s ? finiteNumber(s.last24h) : null, 'Last 24 hours', asOf);
  setTile(els.stat7d, s ? finiteNumber(s.last7d) : null, 'Last 7 days', asOf);
  if (!data.allSources) {
    els.statSources.hidden = true;
  } else {
    els.statSources.hidden = false;
    const enabled = data.allSources.filter((x) => x.enabled);
    const ok = enabled.filter((x) => !x.lastError).length;
    setTile(els.statSources, `${ok}/${enabled.length}`, 'Sources OK / enabled', asOf);
  }
}

// ---------- radar ----------

function renderRadarNow() {
  if (!els.radarSvg || !radarMq.matches) return;
  const now = Date.now();
  const n = radarCount(data.primary, now);
  renderRadar(els.radarSvg, data.primary, now, els.detail.open ? detail.key : null);
  const capNote = n > MAX_BLIPS ? ` \u00b7 showing newest ${MAX_BLIPS}` : '';
  els.radarTitle.textContent = `Last 48 h \u00b7 ${pluralize(n, 'item', 'items')}${capNote}`;
  els.radarSvg.setAttribute('aria-label', `Radar of the ${pluralize(n, 'item', 'items')} published in the last 48 hours; newest nearest the centre. Hover or click a dot, or browse the same items in the feed below.`);
  if (!platesFitted) platesFitted = fitPlates(els.radarSvg);
}

function initRadarPanel() {
  if (!els.radarPanel || !els.radarSvg) return;
  initRadar({ panel: els.radarPanel, svg: els.radarSvg, tip: els.radarTip, onOpen: (key) => openDetail(key, { push: true, from: 'radar' }) });
  document.fonts?.ready.then(() => { if (radarMq.matches) platesFitted = fitPlates(els.radarSvg) || platesFitted; });
  radarMq.addEventListener('change', (e) => {
    if (e.matches) {
      platesFitted = fitPlates(els.radarSvg);
      renderRadarNow();
    }
  });
}

// ---------- data loading ----------

function noteCacheStatus(res) {
  if (!els.offline) return;
  if (res.headers.get('X-Startup-Radar-Cache') === 'fallback') {
    const at = res.headers.get('X-Startup-Radar-Cached-At');
    const rel = at ? relativeTime(at) : '';
    els.offline.textContent = `Offline \u2014 showing data cached ${rel || 'earlier'}`;
    els.offline.hidden = false;
  } else {
    els.offline.hidden = true;
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

/** Load ./data/archive.json once (single flight); 404 = no archive; a network error shows an inline alert. */
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
      if (!res.ok) {
        data.archive = [];
        data.archiveItems = 0;
        return;
      }
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

function applyStats(stats) {
  data.stats = stats;
  data.statsFailed = false;
  statusLine.update(stats);
}

/**
 * Take the archive split of a newer stats.json: when an archive had been loaded or the
 * split changed, forget the loaded archive so the next trigger re-fetches it.
 * Returns whether an archive had been loaded (the caller revalidates it then).
 */
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
    applyStats(stats);
    data.archiveItems = finiteNumber(stats.archiveItems) ?? 0;
    data.seenRefresh = stats.lastRefresh ?? stats.generatedAt ?? null;
  } catch {
    data.stats = null;
    data.statsFailed = true;
    statusLine.fail();
  }
}

async function loadSources() {
  try {
    const payload = await fetchJson(SOURCES_URL, { onResponse: noteCacheStatus });
    if (!payload || !Array.isArray(payload.sources)) throw new Error('unexpected response');
    data.allSources = payload.sources;
    knownSources = payload.sources.filter((s) => s.enabled);
    const known = new Set(knownSources.map((s) => s.id));
    state.sources = state.sources.filter((id) => known.has(id));
    renderSourceOptions(knownSources);
    const n = knownSources.length;
    els.subtitle.textContent = `Newly launched and newly funded startups from ${n} public ${n === 1 ? 'source' : 'sources'}, refreshed automatically.`;
  } catch {
    data.allSources = null; // keep the static subtitle; the checklist stays empty
  }
}

function renderSourceOptions(sources) {
  clear(els.sourceList);
  els.sourceList.append(el('legend', { text: 'Limit to these sources' }));
  const grid = el('div', { className: 'source-grid' });
  for (const s of sources) {
    const id = `src-${s.id}`;
    const input = el('input', { type: 'checkbox', id, value: s.id, name: 'source' });
    input.checked = state.sources.includes(s.id);
    const label = el('label', { className: `source-option${input.checked ? ' checked' : ''}`, for: id }, [
      input,
      el('span', { className: 'source-name', text: s.name }),
      el('span', { className: 'region-note', text: `(${regionLabel(s.region)})` }),
    ]);
    grid.append(label);
  }
  els.sourceList.append(grid);
}

// ---------- live data: polling, new-items pill ----------

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
    refetchFailStreak += 1;
    if (refetchFailStreak === 1) {
      console.warn('[radar] items re-fetch failed:', err?.message ?? err);
      toast('Checking for new items failed', { variant: 'error' });
    }
    return;
  }
  const known = new Set(allItems().map(keyOf));
  const newKeys = fresh.filter((it) => it && !known.has(keyOf(it)));
  if (newKeys.length > 0) {
    data.pending = { items: fresh, stats, at };
    showPill(newKeys.length);
  } else {
    // Nothing new: replace silently (items may have aged out), keep the rendered cards, refresh the Feed tile.
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
  const top = els.results.getBoundingClientRect().top;
  if (top < 0) els.results.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  hidePill();
}

let statsFailStreak = 0;

async function onStatsPolled(stats) {
  statsFailStreak = 0;
  applyStats(stats);
  updateTiles();
  const at = stats.lastRefresh ?? stats.generatedAt ?? null;
  if (at && data.seenRefresh && at !== data.seenRefresh && !data.loadError) {
    await checkNewItems(stats, at);
  } else if (!data.seenRefresh) {
    data.seenRefresh = at;
  }
}

function onStatsError(err) {
  statsFailStreak += 1;
  if (statsFailStreak === 1) console.warn('[radar] stats poll failed:', err?.message ?? err);
  statusLine.fail();
}

function tick() {
  tickTimes(document);
  statusLine.tick();
  renderRadarNow();
}

// ---------- detail drawer ----------

const detail = {
  key: null,
  item: null,
  returnTo: null,
  ownsEntry: false,
  ignoreNextPop: false,
  fromHistory: false,
  closing: false,
};

function renderDetail(item) {
  const panel = els.detailPanel;
  clear(panel);
  const key = keyOf(item);
  const closeBtn = el('button', { type: 'button', id: 'detail-close', className: 'btn-ghost icon-btn', 'aria-label': 'Close' }, [icon('close')]);
  closeBtn.addEventListener('click', closeDetail);
  const head = el('header', { className: 'detail-head' }, [
    el('div', { className: 'detail-badges' }, [sourceBadge(item), kindBadge(item), regionBadge(item)]),
    closeBtn,
  ]);

  const body = el('div', { className: 'detail-body' });
  body.append(el('h2', { id: 'detail-title', tabindex: '-1', text: item.title || '(untitled)' }));
  if (item.publishedAt && absoluteTime(item.publishedAt)) {
    body.append(el('p', { className: 'detail-time' }, [
      document.createTextNode(`Published ${absoluteTime(item.publishedAt)} (`),
      timeEl(item.publishedAt),
      document.createTextNode(')'),
    ]));
  }
  const summary = item.summary && String(item.summary).trim();
  body.append(summary
    ? el('p', { id: 'detail-summary', className: 'detail-summary', text: item.summary })
    : el('p', { id: 'detail-summary', className: 'detail-empty', text: 'No summary provided by the source.' }));

  const rows = detailRows(item);
  if (rows.length) {
    const dl = el('dl', { className: 'detail-meta' });
    for (const row of rows) {
      dl.append(el('dt', { text: row.label }));
      let value;
      if (row.href && row.label === 'Website') value = el('dd', {}, [extLink(row.href, row.value, { ariaLabel: `${row.value} (opens in a new tab)` })]);
      else if (row.href) value = el('dd', {}, [el('a', { href: row.href, text: row.value })]);
      else value = el('dd', { className: row.label === 'Destination' ? 'mono' : null, text: row.value });
      dl.append(value);
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
  const copy = el('button', { type: 'button', id: 'detail-copy', className: 'btn-secondary' }, [icon('copy'), el('span', { text: 'Copy link' })]);
  copy.addEventListener('click', () => copyLink(key));
  actions.append(copy);
  body.append(actions);

  const list = currentList();
  const index = list.findIndex((it) => keyOf(it) === key);
  const prev = el('button', { type: 'button', id: 'detail-prev', className: 'btn-secondary' }, [icon('chevron-left'), el('span', { text: 'Previous' })]);
  const next = el('button', { type: 'button', id: 'detail-next', className: 'btn-secondary' }, [el('span', { text: 'Next' }), icon('chevron-right')]);
  prev.disabled = index <= 0;
  next.disabled = index < 0 || index >= list.length - 1;
  prev.addEventListener('click', () => stepDetail(-1));
  next.addEventListener('click', () => stepDetail(1));
  const pos = el('span', { className: 'detail-pos', text: index >= 0 ? `${index + 1} of ${list.length}` : `\u2014 of ${list.length}` });
  const nav = el('footer', { className: 'detail-nav' }, [prev, pos, next]);

  panel.append(head, body, nav);
}

async function openDetail(key, { push = false, from = 'card' } = {}) {
  let item = findItem(key);
  if (!item && data.archiveItems > 0 && data.archive === null && !data.loadError) {
    await ensureArchive();
    item = findItem(key);
  }
  if (!item) {
    if (from === 'deeplink' || from === 'history') {
      toast('That item is no longer in the feed');
      if (new URLSearchParams(location.search).has('item')) replaceUrl(buildUrl(state, null));
    }
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
  document.title = `${item.title || '(untitled)'} \u2014 Startup Radar`;
  if (push) {
    if (!historyBroken) {
      try { history.pushState({ sr: 'item', key }, '', buildUrl(state, key)); detail.ownsEntry = true; } catch (err) { historyBroken = true; console.warn('[radar] history unavailable:', err?.message ?? err); }
    }
  } else {
    detail.ownsEntry = from === 'history';
  }
  markOpenCard();
  renderRadarNow();
  document.getElementById('detail-title')?.focus();
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
  if (supportsAnimate && !reduceMotion.matches) {
    els.detailPanel.querySelector('.detail-body')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: EASE_OUT });
  }
  replaceUrl(buildUrl(state, key));
  document.title = `${item.title || '(untitled)'} \u2014 Startup Radar`;
  markOpenCard();
  renderRadarNow();
  const wanted = document.getElementById(focusedId === 'detail-prev' || focusedId === 'detail-next' ? focusedId : 'detail-title');
  if (wanted && !wanted.disabled) wanted.focus();
  else {
    const other = document.getElementById(focusedId === 'detail-prev' ? 'detail-next' : 'detail-prev');
    (other && !other.disabled ? other : document.getElementById('detail-title'))?.focus();
  }
}

function closeDetail() {
  if (!els.detail.open || detail.closing) return;
  detail.closing = true;
  els.detail.classList.add('closing');
  const finish = () => { if (els.detail.open) els.detail.close(); };
  if (reduceMotion.matches || !els.detailPanel.getAnimations || els.detailPanel.getAnimations().length === 0) { finish(); return; }
  let done = false;
  const once = () => { if (done) return; done = true; finish(); };
  els.detailPanel.addEventListener('animationend', once, { once: true });
  setTimeout(once, 300);
}

function onDetailClosed() {
  els.detail.classList.remove('closing');
  detail.closing = false;
  document.title = BASE_TITLE;
  restoreToasts();
  const lastKey = detail.key;
  const returnTo = detail.returnTo;
  const fromHistory = detail.fromHistory;
  if (detail.ownsEntry && !fromHistory && !historyBroken) {
    detail.ownsEntry = false;
    detail.ignoreNextPop = true;
    history.back();
  } else if (!detail.ownsEntry && new URLSearchParams(location.search).has('item')) {
    replaceUrl(buildUrl(state, null));
  }
  detail.fromHistory = false;
  detail.ownsEntry = false;
  detail.key = null;
  detail.item = null;
  detail.returnTo = null;
  markOpenCard();
  if (returnTo === 'radar' && radarMq.matches) {
    els.radarPanel.focus();
  } else {
    const card = cardFor(lastKey);
    if (card) {
      state.highlightKey = lastKey;
      applyHighlight();
      card.scrollIntoView({ block: 'nearest' });
      card.querySelector('.card-link')?.focus();
    } else if (radarMq.matches) {
      els.radarPanel.focus();
    } else {
      els.results.focus();
    }
  }
  renderRadarNow();
}

async function copyLink(key) {
  const url = `${location.origin}${location.pathname}?item=${key}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied', { duration: 3000 });
  } catch {
    let field = document.getElementById('detail-copy-field');
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

function openExternal(item) {
  const url = item ? safeHttpUrl(item.url) : null;
  if (!url) return;
  const a = extLink(url, '');
  a.hidden = true;
  (document.querySelector('dialog[open]') ?? document.body).append(a);
  a.click();
  a.remove();
}

async function openDeepLink() {
  const key = pendingDeepKey;
  if (!key) return;
  const opened = await openDetail(key, { push: false, from: 'deeplink' });
  pendingDeepKey = null;
  if (!opened && new URLSearchParams(location.search).has('item')) replaceUrl(buildUrl(state, null));
}

// ---------- phone filter sheet ----------

const sheet = { isOpen: false, pillSuppressed: false, inertEls: [] };
const INERT_SELECTOR = 'header.site-header, section.hero, main > :not(#filter-panel):not(.scrim), footer.site-footer, #new-items, #toasts';

function openSheet() {
  if (!sheetMq.matches || sheet.isOpen) return;
  sheet.isOpen = true;
  els.panel.hidden = false;
  els.panel.setAttribute('role', 'dialog');
  els.panel.setAttribute('aria-modal', 'true');
  els.scrim.hidden = false;
  scrollLock(true);
  for (const node of document.querySelectorAll(INERT_SELECTOR)) {
    node.inert = true;
    sheet.inertEls.push(node);
  }
  if (!els.newItems.hidden) {
    els.newItems.hidden = true;
    sheet.pillSuppressed = true;
  }
  updateApplyLabel(currentList().length);
  els.panelTitle.focus();
}

function closeSheet({ focusTarget = null } = {}) {
  if (!sheet.isOpen) return;
  sheet.isOpen = false;
  for (const node of sheet.inertEls) node.inert = false;
  sheet.inertEls = [];
  if (els.sourcesFilter.open) els.sourcesFilter.open = false;
  els.scrim.hidden = true;
  scrollLock(false);
  els.panel.removeAttribute('role');
  els.panel.removeAttribute('aria-modal');
  els.panel.hidden = sheetMq.matches;
  if (sheet.pillSuppressed) {
    sheet.pillSuppressed = false;
    if (data.pending) els.newItems.hidden = false;
  }
  const target = focusTarget ?? (els.filtersOpen.offsetParent !== null ? els.filtersOpen : els.q);
  target.focus();
}

function syncSheetMode() {
  if (sheetMq.matches) {
    if (!sheet.isOpen) els.panel.hidden = true;
  } else {
    if (sheet.isOpen) closeSheet();
    els.panel.hidden = false;
  }
}

// ---------- keyboard ----------

function cardLinks() {
  return Array.from(els.results.querySelectorAll('article.card[data-key] a.card-link'));
}

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
    if (!els.loadMore.hidden && !els.loadMore.disabled) {
      els.loadMore.click(); // render() is synchronous: move only if a new card appeared
      links = cardLinks();
      if (target >= links.length) { if (index >= 0) focusCardLink(links[Math.min(index, links.length - 1)]); return; }
    } else {
      return;
    }
  }
  if (target < 0) return;
  focusCardLink(links[target]);
}

function onKeydown(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const target = e.target instanceof Element ? e.target : document.body;
  const key = e.key;
  const inText = Boolean(target.closest(TEXT_ENTRY));
  if (inText && key !== 'Escape') return;
  if (!inText && target.closest('select') && key !== 'Escape') return;
  const dialogOpen = document.querySelector('dialog[open]');

  if (key === 'Escape') {
    if (dialogOpen) return; // the dialog's own cancel handler closes it
    if (sheet.isOpen) { e.preventDefault(); closeSheet(); return; }
    if (els.sourcesFilter.open) { e.preventDefault(); els.sourcesFilter.open = false; els.sourcesSummary.focus(); return; }
    if (state.highlightKey && !inText) {
      e.preventDefault();
      state.highlightKey = null;
      applyHighlight();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    return; // not handled: #q keeps the browser's native Esc-clears-field
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

// ---------- events ----------

function applyChange() {
  syncControls();
  state.page = 1;
  syncLocation();
  render();
}

function resetFilters() {
  state.kind = '';
  state.region = '';
  state.sources = [];
  state.q = '';
  state.since = '';
  state.sort = '';
  applyChange();
}

function wireEvents() {
  const debouncedSearch = debounce(() => {
    state.q = els.q.value.trim().slice(0, Q_MAX);
    state.page = 1;
    syncControls();
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
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sheet.isOpen) closeSheet();
  });
  els.kind.addEventListener('change', () => { state.kind = els.kind.value; applyChange(); });
  els.region.addEventListener('change', () => { state.region = els.region.value; applyChange(); });
  els.sort.addEventListener('change', () => { state.sort = els.sort.value === 'points' ? 'points' : ''; applyChange(); });
  for (const btn of els.scopeButtons) {
    btn.addEventListener('click', () => { state.region = btn.dataset.scope; applyChange(); });
  }
  for (const btn of els.chipButtons) {
    btn.addEventListener('click', () => {
      state.since = btn.dataset.since;
      applyChange();
      if (state.since === '30d' || state.since === '') ensureArchive();
    });
  }
  els.sourceList.addEventListener('change', (e) => {
    if (!(e.target instanceof HTMLInputElement) || e.target.type !== 'checkbox') return;
    e.target.closest('label')?.classList.toggle('checked', e.target.checked);
    state.sources = Array.from(els.sourceList.querySelectorAll('input[type="checkbox"]:checked')).map((b) => b.value);
    applyChange();
  });
  els.reset.addEventListener('click', resetFilters);
  els.loadMore.addEventListener('click', () => {
    const shown = els.results.querySelectorAll('article.card').length;
    const exhausted = shown >= currentList().length;
    state.page += 1;
    render();
    if (exhausted) ensureArchive();
  });

  // Delegated card click (title link or anywhere on the card) opens the drawer.
  els.results.addEventListener('click', (e) => {
    const card = e.target instanceof Element ? e.target.closest('article.card[data-key]') : null;
    if (!card) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const interactive = e.target.closest('a, button');
    if (interactive && !interactive.classList.contains('card-link')) return;
    if (e.detail > 0 && document.getSelection()?.toString()) return;
    e.preventDefault();
    openDetail(card.dataset.key, { push: true, from: 'card' });
  });
  els.results.addEventListener('focusin', (e) => {
    const link = e.target instanceof Element ? e.target.closest('a.card-link') : null;
    if (!link) return;
    const card = link.closest('article.card');
    card.classList.add('has-focus');
    state.highlightKey = card.dataset.key;
    applyHighlight();
  });
  els.results.addEventListener('focusout', (e) => {
    const link = e.target instanceof Element ? e.target.closest('a.card-link') : null;
    link?.closest('article.card')?.classList.remove('has-focus');
  });

  // Drawer
  els.detail.addEventListener('cancel', (e) => { e.preventDefault(); closeDetail(); });
  els.detail.addEventListener('close', onDetailClosed);
  els.detail.addEventListener('click', (e) => { if (e.target === els.detail) closeDetail(); });
  window.addEventListener('popstate', () => {
    if (detail.ignoreNextPop) {
      detail.ignoreNextPop = false;
      syncLocation();
      return;
    }
    const key = validKey(new URLSearchParams(location.search).get('item'));
    if (els.detail.open && !key) {
      detail.fromHistory = true;
      detail.ownsEntry = false;
      closeDetail();
      return;
    }
    if (!els.detail.open && key) {
      openDetail(key, { push: false, from: 'history' });
      return;
    }
    readStateFromLocation();
    syncControls();
    render();
  });

  // Phone sheet
  els.filtersOpen.addEventListener('click', openSheet);
  els.filtersClose.addEventListener('click', () => closeSheet());
  els.filtersApply.addEventListener('click', () => closeSheet());
  els.scrim.addEventListener('click', () => closeSheet());
  sheetMq.addEventListener('change', syncSheetMode);

  // Desktop sources popover: outside click closes it
  document.addEventListener('pointerdown', (e) => {
    if (!els.sourcesFilter.open || sheetMq.matches) return;
    if (e.target instanceof Node && els.sourcesFilter.contains(e.target)) return;
    els.sourcesFilter.open = false;
  });

  // View toggle
  const setView = (view) => {
    state.view = view;
    try { localStorage.setItem('sr:view', view); } catch { /* session only */ }
    syncControls();
    render({ animate: false });
  };
  els.viewGrid.addEventListener('click', () => setView('grid'));
  els.viewList.addEventListener('click', () => setView('list'));
  wideMq.addEventListener('change', () => { if (effectiveView() !== lastView) render({ animate: false }); });

  // New-items pill
  els.newItemsBtn.addEventListener('click', applyPending);
  els.newItemsDismiss.addEventListener('click', hidePill);

  document.addEventListener('keydown', onKeydown);
}

// ---------- boot ----------

async function init() {
  initTheme();
  initHelp();
  observeSticky();
  syncSheetMode();
  initRadarPanel();
  pendingDeepKey = validKey(new URLSearchParams(location.search).get('item'));
  readStateFromLocation();
  syncControls();
  wireEvents();
  await Promise.allSettled([loadSources(), loadStats(), loadItems()]);
  readStateFromLocation(); // drop source ids that sources.json does not know
  syncControls();
  syncLocation();
  render();
  updateTiles();
  renderRadarNow();
  if (state.q || state.since === '30d') ensureArchive();
  await openDeepLink();
  pollStats({ url: STATS_URL, onStats: onStatsPolled, onError: onStatsError });
  startTicker(tick);
  registerServiceWorker();
  initInstallPrompt();
}

init();
