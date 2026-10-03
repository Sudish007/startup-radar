// Startup Radar home page. Vanilla ES module; all DOM built with
// createElement/textContent (strict CSP, no inline scripts or HTML strings).
//
// Data comes from the static files ./data/items.json, ./data/sources.json and
// ./data/stats.json (served by the Express app or by GitHub Pages); every
// filter, the search and the paging run in the browser (see ./filter.js).
// ./data/archive.json (older items) is loaded on demand only.

import { SINCE_VALUES, filterItems } from './filter.js';

const KIND_LABELS = {
  launch: 'Launch',
  funding: 'Funding',
  news: 'News',
  accelerator: 'Accelerator',
};

const REGION_LABELS = {
  usa: 'USA',
  europe: 'Europe',
  asia: 'Asia',
  india: 'India',
  latam: 'Latin America',
  africa: 'Africa',
  global: 'Global',
};

const PAGE_SIZE = 30;
const STATS_POLL_MS = 60_000;
const DEBOUNCE_MS = 300;

const ITEMS_URL = './data/items.json';
const ARCHIVE_URL = './data/archive.json';
const SOURCES_URL = './data/sources.json';
const STATS_URL = './data/stats.json';

const els = {
  subtitle: document.getElementById('subtitle'),
  lastRefreshed: document.getElementById('last-refreshed'),
  form: document.getElementById('filters'),
  q: document.getElementById('q'),
  kind: document.getElementById('kind'),
  region: document.getElementById('region'),
  scopeButtons: Array.from(document.querySelectorAll('button.scope')),
  chipButtons: Array.from(document.querySelectorAll('button.chip')),
  sourceList: document.getElementById('source-list'),
  reset: document.getElementById('reset'),
  resultCount: document.getElementById('result-count'),
  results: document.getElementById('results'),
  loadMore: document.getElementById('load-more'),
};

const state = {
  kind: '',
  region: '',
  sources: [],
  q: '',
  since: '',
  page: 1,
};

const data = {
  primary: [],
  archive: null, // null = not loaded yet; [] = loaded (or no archive exists)
  archiveItems: 0, // from stats.json; > 0 means an archive.json exists
  archiveLoading: null, // in-flight promise (single flight)
  archiveError: '', // last network error while loading the archive
  loadError: '', // items.json could not be loaded
};

let knownSources = [];

// ---------- helpers ----------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffSec = Math.round((now - t) / 1000);
  // A source-supplied date in the future is shown as-is rather than as "just now".
  if (diffSec < 0) return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (diffSec < 60) return 'just now';
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function absoluteTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString();
}

export function compactMoney(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ''));
  if (n >= 1e9) return `${fmt(n / 1e9)}B`;
  if (n >= 1e6) return `${fmt(n / 1e6)}M`;
  if (n >= 1e3) return `${fmt(n / 1e3)}K`;
  return String(n);
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- state <-> URL ----------

function readStateFromLocation() {
  const params = new URLSearchParams(location.search);
  state.kind = params.get('kind') || '';
  state.region = params.get('region') || '';
  state.q = params.get('q') || '';
  const since = params.get('since') || '';
  state.since = SINCE_VALUES.has(since) ? since : '';
  const src = params.get('source') || '';
  state.sources = src ? src.split(',').map((s) => s.trim()).filter(Boolean) : [];
  state.page = 1;
}

function stateToParams() {
  const params = new URLSearchParams();
  if (state.kind) params.set('kind', state.kind);
  if (state.region) params.set('region', state.region);
  if (state.sources.length) params.set('source', state.sources.join(','));
  if (state.q) params.set('q', state.q);
  if (state.since) params.set('since', state.since);
  return params;
}

function syncLocation() {
  const qs = stateToParams().toString();
  history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
}

// ---------- rendering ----------

function syncControls() {
  els.q.value = state.q;
  els.kind.value = state.kind;
  const selectable = Object.keys(REGION_LABELS).includes(state.region) ? state.region : '';
  els.region.value = selectable;
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
  }
}

function renderBadge(text, className) {
  return el('span', { className: `badge ${className}`, text });
}

