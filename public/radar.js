// Startup Radar live radar panel: pure geometry (unit-tested, DOM-free at module level) plus the SVG
// renderer and pointer tooltip. Angle = kind quadrant (launch, funding, news, accelerator clockwise
// from 12 o'clock) + region slot; radius = 0.10R (now) .. 0.55R (24 h) .. R (48 h); newest 400 drawn.

import { itemKey } from './filter.js';
import { regionLabel, relativeTime } from './format.js';

export const CENTER = 180;
export const RADIUS = 150;
export const MAX_AGE_H = 48;
export const MAX_BLIPS = 400;
export const FRESH_MIN = 60;
export const KIND_ORDER = ['launch', 'funding', 'news', 'accelerator'];
export const REGION_ORDER = ['usa', 'europe', 'asia', 'india', 'latam', 'africa', 'global'];
const SLOT = 90 / REGION_ORDER.length;
const JITTER_MAX = 4;
const VIEWBOX = 360;
const PAD_X = 4;
const PAD_Y = 2;
const SVG_NS = 'http://www.w3.org/2000/svg';
const itemsBySvg = new WeakMap();

/** Age in hours at `now` (negative for future dates, NaN when unparsable). */
export function ageHours(item, now = Date.now()) {
  const t = Date.parse(item?.publishedAt);
  return Number.isNaN(t) ? NaN : (now - t) / 3_600_000;
}

/** Centre angle of the kind quadrant + region slot; unknown kinds -> news, unknown regions -> global. */
export function baseAngle(kind, region) {
  let k = KIND_ORDER.indexOf(kind);
  if (k < 0) k = 2;
  let r = REGION_ORDER.indexOf(region);
  if (r < 0) r = REGION_ORDER.length - 1;
  return k * 90 + (r + 0.5) * SLOT;
}

/** Deterministic jitter in [-4, 4] degrees from the item key (spreads coincident items). */
export function jitterDeg(key) {
  const s = String(key ?? '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return ((h % 8001) / 8000) * (2 * JITTER_MAX) - JITTER_MAX;
}

/** R * (0.10 + 0.90 * clamp(age / 48, 0, 1)); future dates clamp to 0.10R. */
export function radiusFor(ageH, R = RADIUS) {
  const f = Number.isNaN(ageH) ? 0 : Math.min(1, Math.max(0, ageH / MAX_AGE_H));
  return R * (0.10 + 0.90 * f);
}

/** { x, y, r, angle, base } for one item; angle = base + jitter. */
export function blipPosition(item, now = Date.now(), R = RADIUS) {
  const base = baseAngle(item?.kind, item?.region);
  const angle = (base + jitterDeg(itemKey(item?.url)) + 360) % 360;
  const r = radiusFor(ageHours(item, now), R);
  const rad = (angle * Math.PI) / 180;
  return { x: CENTER + r * Math.sin(rad), y: CENTER - r * Math.cos(rad), r, angle, base };
}

function within48h(item, now) {
  const age = ageHours(item, now);
  return !Number.isNaN(age) && age <= MAX_AGE_H;
}

/** Items within 48 h of `now` (future dates included), newest first, capped at 400. */
export function radarItems(items, now = Date.now()) {
  return (items ?? []).filter((it) => within48h(it, now)).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, MAX_BLIPS);
}

/** Honest count: every item within 48 h, before the cap (never stats.last24h). */
export function radarCount(items, now = Date.now()) {
  let n = 0;
  for (const it of items ?? []) if (within48h(it, now)) n += 1;
  return n;
}

/** Size each rect.radar-plate to its <text> (bbox + 4 x 2 px, clamped); no-op while hidden or fonts not ready. */
export function fitPlates(svg) {
  if (!svg || svg.getClientRects().length === 0) return false;
  const boxes = [];
  for (const text of svg.querySelectorAll('text')) {
    const plate = text.previousElementSibling;
    if (!plate || !plate.matches('rect.radar-plate')) continue;
    const bb = text.getBBox();
    if (!(bb.width > 0) || !(bb.height > 0)) return false;
    boxes.push([plate, bb]);
  }
  for (const [plate, bb] of boxes) {
    let x = bb.x - PAD_X;
    let y = bb.y - PAD_Y;
    let w = bb.width + 2 * PAD_X;
    let h = bb.height + 2 * PAD_Y;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > VIEWBOX) w = VIEWBOX - x;
    if (y + h > VIEWBOX) h = VIEWBOX - y;
    plate.setAttribute('x', x.toFixed(2));
    plate.setAttribute('y', y.toFixed(2));
    plate.setAttribute('width', w.toFixed(2));
    plate.setAttribute('height', h.toFixed(2));
  }
  return true;
}

