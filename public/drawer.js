// Startup Radar detail drawer (plan D4, every page): dialog#detail render, ?item= history, prev/next, Copy link, hooks.

import { itemKey } from './filter.js';
import { absoluteTime, detailRows, hnDiscussion, hostnameOf, safeHttpUrl } from './format.js';
import { afterExit, button, clear, el, extLink, icon, kindBadge, moveToastsInto, reduceMotion, regionBadge, restoreToasts, sourceBadge, timeEl, toast } from './ui.js';

const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)'; // = --ease-out in styles.css
const supportsAnimate = typeof Element.prototype.animate === 'function';
const $ = (id) => document.getElementById(id);
const keyCache = new WeakMap();

/** itemKey(item.url), cached per item object. */
export function keyOf(item) {
  let k = keyCache.get(item);
  if (!k) { k = itemKey(item.url); keyCache.set(item, k); }
  return k;
}

/** `o` / "open original": a transient extLink() anchor, never window.open. */
export function openExternal(item) {
  const url = item ? safeHttpUrl(item.url) : null;
  if (!url) return;
  const a = extLink(url, '');
  a.hidden = true;
  (document.querySelector('dialog[open]') ?? document.body).append(a);
  a.click();
  a.remove();
}

/** getList() -> ordered list; findItem(key) -> item | null | Promise; buildUrl(key|null); onOpen({ key, item, from });
 * onClose({ lastKey, returnTo }) (page does focus return); sections / actions: (item, { key, drawer }) => Node | null;
 * ensureIndexVisible(index). -> { open(key, { push, from }), close, step, isOpen, key, item, rerender, openDeepLink, handlePopstate, dialog } */
