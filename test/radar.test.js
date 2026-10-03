import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CENTER,
  RADIUS,
  MAX_BLIPS,
  KIND_ORDER,
  REGION_ORDER,
  ageHours,
  baseAngle,
  jitterDeg,
  radiusFor,
  blipPosition,
  radarItems,
  radarCount,
} from '../public/radar.js';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const R = RADIUS;

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

describe('blipPosition', () => {
  test('quadrant per kind', () => {
    const expected = { launch: 0, funding: 1, news: 2, accelerator: 3 };
    for (const kind of KIND_ORDER) {
      for (const region of REGION_ORDER) {
        const p = blipPosition(item(1, { kind, region }), NOW);
        assert.equal(quadrant(p.base), expected[kind], `${kind}/${region} base`);
        assert.equal(quadrant(p.angle), expected[kind], `${kind}/${region} angle`);
      }
    }
    // unknown kinds fall into the news quadrant, unknown regions into the global slot
    assert.equal(quadrant(baseAngle('bogus', 'usa')), 2);
    assert.equal(baseAngle('launch', 'mars'), baseAngle('launch', 'global'));
  });

  test('region slot order', () => {
    for (const [k, kind] of KIND_ORDER.entries()) {
      const angles = REGION_ORDER.map((region) => baseAngle(kind, region));
      for (let i = 1; i < angles.length; i += 1) assert.ok(angles[i] > angles[i - 1], `${kind}: ${REGION_ORDER[i]} after ${REGION_ORDER[i - 1]}`);
      assert.ok(angles[0] > k * 90 && angles.at(-1) < (k + 1) * 90, `${kind} slots stay inside the quadrant`);
      assert.ok(Math.abs(angles[0] - (k * 90 + 45 / 7)) < 1e-9, 'first slot centre = q0 + 0.5 * 90/7');
    }
  });

  test('radius 0.10R / 0.55R / R at 0 / 24 / 48 h', () => {
    assert.ok(Math.abs(radiusFor(0) - 0.10 * R) < 1e-9);
    assert.ok(Math.abs(radiusFor(24) - 0.55 * R) < 1e-9);
    assert.ok(Math.abs(radiusFor(48) - R) < 1e-9);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(0) }), NOW)) - 15) < 1e-6);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(24) }), NOW)) - 82.5) < 1e-6);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(48) }), NOW)) - 150) < 1e-6);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(24) }), NOW, 100)) - 55) < 1e-6, 'custom R');
    // monotonic with age
    const r1 = dist(blipPosition(item(1, { publishedAt: hoursAgo(1) }), NOW));
    const r2 = dist(blipPosition(item(1, { publishedAt: hoursAgo(10) }), NOW));
    const r3 = dist(blipPosition(item(1, { publishedAt: hoursAgo(40) }), NOW));
    assert.ok(r1 < r2 && r2 < r3);
  });

  test('future ages clamp to 0.10R', () => {
    assert.ok(Math.abs(radiusFor(-5) - 0.10 * R) < 1e-9);
    assert.ok(Math.abs(dist(blipPosition(item(1, { publishedAt: hoursAgo(-3) }), NOW)) - 15) < 1e-6);
    assert.ok(Math.abs(radiusFor(Number.NaN) - 0.10 * R) < 1e-9);
    assert.ok(Math.abs(radiusFor(500) - R) < 1e-9, 'beyond 48 h clamps to R');
  });

  test('jitter within +/-4 degrees and deterministic', () => {
    for (let i = 0; i < 500; i += 1) {
      const j = jitterDeg(`key${i}`);
      assert.ok(j >= -4 && j <= 4, `jitter ${j}`);
    }
    assert.equal(jitterDeg('abc'), jitterDeg('abc'));
    const seen = new Set();
    for (let i = 0; i < 50; i += 1) seen.add(jitterDeg(`k${i}`).toFixed(3));
    assert.ok(seen.size > 10, 'spreads coincident items');
    for (let i = 0; i < 100; i += 1) {
      const p = blipPosition(item(i, { kind: 'funding', region: 'india' }), NOW);
      assert.ok(Math.abs(p.angle - p.base) <= 4 + 1e-9);
      assert.ok(Math.abs(p.base - baseAngle('funding', 'india')) < 1e-9);
    }
    // x/y follow the clockwise-from-12 convention: age 0, launch quadrant -> upper right
    const p = blipPosition(item(1, { kind: 'launch', region: 'usa', publishedAt: hoursAgo(0) }), NOW);
    assert.ok(p.x > CENTER && p.y < CENTER);
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
