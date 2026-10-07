// Startup Radar: conservative same-story grouping of funding items (DOM-free; shared by src/digest.js in Node
// and public/funding.js in the browser, like ./text.js). Two funding items are one story only when all of
//   1. they were published within GROUP_WINDOW_MS (3 days) of each other;
//   2. their titles share a company-name token: a word with a capital letter, at least 4 characters long, that is
//      not a stopword, a generic business / sector / round / money word, a nationality or a place ("ElevenLabs",
//      "Spiko"). In an all-capitalised (Title Case) headline only the words before the first money figure or raise
//      verb count, because there the capitals carry no information ("Zomint Raises Rs 36 Cr To Scale ..." -> Zomint);
//      a Title Case headline without either yields no token at all;
//   3. their parsed money figures agree: the same approx. USD amount, or - when one of them has no amount - the
//      same valuation (figure and currency). Items with different amounts are never grouped.
// A group is rendered as one row led by the newest item that has an amount; the rest are "also reported by" links.

import { compareNewestFirst } from './filter.js';
import { STOPWORDS } from './text.js';

export const GROUP_WINDOW_MS = 3 * 86_400_000;
/** The one-line label every grouped row shows (the funding page imports it; digest.json carries it as roundsGrouping). */
export const GROUP_RULE = 'grouped: same parsed amount (or valuation) and shared company name, published within 3 days';
const MIN_TOKEN = 4;

