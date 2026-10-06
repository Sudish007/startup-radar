// Startup Radar page shell (plan D2/D3): nav + phone menu, footer links, dialog#help, #toasts, optional dialog#detail,
// theme/help/sticky init, `g` + letter chords.

import { GOTO_ROWS, NAV, pageOf } from './nav.js';
import { clear, el, fillHelp, icon, initHelp, initTheme, observeSticky } from './ui.js';

const CHORD_MS = 800;
const TEXT_ENTRY = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const wideMq = matchMedia('(min-width: 640px)');

function fillNav(ul, page) {
  clear(ul);
  for (const n of NAV) {
    ul.append(el('li', {}, [el('a', { href: n.href, text: n.label, 'aria-current': n.page === page ? 'page' : null })]));
  }
}

/** Phone dropdown: toggles nav.site-nav.is-open; Esc (only while open), outside pointerdown and link clicks close it. */
function mountNavToggle(nav, ul) {
  const btn = el('button', { type: 'button', id: 'nav-toggle', className: 'btn-ghost icon-btn', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': ul.id }, [icon('menu')]);
  const isOpen = () => nav.classList.contains('is-open');
  const set = (open) => {
    nav.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  btn.addEventListener('click', () => set(!isOpen()));
  ul.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('a')) set(false); });
  document.addEventListener('pointerdown', (e) => { if (isOpen() && !(e.target instanceof Node && nav.contains(e.target))) set(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen() || e.defaultPrevented) return;
    e.preventDefault();
    set(false);
    btn.focus();
  });
  wideMq.addEventListener('change', (e) => { if (e.matches && isOpen()) set(false); });
  nav.prepend(btn);
  return btn;
}

function helpDialog() {
  return el('dialog', { id: 'help', className: 'help', 'aria-modal': 'true', 'aria-labelledby': 'help-title' }, [
    el('div', { className: 'help-panel' }, [
      el('div', { className: 'help-head' }, [
        el('h2', { id: 'help-title', tabindex: '-1', text: 'Keyboard shortcuts' }),
        el('button', { type: 'button', id: 'help-close', className: 'btn-ghost icon-btn', 'aria-label': 'Close' }, [icon('close')]),
      ]),
      el('dl', { className: 'help-list' }),
    ]),
  ]);
}

function footerLinks() {
  return el('p', { className: 'footer-links' }, [
    el('a', { id: 'help-link', href: '#help', text: 'Keyboard shortcuts' }),
    el('button', { type: 'button', id: 'install', className: 'btn-secondary', hidden: true }, [icon('download'), el('span', { text: 'Install app' })]),
  ]);
}

/** `g` then h/t/f/y/n within 800 ms navigates (not in text fields, with a dialog open or with modifiers). */
function installChords() {
  let pendingAt = 0;
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) { pendingAt = 0; return; }
    const target = e.target instanceof Element ? e.target : document.body;
    if (target.closest(TEXT_ENTRY) || document.querySelector('dialog[open]')) { pendingAt = 0; return; }
    const now = performance.now();
    if (pendingAt && now - pendingAt <= CHORD_MS) {
      pendingAt = 0;
      const dest = NAV.find((n) => n.key === e.key);
      if (dest) { e.preventDefault(); location.assign(dest.href); return; }
    }
    pendingAt = e.key === 'g' ? now : 0;
  });
}

/** First call of every page's init() -> { page, nav, navToggle, help, toasts, detail (null unless drawer) }. */
export function mountShell({ page = pageOf(location.pathname), drawer = false, help = [] } = {}) {
  const nav = document.querySelector('nav.site-nav');
  const ul = nav?.querySelector('ul') ?? null;
  let navToggle = null;
  if (nav && ul) {
    ul.id = 'site-nav-list';
    fillNav(ul, page);
    navToggle = mountNavToggle(nav, ul);
  }
  document.querySelector('footer.site-footer .wrap')?.append(footerLinks());
  const helpEl = helpDialog();
  const toasts = el('div', { id: 'toasts', className: 'toasts', 'aria-live': 'polite' });
  const detail = drawer
    ? el('dialog', { id: 'detail', className: 'detail', 'aria-modal': 'true', 'aria-labelledby': 'detail-title', 'aria-describedby': 'detail-summary' }, [el('div', { className: 'detail-panel' })])
    : null;
  const pill = document.getElementById('new-items');
  document.body.append(helpEl);
  if (pill) pill.before(toasts); else document.body.append(toasts);
  if (detail) document.body.append(detail);
  initTheme();
  initHelp();
  fillHelp([...help, ...GOTO_ROWS]);
  observeSticky();
  installChords();
  return { page, nav, navToggle, help: helpEl, toasts, detail };
}
