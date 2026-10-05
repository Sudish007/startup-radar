import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CENTER,
  RADIUS,
  MAX_BLIPS,
  KIND_ORDER,
  REGION_ORDER,
  CAPTION_RAY,
  CAPTION_CLEAR,
  LINE_CLEAR,
  MIN_SLOT_DEG,
  MAJORITY_DEG,
  SLOT_PAD_DEG,
  RADIAL_JITTER,
  MIN_GAP,
  ageHours,
  sectorSpan,
  allocateSlots,
  slotSpans,
  slotSpan,
  spreadFraction,
  radialJitter,
  blipAngle,
  radiusFor,
  blipPosition,
  blipStyle,
  bucketCounts,
  layoutRadar,
  radarItems,
  radarCount,
} from '../public/radar.js';
import { itemKey } from '../public/filter.js';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const R = RADIUS;
// The three ring-caption plates of public/index.html (x, y, width, height) on the 270 degree ray: "now", "24 h", "48 h".
const CAPTION_PLATES = [[133.6, 170.2, 31.4, 19.6], [58.3, 170.2, 39.2, 19.6], [2, 170.2, 39.2, 19.6]];
const LIVE_LAUNCH = [0, 2, 1, 1, 0, 0, 261]; // the live launch sector on 2026-10-05: Show HN dominates
const MIXED = [12, 3, 0, 40, 1, 0, 7];

function hoursAgo(h) {
  return new Date(NOW - h * 3_600_000).toISOString();
}

function item(id, overrides = {}) {
  return {
    id,
    title: `Item ${id}`,
    url: `https://example.test/${id}`,
    source: { id: 'hn_show', name: 'HN Show' },
    kind: 'launch',
    region: 'usa',
    publishedAt: hoursAgo(1),
    extra: {},
    ...overrides,
  };
}

const dist = (p) => Math.hypot(p.x - CENTER, p.y - CENTER);
const quadrant = (angle) => Math.floor((((angle % 360) + 360) % 360) / 90);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
/** Distance from a point to the nearest point of a rect [x, y, w, h]. */
const rectDistance = (p, [x, y, w, h]) => Math.hypot(p.x - Math.max(x, Math.min(p.x, x + w)), p.y - Math.max(y, Math.min(p.y, y + h)));
const everyPair = (fn) => { for (const kind of KIND_ORDER) for (const region of REGION_ORDER) fn(kind, region); };
const paddedSpan = ([s0, s1]) => { const pad = Math.min(SLOT_PAD_DEG, (s1 - s0) / 4); return [s0 + pad, s1 - pad]; };
/** Pairs of blips closer than `gap` px. */
function closePairs(blips, gap = MIN_GAP) {
  const out = [];
  for (let i = 0; i < blips.length; i += 1) for (let j = i + 1; j < blips.length; j += 1) if (Math.hypot(blips[i].x - blips[j].x, blips[i].y - blips[j].y) < gap) out.push([blips[i].key, blips[j].key]);
  return out;
}
/** `n` items of one (kind, region), ids `${prefix}-i`, ages from `age(i)` hours. */
const bucket = (prefix, n, kind, region, age) => Array.from({ length: n }, (_, i) => item(`${prefix}-${i}`, { kind, region, publishedAt: hoursAgo(age(i)) }));