/** Capitalised words that name no company: business nouns, sectors, round and money words, verbs, time, places. */
const COMMON = new Set([
  // business nouns and generic name parts
  'startup', 'startups', 'company', 'companies', 'firm', 'firms', 'brand', 'business', 'businesses', 'platform', 'platforms', 'technologies', 'technology',
  'tech', 'labs', 'ventures', 'venture', 'capital', 'partners', 'partner', 'group', 'holdings', 'systems', 'solutions', 'software', 'networks', 'network',
  'robotics', 'therapeutics', 'biotech', 'genomics', 'mobile', 'digital', 'global', 'international', 'space', 'aerospace', 'clinical', 'medical', 'health',
  'healthcare', 'healthtech', 'medtech', 'fintech', 'edtech', 'insurtech', 'proptech', 'agritech', 'cleantech', 'climatetech', 'deeptech', 'foodtech', 'legaltech',
  'finance', 'financial', 'payments', 'banking', 'bank', 'banks', 'lending', 'wealth', 'insurance', 'insurers', 'analytics', 'security', 'cybersecurity', 'cyber',
  'cloud', 'data', 'quantum', 'computing', 'computer', 'intelligence', 'automation', 'autonomous', 'logistics', 'commerce', 'ecommerce', 'retail', 'consumer',
  'enterprise', 'infrastructure', 'energy', 'solar', 'battery', 'climate', 'mobility', 'electric', 'vehicles', 'gaming', 'games', 'media', 'marketing', 'sales',
  'education', 'learning', 'fitness', 'wellness', 'fashion', 'beauty', 'travel', 'hospitality', 'food', 'delivery', 'agriculture', 'farming', 'manufacturing',
  'industrial', 'construction', 'real', 'estate', 'property', 'defence', 'defense', 'drones', 'drone', 'satellite', 'satellites', 'semiconductor', 'chips',
  'hardware', 'devices', 'voice', 'video', 'audio', 'search', 'social', 'creator', 'creators', 'workspace', 'workflow', 'agents', 'agent', 'assistant',
  'model', 'models', 'foundation', 'operating', 'layer', 'electronics', 'portfolio', 'product', 'products', 'service', 'services', 'management', 'operations',
  'engineering', 'design', 'developer', 'developers', 'team', 'market', 'markets', 'industry', 'sector', 'studio', 'studios', 'house', 'world', 'life',
  'science', 'sciences', 'research', 'institute', 'university', 'college', 'colleges', 'school', 'schools', 'skilling', 'trade', 'trading', 'exchange', 'crypto',
  'blockchain', 'stablecoin', 'wallet', 'pension', 'credit', 'loans', 'receivables', 'customers', 'patients', 'doctors', 'homeowners', 'drivers', 'founders', 'founder',
  // round, money and funding verbs
  'raises', 'raise', 'raised', 'raising', 'secures', 'secured', 'lands', 'landed', 'closes', 'closed', 'bags', 'bagged', 'nabs', 'gets', 'picks', 'grabs', 'snags',
  'wins', 'takes', 'backs', 'backed', 'leads', 'joins', 'invests', 'investment', 'investments', 'investors', 'investor', 'funding', 'funds', 'fund', 'fundraise',
  'fundraising', 'round', 'rounds', 'seed', 'series', 'growth', 'debt', 'grant', 'grants', 'equity', 'financing', 'valuation', 'valued', 'valuing', 'worth',
  'unicorn', 'unicorns', 'million', 'billion', 'crore', 'crores', 'lakh', 'lakhs', 'cash', 'money', 'deal', 'deals', 'exclusive', 'report', 'reports', 'sources',
  'announces', 'announced', 'launches', 'launch', 'launched', 'acquires', 'acquired', 'acquisition', 'merger', 'expands', 'expand', 'expansion', 'scale', 'scales',
  'scaling', 'build', 'builds', 'building', 'boost', 'boosts', 'extension', 'tender', 'offer', 'employee', 'employees', 'share', 'shares', 'sale', 'stake',
  'stakes', 'doubles', 'triples', 'hits', 'reaches', 'becomes', 'emerges', 'stealth', 'backer', 'backers', 'alum', 'chief', 'bound', 'ahead', 'planned', 'public',
  // time and framing words that open or shape headlines
  'weekly', 'week', 'month', 'quarter', 'year', 'today', 'another', 'meet', 'inside', 'first', 'second', 'third', 'debut', 'newly', 'former', 'latest', 'biggest',
  'largest', 'major', 'nearly', 'over', 'from', 'with', 'into', 'after', 'before', 'under', 'more', 'than', 'about', 'this', 'that', 'these', 'those', 'what',
  'when', 'where', 'while', 'which', 'their', 'there', 'they', 'your', 'will', 'back', 'also', 'just', 'here', 'beyond',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'sept',
  // nationalities and places
  'africa', 'african', 'america', 'american', 'americas', 'asia', 'asian', 'australia', 'australian', 'austria', 'austrian', 'bangalore', 'bengaluru', 'belgium',
  'belgian', 'berlin', 'boston', 'brazil', 'brazilian', 'britain', 'british', 'california', 'canada', 'canadian', 'chicago', 'china', 'chinese', 'colombia',
  'colombian', 'copenhagen', 'delhi', 'denmark', 'danish', 'dubai', 'dublin', 'egypt', 'egyptian', 'estonia', 'estonian', 'europe', 'european', 'finland',
  'finnish', 'france', 'french', 'germany', 'german', 'ghana', 'ghanaian', 'gurugram', 'hamburg', 'hyderabad', 'india', 'indian', 'indonesia', 'indonesian',
  'ireland', 'irish', 'israel', 'israeli', 'italy', 'italian', 'japan', 'japanese', 'kenya', 'kenyan', 'korea', 'korean', 'lagos', 'latam', 'latin', 'lisbon',
  'london', 'madrid', 'mexico', 'mexican', 'milan', 'mumbai', 'munich', 'nairobi', 'netherlands', 'dutch', 'nigeria', 'nigerian', 'norway', 'norwegian', 'pakistan',
  'pakistani', 'paris', 'poland', 'polish', 'portugal', 'portuguese', 'pune', 'rwanda', 'singapore', 'singaporean', 'south', 'north', 'east', 'west', 'spain',
  'spanish', 'stockholm', 'sweden', 'swedish', 'switzerland', 'swiss', 'sydney', 'tokyo', 'toronto', 'turkey', 'turkish', 'ukraine', 'ukrainian', 'united',
  'kingdom', 'states', 'vietnam', 'vietnamese', 'york', 'zurich', 'amsterdam', 'barcelona', 'bangkok', 'cairo', 'chennai', 'kolkata', 'jakarta', 'manila',
  'melbourne', 'seoul', 'shanghai', 'shenzhen', 'taiwan', 'taiwanese', 'texas', 'austin', 'seattle', 'francisco', 'angeles', 'valley', 'silicon', 'saudi', 'arabia',
  'emirates', 'qatar', 'amazon', 'argentine', 'argentina', 'chile', 'chilean', 'peru', 'peruvian', 'uruguay', 'uruguayan', 'nordic', 'nordics',
  'baltic', 'baltics', 'mena', 'apac', 'emea',
]);

