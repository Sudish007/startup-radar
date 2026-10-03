// Startup Radar sources page. Vanilla ES module; DOM built with
// createElement/textContent only (strict CSP). Reads ./data/sources.json and
// ./data/stats.json (Express or GitHub Pages); the top bar (theme, help,
// status line, 5-minute stats poll, minute ticker) is shared through ./ui.js.

import { absoluteTime, kindLabel, regionLabel, relativeTime } from './format.js';
import {
  clear, createStatusLine, el, extLink, fetchJson, initHelp, initInstallPrompt, initTheme, observeSticky, openHelp, pollStats,
  registerServiceWorker, startTicker, tickTimes, toggleTheme,
} from './ui.js';

const SOURCES_URL = './data/sources.json';
const STATS_URL = './data/stats.json';
const ERROR_MAX = 120;

const els = {
  status: document.getElementById('status'),
  strip: document.querySelector('.status-strip'),
  tableWrap: document.getElementById('table-wrap'),
  tbody: document.querySelector('#sources-table tbody'),
  exploreList: document.getElementById('explore-list'),
};

const statusLine = createStatusLine();
let payload = null;
let loadError = '';

function enabledText(s) {
  if (s.enabled) return 'Yes';
  if (s.requires) {
    // Keys alone (e.g. CRUNCHBASE_API_KEY) read as "not configured";
    // key=value hints (e.g. ENABLE_REDDIT=true) read as "set ...".
    return s.requires.includes('=') ? `No \u2014 set ${s.requires}` : `Not configured \u2014 ${s.requires}`;
  }
  return 'No';
}

function cell(label, children, className = null) {
  return el('td', { role: 'cell', className, 'data-label': label }, children);
}

function renderRow(s) {
  const health = s.enabled ? (s.lastError ? 'warn' : 'ok') : 'off';
  const sourceCell = el('th', { scope: 'row', role: 'rowheader', 'data-label': 'Source' }, [extLink(s.homepage, s.name)]);
  const lastSuccess = s.lastSuccessAt
    ? el('time', { datetime: s.lastSuccessAt, title: absoluteTime(s.lastSuccessAt), 'data-rel': '', text: relativeTime(s.lastSuccessAt) })
    : document.createTextNode('never');
  let lastError;
  if (s.lastError) {
    const full = String(s.lastError);
    const short = full.length > ERROR_MAX ? `${full.slice(0, ERROR_MAX)}\u2026` : full;
    lastError = el('span', { className: 'error-text', title: full, text: short });
  } else {
    lastError = document.createTextNode('\u2014');
  }
  return el('tr', { role: 'row' }, [
    sourceCell,
    cell('Enabled', [el('span', { className: `health-dot ${health}`, 'aria-hidden': 'true' }), document.createTextNode(enabledText(s))]),
    cell('Kind', [document.createTextNode(kindLabel(s.kind))]),
    cell('Region', [document.createTextNode(regionLabel(s.region))]),
    cell('Last successful fetch', [lastSuccess]),
    cell('Last error', [lastError], 'error'),
    cell('Items', [document.createTextNode(String(s.itemCount ?? 0))], 'num'),
  ]);
}

function renderExplore(list) {
  clear(els.exploreList);
  for (const entry of list) {
    const li = el('li', {}, [extLink(entry.url, entry.name)]);
    if (entry.note) li.append(el('span', { className: 'note', text: entry.note }));
    els.exploreList.append(li);
  }
}

function tile(value, label) {
  return el('li', { className: 'stat' }, [
    el('span', { className: 'stat-n', text: String(value) }),
    el('span', { className: 'stat-l', text: label }),
  ]);
}

function renderAll() {
  if (!payload) {
    clear(els.status);
    els.status.setAttribute('role', 'alert');
    els.status.textContent = `Could not load sources: ${loadError}`;
    return;
  }
  const sources = payload.sources;
  const enabled = sources.filter((s) => s.enabled);
  const withErrors = enabled.filter((s) => s.lastError);
  clear(els.tbody);
  for (const s of sources) els.tbody.append(renderRow(s));
  renderExplore(payload.exploreMore || []);
  els.status.textContent = `${sources.length} configured, ${enabled.length} enabled.`;
  clear(els.strip);
  els.strip.append(tile(sources.length, 'Configured'), tile(enabled.length, 'Enabled'), tile(withErrors.length, 'With errors'));
  els.strip.hidden = false;
  els.tableWrap.hidden = false;
}

async function loadSources() {
  try {
    const body = await fetchJson(SOURCES_URL);
    if (!body || !Array.isArray(body.sources)) throw new Error('unexpected response');
    payload = body;
  } catch (err) {
    payload = null;
    loadError = err.message;
  }
}

async function loadStats() {
  try {
    const stats = await fetchJson(STATS_URL);
    if (!stats || typeof stats !== 'object') throw new Error('unexpected response');
    statusLine.update(stats);
  } catch {
    statusLine.fail();
  }
}

function tick() {
  tickTimes(document);
  statusLine.tick();
}

async function init() {
  initTheme();
  initHelp();
  observeSticky();
  // Keyboard layer of this page: `t` toggles the theme (also inside the help dialog), `?` opens help.
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const t = e.target instanceof Element ? e.target : document.body;
    if (t.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 't') { e.preventDefault(); toggleTheme(); return; }
    if (e.key === '?' && !document.querySelector('dialog[open]')) { e.preventDefault(); openHelp(t instanceof HTMLElement ? t : null); }
  });
  await Promise.allSettled([loadSources(), loadStats()]);
  renderAll();
  pollStats({ url: STATS_URL, onStats: (stats) => statusLine.update(stats), onError: () => statusLine.fail() });
  startTicker(tick);
  registerServiceWorker();
  initInstallPrompt();
}

init();
