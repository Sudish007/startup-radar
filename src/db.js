import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DDL = `
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY,
  url_norm     TEXT NOT NULL UNIQUE,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  source_id    TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('launch','funding','news','accelerator')),
  region       TEXT NOT NULL CHECK (region IN ('usa','europe','asia','india','latam','africa','global')),
  published_at TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  extra_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_items_published_at ON items (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_source_id    ON items (source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_kind         ON items (kind, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_region       ON items (region, published_at DESC);

CREATE TABLE IF NOT EXISTS source_status (
  source_id        TEXT PRIMARY KEY,
  last_run_at      TEXT,
  last_success_at  TEXT,
  last_error       TEXT,
  last_duration_ms INTEGER,
  last_item_count  INTEGER
);
`;

const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, summary, content='items', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF title, summary ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
  INSERT INTO items_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END;
`;

const UPSERT_SQL = `
INSERT INTO items (url_norm, url, title, summary, source_id, kind, region, published_at, fetched_at, extra_json)
VALUES (@url_norm, @url, @title, @summary, @source_id, @kind, @region, @published_at, @fetched_at, @extra_json)
ON CONFLICT(url_norm) DO UPDATE SET
  title = excluded.title, summary = excluded.summary, kind = excluded.kind, region = excluded.region,
  extra_json = excluded.extra_json, fetched_at = excluded.fetched_at