const WORD_SPLIT_RE = /[^\p{L}\p{N}'\u2019]+/u;
const POSSESSIVE_RE = /(?:['\u2019]s|['\u2019])$/u;
const ALPHA_RE = /^\p{L}+$/u;
const UPPER_RE = /\p{Lu}/u;
const DIGITS_RE = /^\p{N}/u; // "22BN", "300M": money figures are not names
/** First money figure or raise verb of a headline (the cut for Title Case titles). */
const CUT_RE = /(?:US\$|\$|\u20AC|\u00A3|\u20B9|\bRs\.?\s?|\bINR\s?|\bEUR\s?|\bUSD\s?|\bGBP\s?)\d|\b\d[\d,.]*\s?(?:million|billion|mn|bn|crores?|cr|lakhs?|k|m|b)\b|\b(?:raises?|raised|raising|secures?|secured|lands?|landed|closes?|closed|bags?|bagged|nabs?|nabbed|gets?|picks? up|grabs?|snags?|wins?|takes? on|backs?|leads?|invests?)\b/iu;

const words = (title) => String(title ?? '').split(WORD_SPLIT_RE).map((w) => w.replace(POSSESSIVE_RE, '')).filter(Boolean);

/** Most words after the first one capitalised (3+ alphabetic words of 4+ letters, >= 60 % capitalised). */
export function isTitleCase(title) {
  const long = words(title).slice(1).filter((w) => w.length >= MIN_TOKEN && ALPHA_RE.test(w));
  if (long.length < 3) return false;
  return long.filter((w) => UPPER_RE.test(w[0])).length / long.length >= 0.6;
}

/** Lower-cased company-name candidates of a headline (rule 2) as a Set. */
export function companyTokens(title) {
  let text = String(title ?? '');
  if (isTitleCase(text)) {
    const cut = CUT_RE.exec(text);
    if (!cut) return new Set();
    text = text.slice(0, cut.index);
  }
  const out = new Set();
  for (const w of words(text)) {
    if (w.length < MIN_TOKEN || DIGITS_RE.test(w) || !UPPER_RE.test(w)) continue;
    const lower = w.toLowerCase();
    if (COMMON.has(lower) || STOPWORDS.has(lower)) continue;
    out.add(lower);
  }
  return out;
}

const usdOf = (item) => (typeof item?.usdApprox === 'number' && Number.isFinite(item.usdApprox) ? item.usdApprox : null);
const valuationOf = (item) => (typeof item?.funding?.valuation === 'number' && Number.isFinite(item.funding.valuation) ? item.funding.valuation : null);

/** Rule 3: equal approx. USD amounts, or equal valuations (figure + currency) when an amount is missing. */
export function sameFigure(a, b) {
  const ua = usdOf(a);
  const ub = usdOf(b);
  if (ua !== null && ub !== null) return ua === ub;
  const va = valuationOf(a);
  const vb = valuationOf(b);
  return va !== null && vb !== null && va === vb && a.funding.valuationCurrency === b.funding.valuationCurrency;
}

/** Rule 1: both dates parse and lie within GROUP_WINDOW_MS of each other. */
export function withinWindow(a, b) {
  const ta = Date.parse(a?.publishedAt);
  const tb = Date.parse(b?.publishedAt);
  return !Number.isNaN(ta) && !Number.isNaN(tb) && Math.abs(ta - tb) <= GROUP_WINDOW_MS;
}

/** All three rules; `aTokens` may pass companyTokens(a.title) precomputed. */
export function sameStory(a, b, aTokens = companyTokens(a?.title)) {
  if (!aTokens.size || !withinWindow(a, b) || !sameFigure(a, b)) return false;
  for (const t of companyTokens(b?.title)) if (aTokens.has(t)) return true;
  return false;
}

/** approx. USD descending, items without an amount last, newest first within a tie. */
export function compareUsdDesc(a, b) {
  const ua = usdOf(a) ?? -1;
  const ub = usdOf(b) ?? -1;
  return ub - ua || compareNewestFirst(a, b);
}

/**
 * groupFunding(items, compare) -> [{ item, also: [item...] }] in `compare` order (default compareUsdDesc). The first
 * ungrouped item in that order leads a group and takes every later item that is the same story (judged against the
 * lead), so the lead is the highest-ranked / newest member and the amount-less reports of a round hang off its row.
 */
export function groupFunding(items, compare = compareUsdDesc) {
  const sorted = [...items].sort(compare);
  const used = new Set();
  const out = [];
  for (const lead of sorted) {
    if (used.has(lead)) continue;
    used.add(lead);
    const also = [];
    const tokens = companyTokens(lead.title);
    if (tokens.size) {
      for (const other of sorted) {
        if (!used.has(other) && sameStory(lead, other, tokens)) {
          used.add(other);
          also.push(other);
        }
      }
    }
    out.push({ item: lead, also });
  }
  return out;
}
