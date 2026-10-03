import { normalizeItem } from './lib/normalize.js';

const FETCH_OPTS = { timeoutMs: 15000, maxBytes: 20_000_000 };
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download one JSON file of the previous snapshot. Returns the parsed value when it
 * passes `validate`, otherwise null. A 404 is logged once and not retried; any other
 * failure is retried up to MAX_ATTEMPTS times. Never throws.
 */
async function fetchJsonFile(url, validate, { http, log, retryDelayMs }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await http.fetchText(url, FETCH_OPTS);
      let parsed;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        log(`[build] snapshot: invalid JSON for ${url}`);
        return null;
      }
      if (!validate(parsed)) {
        log(`[build] snapshot: unexpected shape for ${url}`);
        return null;
      }
      return parsed;
    } catch (err) {
      if (err?.status === 404) {
        log(`[build] snapshot: none (HTTP 404 for ${url})`);
        return null;
      }
      const message = String(err?.message ?? err);
      if (attempt < MAX_ATTEMPTS) {
        log(`[build] snapshot: attempt ${attempt}/${MAX_ATTEMPTS} failed for ${url}: ${message}; retrying`);
        await sleep(retryDelayMs);
      } else {
        log(`[build] snapshot: giving up on ${url} after ${MAX_ATTEMPTS} attempts: ${message}`);
      }
    }
  }
  return null;
}

/**
 * Fetch items.json (snapshotUrl) plus the sibling archive.json and sources.json.
 * Returns { items: array|null, archive: array|null, sources: object|null }; never throws.
 */
export async function fetchSnapshot(snapshotUrl, { http, log = console.log, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const opts = { http, log, retryDelayMs };
  const isArray = (v) => Array.isArray(v);
  const isSourcesDoc = (v) => Boolean(v) && typeof v === 'object' && Array.isArray(v.sources);

  const items = await fetchJsonFile(snapshotUrl, isArray, opts);
  const archive = await fetchJsonFile(new URL('archive.json', snapshotUrl).href, isArray, opts);
  const sources = await fetchJsonFile(new URL('sources.json', snapshotUrl).href, isSourcesDoc, opts);
  return { items, archive, sources };
}

function validFetchedAt(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Re-insert previously exported items through the normal normalizeItem + upsert path.
 * Items from sources unknown to the registry are skipped; rows normalizeItem rejects count as invalid.
 * Returns { imported, invalid, unknownSource }.
 */
export function importSnapshotItems(db, sources, items, { log = console.log, nowIso = new Date().toISOString(), url = '' } = {}) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const groups = new Map();
  let imported = 0;
  let invalid = 0;
  let unknownSource = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const source = byId.get(item?.source?.id);
    if (!source) {
      unknownSource += 1;
      continue;
    }
    const fetchedAt = validFetchedAt(item.fetchedAt) ? item.fetchedAt : nowIso;
    const row = normalizeItem(
      { title: item.title, url: item.url, summary: item.summary, publishedAt: item.publishedAt, kind: item.kind, region: item.region, extra: item.extra },
      source,
      fetchedAt,
    );
    if (!row) {
      invalid += 1;
      continue;
    }
    if (!groups.has(source.id)) groups.set(source.id, []);
    groups.get(source.id).push(row);
    imported += 1;
  }

  for (const [sourceId, rows] of groups) db.upsertItems(sourceId, rows);

  const from = url ? ` from ${url}` : '';
  log(`[build] snapshot: imported ${imported} items (${invalid} invalid, ${unknownSource} unknown source)${from}`);
  return { imported, invalid, unknownSource };
}

/** Seed source_status from the previous sources.json so "last successful fetch" survives a failing run. */
export function importSnapshotStatuses(db, sources, sourcesJson) {
  const list = Array.isArray(sourcesJson?.sources) ? sourcesJson.sources : [];
  const known = new Set(sources.map((s) => s.id));
  let seeded = 0;
  for (const entry of list) {
    if (!entry || !known.has(entry.id)) continue;
    db.setSourceStatus(entry.id, {
      last_run_at: entry.lastRunAt ?? null,
      last_success_at: entry.lastSuccessAt ?? null,
      last_error: entry.lastError ?? null,
      last_duration_ms: entry.lastDurationMs ?? null,
      last_item_count: entry.lastItemCount ?? null,
    });
    seeded += 1;
  }
  return { seeded };
}
