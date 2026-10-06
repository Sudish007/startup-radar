// Startup Radar shared UI (strict CSP): el() the only element factory (textContent), extLink() the only external anchor.

import { REGION_LABELS, absoluteTime, kindLabel, regionLabel, relativeTime } from './format.js';

export const STATS_POLL_MS = 300_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const THEME_KEY = 'sr:theme';
const THEME_COLORS = { dark: '#0B0F17', light: '#F4F6FA' };

export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// -- DOM helpers --

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** <svg class="icon" aria-hidden="true"><use href="./icons.svg#name"/></svg> */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `./icons.svg#${name}`);
  svg.append(use);
  return svg;
}

/** The only place a new-tab anchor is created (always noopener noreferrer). */
export function extLink(href, text, { className = null, ariaLabel = null, title = null } = {}) {
  const a = el('a', { href, className, 'aria-label': ariaLabel, title });
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (text) a.textContent = text;
  return a;
}

/** <button type="button" ...props>children</button> with a click handler. */
export function button(props, children, onClick) {
  const b = el('button', { type: 'button', ...props }, children);
  b.addEventListener('click', onClick);
  return b;
}

// -- item badges (cards + drawer on every page) --

export const badge = (text, className, title = null) => el('span', { className: `badge ${className}`, text, title });
export const sourceBadge = (item) => badge(item.source?.name || item.source?.id || 'Unknown source', 'badge-source');
export const kindBadge = (item) => badge(kindLabel(item.kind), `badge-${item.kind}`, 'Kind assigned by Startup Radar from the source and the text');
export const timeEl = (iso) => el('time', { datetime: iso, title: absoluteTime(iso), 'data-rel': '', text: relativeTime(iso) });

export function regionBadge(item) {
  const region = Object.hasOwn(REGION_LABELS, item.region) ? item.region : 'global';
  return el('span', { className: 'badge badge-region' }, [el('span', { className: `dot dot-${region}`, 'aria-hidden': 'true' }), document.createTextNode(regionLabel(item.region))]);
}

export function scrollLock(on) {
  document.documentElement.classList.toggle('has-modal', Boolean(on));
}

/** Run `done` when `node`'s exit animation ends (at once under reduced motion / no animations; 300 ms safety net). */
export function afterExit(node, done) {
  if (reduceMotion.matches || !node?.getAnimations || node.getAnimations().length === 0) { done(); return; }
  let fired = false;
  const once = () => { if (!fired) { fired = true; done(); } };
  node.addEventListener('animationend', once, { once: true });
  setTimeout(once, 300);
}

/** fetch + JSON with the API's { error } convention; onResponse sees the raw response (SW headers). */
export async function fetchJson(url, { noCache = false, onResponse = null } = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: noCache ? 'no-cache' : 'default' });
  onResponse?.(res);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
  return body;
}

// -- toasts --

const toastsEl = () => document.getElementById('toasts');

function dismissToast(t, immediate = false) {
  clearTimeout(Number(t.dataset.timer));
  if (immediate || !t.isConnected) { t.remove(); return; }
  t.classList.add('closing');
  afterExit(t, () => t.remove());
}

/** variant: info|error|update; action: { label, onClick }; <= 2 auto-dismissing toasts, actioned ones persist. */
export function toast(message, { variant = 'info', action = null, duration = 6000 } = {}) {
  const host = toastsEl();
  const t = el('div', { className: `toast ${variant}`, role: variant === 'error' ? 'alert' : null }, [el('p', { text: message })]);
  if (action) {
    const b = el('button', { type: 'button', className: 'toast-action', text: action.label });
    b.addEventListener('click', () => { action.onClick?.(); dismissToast(t, true); });
    t.append(b);
  }
  const close = el('button', { type: 'button', className: 'toast-close btn-ghost icon-btn', 'aria-label': 'Dismiss' }, [icon('close')]);
  close.addEventListener('click', () => dismissToast(t));
  t.append(close);
  if (variant === 'update' || action) {
    t.classList.add('persistent');
  } else {
    const auto = host.querySelectorAll('.toast:not(.persistent):not(.closing)');
    if (auto.length >= 2) dismissToast(auto[0], true);
    t.dataset.timer = String(setTimeout(() => dismissToast(t), duration));
  }
  host.append(t);
  return t;
}

export function moveToastsInto(dialog) {
  const host = toastsEl();
  if (host && dialog) dialog.append(host);
}

export function restoreToasts() {
  const host = toastsEl();
  if (!host) return;
  const pill = document.getElementById('new-items');
  if (pill) pill.before(host);
  else document.body.append(host);
}

// -- theme --

function storedTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch { return null; }
}

export function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[t]);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    btn.querySelector('use')?.setAttribute('href', `./icons.svg#${t === 'dark' ? 'sun' : 'moon'}`);
  }
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* session only */ }
  applyTheme(next);
}

/** Wire the toggle; follow the OS preference only until a choice is stored. */
export function initTheme() {
  applyTheme(currentTheme());
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (storedTheme() === null) applyTheme(e.matches ? 'light' : 'dark');
  });
}

// -- help dialog --

let helpOpener = null;
let helpClosing = false;

