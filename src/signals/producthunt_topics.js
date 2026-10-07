// Signal: Product Hunt topics ordered by follower count (GraphQL API v2). Needs PRODUCTHUNT_TOKEN;
// without it the signal is reported as "not configured (PRODUCTHUNT_TOKEN)". The topics query shape follows
// the v2 schema and is not live-verified (plan §0.2 f).

export const PH_GRAPHQL_URL = 'https://api.producthunt.com/v2/api/graphql';
export const PH_TOPICS_QUERY = 'query { topics(order: FOLLOWERS_COUNT, first: 20) { edges { node { name slug url followersCount postsCount } } } }';

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function mapTopicNode(node) {
  return {
    name: String(node.name ?? ''),
    slug: typeof node.slug === 'string' ? node.slug : null,
    url: typeof node.url === 'string' ? node.url : null,
    followersCount: num(node.followersCount),
    postsCount: num(node.postsCount),
  };
}

export function mapTopics(body) {
  if (body?.errors?.length) {
    throw new Error(`Product Hunt GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  const edges = Array.isArray(body?.data?.topics?.edges) ? body.data.topics.edges : [];
  return { topics: edges.filter((e) => e?.node?.name).map((e) => mapTopicNode(e.node)) };
}

export default {
  id: 'producthunt_topics',
  name: 'Product Hunt: topics',
  homepage: 'https://www.producthunt.com/topics',
  description: 'the 20 Product Hunt topics with the most followers; follower and post counts are the API\'s numbers at fetch time',
  enabled: (env) => Boolean(env?.PRODUCTHUNT_TOKEN),
  requires: 'PRODUCTHUNT_TOKEN',
  async fetch(ctx) {
    const body = await ctx.http.fetchJson(PH_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.env.PRODUCTHUNT_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: PH_TOPICS_QUERY }),
      signal: ctx.signal,
    });
    return mapTopics(body);
  },
};