function metaParts(extra) {
  const parts = [];
  if (!extra || typeof extra !== 'object') return parts;
  if (typeof extra.points === 'number') {
    let s = `${extra.points} points`;
    if (typeof extra.comments === 'number') s += ` \u00b7 ${extra.comments} comments`;
    parts.push(s);
  } else if (typeof extra.comments === 'number') {
    parts.push(`${extra.comments} comments`);
  }
  if (typeof extra.votes === 'number') parts.push(`${extra.votes} votes`);
  if (typeof extra.batch === 'string' && extra.batch) {
    parts.push(/^yc\b/i.test(extra.batch) ? extra.batch : `YC ${extra.batch}`);
  }
  if (extra.investmentType || typeof extra.moneyRaisedUsd === 'number') {
    const bits = [];
    if (extra.investmentType) bits.push(String(extra.investmentType).replace(/_/g, ' '));
    if (typeof extra.moneyRaisedUsd === 'number') bits.push(`$${compactMoney(extra.moneyRaisedUsd)}`);
    parts.push(bits.join(' \u00b7 '));
  }
  if (typeof extra.author === 'string' && extra.author) parts.push(`by ${extra.author}`);
  return parts;
}

export function renderCard(item) {
  const title = el('h2', {}, [
    el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', text: item.title }),
  ]);

  const badges = el('div', { className: 'badges' }, [
    renderBadge(item.source?.name || item.source?.id || 'Unknown source', 'badge-source'),
    renderBadge(KIND_LABELS[item.kind] || item.kind, `badge-${item.kind}`),
    renderBadge(REGION_LABELS[item.region] || item.region, 'badge-region'),
  ]);

  const children = [title, badges];

  if (item.publishedAt) {
    children.push(el('time', {
      datetime: item.publishedAt,
      title: absoluteTime(item.publishedAt),
      text: relativeTime(item.publishedAt),
    }));
  }

  if (item.summary && item.summary.trim()) {
    children.push(el('p', { className: 'summary', text: item.summary }));
  }

  const meta = metaParts(item.extra);
  if (meta.length) {
    children.push(el('p', { className: 'meta', text: meta.join(' \u00b7 ') }));
  }

  return el('article', { className: 'card' }, children);
}

function renderError(message) {
  clear(els.results);
  els.results.append(el('p', { className: 'alert', role: 'alert', text: message }));
  els.resultCount.textContent = '';
  els.loadMore.hidden = true;
  els.results.setAttribute('aria-busy', 'false');
}

function renderSourceOptions(sources) {
  clear(els.sourceList);
  els.sourceList.append(el('legend', { text: 'Limit to these sources' }));
  for (const s of sources) {
    const id = `src-${s.id}`;
    const input = el('input', { type: 'checkbox', id, value: s.id, name: 'source' });
    input.checked = state.sources.includes(s.id);
    const label = el('label', { className: 'source-option', for: id }, [
      input,
      el('span', { text: s.name }),
      el('span', { className: 'region-note', text: `(${REGION_LABELS[s.region] || s.region})` }),
    ]);
    els.sourceList.append(label);
  }
}

/** Filter + sort + page the loaded items and redraw the list, count and Load-more button. */
function render() {
  if (data.loadError) {
    renderError(`Could not load items: ${data.loadError}`);
    return;
  }

  const all = data.archive ? data.primary.concat(data.archive) : data.primary;
  const matches = filterItems(all, state);
  const shownItems = matches.slice(0, state.page * PAGE_SIZE);
  const total = matches.length;
  const shown = shownItems.length;
  const archivePending = data.archive === null && data.archiveItems > 0;

  clear(els.results);
  if (data.archiveError) {
    els.results.append(el('p', { className: 'alert', role: 'alert', text: `Could not load older items: ${data.archiveError}` }));
  }
  for (const item of shownItems) els.results.append(renderCard(item));

  if (total === 0) {
    els.resultCount.textContent = 'No items match these filters.';
    els.results.append(el('p', { className: 'empty', text: 'Nothing here yet. Try a wider time range, another region, or reset the filters.' }));
  } else if (archivePending) {
    els.resultCount.textContent = `${total} recent items \u00b7 showing ${shown} \u00b7 older items load on demand`;
  } else {
    els.resultCount.textContent = `${total} items \u00b7 showing ${shown}`;
  }

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

  els.results.setAttribute('aria-busy', data.archiveLoading ? 'true' : 'false');
}