describe('sectors and the sub-wedge allocation', () => {
  test('quadrant per kind at every age; unknown kinds -> news, unknown regions -> global', () => {
    const expected = { launch: 0, funding: 1, news: 2, accelerator: 3 };
    for (const age of [0, 0.5, 2, 10, 24, 40, 48]) {
      everyPair((kind, region) => {
        const p = blipPosition(item(`${kind}-${region}-${age}`, { kind, region, publishedAt: hoursAgo(age) }), NOW);
        assert.equal(quadrant(p.angle), expected[kind], `${kind}/${region} at ${age} h -> ${p.angle}`);
      });
    }
    assert.deepEqual(sectorSpan('bogus', R), sectorSpan('news', R));
    assert.deepEqual(slotSpan('launch', 'mars', R), slotSpan('launch', 'global', R));
    assert.deepEqual(slotSpan('launch', 'mars', R, MIXED), slotSpan('launch', 'global', R, MIXED));
    assert.equal(quadrant(blipAngle('bogus', 'usa', 'k', R)), 2);
  });

  test('allocateSlots: widths sum exactly to the sector width, empty regions get 0, non-empty ones >= 6 degrees', () => {
    for (const width of [86.56, 81.78, 64, 48.1, 43]) {
      for (const counts of [LIVE_LAUNCH, MIXED, [1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 400], [5, 0, 0, 0, 0, 0, 0], [0, 100, 0, 0, 100, 0, 0]]) {
        const w = allocateSlots(counts, width);
        assert.equal(w.length, REGION_ORDER.length);
        assert.ok(Math.abs(sum(w) - width) < 1e-9, `${counts} @ ${width}: widths ${w} sum to ${sum(w)}`);
        counts.forEach((c, i) => {
          if (c === 0) assert.equal(w[i], 0, `${counts} @ ${width}: empty region ${REGION_ORDER[i]} has width ${w[i]}`);
          else assert.ok(w[i] >= MIN_SLOT_DEG - 1e-9, `${counts} @ ${width}: ${REGION_ORDER[i]} (${c} items) only ${w[i]} deg`);
        });
      }
    }
    assert.equal(MIN_SLOT_DEG, 6);
    assert.deepEqual(allocateSlots([0, 0, 0, 0, 0, 0, 0], 86.56), [0, 0, 0, 0, 0, 0, 0], 'an empty sector allocates nothing');
    assert.deepEqual(allocateSlots([0, 0, 0, 7, 0, 0, 0], 86.56), [0, 0, 0, 86.56, 0, 0, 0], 'a lone region takes the whole sector');
  });

  test('allocateSlots: sqrt(count) weighting (ordering, exact ratio when no floor binds) and the live launch sector >= 45 degrees', () => {
    const w = allocateSlots(MIXED, 86.56);
    const order = MIXED.map((c, i) => [c, w[i]]).filter(([c]) => c > 0).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < order.length; i += 1) assert.ok(order[i][1] >= order[i - 1][1] - 1e-9, `more items never means a narrower slot: ${JSON.stringify(order)}`);
    // 4 and 16 items with no floor binding: widths in the ratio sqrt(4) : sqrt(16) = 1 : 2
    const two = allocateSlots([4, 0, 0, 0, 0, 0, 16], 90);
    assert.ok(Math.abs(two[6] / two[0] - 2) < 1e-9, `${two}`);
    assert.ok(Math.abs(two[0] - 30) < 1e-9 && Math.abs(two[6] - 60) < 1e-9);
    // sqrt, not linear: 1 vs 100 items gives 1 : 10, so the small region keeps 10 % (not 1 %)
    const skew = allocateSlots([1, 0, 0, 0, 0, 0, 100], 88);
    assert.ok(Math.abs(skew[6] / skew[0] - 10) < 1e-9, `${skew}`);
    // the live data: 261 of 265 launch items are global -> about 68.5 of the 86.56 degree sector, the three small regions at the floor
    const [a, b] = sectorSpan('launch', R);
    const live = allocateSlots(LIVE_LAUNCH, b - a);
    assert.ok(live[6] >= 45, `global gets ${live[6]} deg`);
    assert.ok(live[6] > 68 && live[6] < 69, `global gets ${live[6]} deg`);
    assert.ok(Math.abs(live[2] - 6) < 1e-9 && Math.abs(live[3] - 6) < 1e-9, `asia/india at the floor: ${live}`);
    assert.ok(live[1] >= 6 && live[1] < 6.1, `europe just above the floor: ${live[1]}`);
  });

  test('allocateSlots: a bucket holding at least half of its sector gets >= 45 degrees (as far as the other floors allow); below half the sqrt share stands', () => {
    assert.equal(MAJORITY_DEG, 45);
    // the live news sector: india 26 of 38 -> sqrt alone would give 35.5 deg; the majority floor lifts it to 45 and the rest re-shares
    const news = [2, 5, 1, 26, 0, 3, 1];
    const [a, b] = sectorSpan('news', R);
    const w = allocateSlots(news, b - a);
    assert.ok(Math.abs(w[3] - 45) < 1e-9, `${w}`);
    assert.ok(Math.abs(sum(w) - (b - a)) < 1e-9);
    news.forEach((c, i) => { if (c > 0) assert.ok(w[i] >= 6 - 1e-9, `${w}`); });
    assert.ok(w[1] > w[5] && w[5] > w[0] && w[0] >= w[2], `sqrt order kept among the others: ${w}`);
    // exactly half counts as a majority; 20 of 41 does not (its sqrt share, 35.8 deg, stands)
    assert.ok(Math.abs(allocateSlots([10, 10, 0, 0, 0, 0, 20], 86.56)[6] - 45) < 1e-9);
    const below = allocateSlots([10, 11, 0, 0, 0, 0, 20], 86.56);
    assert.ok(below[6] < 45 && below[6] > 35, `${below}`);
    // a narrow sector: 45 cannot fit next to the other floors, so the majority gets what is left (width - 6 per other region)
    assert.deepEqual(allocateSlots([1, 0, 0, 0, 0, 0, 50], 30).map((x) => +x.toFixed(9)), [6, 0, 0, 0, 0, 0, 24]);
    assert.deepEqual(allocateSlots([1, 1, 0, 0, 0, 0, 2], 19).map((x) => +x.toFixed(9)), [6, 6, 0, 0, 0, 0, 7]);
    // already wider than 45 by weight: unchanged
    assert.ok(allocateSlots(LIVE_LAUNCH, 86.56)[6] > 68);
  });

  test('allocateSlots: the floor cascades (fixing one starved region never starves another below 6) and equal shares when the floors cannot fit', () => {
    const w = allocateSlots([1, 1, 1, 1, 1, 1, 200], 50);
    for (let i = 0; i < 6; i += 1) assert.ok(Math.abs(w[i] - 6) < 1e-9, `${w}`);
    assert.ok(Math.abs(w[6] - 14) < 1e-9, `${w}`);
    // 7 non-empty regions in a 14 degree sector (the very centre): 7 x 6 does not fit -> 2 degrees each, still summing to 14
    const tight = allocateSlots([1, 2, 3, 4, 5, 6, 700], 14);
    for (const x of tight) assert.ok(Math.abs(x - 2) < 1e-9, `${tight}`);
    assert.ok(Math.abs(sum(tight) - 14) < 1e-9);
    const three = allocateSlots([9, 0, 0, 0, 0, 1, 1], 17);
    assert.ok(Math.abs(sum(three) - 17) < 1e-9 && three.filter((x) => x > 0).length === 3, `${three}`);
  });

  test('allocateSlots is deterministic and does not mutate its input', () => {
    const counts = [...MIXED];
    const a = allocateSlots(counts, 86.56);
    const b = allocateSlots(counts, 86.56);
    assert.deepEqual(a, b);
    assert.deepEqual(counts, MIXED);
    assert.deepEqual(allocateSlots(LIVE_LAUNCH, 64), allocateSlots([...LIVE_LAUNCH], 64));
  });

  test('slotSpans: region sub-wedges keep REGION_ORDER, are contiguous and fill the sector exactly at every radius', () => {
    for (const r of [15, 20, 46, 82.5, 120, 150]) {
      for (const kind of KIND_ORDER) {
        const [a, b] = sectorSpan(kind, r);
        const k = KIND_ORDER.indexOf(kind);
        assert.ok(a > k * 90 && b < (k + 1) * 90 && b > a, `${kind} sector ${a}-${b} inside its quadrant at r=${r}`);
        for (const counts of [[1, 1, 1, 1, 1, 1, 1], LIVE_LAUNCH, MIXED]) {
          const spans = slotSpans(kind, counts, r);
          assert.equal(spans.length, REGION_ORDER.length);
          let prevEnd = a;
          spans.forEach(([s0, s1], i) => {
            assert.ok(Math.abs(s0 - prevEnd) < 1e-9 && s1 >= s0, `${kind}/${REGION_ORDER[i]} follows the previous slot at r=${r}`);
            if (counts[i] === 0) assert.ok(Math.abs(s1 - s0) < 1e-9, 'empty region: zero width');
            assert.deepEqual(slotSpan(kind, REGION_ORDER[i], r, counts), [s0, s1]);
            prevEnd = s1;
          });
          assert.ok(Math.abs(prevEnd - b) < 1e-9, `${kind}: the last slot ends at the sector end`);
        }
      }
    }
  });

  test('blips keep LINE_CLEAR px off the crosshairs (CAPTION_CLEAR off the caption half) and never straddle a sector boundary', () => {
    for (const age of [0, 0.2, 1, 3, 8, 16, 24, 36, 48]) {
      everyPair((kind, region) => {
        for (let i = 0; i < 20; i += 1) {
          const p = blipPosition(item(`${kind}-${region}-${age}-${i}`, { kind, region, publishedAt: hoursAgo(age) }), NOW);
          const toVertical = Math.abs(p.x - CENTER);
          const toHorizontal = Math.abs(p.y - CENTER);
          assert.ok(toVertical >= LINE_CLEAR - 1e-6, `${kind}/${region} ${age} h: ${toVertical} px from the vertical line`);
          assert.ok(toHorizontal >= LINE_CLEAR - 1e-6, `${kind}/${region} ${age} h: ${toHorizontal} px from the horizontal line`);
          // left half = the caption channel: the full clearance from r = 20 px on (below that the sector floor of 2 deg/slot wins)
          if (p.x < CENTER && p.r >= 20) assert.ok(toHorizontal >= CAPTION_CLEAR - 1e-6, `${kind}/${region} ${age} h: ${toHorizontal} px from the caption ray`);
        }
      });
    }
  });

  test('the caption channel: no blip disc (open blip r=5.5 included) ever touches a ring-caption plate, alone or in a dense de-stacked layout', () => {
    let minDistance = Infinity;
    for (let i = 0; i < 400; i += 1) {
      const age = (i / 399) * 48;
      everyPair((kind, region) => {
        const p = blipPosition(item(`${kind}/${region}/${i}`, { kind, region, publishedAt: hoursAgo(age) }), NOW);
        for (const plate of CAPTION_PLATES) minDistance = Math.min(minDistance, rectDistance(p, plate));
      });
    }
    assert.ok(minDistance > 5.5, `closest lone blip centre is ${minDistance} px from a caption plate`);
    // 200 news/global + 200 accelerator/usa hug the caption ray from both sides; the de-stacking must stay inside the padded sub-wedges
    const dense = [...bucket('n', 200, 'news', 'global', (i) => (i / 199) * 48), ...bucket('a', 200, 'accelerator', 'usa', (i) => (i / 199) * 48)];
    const blips = layoutRadar(radarItems(dense, NOW), NOW);
    assert.equal(blips.length, 400);
    let minDense = Infinity;
    for (const p of blips) {
      for (const plate of CAPTION_PLATES) minDense = Math.min(minDense, rectDistance(p, plate));
      if (p.r >= 20) assert.ok(Math.abs(p.y - CENTER) >= CAPTION_CLEAR - 1e-6, `${p.key}: ${Math.abs(p.y - CENTER)} px from the caption ray`);
      assert.ok(Math.abs(p.x - CENTER) >= LINE_CLEAR - 1e-6 && Math.abs(p.y - CENTER) >= LINE_CLEAR - 1e-6, `${p.key} too close to a crosshair line`);
    }
    assert.ok(minDense > 5.5, `closest dense blip centre is ${minDense} px from a caption plate`);
    assert.equal(closePairs(blips).length, 0, 'de-stacked');
    assert.equal(CAPTION_RAY, 270);
    assert.ok(CAPTION_CLEAR >= 10 + 5.5, 'clearance covers the plate half-height plus the open-blip radius');
  });
});

