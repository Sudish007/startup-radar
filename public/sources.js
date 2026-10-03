// Startup Radar sources page. Vanilla ES module; DOM built with
// createElement/textContent only (strict CSP).

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

const ERROR_MAX = 120;
const STATS_POLL_MS = 60_000;

const els = {
  subtitle: document.getElementById('subtitle'),
  lastRefreshed: document.getElementById('last-refreshed'),
  status: document.getElementById('status'),
  tableWrap: document.getElementById('table-wrap'),
  tbody: document.querySelector('#sources-table tbody'),
  exploreList: document.getElementById('explore-list'),
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
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

function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffSec = Math.round((now - t) / 1000);
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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

function enabledText(s) {
  if (s.enabled) return 'Yes';
  if (s.requires) {
    // Keys alone (e.g. CRUNCHBASE_API_KEY) read as "not configured";
    // key=value hints (e.g. ENABLE_REDDIT=true) read as "set ...".
    return s.requires.includes('=') ? `No \u2014 set ${s.requires}` : `Not configured \u2014 ${s.requires}`;
  }
  return 'No';
}

function renderRow(s) {
  const sourceCell = el('th', { scope: 'row' }, [
    el('a', { href: s.homepage, target: '_blank', rel: 'noopener noreferrer', text: s.name }),
  ]);

  const lastSuccess = s.lastSuccessAt
    ? el('time', { datetime: s.lastSuccessAt, title: absoluteTime(s.lastSuccessAt), text: relativeTime(s.lastSuccessAt) })
    : document.createTextNode('never');

  let lastError;
  if (s.lastError) {
    const full = String(s.lastError);
    const short = full.length > ERROR_MAX ? `${full.slice(0, ERROR_MAX)}\u2026` : full;
    lastError = el('span', { className: 'error-text', title: full, text: short });
  } else {
    lastError = document.createTextNode('\u2014');
  }

  return el('tr', {}, [
    sourceCell,
    el('td', { text: enabledText(s) }),
    el('td', { text: KIND_LABELS[s.kind] || s.kind }),
    el('td', { text: REGION_LABELS[s.region] || s.region }),
    el('td', {}, [lastSuccess]),
    el('td', {}, [lastError]),
    el('td', { className: 'num', text: String(s.itemCount ?? 0) }),
  ]);
}

function renderExplore(list) {
  clear(els.exploreList);
  for (const entry of list) {
    const li = el('li', {}, [
      el('a', { href: entry.url, target: '_blank', rel: 'noopener noreferrer', text: entry.name }),
    ]);
    if (entry.note) {
      li.append(document.createTextNode(' \u2014 '));
      li.append(el('span', { className: 'note', text: entry.note }));
    }
    els.exploreList.append(li);
  }
}

async function loadSources() {
  try {
    const data = await fetchJson('/api/sources');
    const sources = data.sources || [];
    clear(els.tbody);
    for (const s of sources) els.tbody.append(renderRow(s));
    renderExplore(data.exploreMore || []);

    const enabled = sources.filter((s) => s.enabled).length;
    els.status.textContent = `${sources.length} configured, ${enabled} enabled.`;
    els.tableWrap.hidden = false;
    els.subtitle.textContent = `Newly launched and newly funded startups from ${enabled} public ${enabled === 1 ? 'source' : 'sources'}, refreshed automatically.`;
  } catch (err) {
    clear(els.status);
    els.status.setAttribute('role', 'alert');
    els.status.textContent = `Could not load sources: ${err.message}`;
  }
}

async function loadStats() {
  try {
    const stats = await fetchJson('/api/stats');
    if (stats.lastRefresh) {
      els.lastRefreshed.textContent = `Last refreshed ${relativeTime(stats.lastRefresh)}`;
      els.lastRefreshed.title = absoluteTime(stats.lastRefresh);
    } else {
      els.lastRefreshed.textContent = 'Last refreshed: never (first fetch in progress)';
      els.lastRefreshed.removeAttribute('title');
    }
  } catch {
    els.lastRefreshed.textContent = 'Last refreshed: unknown';
  }
}

async function init() {
  await Promise.all([loadSources(), loadStats()]);
  setInterval(loadStats, STATS_POLL_MS);
}

init();
