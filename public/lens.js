// Startup Radar lens-page runtime shared by trends.js, funding.js and yc.js (plan §2.3 common page contract):
// shell + drawer mount, ?item=<key> deep link / popstate, keyboard layer (t, ?, drawer j/k/o), status line,
// items.json (+ archive.json on demand) store for drawer lookups, small textContent-only table helpers.

import { createDrawer, keyOf, openExternal } from './drawer.js';
import { mountShell } from './shell.js';
import { createStatusLine, el, fetchJson, openHelp, pollStats, startPwa, startTicker, tickTimes, toast, toggleTheme } from './ui.js';

export const STATS_URL = './data/stats.json';
export const ITEMS_URL = './data/items.json';
export const ARCHIVE_URL = './data/archive.json';
const KEY_RE = /^[0-9a-z]{1,13}$/;
const TEXT_ENTRY = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export const HELP = [
  [['t'], 'Toggle dark / light theme'],
  [['?'], 'Show this list'],
  [['Esc'], 'Close the open panel'],
  [['j', '\u2192'], 'In the detail panel: next item'],
  [['k', '\u2190'], 'In the detail panel: previous item'],
  [['o'], 'In the detail panel: open the original page in a new tab'],
];

export const validKey = (v) => (typeof v === 'string' && KEY_RE.test(v) ? v : null);
export const itemParam = () => validKey(new URLSearchParams(location.search).get('item'));
export const tx = (s) => document.createTextNode(String(s));
/** Integer/decimal as text (locale grouping); em dash for a missing value. */
export const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '\u2014');
export const cell = (label, children, className = null) => el('td', { 'data-label': label, className }, children);
export const textCell = (label, text, className = null) => cell(label, [tx(text)], className);
export const th = (text, className = null, title = null) => el('th', { scope: 'col', className, title, text });
export const rowHead = (children, label = null) => el('th', { scope: 'row', 'data-label': label }, children);

/** ./data/items.json + ./data/archive.json (loaded once, on the first miss) for drawer lookups. */
export function createItemStore() {
  let primary = [];
  let archive = null; // null = not loaded
  let archiveLoading = null;
  let archiveItems = 0; // from stats.json
  const byKey = new Map();
  const index = (list) => { for (const it of list) byKey.set(keyOf(it), it); };
  async function ensureArchive() {
    if (archive !== null || archiveItems === 0) return;
    if (!archiveLoading) {
      archiveLoading = (async () => {
        try {
          const res = await fetch(ARCHIVE_URL, { headers: { Accept: 'application/json' } });
          const body = res.ok ? await res.json().catch(() => null) : null;
          archive = Array.isArray(body) ? body : [];
          index(archive);
        } catch {
          archive = null; // retry on the next miss
        } finally {
          archiveLoading = null;
        }
      })();
    }
    await archiveLoading;
  }
  return {
    async load() {
      const items = await fetchJson(ITEMS_URL);
      if (!Array.isArray(items)) throw new Error('unexpected response');
      primary = items.filter((it) => it && typeof it === 'object');
      index(primary);
      return primary;
    },
    setArchiveItems(n) { archiveItems = typeof n === 'number' && Number.isFinite(n) ? n : 0; },
    all: () => (archive ? primary.concat(archive) : primary),
    has: (key) => byKey.has(key),
    peek: (key) => byKey.get(key) ?? null,
    async find(key) {
      if (!byKey.has(key)) await ensureArchive();
      return byKey.get(key) ?? null;
    },
  };
}

/**
 * Mount the shell + drawer of a lens page. getList/findItem/buildUrl/sections as createDrawer; openers (clicked
 * elements) get focus back on close. -> { drawer, statusLine, open(key, opener), loadStats(), start() }
 */
export function createLensPage({ page, help = HELP, getList, findItem, buildUrl, sections = [], onOpen = null, onClose = null }) {
  const shell = mountShell({ page, drawer: true, help });
  const statusLine = createStatusLine();
  const main = document.getElementById('main');
  let opener = null;
  let historyBroken = false;
  const drawer = createDrawer({
    dialog: shell.detail,
    getList,
    findItem,
    buildUrl,
    sections,
    onOpen,
    onClose: (info) => {
      if (opener?.isConnected) opener.focus(); else main?.focus();
      opener = null;
      onClose?.(info);
    },
  });

  async function open(key, from = null) {
    opener = from instanceof HTMLElement ? from : null;
    const ok = await drawer.open(key, { push: true, from: 'card' });
    if (!ok) toast('That item is no longer in the feed'); // key absent from items.json + archive.json
    return ok;
  }

  function replaceUrl(url) {
    if (historyBroken) return;
    try { history.replaceState(null, '', url); } catch (err) { historyBroken = true; console.warn('[radar] history unavailable:', err?.message ?? err); }
  }

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const t = e.target instanceof Element ? e.target : document.body;
    if (t.closest(TEXT_ENTRY) && e.key !== 'Escape') return;
    const dialogOpen = document.querySelector('dialog[open]');
    if (dialogOpen === drawer.dialog) {
      if (e.key === 'j' || e.key === 'ArrowRight') { e.preventDefault(); drawer.step(1); return; }
      if (e.key === 'k' || e.key === 'ArrowLeft') { e.preventDefault(); drawer.step(-1); return; }
      if (e.key === 'o') { e.preventDefault(); openExternal(drawer.item()); return; }
    }
    if (e.key === 't') { e.preventDefault(); toggleTheme(); return; }
    if (e.key === '?' && !dialogOpen) { e.preventDefault(); openHelp(t instanceof HTMLElement ? t : null); }
  });

  async function loadStats() {
    try {
      const stats = await fetchJson(STATS_URL);
      if (!stats || typeof stats !== 'object') throw new Error('unexpected response');
      statusLine.update(stats);
      return stats;
    } catch {
      statusLine.fail();
      return null;
    }
  }

  /** After the first render: deep link, popstate, polling, ticker, PWA. onPopstate re-reads page state (optional). */
  async function start({ onPopstate = null } = {}) {
    window.addEventListener('popstate', () => {
      if (drawer.handlePopstate(itemParam())) return;
      onPopstate?.();
    });
    await drawer.openDeepLink(itemParam());
    pollStats({ url: STATS_URL, onStats: (stats) => statusLine.update(stats), onError: () => statusLine.fail() });
    startTicker(() => { tickTimes(document); statusLine.tick(); });
    startPwa();
  }

  return { shell, drawer, statusLine, open, loadStats, start, replaceUrl };
}

/** Delegated click on a[href^="?item="] / [data-open-key] inside `root` opens the drawer (modifier clicks pass through). */
export function wireOpeners(root, open) {
  root.addEventListener('click', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target.closest('[data-open-key]') : null;
    if (!target || !root.contains(target)) return;
    e.preventDefault();
    open(target.dataset.openKey, target);
  });
}

/** <a class="item-link" href="?item=key" data-open-key=key>title</a> (the drawer intercepts the click). */
export function itemLink(key, text) {
  return el('a', { className: 'item-link', href: `?item=${key}`, dataset: { openKey: key }, text });
}

/** p.coverage / p.method style notes. */
export const note = (className, text) => el('p', { className, text });