// ---------- data loading ----------

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

/** Fetch ./data/items.json exactly once. */
async function loadItems() {
  els.results.setAttribute('aria-busy', 'true');
  try {
    const items = await fetchJson(ITEMS_URL);
    if (!Array.isArray(items)) throw new Error('unexpected response');
    data.primary = items;
    data.loadError = '';
  } catch (err) {
    data.primary = [];
    data.loadError = err.message;
  }
}

/**
 * Load ./data/archive.json once (single flight). A 404 / non-OK answer means
 * "no archive"; a network error shows an alert and is retried on the next trigger.
 */
function ensureArchive() {
  if (data.archive !== null || data.archiveItems === 0 || data.loadError) return Promise.resolve();
  if (data.archiveLoading) return data.archiveLoading;

  data.archiveError = '';
  els.results.setAttribute('aria-busy', 'true');
  els.loadMore.disabled = true;
  data.archiveLoading = (async () => {
    try {
      const res = await fetch(ARCHIVE_URL, { headers: { Accept: 'application/json' } });
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

async function loadStats() {
  try {
    const stats = await fetchJson(STATS_URL);
    data.archiveItems = Number(stats.archiveItems) || 0;
    const at = stats.lastRefresh ?? stats.generatedAt;
    if (at) {
      els.lastRefreshed.textContent = `Last refreshed ${relativeTime(at)}`;
      els.lastRefreshed.title = absoluteTime(at);
    } else {
      els.lastRefreshed.textContent = 'Last refreshed: unknown';
      els.lastRefreshed.removeAttribute('title');
    }
  } catch {
    els.lastRefreshed.textContent = 'Last refreshed: unknown';
  }
}

async function loadSources() {
  try {
    const payload = await fetchJson(SOURCES_URL);
    knownSources = payload.sources.filter((s) => s.enabled);
    renderSourceOptions(knownSources);
    const n = knownSources.length;
    els.subtitle.textContent = `Newly launched and newly funded startups from ${n} public ${n === 1 ? 'source' : 'sources'}, refreshed automatically.`;
  } catch {
    // Keep the static subtitle; the checklist simply stays empty.
  }
}

// ---------- events ----------

function applyChange() {
  syncControls();
  syncLocation();
  state.page = 1;
  render();
}

function wireEvents() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    state.q = els.q.value.trim();
    applyChange();
    if (state.q) ensureArchive();
  });

  els.q.addEventListener('input', debounce(() => {
    state.q = els.q.value.trim();
    syncLocation();
    state.page = 1;
    render();
    if (state.q) ensureArchive();
  }, DEBOUNCE_MS));

  els.kind.addEventListener('change', () => {
    state.kind = els.kind.value;
    applyChange();
  });

  els.region.addEventListener('change', () => {
    state.region = els.region.value;
    applyChange();
  });

  for (const btn of els.scopeButtons) {
    btn.addEventListener('click', () => {
      state.region = btn.dataset.scope;
      applyChange();
    });
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
    state.sources = Array.from(els.sourceList.querySelectorAll('input[type="checkbox"]:checked')).map((b) => b.value);
    syncLocation();
    state.page = 1;
    render();
  });

  els.reset.addEventListener('click', () => {
    state.kind = '';
    state.region = '';
    state.sources = [];
    state.q = '';
    state.since = '';
    applyChange();
  });

  els.loadMore.addEventListener('click', () => {
    const shown = els.results.querySelectorAll('article').length;
    const all = data.archive ? data.primary.concat(data.archive) : data.primary;
    const exhausted = shown >= filterItems(all, state).length;
    state.page += 1;
    render();
    if (exhausted) ensureArchive();
  });
}

// ---------- boot ----------

async function init() {
  readStateFromLocation();
  syncControls();
  wireEvents();
  await loadSources();
  await Promise.all([loadStats(), loadItems()]);
  render();
  if (state.q || state.since === '30d') ensureArchive();
  setInterval(loadStats, STATS_POLL_MS);
}

init();
