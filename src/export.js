import { EXPLORE_MORE } from './explore.js';

/** Caps for the static export (see plan: 90 days, 3000 items, 800 / 600 KB primary file). */
export const EXPORT_LIMITS = { maxDays: 90, maxItems: 3000, primaryMaxItems: 800, primaryMaxBytes: 600_000 };

/** The /api/sources payload: registry + status rows + item counts + the explore list. */
export function sourcesPayload({ db, sources, env = process.env }) {
  const statuses = db.getSourceStatuses();
  const counts = db.itemCountsBySource();
  const list = sources.map((s) => {
    const st = statuses.get(s.id) ?? {};
    return {
      id: s.id,
      name: s.name,
      homepage: s.homepage,
      kind: s.kind,
      region: s.region,
      enabled: Boolean(s.enabled(env)),
      requires: s.requires ?? null,
      lastRunAt: st.last_run_at ?? null,
      lastSuccessAt: st.last_success_at ?? null,
      lastError: st.last_error ?? null,
      lastDurationMs: st.last_duration_ms ?? null,
      lastItemCount: st.last_item_count ?? null,
      itemCount: counts[s.id] ?? 0,
    };
  });
  return { sources: list, exploreMore: EXPLORE_MORE };
}

/**
 * Items within the export window, newest first, with `source.name` filled from the registry.
 * Returns { items, archive }: `archive` is null unless the full set exceeds `primaryMaxBytes`.
 */
export function itemsPayload({ db, sources, now = new Date(), limits = EXPORT_LIMITS }) {
  const nameOf = new Map(sources.map((s) => [s.id, s.name]));
  const since = new Date(now.getTime() - limits.maxDays * 24 * 3600_000).toISOString();
  const all = db.listItems({ since, limit: limits.maxItems });
  for (const item of all) item.source.name = nameOf.get(item.source.id) ?? item.source.id;

  if (Buffer.byteLength(JSON.stringify(all)) <= limits.primaryMaxBytes) {
    return { items: all, archive: null };
  }
  return { items: all.slice(0, limits.primaryMaxItems), archive: all.slice(limits.primaryMaxItems) };
}

export function statsPayload({ db, now = new Date(), archiveItems = 0 }) {
  return { ...db.getStats(), generatedAt: now.toISOString(), archiveItems };
}

/** Everything the static build writes: { items, archive, sources, stats }. */
export function buildSnapshot({ db, sources, env = process.env, now = new Date(), limits = EXPORT_LIMITS }) {
  const { items, archive } = itemsPayload({ db, sources, now, limits });
  return {
    items,
    archive,
    sources: sourcesPayload({ db, sources, env }),
    stats: statsPayload({ db, now, archiveItems: archive ? archive.length : 0 }),
  };
}
