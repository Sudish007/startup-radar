import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createHttp } from './lib/http.js';
import { fetchFeed, parseFeed, feedItemToRaw } from './lib/rss.js';
import { normalizeItem } from './lib/normalize.js';
import { loadSources } from './sources/index.js';

export const SOURCE_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fetch one source, normalize, upsert, record status.
 * Never throws: failures are captured in the returned record and the status row.
 */
export async function runSource(source, deps) {
  const { db, http, env = process.env, log = console.log } = deps;
  const startedAt = Date.now();
  const nowIso = new Date(startedAt).toISOString();
  const ctx = {
    http,
    rss: { fetchFeed, parseFeed, feedItemToRaw },
    env,
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    log,
  };

  try {
    const rawItems = await withTimeout(Promise.resolve().then(() => source.fetch(ctx)), SOURCE_TIMEOUT_MS, source.id);
    if (!Array.isArray(rawItems)) throw new Error('adapter did not return an array');

    const rows = [];
    let dropped = 0;
    for (const raw of rawItems) {
      const row = normalizeItem(raw, source, nowIso);
      if (row) rows.push(row);
      else dropped += 1;
    }

    db.upsertItems(source.id, rows);
    const durationMs = Date.now() - startedAt;
    const finishedIso = new Date().toISOString();
    db.setSourceStatus(source.id, {
      last_run_at: finishedIso,
      last_success_at: finishedIso,
      last_error: null,
      last_duration_ms: durationMs,
      last_item_count: rows.length,
    });
    return { id: source.id, ok: true, count: rows.length, dropped, error: null, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = String(err?.message ?? err).slice(0, 500);
    try {
      db.setSourceStatus(source.id, {
        last_run_at: new Date().toISOString(),
        last_success_at: null,
        last_error: message,
        last_duration_ms: durationMs,
        last_item_count: null,
      });
    } catch (statusErr) {
      log(`[refresh] ${source.id}: could not record status: ${statusErr.message}`);
    }
    return { id: source.id, ok: false, count: 0, dropped: 0, error: message, durationMs };
  }
}

/**
 * Create a refresh engine bound to deps { db, http, sources, env, log }.
 * runRefreshCycle is single-flight: concurrent callers share the in-flight promise.
 */
export function createRefresh(deps) {
  const { sources, env = process.env, log = console.log } = deps;
  let inFlight = null;

  function enabledSources() {
    return sources.filter((s) => s.enabled(env));
  }

  async function cycle() {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const targets = enabledSources();
    const settled = await Promise.allSettled(targets.map((s) => runSource(s, { ...deps, env, log })));
    const results = settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { id: targets[i].id, ok: false, count: 0, dropped: 0, error: String(r.reason?.message ?? r.reason).slice(0, 500), durationMs: 0 },
    );
    for (const r of results) {
      log(
        r.ok
          ? `[refresh] ${r.id}: OK ${r.count} items (${r.dropped} dropped) in ${r.durationMs} ms`
          : `[refresh] ${r.id}: FAIL after ${r.durationMs} ms: ${r.error}`,
      );
    }
    return { startedAt, durationMs: Date.now() - started, sources: results };
  }

  function runRefreshCycle() {
    if (inFlight) return inFlight;
    inFlight = cycle().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function isRunning() {
    return inFlight !== null;
  }

  return { runRefreshCycle, isRunning, enabledSources };
}

/** Convenience for callers that hold deps but not an engine. */
export function runRefreshCycle(deps) {
  return createRefresh(deps).runRefreshCycle();
}

/**
 * Periodic runner. Accepts either a refresh engine (from createRefresh) or raw deps.
 * start() runs one cycle immediately (not awaited) and then every `minutes`.
 */
export function createScheduler(depsOrEngine, minutes) {
  const refresh = typeof depsOrEngine.runRefreshCycle === 'function' ? depsOrEngine : createRefresh(depsOrEngine);
  const log = depsOrEngine.log ?? console.log;
  let timer = null;

  function tick() {
    refresh.runRefreshCycle().catch((err) => log(`[refresh] cycle failed: ${err.message}`));
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, Math.max(1, minutes) * 60_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function statusLabel(source, result, env) {
  if (!source.enabled(env)) {
    const req = source.requires ? ` (${source.requires})` : '';
    return source.id === 'crunchbase' ? `not configured${req}` : `disabled${req}`;
  }
  return result?.ok ? 'OK' : 'FAIL';
}

async function main() {
  const config = loadConfig();
  const db = openDb(path.join(config.dataDir, 'startup-radar.db'));
  try {
    const sources = await loadSources();
    const http = createHttp(config);
    const refresh = createRefresh({ db, http, sources, env: process.env, log: () => {} });
    const summary = await refresh.runRefreshCycle();
    const byId = new Map(summary.sources.map((r) => [r.id, r]));

    const idWidth = Math.max(6, ...sources.map((s) => s.id.length));
    const statusWidth = Math.max(6, ...sources.map((s) => statusLabel(s, byId.get(s.id), process.env).length));
    console.log(`${pad('source', idWidth)} | ${pad('status', statusWidth)} | ${pad('items', 5)} | ${pad('ms', 6)} | error`);
    console.log(`${'-'.repeat(idWidth)}-+-${'-'.repeat(statusWidth)}-+-------+--------+------`);
    for (const s of sources) {
      const r = byId.get(s.id);
      const label = statusLabel(s, r, process.env);
      const items = r ? r.count : '-';
      const ms = r ? r.durationMs : '-';
      const error = r?.error ?? '';
      console.log(`${pad(s.id, idWidth)} | ${pad(label, statusWidth)} | ${pad(items, 5)} | ${pad(ms, 6)} | ${error}`);
    }
    const okCount = summary.sources.filter((r) => r.ok).length;
    console.log(`\n${okCount}/${summary.sources.length} enabled sources OK in ${summary.durationMs} ms; ${db.countItems()} items in DB`);
    return okCount > 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
