// ISO-8601 week helpers in UTC, no Intl: weeks start Monday 00:00Z, week 1 contains the year's first Thursday.

const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;
const WEEK_ID_RE = /^(\d{4})-W(\d{2})$/;

/** Monday 00:00Z of the ISO week containing `date`. */
function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  return new Date(d.getTime() - dow * DAY_MS);
}

/** Monday 00:00Z of week 1 of ISO year `year` (the week containing 4 January). */
function week1Monday(year) {
  return mondayOf(new Date(Date.UTC(year, 0, 4)));
}

/** Date -> 'YYYY-Www' (ISO week-numbering year, zero-padded week 01-53). */
export function isoWeekId(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError('isoWeekId: invalid date');
  const monday = mondayOf(d);
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((monday.getTime() - week1Monday(year).getTime()) / WEEK_MS) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Strict 'YYYY-Www' (week 01-53) -> the same id, or null. */
export function parseWeekId(s) {
  const m = WEEK_ID_RE.exec(String(s ?? ''));
  if (!m) return null;
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  return m[0];
}

/** 'YYYY-Www' -> Monday 00:00:00.000Z of that week. Throws on an invalid id. */
export function isoWeekStart(id) {
  const valid = parseWeekId(id);
  if (!valid) throw new TypeError(`isoWeekStart: invalid week id ${String(id)}`);
  const m = WEEK_ID_RE.exec(valid);
  return new Date(week1Monday(Number(m[1])).getTime() + (Number(m[2]) - 1) * WEEK_MS);
}

/** 'YYYY-Www' -> Sunday 23:59:59.999Z of that week (inclusive end). */
export function isoWeekEnd(id) {
  return new Date(isoWeekStart(id).getTime() + WEEK_MS - 1);
}

/** The `n` ISO week ids ending with the week containing `now`, oldest first. */
export function lastWeeks(now, n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const monday = mondayOf(now instanceof Date ? now : new Date(now));
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push(isoWeekId(new Date(monday.getTime() - i * WEEK_MS)));
  return out;
}
