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
  SPREAD,
  ageHours,
  sectorSpan,
  slotSpan,
  spreadFraction,
  blipAngle,
  radiusFor,
  blipPosition,
  radarItems,
  radarCount,
} from '../public/radar.js';
import { itemKey } from '../public/filter.js';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const R = RADIUS;
// The three ring-caption plates of public/index.html (x, y, width, height) on the 270 degree ray: "now", "24 h", "48 h".
const CAPTION_PLATES = [[133.6, 170.2, 31.4, 19.6], [58.3, 170.2, 39.2, 19.6], [2, 170.2, 39.2, 19.6]];

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
/** Distance from a point to the nearest point of a rect [x, y, w, h]. */
const rectDistance = (p, [x, y, w, h]) => Math.hypot(p.x - Math.max(x, Math.min(p.x, x + w)), p.y - Math.max(y, Math.min(p.y, y + h)));
const everyPair = (fn) => { for (const kind of KIND_ORDER) for (const region of REGION_ORDER) fn(kind, region); };

describe('sectors and sub-wedges', () => {
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
    assert.equal(quadrant(blipAngle('bogus', 'usa', 'k', R)), 2);
  });

  test('region sub-wedges are ordered, contiguous and inside the sector at every radius', () => {
    for (const r of [15, 20, 46, 82.5, 120, 150]) {
      for (const kind of KIND_ORDER) {
        const [a, b] = sectorSpan(kind, r);
        const k = KIND_ORDER.indexOf(kind);
        assert.ok(a > k * 90 && b < (k + 1) * 90 && b > a, `${kind} sector ${a}-${b} inside its quadrant at r=${r}`);
        let prevEnd = a;
        for (const region of REGION_ORDER) {
          const [s0, s1] = slotSpan(kind, region, r);
          assert.ok(Math.abs(s0 - prevEnd) < 1e-9 && s1 > s0, `${kind}/${region} follows the previous slot at r=${r}`);
          prevEnd = s1;
        }
        assert.ok(Math.abs(prevEnd - b) < 1e-9, `${kind}: the last slot ends at the sector end`);
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

  test('the caption channel: no blip disc (open blip r=5.5 included) ever touches a ring-caption plate', () => {
    let minDistance = Infinity;
    for (let i = 0; i < 400; i += 1) {
      const age = (i / 399) * 48;
      everyPair((kind, region) => {
        const p = blipPosition(item(`${kind}/${region}/${i}`, { kind, region, publishedAt: hoursAgo(age) }), NOW);
        for (const plate of CAPTION_PLATES) minDistance = Math.min(minDistance, rectDistance(p, plate));
      });
    }
    assert.ok(minDistance > 5.5, `closest blip centre is ${minDistance} px from a caption plate`);
    assert.equal(CAPTION_RAY, 270);
    assert.ok(CAPTION_CLEAR >= 10 + 5.5, 'clearance covers the plate half-height plus the open-blip radius');
  });
});

describe('deterministic spread', () => {
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

  test('blipAngle stays inside [0.1, 0.9] of its sub-wedge and is the same for the same key', () => {
    assert.deepEqual(SPREAD, [0.1, 0.9]);
    for (const r of [15, 40, 82.5, 150]) {
      everyPair((kind, region) => {
        const [s0, s1] = slotSpan(kind, region, r);
        for (let i = 0; i < 50; i += 1) {
          const a = blipAngle(kind, region, `k${i}`, r);
          assert.ok(a >= s0 + 0.1 * (s1 - s0) - 1e-9 && a <= s0 + 0.9 * (s1 - s0) + 1e-9, `${kind}/${region} r=${r}: ${a} outside [${s0}, ${s1}] padded`);
        }
        assert.equal(blipAngle(kind, region, 'same', r), blipAngle(kind, region, 'same', r));
      });
    }
  });

  test('same (kind, region, age) items fan out over >= 5 distinct angles (150 global launches)', () => {
    const angles = new Set();
    for (let i = 0; i < 150; i += 1) angles.add(blipPosition(item(`show-hn-${i}`, { kind: 'launch', region: 'global', publishedAt: hoursAgo(30) }), NOW).angle.toFixed(2));
    assert.ok(angles.size >= 5, `${angles.size} distinct angles`);
    assert.ok(angles.size >= 100, `${angles.size} distinct angles out of 150`);
    const [s0, s1] = slotSpan('launch', 'global', radiusFor(30));
    for (const a of angles) assert.ok(Number(a) >= s0 && Number(a) <= s1);
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

describe('radius', () => {
  test('radius 0.10R / 0.55R / R at 0 / 24 / 48 h', () => {
    assert.ok(Math.abs(radiusFor(0) - 0.10 * R) < 1e-9);
    assert.ok(Math.abs(radiusFor(24) - 0.55 * R) < 1e-9);
    assert.ok(Math.abs(radiusFor(48) - R) < 1e-9);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(0) }), NOW)) - 15) < 1e-6);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(24) }), NOW)) - 82.5) < 1e-6);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(48) }), NOW)) - 150) < 1e-6);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(24) }), NOW, 100)) - 55) < 1e-6, 'custom R');
    const r1 = dist(blipPosition(item(1, { publishedAt: hoursAgo(1) }), NOW));
    const r2 = dist(blipPosition(item(1, { publishedAt: hoursAgo(10) }), NOW));
    const r3 = dist(blipPosition(item(1, { publishedAt: hoursAgo(40) }), NOW));
    assert.ok(r1 < r2 && r2 < r3, 'monotonic with age');
  });

  test('future ages clamp to 0.10R', () => {
    assert.ok(Math.abs(radiusFor(-5) - 0.10 * R) < 1e-9);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(-3) }), NOW)) - 15) < 1e-6);
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
