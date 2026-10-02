import { stripHtml } from './normalize.js';

function numberOrOmit(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

/** Algolia HN hit -> raw adapter item (shared by Show HN and Launch HN). */
export function mapHnHit(hit) {
  const hnUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
  return {
    title: hit.title,
    url: hit.url || hnUrl,
    summary: stripHtml(hit.story_text || ''),
    publishedAt: hit.created_at,
    extra: compact({
      points: numberOrOmit(hit.points),
      comments: numberOrOmit(hit.num_comments),
      author: hit.author ?? undefined,
      hnUrl,
    }),
  };
}
