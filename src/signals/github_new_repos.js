// Signal: GitHub repositories created in the last 7 days, ordered by stars (GitHub search API).
// Unauthenticated search allows 10 requests/minute; GITHUB_TOKEN (Actions passes github.token) raises it to 30.

export const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
export const GITHUB_LABEL = 'stars since creation (<= 7 days)';
export const SINCE_DAYS = 7;
export const MAX_DESCRIPTION = 200;
export const MAX_TOPICS = 8;

/** 'YYYY-MM-DD' of `now` minus 7 days (UTC). */
export function sinceDate(now = new Date()) {
  return new Date(now.getTime() - SINCE_DAYS * 24 * 3600_000).toISOString().slice(0, 10);
}

export function searchUrl(now = new Date()) {
  const q = encodeURIComponent(`created:>=${sinceDate(now)}`);
  return `${GITHUB_SEARCH_URL}?q=${q}&sort=stars&order=desc&per_page=50`;
}

/** Request headers; the Authorization header is present only when GITHUB_TOKEN is set. */
export function requestHeaders(env = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = typeof env.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Search item -> { fullName, url, description, stars, language, topics, createdAt }. */
export function mapRepo(item) {
  const description = typeof item.description === 'string' ? item.description.replace(/\s+/g, ' ').trim() : '';
  return {
    fullName: String(item.full_name ?? ''),
    url: String(item.html_url ?? ''),
    description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
    stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
    language: typeof item.language === 'string' ? item.language : null,
    topics: (Array.isArray(item.topics) ? item.topics : []).filter((t) => typeof t === 'string').slice(0, MAX_TOPICS),
    createdAt: item.created_at ?? null,
  };
}

export function mapGithub(body, { now = new Date(), authenticated = false } = {}) {
  const items = Array.isArray(body?.items) ? body.items : [];
  return {
    since: sinceDate(now),
    authenticated,
    label: GITHUB_LABEL,
    repos: items.filter((r) => r && r.full_name && r.html_url).map(mapRepo),
  };
}

export default {
  id: 'github_new_repos',
  name: 'GitHub: new repositories',
  homepage: 'https://github.com/trending',
  description: 'the 50 most-starred repositories created in the last 7 days, as returned by the GitHub search API at fetch time',
  enabled: () => true,
  requires: null,
  async fetch(ctx) {
    const now = ctx.now ?? new Date();
    const headers = requestHeaders(ctx.env ?? {});
    const body = await ctx.http.fetchJson(searchUrl(now), { headers, signal: ctx.signal });
    return mapGithub(body, { now, authenticated: 'Authorization' in headers });
  },
};