export function openHelp(opener = null) {
  const d = document.getElementById('help');
  if (!d || d.open) return;
  helpOpener = opener instanceof HTMLElement ? opener : null;
  d.showModal();
  moveToastsInto(d);
  document.getElementById('help-title')?.focus();
}

export function closeHelp() {
  const d = document.getElementById('help');
  if (!d || !d.open || helpClosing) return;
  helpClosing = true;
  d.classList.add('closing');
  afterExit(d.querySelector('.help-panel'), () => { if (d.open) d.close(); });
}

/** Fill dl.help-list from [[keys...], description] rows. */
export function fillHelp(rows) {
  const dl = document.querySelector('#help dl.help-list');
  if (!dl) return;
  clear(dl);
  for (const [keys, text] of rows) {
    const dt = el('dt');
    keys.forEach((k, i) => { if (i) dt.append(' '); dt.append(el('kbd', { text: k })); });
    dl.append(dt, el('dd', { text }));
  }
}

export function initHelp() {
  const d = document.getElementById('help');
  if (!d) return;
  d.addEventListener('cancel', (e) => { e.preventDefault(); closeHelp(); });
  d.addEventListener('close', () => {
    d.classList.remove('closing');
    helpClosing = false;
    restoreToasts();
    const target = helpOpener;
    helpOpener = null;
    if (target?.isConnected) target.focus();
  });
  d.addEventListener('click', (e) => { if (e.target === d) closeHelp(); });
  document.getElementById('help-close')?.addEventListener('click', closeHelp);
  document.getElementById('help-open')?.addEventListener('click', (e) => openHelp(e.currentTarget));
  document.getElementById('help-link')?.addEventListener('click', (e) => { e.preventDefault(); openHelp(e.currentTarget); });
}

// -- timers, sticky heights, polling, status line --

/** Run `fn` every minute while visible, and when the page becomes visible again. */
export function startTicker(fn) {
  const id = setInterval(() => { if (!document.hidden) fn(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fn(); });
  return () => clearInterval(id);
}

/** Measure the sticky header (+ desktop filter bar) into --topbar-h / --sticky-h on <html>. */
export function observeSticky() {
  const header = document.querySelector('header.site-header');
  const panel = document.getElementById('filter-panel');
  const mq = matchMedia('(min-width: 1024px)');
  const root = document.documentElement;
  const update = () => {
    const th = header ? header.offsetHeight : 0;
    const ph = panel && mq.matches ? panel.offsetHeight : 0;
    root.style.setProperty('--topbar-h', `${th}px`);
    root.style.setProperty('--sticky-h', `${th + ph}px`);
  };
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(update);
    if (header) ro.observe(header);
    if (panel) ro.observe(panel);
  }
  mq.addEventListener('change', update);
  window.addEventListener('load', update);
  update();
  return update;
}

/** Poll stats.json every 5 minutes (never at start), paused while hidden, immediately on return when stale. */
export function pollStats({ url, onStats, onError }) {
  let last = Date.now();
  let inflight = false;
  async function poll() {
    if (inflight) return;
    inflight = true;
    last = Date.now();
    try {
      const body = await fetchJson(url, { noCache: true });
      if (!body || typeof body !== 'object') throw new Error('unexpected response');
      await onStats(body);
    } catch (err) {
      onError?.(err);
    } finally {
      inflight = false;
    }
  }
  const id = setInterval(() => { if (!document.hidden) poll(); }, STATS_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - last >= STATS_POLL_MS) poll();
  });
  return { poll, stop: () => clearInterval(id) };
}

/** #last-refreshed text contract (+ " · update check failed"); #refresh-announce is the only live region. */
export function createStatusLine() {
  const p = document.getElementById('last-refreshed');
  const text = p?.querySelector('.status-text') ?? p;
  const announce = document.getElementById('refresh-announce');
  let at = null;
  let failed = false;
  let announcedFail = false;
  const paint = () => {
    if (!p) return;
    text.textContent = at ? `Last refreshed ${relativeTime(at)}${failed ? ' \u00b7 update check failed' : ''}` : `Last refreshed: ${failed ? 'unknown' : 'loading\u2026'}`;
    if (at) p.title = absoluteTime(at); else p.removeAttribute('title');
    p.querySelector('.live-dot')?.classList.toggle('is-warn', failed);
  };
  return {
    update(stats) {
      const next = stats?.lastRefresh ?? stats?.generatedAt ?? null;
      const changed = at !== null && next !== null && next !== at;
      at = next;
      failed = false;
      announcedFail = false;
      paint();
      if (changed && announce) announce.textContent = `Data refreshed ${absoluteTime(at)}`;
    },
    fail() {
      failed = true;
      paint();
      if (!announcedFail && announce) { announce.textContent = 'Update check failed'; announcedFail = true; }
    },
    tick: paint,
  };
}

/** Re-render every relative time stamp (`time[datetime][data-rel]`) inside `root`. */
export function tickTimes(root = document) {
  for (const t of root.querySelectorAll('time[datetime][data-rel]')) t.textContent = relativeTime(t.getAttribute('datetime'));
}

// -- PWA --

/** After `load`, import ./pwa.js (SW registration, update toast, install prompt); failures only warn. */
export function startPwa() {
  const run = () => import('./pwa.js').then((m) => m.init({ toast })).catch((err) => console.warn('[radar] pwa init failed:', err?.message ?? err));
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}
