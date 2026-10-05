// Shared text helpers (DOM-free; plan D5). Used by src/trends.js in Node and by the browser's
// related-items label, so both describe the same method: tokenize() from ./filter.js, drop stopwords,
// short tokens and pure numbers, light de-pluralisation, adjacent-pair bigrams.

import { tokenize } from './filter.js';

/** English function words + feed boilerplate that would otherwise dominate every count. */
export const STOPWORDS = new Set([
  // function words
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'was', 'were', 'has', 'have',
  'had', 'but', 'not', 'all', 'any', 'can', 'its', 'our', 'out', 'over', 'than', 'then', 'them', 'they', 'their',
  'there', 'these', 'those', 'what', 'when', 'where', 'which', 'who', 'why', 'how', 'will', 'would', 'could',
  'should', 'about', 'after', 'before', 'also', 'just', 'more', 'most', 'some', 'such', 'only', 'other', 'per',
  'via', 'own', 'off', 'one', 'two', 'now', 'get', 'got', 'use', 'using', 'used', 'make', 'makes', 'made', 'like',
  'help', 'helps', 'lets', 'let', 'want', 'need', 'without', 'within', 'while', 'being', 'been', 'does', 'did',
  'each', 'every', 'much', 'many', 'very', 'here', 'back', 'still', 'first', 'last', 'next', 'under', 'between',
  'through', 'against', 'because', 'both', 'few', 'same', 'too', 'yet', 'way', 'well', 'say', 'says',
  // feed boilerplate
  'show', 'hn', 'launch', 'ask', 'tell', 'startup', 'startups', 'company', 'companies', 'new', 'app', 'apps',
  'platform', 'yc', 'inc', 'ltd', 'raises', 'raised', 'million', 'billion', 'funding', 'round', 'series', 'seed',
  'announces', 'launches', 'today', 'tool', 'tools', 'build', 'built', 'building', 'open', 'source', 'free',
]);

const PURE_NUMBER_RE = /^\d+$/;
const KEEP_PLURAL_RE = /(ss|us|is)$/;

/** Light de-pluralisation: strip a final "s" when the word is longer than 4 and does not end in ss/us/is. */
export function singularize(token) {
  if (token.length > 4 && token.endsWith('s') && !KEEP_PLURAL_RE.test(token)) return token.slice(0, -1);
  return token;
}

/** tokenize(text) minus stopwords, tokens shorter than 3, pure numbers; de-pluralised. Keeps order and repeats. */
export function significantTokens(text) {
  const out = [];
  for (const raw of tokenize(text)) {
    if (raw.length < 3 || PURE_NUMBER_RE.test(raw) || STOPWORDS.has(raw)) continue;
    const token = singularize(raw);
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/** Adjacent pairs of one token list, joined with a space ("machine learning"). */
export function bigrams(tokens) {
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}