describe('deterministic spread and jitter', () => {
  test('spreadFraction is in [0, 1), stable for the same key and varied across keys', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) {
      const f = spreadFraction(`key${i}`);
      assert.ok(f >= 0 && f < 1, `fraction ${f}`);
      seen.add(f.toFixed(3));
    }
    // 500 uniform draws into 1000 bins leave ~393 distinct values; sequential keys must not cluster below that
    assert.ok(seen.size > 350, `spreads coincident items (${seen.size} distinct of 500 at 3 decimals)`);
    assert.equal(spreadFraction('abc'), spreadFraction('abc'));
    assert.notEqual(spreadFraction('abc'), spreadFraction('abd'));
    assert.equal(spreadFraction(undefined), spreadFraction(''));
  });

  test('radialJitter: same key -> same offset, within +/- 2 px, independent of the angular hash, varied across keys', () => {
    assert.equal(RADIAL_JITTER, 2);
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) {
      const j = radialJitter(`key${i}`);
      assert.ok(j > -RADIAL_JITTER && j < RADIAL_JITTER, `offset ${j}`);
      assert.equal(j, radialJitter(`key${i}`));
      seen.add(j.toFixed(2));
    }
    // 500 uniform draws into 400 bins (4 px at 0.01) leave ~285 distinct values
    assert.ok(seen.size > 250, `${seen.size} distinct offsets of 500`);
    // not a function of the angular fraction: keys with near-equal spread fractions do not share a radial offset
    const pairs = [];
    for (let i = 0; i < 2000; i += 1) pairs.push([spreadFraction(`k${i}`), radialJitter(`k${i}`), `k${i}`]);
    pairs.sort((a, b) => a[0] - b[0]);
    let same = 0;
    for (let i = 1; i < pairs.length; i += 1) if (Math.abs(pairs[i][1] - pairs[i - 1][1]) < 0.01) same += 1;
    assert.ok(same < 40, `${same} of 1999 neighbours in angle share a radial offset`);
  });

  test('blipAngle stays inside the padded sub-wedge (1.5 deg, at most a quarter of the width) for lone and bucketed items, same key -> same angle', () => {
    assert.equal(SLOT_PAD_DEG, 1.5);
    for (const r of [15, 40, 82.5, 150]) {
      everyPair((kind, region) => {
        for (const counts of [undefined, MIXED, LIVE_LAUNCH, [1, 1, 1, 1, 1, 1, 1]]) {
          if (counts && counts[REGION_ORDER.indexOf(region)] === 0) continue;
          const span = slotSpan(kind, region, r, counts);
          const [lo, hi] = paddedSpan(span);
          const pad = lo - span[0];
          assert.ok(pad > 0 && pad <= SLOT_PAD_DEG + 1e-9 && Math.abs(pad - Math.min(SLOT_PAD_DEG, (span[1] - span[0]) / 4)) < 1e-9, `pad ${pad} for a ${span[1] - span[0]} deg slot`);
          for (let i = 0; i < 50; i += 1) {
            const a = blipAngle(kind, region, `k${i}`, r, counts);
            assert.ok(a >= lo - 1e-9 && a <= hi + 1e-9, `${kind}/${region} r=${r} counts=${counts}: ${a} outside [${lo}, ${hi}]`);
          }
          assert.equal(blipAngle(kind, region, 'same', r, counts), blipAngle(kind, region, 'same', r, counts));
        }
      });
    }
    // the padding is measured from the sub-wedge edges, so sector clearances and the padding add up
    const [s0] = slotSpan('launch', 'usa', R, [5, 0, 0, 0, 0, 0, 100]);
    assert.ok(Math.abs(s0 - sectorSpan('launch', R)[0]) < 1e-9);
    assert.ok(blipAngle('launch', 'usa', 'k', R, [5, 0, 0, 0, 0, 0, 100]) >= s0 + 1.5 - 1e-9);
  });

  test('blipPosition: radius = age radius + the key jitter, clamped to the rings; the angle is computed at the drawn radius', () => {
    for (const age of [0, 0.01, 1, 24, 47.9, 48, 60]) {
      for (let i = 0; i < 30; i += 1) {
        const it = item(`j-${age}-${i}`, { publishedAt: hoursAgo(age) });
        const p = blipPosition(it, NOW);
        const expected = Math.min(R, Math.max(0.1 * R, radiusFor(age) + radialJitter(itemKey(it.url))));
        assert.ok(Math.abs(p.r - expected) < 1e-9, `${age} h: r ${p.r} vs ${expected}`);
        assert.ok(Math.abs(dist(p) - p.r) < 1e-6);
        assert.ok(p.r >= 0.1 * R - 1e-9 && p.r <= R + 1e-9, `${p.r} inside the rings`);
        assert.ok(Math.abs(p.r - radiusFor(age)) <= RADIAL_JITTER + 1e-9, 'never more than 2 px off the age radius');
        assert.equal(p.angle, blipAngle(it.kind, it.region, p.key, p.r));
      }
    }
  });

  test('150 identical launch/global items (same timestamp) fan out: >= 100 distinct angles inside their slot, no two blips within 0.5 px', () => {
    const items = bucket('show-hn', 150, 'launch', 'global', () => 30);
    const drawn = radarItems(items, NOW);
    const blips = layoutRadar(drawn, NOW);
    assert.equal(blips.length, 150);
    const angles = new Set(blips.map((p) => p.angle.toFixed(2)));
    assert.ok(angles.size >= 100, `${angles.size} distinct angles out of 150`);
    const counts = bucketCounts(drawn).get('launch');
    assert.deepEqual(counts, [0, 0, 0, 0, 0, 0, 150]);
    for (const p of blips) {
      const [lo, hi] = paddedSpan(slotSpan('launch', 'global', p.r, counts));
      assert.ok(p.angle >= lo - 1e-9 && p.angle <= hi + 1e-9, `${p.angle} outside [${lo}, ${hi}]`);
      assert.ok(Math.abs(p.r - radiusFor(30)) <= RADIAL_JITTER + 1e-9);
    }
    assert.equal(MIN_GAP, 0.5);
    assert.deepEqual(closePairs(blips), [], 'no two blips share a centre to within 0.5 px');
    // the de-stacking is deterministic and keeps the item order
    const again = layoutRadar(radarItems(items, NOW), NOW);
    assert.deepEqual(again.map((p) => [p.x, p.y]), blips.map((p) => [p.x, p.y]));
    blips.forEach((p, i) => assert.equal(p.key, itemKey(drawn[i].url)));
  });

  test('blipPosition is a pure function of the item (same url -> same point) and carries the item key', () => {
    const a = blipPosition(item(1, { url: 'https://acme.test/x' }), NOW);
    const b = blipPosition(item(2, { url: 'https://acme.test/x', title: 'other build, other id' }), NOW);
    assert.deepEqual(a, b);
    assert.equal(a.key, itemKey('https://acme.test/x'));
    // clockwise-from-12 convention: age 0, launch quadrant -> upper right
    const p = blipPosition(item(1, { kind: 'launch', region: 'usa', publishedAt: hoursAgo(0) }), NOW);
    assert.ok(p.x > CENTER && p.y < CENTER);
  });
});

