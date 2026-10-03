// Startup Radar shared UI module (home + sources pages). Vanilla ES module;
// every DOM node is built with createElement/textContent (strict CSP), the
// only element factory is el() and the only place target="_blank" is set is
// extLink(). Dynamic styles go through style.setProperty / WAAPI only.

import { absoluteTime, relativeTime } from './format.js';

export const STATS_POLL_MS = 300_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';
const THEME_KEY = 'sr:theme';
const THEME_COLORS = { dark: '#0B0F17', light: '#F4F6FA' };

export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- DOM helpers ----------

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** <svg class="icon" aria-hidden="true" focusable="false"><use href="./icons.svg#name"/></svg> */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `./icons.svg#${name}`);
  use.setAttributeNS(XLINK, 'xlink:href', `./icons.svg#${name}`);
  svg.append(use);
  return svg;
}

/** The ONLY constructor of external anchors: target=_blank + rel="noopener noreferrer". */
export function extLink(href, text, { className = null, ariaLabel = null, title = null } = {}) {
  const a = el('a', { href, className, 'aria-label': ariaLabel, title });
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (text) a.textContent = text;
  return a;
}

export function scrollLock(on) {
  document.documentElement.classList.toggle('has-modal', Boolean(on));
}

/** fetch + JSON with the error-message convention of the API; `cacheInfo` receives the SW fallback headers. */
export async function fetchJson(url, { noCache = false, onResponse = null } = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: noCache ? 'no-cache' : 'default' });
  onResponse?.(res);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// ---------- toasts ----------

const toastsEl = () => document.getElementById('toasts');

function dismissToast(t, immediate = false) {
  clearTimeout(Number(t.dataset.timer));
  if (immediate || reduceMotion.matches || !t.isConnected) { t.remove(); return; }
  t.classList.add('closing');
  t.addEventListener('animationend', () => t.remove(), { once: true });
  setTimeout(() => t.remove(), 300);
}

/**
 * toast(message, { variant = 'info' | 'error' | 'update', action = { label, onClick } | null, duration = 6000 }) -> HTMLElement
 * At most two auto-dismissing toasts are visible; toasts with an action (and the
 * persistent `update` variant) never auto-dismiss and are never evicted.
 */
export function toast(message, { variant = 'info', action = null, duration = 6000 } = {}) {
  const host = toastsEl();
  const t = el('div', { className: `toast ${variant}`, role: variant === 'error' ? 'alert' : null });
  t.append(el('p', { text: message }));
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

// ---------- theme ----------

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
    const use = btn.querySelector('use');
    if (use) {
      use.setAttribute('href', `./icons.svg#${t === 'dark' ? 'sun' : 'moon'}`);
      use.setAttributeNS(XLINK, 'xlink:href', `./icons.svg#${t === 'dark' ? 'sun' : 'moon'}`);
    }
  }
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* session only */ }
  applyTheme(next);
}

export function initTheme() {
  applyTheme(currentTheme());
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  const mq = matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener('change', (e) => {
    if (storedTheme() === null) applyTheme(e.matches ? 'light' : 'dark');
  });
}

// ---------- help dialog ----------

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
  const panel = d.querySelector('.help-panel');
  const finish = () => { if (d.open) d.close(); };
  if (reduceMotion.matches || !panel?.getAnimations || panel.getAnimations().length === 0) { finish(); return; }
  let done = false;
  const once = () => { if (done) return; done = true; finish(); };
  panel.addEventListener('animationend', once, { once: true });
  setTimeout(once, 300);
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
    if (target && target.isConnected) target.focus();
  });
  d.addEventListener('click', (e) => { if (e.target === d) closeHelp(); });
  document.getElementById('help-close')?.addEventListener('click', closeHelp);
  document.getElementById('help-open')?.addEventListener('click', (e) => openHelp(e.currentTarget));
  document.getElementById('help-link')?.addEventListener('click', (e) => { e.preventDefault(); openHelp(e.currentTarget); });
}

// ---------- timers, sticky heights, polling ----------

/** Run `fn` every minute while the page is visible, and once when it becomes visible again. */
export function startTicker(fn) {
  const id = setInterval(() => { if (!document.hidden) fn(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fn(); });
  return () => clearInterval(id);
}

/** Measure the sticky bars into --topbar-h / --sticky-h on <html> (CSP-safe CSSOM writes). */
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

/** Poll stats.json every 5 minutes (not at start), paused while hidden, immediately on return when stale. */
export function pollStats({ url, onStats, onError }) {
  let last = Date.now();
  let inflight = false;
  async function poll() {
    if (inflight) return;
    inflight = true;
    last = Date.now();
    try {
      const res = await fetch(url, { cache: 'no-cache', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body || typeof body !== 'object') throw new Error('unexpected response');
      await onStats(body, res);
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

/** The #last-refreshed contract: "Last refreshed <relative>" (+ " · update check failed"), no aria-live; #refresh-announce is the live region. */
export function createStatusLine() {
  const p = document.getElementById('last-refreshed');
  const dot = p?.querySelector('.live-dot');
  const text = p?.querySelector('.status-text') ?? p;
  const announce = document.getElementById('refresh-announce');
  let at = null;
  let failed = false;
  let announcedFail = false;
  function paint() {
    if (!p) return;
    if (!at) {
      text.textContent = failed ? 'Last refreshed: unknown' : 'Last refreshed: loading\u2026';
      p.removeAttribute('title');
    } else {
      text.textContent = `Last refreshed ${relativeTime(at)}${failed ? ' \u00b7 update check failed' : ''}`;
      p.title = absoluteTime(at);
    }
    dot?.classList.toggle('is-warn', failed);
  }
  return {
    get at() { return at; },
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
    tick() { paint(); },
  };
}

// ---------- PWA: service worker registration, update toast, install prompt ----------

let awaitingReload = false;
let updateToast = null;

function showUpdateToast(worker) {
  if (updateToast && updateToast.isConnected) return;
  updateToast = toast('Update available \u2014 Reload', {
    variant: 'update',
    action: {
      label: 'Reload',
      onClick: () => {
        awaitingReload = true;
        worker.postMessage({ type: 'SKIP_WAITING' });
      },
    },
  });
}

/** Register ./sw.js (relative scope) after load on https or localhost; failures only warn. */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !local) return;
  const run = async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(w);
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!awaitingReload) return; // the first install (clients.claim) never reloads
        awaitingReload = false;
        location.reload();
      });
    } catch (err) {
      console.warn('[radar] service worker registration failed:', err?.message ?? err);
    }
  };
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}

/** Show the footer Install button only when the browser offers beforeinstallprompt. */
export function initInstallPrompt() {
  const btn = document.getElementById('install');
  if (!btn) return;
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    const ev = deferred;
    deferred = null;
    btn.hidden = true;
    if (!ev) return;
    try { await ev.prompt(); } catch { /* dismissed or unavailable */ }
  });
  window.addEventListener('appinstalled', () => { btn.hidden = true; });
}

/** Re-render every relative time stamp (`time[datetime][data-rel]`) inside `root`. */
export function tickTimes(root = document) {
  for (const t of root.querySelectorAll('time[datetime][data-rel]')) {
    t.textContent = relativeTime(t.getAttribute('datetime'));
  }
}