WHERE items.source_id = excluded.source_id;
`;

const ITEM_COLUMNS = 'id, url, title, summary, source_id, kind, region, published_at, fetched_at, extra_json';

function parseExtra(json) {
  try {
    const v = JSON.parse(json ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** DB row -> API object. `source.name` is filled by the caller from the registry. */
export function rowToItem(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    source: { id: row.source_id, name: row.source_id },
    kind: row.kind,
    region: row.region,
    summary: row.summary,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    extra: parseExtra(row.extra_json),
  };
}

/** Build a safe FTS5 MATCH expression: up to 8 quoted tokens, inner quotes removed. */
export function buildFtsQuery(q) {
  const tokens = String(q ?? '')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' ');
}

export function openDb(filePath) {
  const isMemory = filePath === ':memory:';
  if (!isMemory) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const sqlite = new Database(filePath);

  if (!isMemory) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(DDL);

  let ftsAvailable = false;
  try {
    sqlite.exec(FTS_DDL);
    ftsAvailable = true;
  } catch {
    ftsAvailable = false;
  }

  const upsertStmt = sqlite.prepare(UPSERT_SQL);
  const upsertTx = sqlite.transaction((rows) => {
    let changed = 0;
    for (const row of rows) {
      const info = upsertStmt.run(row);
      changed += info.changes;
    }
    return changed;
  });

  const countStmt = sqlite.prepare('SELECT COUNT(*) AS n FROM items');
  const lastRefreshStmt = sqlite.prepare('SELECT MAX(last_success_at) AS t FROM source_status');
  const statusStmt = sqlite.prepare('SELECT * FROM source_status');
  const setStatusStmt = sqlite.prepare(`
    INSERT INTO source_status (source_id, last_run_at, last_success_at, last_error, last_duration_ms, last_item_count)
    VALUES (@source_id, @last_run_at, @last_success_at, @last_error, @last_duration_ms, @last_item_count)
    ON CONFLICT(source_id) DO UPDATE SET
      last_run_at = COALESCE(excluded.last_run_at, source_status.last_run_at),
      last_success_at = COALESCE(excluded.last_success_at, source_status.last_success_at),
      last_error = excluded.last_error,
      last_duration_ms = COALESCE(excluded.last_duration_ms, source_status.last_duration_ms),
      last_item_count = COALESCE(excluded.last_item_count, source_status.last_item_count)
  `);
  const countBySourceStmt = sqlite.prepare('SELECT source_id, COUNT(*) AS n FROM items GROUP BY source_id');
  const countByKindStmt = sqlite.prepare('SELECT kind, COUNT(*) AS n FROM items GROUP BY kind');
  const countByRegionStmt = sqlite.prepare('SELECT region, COUNT(*) AS n FROM items GROUP BY region');
  const countSinceStmt = sqlite.prepare('SELECT COUNT(*) AS n FROM items WHERE published_at >= ?');

  function buildWhere({ kind, region, sources, since }) {
    const clauses = [];
    const params = [];
    if (kind) {
      clauses.push('items.kind = ?');
      params.push(kind);
    }
    if (region === 'world') {
      clauses.push("items.region <> 'usa'");
    } else if (region) {
      clauses.push('items.region = ?');
      params.push(region);
    }
    if (Array.isArray(sources) && sources.length > 0) {
      clauses.push(`items.source_id IN (${sources.map(() => '?').join(', ')})`);
      params.push(...sources);
    }
    if (since) {
      clauses.push('items.published_at >= ?');
      params.push(since);
    }
    return { clauses, params };
  }

  function runQuery({ clauses, params, join, limit, offset }) {
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT ${ITEM_COLUMNS} FROM items ${join} ${where} ORDER BY items.published_at DESC, items.id DESC LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) AS n FROM items ${join} ${where}`;
    const rows = sqlite.prepare(sql).all(...params, limit, offset);
    const total = sqlite.prepare(countSql).get(...params).n;
    return { rows, total };
  }

  function queryItems({ kind, region, sources, q, since, page = 1, limit = 30 } = {}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
    const safePage = Math.min(10000, Math.max(1, Number(page) || 1));
    const offset = (safePage - 1) * safeLimit;
    const base = buildWhere({ kind, region, sources, since });
    const query = typeof q === 'string' ? q.trim() : '';

    let result = null;
    if (query && ftsAvailable) {
      const match = buildFtsQuery(query);
      if (match) {
        try {
          result = runQuery({
            clauses: ['items_fts MATCH ?', ...base.clauses],
            params: [match, ...base.params],
            join: 'JOIN items_fts ON items_fts.rowid = items.id',
            limit: safeLimit,
            offset,
          });
        } catch {
          result = null; // fall back to LIKE below
        }
      }
    }
    if (!result && query) {
      const like = `%${query}%`;
      result = runQuery({
        clauses: ['(items.title LIKE ? OR items.summary LIKE ?)', ...base.clauses],
        params: [like, like, ...base.params],
        join: '',
        limit: safeLimit,
        offset,
      });
    }
    if (!result) {
      result = runQuery({ clauses: base.clauses, params: base.params, join: '', limit: safeLimit, offset });
    }
    return { items: result.rows.map(rowToItem), total: result.total };
  }

  /** Newest-first list for exports: no 100 clamp, `limit` defaults to 3000. */
  function listItems({ since, limit = 3000 } = {}) {
    const safeLimit = Math.max(1, Number(limit) || 3000);
    const where = since ? 'WHERE published_at >= ?' : '';
    const params = since ? [since, safeLimit] : [safeLimit];
    const sql = `SELECT ${ITEM_COLUMNS} FROM items ${where} ORDER BY published_at DESC, id DESC LIMIT ?`;
    return sqlite.prepare(sql).all(...params).map(rowToItem);
  }

  function countItems() {
    return countStmt.get().n;
  }

  function lastRefresh() {
    return lastRefreshStmt.get().t ?? null;
  }

  function itemCountsBySource() {
    const out = {};
    for (const row of countBySourceStmt.all()) out[row.source_id] = row.n;
    return out;
  }

  function getStats() {
    const now = Date.now();
    const byKind = {};
    for (const row of countByKindStmt.all()) byKind[row.kind] = row.n;
    const byRegion = {};
    for (const row of countByRegionStmt.all()) byRegion[row.region] = row.n;
    return {
      items: countItems(),
      lastRefresh: lastRefresh(),
      last24h: countSinceStmt.get(new Date(now - 24 * 3600_000).toISOString()).n,
      last7d: countSinceStmt.get(new Date(now - 7 * 24 * 3600_000).toISOString()).n,
      bySource: itemCountsBySource(),
      byKind,
      byRegion,
    };
  }

  function getSourceStatuses() {
    const map = new Map();
    for (const row of statusStmt.all()) map.set(row.source_id, row);
    return map;
  }

  function setSourceStatus(sourceId, status = {}) {
    setStatusStmt.run({
      source_id: sourceId,
      last_run_at: status.last_run_at ?? null,
      last_success_at: status.last_success_at ?? null,
      last_error: status.last_error ?? null,
      last_duration_ms: status.last_duration_ms ?? null,
      last_item_count: status.last_item_count ?? null,
    });
  }

  function upsertItems(sourceId, rows) {
    const list = (rows ?? []).filter((r) => r && r.source_id === sourceId);
    const changed = list.length ? upsertTx(list) : 0;
    return { attempted: list.length, changed };
  }

  return {
    ftsAvailable,
    upsertItems,
    queryItems,
    listItems,
    countItems,
    lastRefresh,
    getStats,
    getSourceStatuses,
    setSourceStatus,
    itemCountsBySource,
    close: () => sqlite.close(),
  };
}