describe('density: bucket sizes, blip style, layout', () => {
  test('bucketCounts: one number[7] per kind in REGION_ORDER; unknown kinds -> news, unknown regions -> global', () => {
    const items = [
      ...bucket('g', 5, 'launch', 'global', () => 1),
      ...bucket('u', 2, 'launch', 'usa', () => 1),
      item('n1', { kind: 'news', region: 'india' }),
      item('x1', { kind: 'bogus', region: 'mars' }),
    ];
    const b = bucketCounts(items);
    assert.deepEqual([...b.keys()].sort(), ['launch', 'news']);
    assert.deepEqual(b.get('launch'), [2, 0, 0, 0, 0, 0, 5]);
    assert.deepEqual(b.get('news'), [0, 0, 0, 1, 0, 0, 1]);
    assert.equal(bucketCounts([]).size, 0);
  });

  test('blipStyle: 3 px / 0.9 up to 20 items, 2.5 px / 0.75 up to 60, 2 px / 0.6 above', () => {
    assert.deepEqual(blipStyle(1), { blipR: 3, opacity: 0.9 });
    assert.deepEqual(blipStyle(20), { blipR: 3, opacity: 0.9 });
    assert.deepEqual(blipStyle(21), { blipR: 2.5, opacity: 0.75 });
    assert.deepEqual(blipStyle(60), { blipR: 2.5, opacity: 0.75 });
    assert.deepEqual(blipStyle(61), { blipR: 2, opacity: 0.6 });
    assert.deepEqual(blipStyle(400), { blipR: 2, opacity: 0.6 });
  });

  test('layoutRadar: live-like mix -> global launches get >= 45 degrees and the dense style, small buckets keep 3 px blips, every sector with items renders', () => {
    const items = [
      ...bucket('hn', 261, 'launch', 'global', (i) => (i / 260) * 47),
      ...bucket('le', 2, 'launch', 'europe', (i) => 5 + i),
      item('la', { kind: 'launch', region: 'asia', publishedAt: hoursAgo(9) }),
      item('li', { kind: 'launch', region: 'india', publishedAt: hoursAgo(10) }),
      ...bucket('ni', 24, 'news', 'india', (i) => i),
      ...bucket('fe', 2, 'funding', 'europe', (i) => 2 + i),
    ];
    const drawn = radarItems(items, NOW);
    const blips = layoutRadar(drawn, NOW);
    assert.equal(blips.length, 291);
    const hn = blips.filter((_, i) => drawn[i].region === 'global');
    const [a, b] = sectorSpan('launch', R);
    const widths = allocateSlots(bucketCounts(drawn).get('launch'), b - a);
    assert.ok(widths[6] >= 45, `global slot ${widths[6]} deg`);
    const angles = hn.map((p) => p.angle);
    assert.ok(Math.max(...angles) - Math.min(...angles) > 55, `fan spans ${Math.max(...angles) - Math.min(...angles)} deg`);
    for (const p of hn) assert.deepEqual([p.blipR, p.opacity], [2, 0.6]);
    for (const p of blips.filter((_, i) => drawn[i].kind === 'news')) assert.deepEqual([p.blipR, p.opacity], [2.5, 0.75]);
    for (const p of blips.filter((_, i) => drawn[i].kind === 'funding' || drawn[i].region === 'europe')) assert.deepEqual([p.blipR, p.opacity], [3, 0.9]);
    assert.deepEqual(closePairs(blips), []);
    for (const p of blips) assert.ok(p.r >= 15 - 1e-9 && p.r <= 150 + 1e-9 && quadrant(p.angle) === KIND_ORDER.indexOf(drawn[blips.indexOf(p)].kind));
    // no accelerator items at all: the accelerator sector allocates nothing and nothing is drawn there
    assert.equal(bucketCounts(drawn).has('accelerator'), false);
    assert.deepEqual(allocateSlots([0, 0, 0, 0, 0, 0, 0], sectorSpan('accelerator', R)[1] - sectorSpan('accelerator', R)[0]), [0, 0, 0, 0, 0, 0, 0]);
    assert.equal(blips.filter((p) => quadrant(p.angle) === 3).length, 0);
    assert.deepEqual(layoutRadar([], NOW), []);
  });

  test('layoutRadar: the de-stacking keeps every blip inside its padded sub-wedge and within the 2 px jitter budget of its age radius', () => {
    // 120 items with one timestamp: on the 24 h ring (129 px of arc) they all separate; at r = 20.6 px (6.8 px of arc)
    // they cannot all, and the invariants still hold
    for (const [age, mustSeparate] of [[24, true], [2, false]]) {
      const items = bucket(`same${age}`, 120, 'news', 'india', () => age);
      const drawn = radarItems(items, NOW);
      const counts = bucketCounts(drawn).get('news');
      const blips = layoutRadar(drawn, NOW);
      let moved = 0;
      blips.forEach((p, i) => {
        const raw = blipPosition(drawn[i], NOW, R, counts);
        assert.equal(p.key, raw.key);
        if (p.r !== raw.r || p.angle !== raw.angle) moved += 1;
        assert.ok(Math.abs(p.r - radiusFor(age)) <= RADIAL_JITTER + 1e-9, `${p.r} vs the age radius ${radiusFor(age)}`);
        assert.ok(p.r >= 0.1 * R - 1e-9 && p.r <= R + 1e-9);
        assert.ok(Math.abs(dist(p) - p.r) < 1e-6);
        const [lo, hi] = paddedSpan(slotSpan('news', 'india', p.r, counts));
        assert.ok(p.angle >= lo - 1e-9 && p.angle <= hi + 1e-9, `${p.angle} outside [${lo}, ${hi}] at r=${p.r}`);
        assert.ok(!('item' in p) && !('counts' in p), 'no item references leak out of the layout');
      });
      if (mustSeparate) {
        // as rendered: cx/cy are written with two decimals, so the gap must survive the rounding
        const rounded = blips.map((p) => ({ key: p.key, x: +p.x.toFixed(2), y: +p.y.toFixed(2) }));
        assert.deepEqual(closePairs(rounded), [], `${age} h: no two rendered blips within 0.5 px`);
        assert.ok(moved < 60, `${moved} of 120 blips nudged at ${age} h`);
      }
    }
  });
});

