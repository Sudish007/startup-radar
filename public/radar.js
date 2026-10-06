// Startup Radar live radar: pure geometry (DOM-free, unit-tested) + SVG renderer + tooltip. Angle = kind quadrant
// (launch, funding, news, accelerator clockwise from 12) + sqrt-sized region sub-wedge, hash-spread; radius = 0.10R
// (now) .. 0.55R (24 h) .. R (48 h) +/- 2 px jitter; newest 400 drawn; captions on the 9 o'clock channel.

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
export const LINE_CLEAR = 4.5; // 1 px line + 3 px blip + air
export const MIN_SLOT_DEG = 6; // floor of a non-empty region sub-wedge (equal shares when the floors do not fit)
export const MAJORITY_DEG = 45; // floor of a bucket holding at least half of its sector's items (what the other floors leave, at most)
export const SLOT_PAD_DEG = 1.5; // inner padding of a sub-wedge, capped at a quarter of its width
export const RADIAL_JITTER = 2; // +/- px off the age radius, clamped to [0.10R, R]
export const MIN_GAP = 0.5; // px between any two blip centres after de-stacking (as rendered, cx/cy rounded to 0.01)
const MIN_SECTOR_DEG = 14; // 2 degrees per region slot at the very centre (r < 20 px)
const DEG = 180 / Math.PI;
const VIEWBOX = 360;
const PAD_X = 4;
const PAD_Y = 2;
const SVG_NS = 'http://www.w3.org/2000/svg';
const itemsBySvg = new WeakMap();

const kindIndex = (kind) => { const k = KIND_ORDER.indexOf(kind); return k < 0 ? 2 : k; };
const regionIndex = (region) => { const i = REGION_ORDER.indexOf(region); return i < 0 ? REGION_ORDER.length - 1 : i; };

/** Age in hours at `now` (negative for future dates, NaN when unparsable). */
export function ageHours(item, now = Date.now()) {
  const t = Date.parse(item?.publishedAt);
  return Number.isNaN(t) ? NaN : (now - t) / 3_600_000;
}

/** Degrees off a line through the centre that put a point at radius r `px` away from it. */
const clearanceDeg = (px, r) => Math.asin(Math.min(1, px / Math.max(r, 1e-9))) * DEG;

/** [start, end] of a kind's sector at radius r: its quadrant minus the clearances (the caption channel at 270). */
export function sectorSpan(kind, r = RADIUS) {
  const q0 = kindIndex(kind) * 90;
  const q1 = q0 + 90;
  const line = clearanceDeg(LINE_CLEAR, r);
  const channel = Math.min(clearanceDeg(CAPTION_CLEAR, r), 90 - line - MIN_SECTOR_DEG);
  return [q0 + (q0 === CAPTION_RAY ? channel : line), q1 - (q1 === CAPTION_RAY ? channel : line)];
}

/** Sub-wedge widths (deg) per region, summing to `width`: sqrt(count) shares, >= minDeg when non-empty, 0 when empty,
 * >= MAJORITY_DEG for a bucket with at least half of the items; equal shares when the floors do not fit (the centre). */
export function allocateSlots(counts, width, minDeg = MIN_SLOT_DEG) {
  const out = counts.map(() => 0);
  let free = counts.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
  if (!free.length) return out;
  const equal = free.length * minDeg >= width;
  const weight = (i) => (equal ? 1 : Math.sqrt(counts[i]));
  const total = free.reduce((s, i) => s + counts[i], 0);
  const top = free.reduce((a, i) => (counts[i] > counts[a] ? i : a), free[0]);
  const majority = Math.max(minDeg, Math.min(MAJORITY_DEG, width - (free.length - 1) * minDeg));
  const floor = (i) => (i === top && counts[i] * 2 >= total ? majority : minDeg);
  let rest = width;
  while (!equal) {
    const sum = free.reduce((s, i) => s + weight(i), 0);
    const starved = free.filter((i) => (weight(i) / sum) * rest < floor(i));
    if (!starved.length || starved.length === free.length) break;
    for (const i of starved) { out[i] = floor(i); rest -= floor(i); }
    free = free.filter((i) => !starved.includes(i));
  }
  const sum = free.reduce((s, i) => s + weight(i), 0);
  for (const i of free) out[i] = (weight(i) / sum) * rest;
  out[free[0]] += width - out.reduce((s, w) => s + w, 0); // floating-point drift goes to one proportional slot
  return out;
}

/** [start, end] per region (REGION_ORDER) inside the kind sector at radius r for the bucket sizes `counts`. */
export function slotSpans(kind, counts, r = RADIUS) {
  const [a, b] = sectorSpan(kind, r);
  let at = a;
  return allocateSlots(counts, b - a).map((w) => [at, (at += w)]);
}

/** Bucket sizes of a lone item: its region takes the whole sector. */
const lone = (region) => REGION_ORDER.map((_, i) => (i === regionIndex(region) ? 1 : 0));

/** [start, end] of the region sub-wedge at radius r; unknown regions -> global; without `counts` the item is alone. */
export function slotSpan(kind, region, r = RADIUS, counts = lone(region)) {
  return slotSpans(kind, counts, r)[regionIndex(region)];
}

/** The sub-wedge minus SLOT_PAD_DEG on both sides (at most a quarter of its width each). */
const padded = (kind, region, r, counts) => {
  const [s0, s1] = slotSpan(kind, region, r, counts);
  const pad = Math.min(SLOT_PAD_DEG, (s1 - s0) / 4);
  return [s0 + pad, s1 - pad];
};

