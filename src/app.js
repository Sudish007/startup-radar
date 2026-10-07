import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { KINDS, REGIONS } from './lib/classify.js';
import { buildDerived } from './derived.js';
import { buildSnapshot, decorateItem, itemsPayload, sourcesPayload } from './export.js';
import { SIGNALS_KV_KEY } from './refresh.js';
import { EMPTY_SIGNALS } from './signals/run.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const PAGES = ['sources', 'trends', 'funding', 'yc', 'notebook', 'signals', 'digest', 'resources'];

const CSP = "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

const LIMIT_DEFAULT = 30;
const LIMIT_MAX = 100;
const PAGE_MAX = 10000;
const Q_MAX = 200;

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path === '/health' || req.path.startsWith('/api/') || req.path.startsWith('/data/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

function parseIntParam(value, { fallback, min, max }) {
  if (value === undefined) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function firstString(value) {
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

/** Validate /api/items query. Returns { ok: true, params } or { ok: false, error }. */
export function parseItemsQuery(query, knownSourceIds) {
  const kind = firstString(query.kind);
  if (kind !== undefined && kind !== '' && !KINDS.includes(kind)) {
    return { ok: false, error: `invalid kind; expected one of ${KINDS.join(', ')}` };
  }

  const region = firstString(query.region);
  if (region !== undefined && region !== '' && region !== 'world' && !REGIONS.includes(region)) {
    return { ok: false, error: `invalid region; expected one of ${[...REGIONS, 'world'].join(', ')}` };
  }

  let sources;
  const sourceParam = firstString(query.source);
  if (sourceParam !== undefined && sourceParam !== '') {
    sources = sourceParam.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = sources.filter((s) => !knownSourceIds.has(s));
    if (unknown.length) return { ok: false, error: `unknown source: ${unknown.join(', ')}` };
  }

  let since;
  const sinceParam = firstString(query.since);
  if (sinceParam !== undefined && sinceParam !== '') {
    const t = Date.parse(sinceParam);
    if (Number.isNaN(t)) return { ok: false, error: 'invalid since; expected an ISO 8601 date' };
    since = new Date(t).toISOString();
  }

  const qRaw = firstString(query.q);
  const q = qRaw ? qRaw.trim().slice(0, Q_MAX) : undefined;

  return {
    ok: true,
    params: {
      kind: kind || undefined,
      region: region || undefined,
      sources,
      since,
      q: q || undefined,
      page: parseIntParam(firstString(query.page), { fallback: 1, min: 1, max: PAGE_MAX }),
      limit: parseIntParam(firstString(query.limit), { fallback: LIMIT_DEFAULT, min: 1, max: LIMIT_MAX }),
    },
  };
}

function bearerToken(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createApp({ db, sources, config, refresh, env = process.env, swVersion = new Date().toISOString() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const nameOf = (id) => sourceById.get(id)?.name ?? id;
  // The service worker's cache name embeds the version; read once at boot (misconfiguration is fatal here).
  const swSource = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8').replaceAll('__BUILD_VERSION__', String(swVersion));

  app.use(securityHeaders);

  // Registered before express.static so the version token is always replaced.
  app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(swSource);
  });

  // Same JSON files the static build writes to dist/data/, generated per request.
  app.get('/data/items.json', (req, res) => {
    res.json(itemsPayload({ db, sources }).items);
  });

  app.get('/data/archive.json', (req, res) => {
    const { archive } = buildSnapshot({ db, sources, env });
    if (!archive) return res.status(404).json({ error: 'not found' });
    res.json(archive);
  });

  app.get('/data/sources.json', (req, res) => {
    res.json(sourcesPayload({ db, sources, env }));
  });

  app.get('/data/stats.json', (req, res) => {
    res.json(buildSnapshot({ db, sources, env }).stats);
  });

  // Derived files (trends/funding/yc) are computed once per DB state: the cache key changes whenever a
  // refresh succeeded or the item count moved, which is exactly when the static build would differ.
  // The signals payload is part of the key so the digest highlights follow the latest signal run.
  const derivedCache = { key: null, value: null };
  function signalsPayload() {
    return db.kvGet(SIGNALS_KV_KEY) ?? EMPTY_SIGNALS;
  }
  function derived() {
    const signals = signalsPayload();
    const key = `${db.lastRefresh()}|${db.countItems()}|${signals.generatedAt}`;
    if (derivedCache.key !== key) {
      derivedCache.value = buildDerived({ db, sources, env, signals, publicUrl: config.publicUrl });
      derivedCache.key = key;
    }
    return derivedCache.value;
  }

  app.get('/data/trends.json', (req, res) => {
    res.json(derived().trends);
  });

  app.get('/data/funding.json', (req, res) => {
    res.json(derived().funding);
  });

  app.get('/data/yc.json', (req, res) => {
    res.json(derived().yc);
  });

  // Signals are persisted by the refresh engine in kv (plan D8); before the first refresh the empty shape is served.
  app.get('/data/signals.json', (req, res) => {
    res.json(signalsPayload());
  });

  app.get('/data/digest.json', (req, res) => {
    res.json(derived().digest);
  });

  app.get('/feed.xml', (req, res) => {
    res.setHeader('Content-Type', 'application/atom+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(derived().feedXml);
  });

  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }));

  // Extensionless page routes (/sources -> public/sources.html, ... /notebook -> public/notebook.html).
  for (const page of PAGES) {
    app.get(`/${page}`, (req, res) => {
      res.sendFile(path.join(PUBLIC_DIR, `${page}.html`));
    });
  }

  app.get('/health', (req, res) => {
    res.json({ ok: true, items: db.countItems(), lastRefresh: db.lastRefresh() });
  });

  app.get('/api/items', (req, res) => {
    const parsed = parseItemsQuery(req.query, sourceById);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { params } = parsed;
    const { items, total } = db.queryItems(params);
    for (const item of items) {
      item.source.name = nameOf(item.source.id);
      decorateItem(item);
    }
    res.json({
      items,
      page: params.page,
      limit: params.limit,
      total,
      hasMore: params.page * params.limit < total,
    });
  });

  app.get('/api/sources', (req, res) => {
    res.json(sourcesPayload({ db, sources, env }));
  });

  app.get('/api/stats', (req, res) => {
    res.json(db.getStats());
  });

  app.post('/api/refresh', async (req, res, next) => {
    try {
      if (!config.adminToken) return res.status(404).json({ error: 'not found' });
      const token = bearerToken(req);
      if (!tokenMatches(token, config.adminToken)) return res.status(401).json({ error: 'unauthorized' });
      if (refresh.isRunning()) return res.status(409).json({ running: true });
      const summary = await refresh.runRefreshCycle();
      res.json({
        ok: true,
        durationMs: summary.durationMs,
        sources: summary.sources.map(({ id, ok, count, error, durationMs }) => ({ id, ok, count, error, durationMs })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[app] unhandled error:', err?.message ?? err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
