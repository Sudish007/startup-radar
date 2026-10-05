import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isoWeekId, isoWeekStart, isoWeekEnd, lastWeeks, parseWeekId } from '../src/lib/weeks.js';

describe('weeks', () => {
  test('isoWeekId: plain mid-year dates', () => {
    assert.equal(isoWeekId(new Date('2026-10-05T00:00:00Z')), '2026-W41'); // Monday
    assert.equal(isoWeekId(new Date('2026-10-11T23:59:59Z')), '2026-W41'); // Sunday of the same week
    assert.equal(isoWeekId(new Date('2026-10-12T00:00:00Z')), '2026-W42');
    assert.equal(isoWeekId('2026-06-15T12:00:00Z'), '2026-W25');
  });

  test('isoWeekId: year boundaries (week 53 and week 1 spill-over)', () => {
    assert.equal(isoWeekId(new Date('2026-12-28T00:00:00Z')), '2026-W53'); // 2026 has 53 ISO weeks
    assert.equal(isoWeekId(new Date('2027-01-03T23:59:59Z')), '2026-W53'); // Sunday still in 2026-W53
    assert.equal(isoWeekId(new Date('2027-01-04T00:00:00Z')), '2027-W01');
    assert.equal(isoWeekId(new Date('2021-01-01T00:00:00Z')), '2020-W53'); // Friday belongs to the old year
    assert.equal(isoWeekId(new Date('2024-12-30T00:00:00Z')), '2025-W01'); // Monday belongs to the new year
    assert.equal(isoWeekId(new Date('2026-01-01T00:00:00Z')), '2026-W01'); // 2026 starts on a Thursday
    assert.equal(isoWeekId(new Date('2025-12-29T00:00:00Z')), '2026-W01');
  });

  test('isoWeekId rejects invalid dates', () => {
    assert.throws(() => isoWeekId('nope'), TypeError);
  });

  test('parseWeekId is strict', () => {
    assert.equal(parseWeekId('2026-W41'), '2026-W41');
    assert.equal(parseWeekId('2026-W01'), '2026-W01');
    assert.equal(parseWeekId('2026-W53'), '2026-W53');
    assert.equal(parseWeekId('2026-W00'), null);
    assert.equal(parseWeekId('2026-W54'), null);
    assert.equal(parseWeekId('2026-W1'), null);
    assert.equal(parseWeekId('2026-41'), null);
    assert.equal(parseWeekId(' 2026-W41'), null);
    assert.equal(parseWeekId('2026-W41x'), null);
    assert.equal(parseWeekId(null), null);
    assert.equal(parseWeekId(undefined), null);
  });

  test('isoWeekStart / isoWeekEnd bracket the week in UTC', () => {
    assert.equal(isoWeekStart('2026-W41').toISOString(), '2026-10-05T00:00:00.000Z');
    assert.equal(isoWeekEnd('2026-W41').toISOString(), '2026-10-11T23:59:59.999Z');
    assert.equal(isoWeekStart('2026-W01').toISOString(), '2025-12-29T00:00:00.000Z');
    assert.equal(isoWeekStart('2026-W53').toISOString(), '2026-12-28T00:00:00.000Z');
    assert.equal(isoWeekStart('2027-W01').toISOString(), '2027-01-04T00:00:00.000Z');
    assert.equal(isoWeekStart('2025-W01').toISOString(), '2024-12-30T00:00:00.000Z');
    assert.throws(() => isoWeekStart('bogus'), TypeError);
  });

  test('isoWeekId and isoWeekStart round-trip for every day of several years', () => {
    for (let t = Date.UTC(2019, 0, 1); t <= Date.UTC(2028, 11, 31); t += 24 * 3600_000) {
      const d = new Date(t);
      const id = isoWeekId(d);
      assert.equal(parseWeekId(id), id);
      const start = isoWeekStart(id);
      const end = isoWeekEnd(id);
      assert.ok(start.getTime() <= t && t <= end.getTime(), `${d.toISOString()} inside ${id}`);
      assert.equal(start.getUTCDay(), 1, 'starts on a Monday');
    }
  });

  test('lastWeeks returns n ids oldest first, current week last', () => {
    const now = new Date('2026-10-07T15:00:00Z');
    assert.deepEqual(lastWeeks(now, 3), ['2026-W39', '2026-W40', '2026-W41']);
    assert.deepEqual(lastWeeks(now, 1), ['2026-W41']);
    assert.deepEqual(lastWeeks(now, 0), []);
    const twelve = lastWeeks(now, 12);
    assert.equal(twelve.length, 12);
    assert.equal(twelve[0], '2026-W30');
    assert.equal(twelve.at(-1), '2026-W41');
  });

  test('lastWeeks crosses a year boundary', () => {
    assert.deepEqual(lastWeeks(new Date('2027-01-06T00:00:00Z'), 3), ['2026-W52', '2026-W53', '2027-W01']);
    assert.deepEqual(lastWeeks(new Date('2025-01-02T00:00:00Z'), 2), ['2024-W52', '2025-W01']);
  });
});
