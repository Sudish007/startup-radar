// Startup Radar live radar panel: pure geometry (unit-tested, DOM-free at module level) plus the SVG
// renderer and pointer tooltip. Angle = kind sector (launch, funding, news, accelerator clockwise from
// 12 o'clock) + region sub-wedge, spread inside it by a hash of the item key; radius = 0.10R (now) ..
// 0.55R (24 h) .. R (48 h); newest 400 drawn. The ring captions sit on the 9 o'clock half of the
// crosshair (the caption channel); blips keep CAPTION_CLEAR px off it and LINE_CLEAR px off the lines.

import { itemKey } from './filter.js';
import { regionLabel, relativeTime } from './format.js';

export const CENTER = 180;
export const RADIUS = 150;
export const MAX_AGE_H = 48;
export const MAX_BLIPS = 400;
export const FRESH_MIN = 60;
export const KIND_ORDER = ['launch', 'funding', 'news', 'accelerator'];
export const REGION_ORDER = ['usa', 'europe', 'asia', 'india', 'latam', 'africa', 'global'];
export const CAPTION_RAY = 270;
export const CAPTION_CLEAR = 17; // plate half-height 10 + open blip 5.5 + air
export const LINE_CLEAR = 4.5; // 1 px line + 3.5 px blip + air
export const SPREAD = [0.1, 0.9]; // the part of its sub-wedge a blip may occupy
const MIN_SECTOR_DEG = 14; // 2 degrees per region slot at the very centre (r < 20 px)
const DEG = 180 / Math.PI;
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

/** Degrees off a line through the centre that put a point at radius r `px` away from it. */
const clearanceDeg = (px, r) => Math.asin(Math.min(1, px / Math.max(r, 1e-9))) * DEG;

/** [start, end] of a kind's sector at radius r: its quadrant minus the clearances (the caption channel at 270). */
export function sectorSpan(kind, r = RADIUS) {
  let k = KIND_ORDER.indexOf(kind);
  if (k < 0) k = 2;
  const q0 = k * 90;
  const q1 = q0 + 90;
  const line = clearanceDeg(LINE_CLEAR, r);
  const channel = Math.min(clearanceDeg(CAPTION_CLEAR, r), 90 - line - MIN_SECTOR_DEG);
  return [q0 + (q0 === CAPTION_RAY ? channel : line), q1 - (q1 === CAPTION_RAY ? channel : line)];
}

/** [start, end] of the region sub-wedge inside the sector at radius r; unknown regions -> global. */
export function slotSpan(kind, region, r = RADIUS) {
  let i = REGION_ORDER.indexOf(region);
  if (i < 0) i = REGION_ORDER.length - 1;
  const [a, b] = sectorSpan(kind, r);
  const w = (b - a) / REGION_ORDER.length;
  return [a + i * w, a + (i + 1) * w];
}

/** Deterministic fraction in [0, 1) from the item key (FNV-1a + avalanche); never Math.random, so renders are stable. */
export function spreadFraction(key) {
  const s = String(key ?? '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Blip angle in degrees: sub-wedge start + (0.1 + 0.8 * fraction) of its width. */
export function blipAngle(kind, region, key, r = RADIUS) {
  const [s0, s1] = slotSpan(kind, region, r);
  return s0 + (SPREAD[0] + (SPREAD[1] - SPREAD[0]) * spreadFraction(key)) * (s1 - s0);
}

/** R * (0.10 + 0.90 * clamp(age / 48, 0, 1)); future dates clamp to 0.10R. */
export function radiusFor(ageH, R = RADIUS) {
  const f = Number.isNaN(ageH) ? 0 : Math.min(1, Math.max(0, ageH / MAX_AGE_H));
  return R * (0.10 + 0.90 * f);
}

/** { x, y, r, angle, key } for one item. */
export function blipPosition(item, now = Date.now(), R = RADIUS) {
  const key = itemKey(item?.url);
  const r = radiusFor(ageHours(item, now), R);
  const angle = blipAngle(item?.kind, item?.region, key, r);
  const rad = angle / DEG;
  return { x: CENTER + r * Math.sin(rad), y: CENTER - r * Math.cos(rad), r, angle, key };
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
    const pos = blipPosition(item, now);
    const { key } = pos;
    lookup.set(key, item);
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