describe('radius', () => {
  test('radius 0.10R / 0.55R / R at 0 / 24 / 48 h (blips within the 2 px jitter, clamped to the rings)', () => {
    assert.ok(Math.abs(radiusFor(0) - 0.10 * R) < 1e-9);
    assert.ok(Math.abs(radiusFor(24) - 0.55 * R) < 1e-9);
    assert.ok(Math.abs(radiusFor(48) - R) < 1e-9);
    const d0 = dist(blipPosition(item(1, { publishedAt: hoursAgo(0) }), NOW));
    const d24 = dist(blipPosition(item(1, { publishedAt: hoursAgo(24) }), NOW));
    const d48 = dist(blipPosition(item(1, { publishedAt: hoursAgo(48) }), NOW));
    assert.ok(d0 >= 15 - 1e-6 && d0 <= 17 + 1e-6, `${d0}`);
    assert.ok(Math.abs(d24 - 82.5) <= 2 + 1e-6, `${d24}`);
    assert.ok(d48 >= 148 - 1e-6 && d48 <= 150 + 1e-6, `${d48}`);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(24) }), NOW, 100)) - 55) <= 2 + 1e-6, 'custom R');
    const r1 = dist(blipPosition(item(1, { publishedAt: hoursAgo(1) }), NOW));
    const r2 = dist(blipPosition(item(1, { publishedAt: hoursAgo(10) }), NOW));
    const r3 = dist(blipPosition(item(1, { publishedAt: hoursAgo(40) }), NOW));
    assert.ok(r1 < r2 && r2 < r3, 'monotonic with age');
  });

  test('future ages clamp to 0.10R', () => {
    assert.ok(Math.abs(radiusFor(-5) - 0.10 * R) < 1e-9);
    const d = dist(blipPosition(item(1, { publishedAt: hoursAgo(-3) }), NOW));
    assert.ok(d >= 15 - 1e-6 && d <= 17 + 1e-6, `${d}`);
    assert.ok(Math.abs(radiusFor(Number.NaN) - 0.10 * R) < 1e-9);
    assert.ok(Math.abs(radiusFor(500) - R) < 1e-9, 'beyond 48 h clamps to R');
  });
});

