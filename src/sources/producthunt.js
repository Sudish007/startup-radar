import { feedItemToRaw } from '../lib/rss.js';
import { stripHtml } from '../lib/normalize.js';

// Two modes:
//  - PRODUCTHUNT_TOKEN set  -> GraphQL API v2 (gives votesCount). Errors are thrown,
//    never silently downgraded, so a bad token is visible on /sources.
//  - otherwise              -> public Atom feed (no vote counts; ordered by <updated>,
//    so <published> is used as the item date).
const GRAPHQL_URL = 'https://api.producthunt.com/v2/api/graphql';
const ATOM_URL = 'https://www.producthunt.com/feed';
const QUERY =
  'query { posts(order: NEWEST, first: 50) { edges { node { id name tagline url votesCount createdAt website } } } }';
const PLACEHOLDER_SNIPPET_RE = /^\s*Discussion\s*\|\s*Link\s*$/i;

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

/** GraphQL post node -> raw item. */
export function mapGraphqlNode(node) {
  return {
    title: node.name,
    url: node.url,
    summary: node.tagline || '',
    publishedAt: node.createdAt,
    extra: compact({ votes: node.votesCount, website: node.website }),
  };
}

/** First <p> of an HTML string as plain text, or null. */
function firstParagraph(html) {
  const m = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html || '');
  return m ? stripHtml(m[1]) : null;
}

/** Atom entry (rss-parser item) -> raw item. */
export function mapAtomItem(item) {
  const raw = feedItemToRaw(item);
  if (!item.contentSnippet || PLACEHOLDER_SNIPPET_RE.test(item.contentSnippet)) {
    raw.summary = firstParagraph(item.content) || stripHtml(item.content || '');
  }
  raw.publishedAt = item.published || item.isoDate || null;
  raw.extra = compact({ ...raw.extra, author: item.author ?? raw.extra.author, via: 'atom' });
  return raw;
}

async function fetchGraphql(ctx, token) {
  const body = await ctx.http.fetchJson(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: QUERY }),
    signal: ctx.signal,
  });
  if (body.errors?.length) {
    throw new Error(`Product Hunt GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return (body.data?.posts?.edges ?? []).map((edge) => mapGraphqlNode(edge.node));
}

async function fetchAtom(ctx) {
  const feed = await ctx.rss.fetchFeed(ATOM_URL, ctx);
  return (feed.items ?? []).map(mapAtomItem);
}

export default {
  id: 'producthunt',
  name: 'Product Hunt',
  homepage: 'https://www.producthunt.com/',
  kind: 'launch',
  region: 'global',
  enabled: () => true,
  requires: null,
  async fetch(ctx) {
    const token = ctx.env?.PRODUCTHUNT_TOKEN;
    return token ? fetchGraphql(ctx, token) : fetchAtom(ctx);
  },
};
