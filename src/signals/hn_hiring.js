// Signal: keyword counts over the comments of the current "Ask HN: Who is hiring?" thread.
// Every number is "the number of distinct comments mentioning the term" (word-boundary, case-insensitive).

import { stripHtml } from '../lib/normalize.js';

export const HIRING_STORIES_URL = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10';
export const HIRING_TITLE_PREFIX = 'Ask HN: Who is hiring?';

export const HIRING_KEYWORDS = {
  languages: ['python', 'typescript', 'javascript', 'go', 'rust', 'java', 'kotlin', 'swift', 'c++', 'c#', 'ruby', 'elixir'],
  frameworks: ['react', 'next.js', 'node', 'django', 'rails', 'flutter', 'vue', 'svelte'],
  infra: ['aws', 'gcp', 'azure', 'kubernetes', 'postgres', 'terraform', 'snowflake', 'kafka'],
  'LLM/AI': ['llm', 'ai', 'machine learning', 'openai', 'anthropic'],
  'roles/modes': ['founding engineer', 'remote', 'onsite', 'hybrid', 'contract', 'intern', 'visa'],
};

export function commentsUrl(storyId) {
  return `https://hn.algolia.com/api/v1/search?tags=comment,story_${encodeURIComponent(String(storyId))}&hitsPerPage=1000`;
}

/** First story hit whose title starts with "Ask HN: Who is hiring?" ("Who wants to be hired?" is skipped). */
export function findHiringThread(hits) {
  return (Array.isArray(hits) ? hits : []).find((h) => typeof h?.title === 'string' && h.title.startsWith(HIRING_TITLE_PREFIX)) ?? null;
}

/** 'Ask HN: Who is hiring? (October 2026)' -> 'October 2026'; null when no parenthesised month. */
export function parseMonth(title) {
  const m = /\(([A-Z][a-z]+ \d{4})\)/.exec(String(title ?? ''));
  return m ? m[1] : null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive match of `term` not glued to letters/digits on either side (works for c++, c#, next.js). */
export function termRegex(term) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
}

/** [{ term, group, comments }] - comments = number of texts mentioning the term at least once. */
export function countKeywords(texts) {
  const list = Array.isArray(texts) ? texts : [];
  const out = [];
  for (const [group, terms] of Object.entries(HIRING_KEYWORDS)) {
    for (const term of terms) {
      const re = termRegex(term);
      out.push({ term, group, comments: list.reduce((n, t) => n + (re.test(t) ? 1 : 0), 0) });
    }
  }
  return out;
}

export function buildHiringData(thread, commentHits) {
  const texts = (Array.isArray(commentHits) ? commentHits : []).map((h) => stripHtml(h?.comment_text ?? ''));
  const month = parseMonth(thread.title);
  return {
    threadTitle: thread.title,
    threadUrl: `https://news.ycombinator.com/item?id=${thread.objectID}`,
    month,
    comments: texts.length,
    label: `mentions in ${texts.length} comments of the ${month ?? 'current'} thread`,
    keywords: countKeywords(texts),
  };
}

export default {
  id: 'hn_hiring',
  name: 'HN: Who is hiring?',
  homepage: 'https://news.ycombinator.com/submitted?id=whoishiring',
  description: 'number of comments in the current "Ask HN: Who is hiring?" thread that mention each keyword (word-boundary, case-insensitive)',
  enabled: () => true,
  requires: null,
  async fetch(ctx) {
    const stories = await ctx.http.fetchJson(HIRING_STORIES_URL, { signal: ctx.signal });
    const thread = findHiringThread(stories?.hits);
    if (!thread) throw new Error('no "Ask HN: Who is hiring?" story among the 10 newest whoishiring posts');
    const comments = await ctx.http.fetchJson(commentsUrl(thread.objectID), { signal: ctx.signal });
    return buildHiringData(thread, comments?.hits);
  },
};