export function createDrawer({ dialog, getList, findItem, buildUrl, onOpen = null, onClose = null, sections = [], actions = [], ensureIndexVisible = null }) {
  const panel = dialog.querySelector('.detail-panel');
  const st = { key: null, item: null, returnTo: null, ownsEntry: false, ignoreNextPop: false, fromHistory: false, closing: false };
  let historyBroken = false;

  function historyCall(fn) {
    if (historyBroken) return false;
    try { fn(); return true; } catch (err) { historyBroken = true; console.warn('[radar] history unavailable:', err?.message ?? err); return false; }
  }
  const replaceUrl = (url) => historyCall(() => history.replaceState(null, '', url));
  const itemParam = () => new URLSearchParams(location.search).get('item');
  const dropItemParam = () => { if (itemParam() !== null) replaceUrl(buildUrl(null)); };

  const api = {
    open, close, step, rerender, openDeepLink, handlePopstate, dialog,
    isOpen: () => dialog.open,
    key: () => (dialog.open ? st.key : null),
    item: () => (dialog.open ? st.item : null),
  };

  function render(item) {
    clear(panel);
    const key = keyOf(item);
    const ctx = { key, drawer: api };
    const head = el('header', { className: 'detail-head' }, [
      el('div', { className: 'detail-badges' }, [sourceBadge(item), kindBadge(item), regionBadge(item)]),
      button({ id: 'detail-close', className: 'btn-ghost icon-btn', 'aria-label': 'Close' }, [icon('close')], close),
    ]);
    const body = el('div', { className: 'detail-body' }, [el('h2', { id: 'detail-title', tabindex: '-1', text: item.title || '(untitled)' })]);
    // relative time here (title = absolute); the "Published" row below carries the absolute value
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
    for (const hook of sections) { const node = hook(item, ctx); if (node) body.append(node); }
    const actionRow = el('div', { className: 'detail-actions' });
    const url = safeHttpUrl(item.url);
    if (url) {
      const host = hostnameOf(url);
      const open = extLink(url, '', { className: 'btn btn-primary', ariaLabel: `Open original on ${host} (opens in a new tab)` });
      open.append(el('span', { text: `Open on ${host}` }), icon('external'));
      actionRow.append(open);
    }
    const hn = hnDiscussion(item);
    if (hn) actionRow.append(extLink(hn, 'Discussion on Hacker News', { className: 'btn btn-ghost' }));
    actionRow.append(button({ id: 'detail-copy', className: 'btn-secondary' }, [icon('copy'), el('span', { text: 'Copy link' })], () => copyLink(key)));
    for (const hook of actions) { const node = hook(item, ctx); if (node) actionRow.append(node); }
    body.append(actionRow);

    const list = getList();
    const index = list.findIndex((it) => keyOf(it) === key);
    const prev = button({ id: 'detail-prev', className: 'btn-secondary' }, [icon('chevron-left'), el('span', { text: 'Previous' })], () => step(-1));
    const next = button({ id: 'detail-next', className: 'btn-secondary' }, [el('span', { text: 'Next' }), icon('chevron-right')], () => step(1));
    prev.disabled = index <= 0;
    next.disabled = index < 0 || index >= list.length - 1;
    const pos = el('span', { className: 'detail-pos', text: `${index >= 0 ? index + 1 : '\u2014'} of ${list.length}` });
    panel.append(head, body, el('footer', { className: 'detail-nav' }, [prev, pos, next]));
  }

  async function open(key, { push = false, from = 'card' } = {}) {
    let item = findItem(key);
    if (item && typeof item.then === 'function') item = await item;
    if (!item) {
      if (from === 'deeplink' || from === 'history') { toast('That item is no longer in the feed'); dropItemParam(); }
      return false;
    }
    const wasOpen = dialog.open;
    st.key = key;
    st.item = item;
    if (!wasOpen) st.returnTo = from;
    render(item);
    if (!wasOpen) {
      try { dialog.showModal(); } catch { /* already open: content re-rendered in place */ }
      moveToastsInto(dialog);
    }
    if (push) st.ownsEntry = historyCall(() => history.pushState({ sr: 'item', key }, '', buildUrl(key)));
    else st.ownsEntry = from === 'history';
    onOpen?.({ key, item, from });
    $('detail-title')?.focus();
    return true;
  }

  function step(dir) {
    if (!dialog.open || !st.key) return;
    const list = getList();
    const index = list.findIndex((it) => keyOf(it) === st.key);
    const nextIndex = index + dir;
    if (index < 0 || nextIndex < 0 || nextIndex >= list.length) return;
    const item = list[nextIndex];
    const key = keyOf(item);
    const focusedId = document.activeElement?.id;
    st.key = key;
    st.item = item;
    ensureIndexVisible?.(nextIndex);
    render(item);
    if (supportsAnimate && !reduceMotion.matches) panel.querySelector('.detail-body')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: EASE_OUT });
    replaceUrl(buildUrl(key));
    onOpen?.({ key, item, from: 'step' });
    const wanted = focusedId === 'detail-prev' || focusedId === 'detail-next' ? $(focusedId) : null;
    const other = focusedId === 'detail-prev' ? $('detail-next') : $('detail-prev');
    (wanted && !wanted.disabled ? wanted : wanted && !other.disabled ? other : $('detail-title')).focus();
  }

  function rerender() {
    if (dialog.open && st.item) render(st.item);
  }

  function close() {
    if (!dialog.open || st.closing) return;
    st.closing = true;
    dialog.classList.add('closing');
    afterExit(panel, () => { if (dialog.open) dialog.close(); });
  }

  /** The dialog `close` event is the single cleanup path for every close route. */
  function onClosed() {
    dialog.classList.remove('closing');
    st.closing = false;
    restoreToasts();
    const { key: lastKey, returnTo, fromHistory } = st;
    if (st.ownsEntry && !fromHistory && !historyBroken) {
      st.ownsEntry = false;
      st.ignoreNextPop = true;
      history.back();
    } else if (!st.ownsEntry) {
      dropItemParam();
    }
    Object.assign(st, { fromHistory: false, ownsEntry: false, key: null, item: null, returnTo: null });
    onClose?.({ lastKey, returnTo });
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
        panel.querySelector('.detail-actions')?.after(field);
      }
      field.value = url;
      field.focus();
      field.select();
      toast('Couldn\u2019t copy automatically \u2014 press Ctrl+C / \u2318C');
    }
  }

  /** Boot-time ?item=<key> (no history entry); a miss removes the param. */
  async function openDeepLink(key) {
    if (!key) return false;
    const opened = await open(key, { push: false, from: 'deeplink' });
    if (!opened) dropItemParam();
    return opened;
  }

  /** popstate: true when the event was the drawer's (the page then skips its own state re-read). */
  function handlePopstate(key) {
    if (st.ignoreNextPop) { st.ignoreNextPop = false; replaceUrl(buildUrl(dialog.open ? st.key : null)); return true; }
    if (dialog.open && !key) { st.fromHistory = true; st.ownsEntry = false; close(); return true; }
    if (!dialog.open && key) { open(key, { push: false, from: 'history' }); return true; }
    // Back/Forward between two ?item= entries (a related item opened while already open)
    if (dialog.open && key && key !== st.key) { open(key, { push: false, from: 'history' }); return true; }
    return false;
  }

  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('close', onClosed);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  return api;
}