/** One circle.blip per radar item in g.blips (attribute updates only); `openKey` is highlighted. */
export function renderRadar(svg, items, now = Date.now(), openKey = null) {
  const group = svg.querySelector('g.blips');
  if (!group) return 0;
  const drawn = radarItems(items, now);
  const byKey = new Map();
  for (const c of group.querySelectorAll('circle.blip')) byKey.set(c.dataset.key, c);
  const lookup = new Map();
  for (const item of drawn) {
    const key = itemKey(item.url);
    lookup.set(key, item);
    const pos = blipPosition(item, now);
    let circle = byKey.get(key);
    if (circle) byKey.delete(key);
    else {
      circle = document.createElementNS(SVG_NS, 'circle');
      circle.dataset.key = key;
      group.append(circle);
    }
    const fresh = ageHours(item, now) < FRESH_MIN / 60;
    const open = openKey !== null && key === openKey;
    circle.setAttribute('class', `blip${fresh ? ' is-fresh' : ''}${open ? ' is-open' : ''}`);
    circle.setAttribute('cx', pos.x.toFixed(2));
    circle.setAttribute('cy', pos.y.toFixed(2));
    circle.setAttribute('r', open ? '5' : '3.5');
    // --accent-fill (= --accent when dark) stays >= 3:1 on white at the 0.75 pulse trough
    circle.setAttribute('fill', open ? 'var(--accent-fill)' : `var(--region-${REGION_ORDER.includes(item.region) ? item.region : 'global'})`);
    circle.setAttribute('stroke', open ? 'var(--fg-0)' : 'transparent');
    circle.setAttribute('stroke-width', open ? '1' : '9'); // transparent 9 px stroke = 16 px pointer target
  }
  for (const stale of byKey.values()) stale.remove();
  itemsBySvg.set(svg, lookup);
  return drawn.length;
}

/** Pointer tooltip (CSSOM-positioned, flipped at the panel edges) and click-to-open wiring. */
export function initRadar({ panel, svg, tip, onOpen }) {
  if (!panel || !svg || !tip) return;
  const title = document.createElement('p');
  title.className = 'tip-title';
  const meta = document.createElement('p');
  meta.className = 'tip-meta';
  tip.append(title, meta);
  const itemFor = (target) => {
    const blip = target instanceof Element ? target.closest('circle.blip') : null;
    return blip ? { key: blip.dataset.key, item: itemsBySvg.get(svg)?.get(blip.dataset.key) ?? null } : null;
  };
  const hide = () => { tip.hidden = true; };
  svg.addEventListener('pointerover', (event) => {
    const found = itemFor(event.target);
    if (!found?.item) return;
    const { item } = found;
    title.textContent = item.title || '(untitled)';
    meta.textContent = [item.source?.name || item.source?.id || '', regionLabel(item.region), relativeTime(item.publishedAt)].filter(Boolean).join(' \u00b7 ');
    tip.hidden = false;
    const box = panel.getBoundingClientRect();
    const tipBox = tip.getBoundingClientRect();
    let left = event.clientX - box.left + 12;
    let top = event.clientY - box.top + 12;
    if (left + tipBox.width > box.width - 4) left = event.clientX - box.left - 12 - tipBox.width;
    if (top + tipBox.height > box.height - 4) top = event.clientY - box.top - 12 - tipBox.height;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, top)}px`;
  });
  svg.addEventListener('pointerout', (event) => { if (itemFor(event.target)) hide(); });
  panel.addEventListener('pointerleave', hide);
  svg.addEventListener('click', (event) => {
    const found = itemFor(event.target);
    if (!found) return;
    hide();
    onOpen?.(found.key);
  });
}
