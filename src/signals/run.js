// Isolated signal runner (plan D8, §3.1 item 14). Every enabled signal runs under Promise.allSettled with a
// 15 s timeout; a failure carries the previous payload forward (`data`, `lastSuccessAt`) and records
// `unavailableSince` (the first failure time, kept across consecutive failures). A failing signal never throws.

export const SIGNAL_TIMEOUT_MS = 15000;
export const EMPTY_SIGNALS = Object.freeze({ generatedAt: null, signals: [] });

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function previousById(previous) {
  const list = Array.isArray(previous?.signals) ? previous.signals : [];
  return new Map(list.filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
}

function base(signal) {
  return {
    id: signal.id,
    name: signal.name,
    homepage: signal.homepage,
    description: signal.description,
    requires: signal.requires ?? null,
  };
}

async function runOne(signal, { http, env, now, nowIso, prev, log }) {
  const startedAt = Date.now();
  const ctx = { http, env, now, signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS), log };
  try {
    const data = await withTimeout(Promise.resolve().then(() => signal.fetch(ctx)), SIGNAL_TIMEOUT_MS, signal.id);
    if (!data || typeof data !== 'object') throw new Error('adapter did not return an object');
    return {
      ...base(signal),
      enabled: true,
      ok: true,
      fetchedAt: nowIso,
      lastSuccessAt: nowIso,
      error: null,
      unavailableSince: null,
      data,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 500);
    return {
      ...base(signal),
      enabled: true,
      ok: false,
      fetchedAt: nowIso,
      lastSuccessAt: prev?.lastSuccessAt ?? null,
      error: message,
      unavailableSince: prev?.unavailableSince ?? nowIso,
      data: prev?.data ?? null,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * runSignals({ signals, http, env, previous, now, log }) ->
 *   { generatedAt, signals: [{ id, name, homepage, description, requires, enabled, ok, fetchedAt,
 *     lastSuccessAt, error, unavailableSince, data, durationMs }] } in registry order.
 * Disabled signals report enabled:false, error 'not configured (<requires>)', data null.
 */
export async function runSignals({ signals, http, env = process.env, previous = null, now = new Date(), log = console.log }) {
  const nowIso = now.toISOString();
  const prevMap = previousById(previous);
  const rows = new Array(signals.length);
  const jobs = [];

  signals.forEach((signal, i) => {
    if (!signal.enabled(env)) {
      rows[i] = {
        ...base(signal),
        enabled: false,
        ok: false,
        fetchedAt: null,
        lastSuccessAt: null,
        error: `not configured (${signal.requires ?? 'disabled'})`,
        unavailableSince: null,
        data: null,
        durationMs: 0,
      };
      return;
    }
    jobs.push(
      runOne(signal, { http, env, now, nowIso, prev: prevMap.get(signal.id), log }).then((row) => {
        rows[i] = row;
      }),
    );
  });
  await Promise.allSettled(jobs);

  for (const r of rows) {
    if (!r.enabled) continue;
    log(
      r.ok
        ? `[signals] ${r.id}: OK in ${r.durationMs} ms`
        : `[signals] ${r.id}: FAIL after ${r.durationMs} ms: ${r.error}${r.data ? ' (previous data kept)' : ''}`,
    );
  }
  return { generatedAt: nowIso, signals: rows };
}

function pad(s, n) {
  return String(s).padEnd(n);
}

/** Rough "items" figure for the log table: the summed length of the top-level arrays in `data`. */
export function countSignalItems(data) {
  if (!data || typeof data !== 'object') return 0;
  return Object.values(data).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
}

function statusLabel(row) {
  if (!row.enabled) return `not configured${row.requires ? ` (${row.requires})` : ''}`;
  if (row.ok) return 'OK';
  return row.data ? 'FAIL (previous kept)' : 'FAIL';
}

/**
 * Per-signal table for a run, in the formatSummaryTable style:
 * header, separator, one row per signal, a blank line and the `N/M enabled signals OK` footer.
 */
export function formatSignalsTable(signals, result) {
  const byId = new Map((result?.signals ?? []).map((r) => [r.id, r]));
  const rows = signals.map((s) => byId.get(s.id) ?? { ...base(s), enabled: false, ok: false, data: null, durationMs: '-', error: '' });
  const lines = [];
  const idWidth = Math.max(6, ...rows.map((r) => r.id.length));
  const statusWidth = Math.max(6, ...rows.map((r) => statusLabel(r).length));
  lines.push(`${pad('signal', idWidth)} | ${pad('status', statusWidth)} | ${pad('items', 5)} | ${pad('ms', 6)} | error`);
  lines.push(`${'-'.repeat(idWidth)}-+-${'-'.repeat(statusWidth)}-+-------+--------+------`);
  for (const r of rows) {
    const items = r.enabled ? countSignalItems(r.data) : '-';
    const error = r.enabled ? r.error ?? '' : ''; // the status column already says "not configured"
    lines.push(`${pad(r.id, idWidth)} | ${pad(statusLabel(r), statusWidth)} | ${pad(items, 5)} | ${pad(r.durationMs, 6)} | ${error}`);
  }
  const enabled = rows.filter((r) => r.enabled);
  lines.push('');
  lines.push(`${enabled.filter((r) => r.ok).length}/${enabled.length} enabled signals OK`);
  return lines;
}