describe('radarItems / radarCount', () => {
  test('older than 48 h excluded, future included, newest first', () => {
    const items = [
      item(1, { publishedAt: hoursAgo(49) }),
      item(2, { publishedAt: hoursAgo(48) }),
      item(3, { publishedAt: hoursAgo(47) }),
      item(4, { publishedAt: hoursAgo(1) }),
      item(5, { publishedAt: hoursAgo(-2) }),
      item(6, { publishedAt: 'garbage' }),
      item(7, { publishedAt: undefined }),
    ];
    assert.deepEqual(radarItems(items, NOW).map((i) => i.id), [5, 4, 3, 2]);
    assert.equal(radarCount(items, NOW), 4);
    assert.deepEqual(radarItems([], NOW), []);
    assert.equal(radarCount(undefined, NOW), 0);
    assert.ok(Number.isNaN(ageHours(item(6, { publishedAt: 'garbage' }), NOW)));
    assert.ok(Math.abs(ageHours(item(1, { publishedAt: hoursAgo(2) }), NOW) - 2) < 1e-9);
  });

  test('cap keeps the newest 400 and radarCount counts before the cap (503 vs 400 drawn)', () => {
    const items = [item('a', { publishedAt: hoursAgo(1) }), item('b', { publishedAt: hoursAgo(47) }), item('c', { publishedAt: hoursAgo(48) }), item('d', { publishedAt: hoursAgo(49) })];
    for (let i = 0; i < 500; i += 1) items.push(item(`m${i}`, { publishedAt: hoursAgo(2) }));
    assert.equal(radarCount(items, NOW), 503);
    const drawn = radarItems(items, NOW);
    assert.equal(drawn.length, MAX_BLIPS);
    assert.equal(drawn.length, 400);
    assert.equal(drawn[0].id, 'a');
    assert.ok(!drawn.some((i) => i.id === 'b' || i.id === 'c' || i.id === 'd'), 'the oldest items are the ones cut');
    assert.equal(radarCount(items, NOW, { last24h: 999, items: 1 }), 503, 'a stats argument is ignored: the count comes from items.json only');
  });
});