/** Deterministic fraction in [0, 1) from the item key (FNV-1a + avalanche); never Math.random, so renders are stable. */
export function spreadFraction(key) {
  const s = String(key ?? '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Deterministic radial offset in (-RADIAL_JITTER, RADIAL_JITTER) px from the item key (a salted spreadFraction). */
export function radialJitter(key) {
  return (2 * spreadFraction(`${key}|r`) - 1) * RADIAL_JITTER;
}

/** Blip angle in degrees: the hash-chosen point of its padded sub-wedge. */
export function blipAngle(kind, region, key, r = RADIUS, counts) {
  const [lo, hi] = padded(kind, region, r, counts);
  return lo + (hi - lo) * spreadFraction(key);
}

/** R * (0.10 + 0.90 * clamp(age / 48, 0, 1)); future dates clamp to 0.10R. */
export function radiusFor(ageH, R = RADIUS) {
  const f = Number.isNaN(ageH) ? 0 : Math.min(1, Math.max(0, ageH / MAX_AGE_H));
  return R * (0.10 + 0.90 * f);
}

const place = (b) => {
  const rad = b.angle / DEG;
  b.x = CENTER + b.r * Math.sin(rad);
  b.y = CENTER - b.r * Math.cos(rad);
  return b;
};

/** { x, y, r, angle, lo, hi, key } for one item; `counts` = its kind's bucket sizes per region (default: alone). */
export function blipPosition(item, now = Date.now(), R = RADIUS, counts) {
  const key = itemKey(item?.url);
  const r = Math.min(R, Math.max(0.1 * R, radiusFor(ageHours(item, now), R) + radialJitter(key)));
  const [lo, hi] = padded(item?.kind, item?.region, r, counts);
  return place({ key, r, angle: lo + (hi - lo) * spreadFraction(key), lo, hi });
}

/** Blip radius and fill-opacity for a bucket of `count` items: dense buckets read as density, not as a solid shape. */
export function blipStyle(count) {
  return count > 60 ? { blipR: 2, opacity: 0.6 } : count > 20 ? { blipR: 2.5, opacity: 0.75 } : { blipR: 3, opacity: 0.9 };
}

/** Bucket sizes of the drawn items: Map kind -> number[REGION_ORDER.length]. */
export function bucketCounts(items) {
  const m = new Map();
  for (const it of items) {
    const kind = KIND_ORDER[kindIndex(it?.kind)];
    if (!m.has(kind)) m.set(kind, REGION_ORDER.map(() => 0));
    m.get(kind)[regionIndex(it?.region)] += 1;
  }
  return m;
}

/** Positions + styles per drawn item (pure): bucket-sized sub-wedges, then de-stacking in key order - a blip within
 * MIN_GAP px of an earlier one steps (alternating sides, <= 32 tries) 1 px along its ring / 0.5 px off its radius. */
export function layoutRadar(drawn, now = Date.now()) {
  const buckets = bucketCounts(drawn);
  const blips = drawn.map((item) => {
    const counts = buckets.get(KIND_ORDER[kindIndex(item?.kind)]);
    return Object.assign(blipPosition(item, now, RADIUS, counts), blipStyle(counts[regionIndex(item?.region)]), { item, counts });
  });
  const done = [];
  for (const b of [...blips].sort((p, q) => (p.key < q.key ? -1 : 1))) {
    const { r: r0, angle: a0, lo: lo0, hi: hi0 } = b;
    const base = radiusFor(ageHours(b.item, now));
    for (let s = 1; s <= 32 && done.some((o) => Math.hypot(o.x - b.x, o.y - b.y) < MIN_GAP + 0.02); s += 1) {
      const k = ((s + 3) >> 2) * (s & 1 ? 1 : -1); // +1, -1 (angular), +1, -1 (radial), +2, -2, +2, -2, ...
      const radial = (s - 1) & 2;
      b.r = radial ? Math.min(RADIUS, base + RADIAL_JITTER, Math.max(0.1 * RADIUS, base - RADIAL_JITTER, r0 + k / 2)) : r0;
      [b.lo, b.hi] = radial ? padded(b.item?.kind, b.item?.region, b.r, b.counts) : [lo0, hi0];
      b.angle = Math.min(b.hi, Math.max(b.lo, radial ? a0 : a0 + k * (DEG / r0)));
      place(b);
    }
    done.push(b);
    delete b.item;
    delete b.counts;
  }
  return blips;
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
  const blips = layoutRadar(drawn, now);
  const byKey = new Map();
  for (const c of group.querySelectorAll('circle.blip')) byKey.set(c.dataset.key, c);
  const lookup = new Map();
  drawn.forEach((item, i) => {
    const pos = blips[i];
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
    circle.setAttribute('r', open ? '5' : String(pos.blipR));
    // --accent-fill (= --accent when dark) stays >= 3:1 on white at the 0.75 pulse trough
    circle.setAttribute('fill', open ? 'var(--accent-fill)' : `var(--region-${REGION_ORDER[regionIndex(item.region)]})`);
    circle.setAttribute('fill-opacity', open ? '1' : String(pos.opacity)); // styles.css restores 1 on :hover
    circle.setAttribute('stroke', open ? 'var(--fg-0)' : 'transparent');
    circle.setAttribute('stroke-width', open ? '1' : String(16 - 2 * pos.blipR)); // transparent stroke pads the pointer target to 16 px
  });
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
