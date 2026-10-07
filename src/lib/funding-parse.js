// Funding amount + stage parser (plan D6). Pure text rules over the title first, then the summary.
// Displayed as "parsed from headline". Does not decide whether an item *is* a funding story -
// that is classifyKind() in ./classify.js - so "a $10 billion market" still yields an amount.
//
// Valuations are not round amounts (funding parser fix): a money figure in valuation context is
// recorded as `valuation`, never as `amount`. A figure is a valuation when
//   (1) "valuation" (or "unicorn", optionally "+" / "pre-money" / "post-money") follows it directly:
//       "$22B valuation", "$40B+ valuation", "at a $1B valuation";
//   (2) "valuation", "valued", "valuing", "values", "worth" or "unicorn" occurs within the 4 words
//       before it with no raise word in between: "valuation to $22B", "valued at $2B", "worth $5B"
//       (but "unicorn MNT-Halan secures $76.5m" stays an amount);
//   (3) it follows "at" / "at a" after a round figure and a raise word: "raises $50M at $1B"
//       ("closes its third fund at $120 million" has no round figure before the "at", so it stays an amount).
// A round noun right after the figure overrides (2) and (3): "becomes a unicorn with $150M Series C"; "deals worth
// €3.9 billion" is an aggregate, not a valuation. Two figures with only punctuation or a conversion word between
// them ("€892.4 million ($1 billion) valuation") are one figure: the first is kept, the restatement is dropped.
// Windows never cross another money figure, so "$255.5M at $2.5B valuation" keeps $255.5M as the amount.
// Among the remaining figures the amount is the one closest to a raise word (raises, secures, lands,
// closes, bags, nabs, gets, picks up, round, seed, Series, funding, investment, tender offer, debt,
// grant, ...), the first one when the text has no raise word. A headline with only a valuation
// figure has amount null, so it is never ranked or summed.

const PREFIX = '(US\\$|USD|\\$|\u20AC|EUR|\u00A3|GBP|Rs\\.?|\u20B9|INR)';
const NUMBER = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const MULTIPLIER = '(?:\\s*(thousand|million|billion|crores?|lakhs?|mn|mm|bn|k|m|b|cr)\\b)?';
const SUFFIX = '(?:\\s*(USD|EUR|GBP|INR|dollars?|euros?|pounds?|rupees?)\\b)?';

// Groups: 1 prefix, 2 number, 3 multiplier, 4 suffix.
const AMOUNT_RE = new RegExp(`(?<![A-Za-z\\d.])(?:${PREFIX}\\s?)?${NUMBER}${MULTIPLIER}${SUFFIX}`, 'gi');

const CURRENCY_OF = {
  '$': 'USD', 'us$': 'USD', usd: 'USD', dollar: 'USD', dollars: 'USD',
  '\u20AC': 'EUR', eur: 'EUR', euro: 'EUR', euros: 'EUR',
  '\u00A3': 'GBP', gbp: 'GBP', pound: 'GBP', pounds: 'GBP',
  rs: 'INR', 'rs.': 'INR', '\u20B9': 'INR', inr: 'INR', rupee: 'INR', rupees: 'INR',
};

const MULTIPLIER_OF = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, mm: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  lakh: 1e5, lakhs: 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7,
};

const INR_ONLY_MULTIPLIERS = new Set(['lakh', 'lakhs', 'cr', 'crore', 'crores']);

const PRE_SEED_RE = /\bpre-?seed\b/i;
const STAGE_RE = /\b(seed|series[\s-]?([a-h])\d?|bridge(?= (round|financing|funding|loan))|growth(?= (round|equity|funding|stage|capital|investment))|debt|grant)\b/i;

/** Raise verbs and round nouns: the words an amount sits next to. */
const RAISE_WORDS = 'raises?|raised|raising|secures?|secured|lands?|landed|closes?|closed|bags?|bagged|nabs?|nabbed|gets?|got|picks? up|picked up|grabs?|grabbed|snags?|wins?|won|takes? on|took on|rounds?|seed|series|funding|investment|financing|fundraise|fundraising|tender offers?|debt|grants?|loan|facility';
const RAISE_RE = new RegExp(`\\b(?:${RAISE_WORDS})\\b`, 'i');
const RAISE_ALL_RE = new RegExp(`\\b(?:${RAISE_WORDS})\\b`, 'gi');
/** Valuation vocabulary before a figure ("valuation to $22B", "valued at $2B", "worth $5B"). */
const VALUATION_WORD_RE = /\b(?:valuations?|valued|valuing|values|worth|unicorns?|decacorns?)\b/gi;
/** "deals worth €3.9 billion", "rounds worth $1B": an aggregate of money raised, not a valuation. */
const AGGREGATE_WORTH_RE = /\b(?:deals?|rounds?|funding|investments?|transactions?|financing|raises?|raised)\s+worth$/i;
/** Valuation noun directly after a figure ("$22B valuation", "$40B+ valuation", "$1B post-money valuation"). */
const VALUATION_AFTER_RE = /^\s*\)?\s*\+?\s*(?:(?:pre|post)[- ]money\s+)?(?:valuations?|unicorn)\b/i;
/** A round noun directly after a figure keeps it an amount even in valuation context ("unicorn with $150M Series C"). */
const ROUND_AFTER_RE = /^\s*(?:in\s+(?:a|an|its)\s+|in\s+)?(?:pre-?seed|seed|series\s?[a-h]\b|rounds?|funding|financing|investment|debt|grants?|tender offers?|fundraise)\b/i;
/** "... at $1B" / "... at a $1B" after a raise word. */
const AT_TAIL_RE = /\bat(?:\s+(?:a|an|the|its))?\s*$/i;
/** Only punctuation or a conversion word between two figures: "€892.4 million ($1 billion)", "$50M, or €46M", "$5M (about €4.6M)". */
const CONVERSION_GLUE_RE = /^\s*[,(\[]?\s*(?:or|about|around|approx\.?|approximately|roughly|some|nearly|~|\u2248|c\.|circa)?\s*$/i;
const CONTEXT_WORDS = 4;

function currencyOf(token) {
  if (!token) return null;
  return CURRENCY_OF[token.toLowerCase()] ?? null;
}

/** A regex match -> { amount, currency, amountText } or null for a bare number. */
function figureOf(m) {
  const [raw, prefix, number, multiplier, suffix] = m;
  const mult = multiplier ? multiplier.toLowerCase() : null;
  let currency = currencyOf(prefix) ?? currencyOf(suffix);
  if (!currency && mult && INR_ONLY_MULTIPLIERS.has(mult)) currency = 'INR';
  if (!currency) return null; // a bare number is not an amount
  const n = Number(number.replaceAll(',', ''));
  if (!Number.isFinite(n)) return null;
  return { amount: Math.round(n * (mult ? MULTIPLIER_OF[mult] : 1)), currency, amountText: raw.trim() };
}

/** Every money figure of `text` in order, with its character range. */
function figuresOf(text) {
  const out = [];
  AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = AMOUNT_RE.exec(text)) !== null) {
    const figure = figureOf(m);
    if (figure) out.push({ ...figure, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const lastWords = (s, n) => s.trim().split(/\s+/).filter(Boolean).slice(-n).join(' ');
const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Valuation context of one figure (or of a figure plus its glued conversions): `before` / `after` stop at the
 * neighbouring figures, `wholeBefore` is the text up to it, `afterAmount` says whether an amount figure precedes it.
 */
function isValuation(before, after, wholeBefore, afterAmount) {
  if (VALUATION_AFTER_RE.test(after)) return true;
  if (ROUND_AFTER_RE.test(after)) return false;
  const context = lastWords(before, CONTEXT_WORDS);
  VALUATION_WORD_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = VALUATION_WORD_RE.exec(context)) !== null) {
    if (m[0].toLowerCase() === 'worth' && AGGREGATE_WORTH_RE.test(context.slice(0, m.index + m[0].length))) continue;
    last = m.index + m[0].length;
  }
  if (last !== null && !RAISE_RE.test(context.slice(last))) return true;
  // "raises $50M at $1B": the "at" figure after a round figure and a raise word ("closes its fund at $120M" is not)
  return afterAmount && AT_TAIL_RE.test(context) && RAISE_RE.test(wholeBefore);
}

/** Figures with only punctuation or a conversion word between them form one group: the first is the figure, the rest restate it. */
function groupConversions(text, figures) {
  const groups = [];
  for (const f of figures) {
    const current = groups.at(-1);
    if (current && CONVERSION_GLUE_RE.test(text.slice(current.at(-1).end, f.start))) current.push(f);
    else groups.push([f]);
  }
  return groups;
}

/** Words between a figure and the nearest raise word of the text (Infinity when there is none). */
function raiseDistance(text, figure, raisePositions) {
  let best = Infinity;
  for (const [start, end] of raisePositions) {
    const d = end <= figure.start ? wordCount(text.slice(end, figure.start)) : start >= figure.end ? wordCount(text.slice(figure.end, start)) : 0;
    if (d < best) best = d;
  }
  return best;
}

/**
 * scanField(text) -> { amount: figure|null, valuation: figure|null } where figure = { amount, currency, amountText }.
 * The valuation is the first figure in valuation context; the amount is the remaining figure closest to a raise word.
 */
export function scanField(text) {
  const s = String(text ?? '');
  const groups = groupConversions(s, figuresOf(s));
  const candidates = [];
  let valuation = null;
  for (const [i, group] of groups.entries()) {
    const f = group[0];
    const before = s.slice(i > 0 ? groups[i - 1].at(-1).end : 0, f.start);
    const after = s.slice(group.at(-1).end, i + 1 < groups.length ? groups[i + 1][0].start : s.length);
    if (isValuation(before, after, s.slice(0, f.start), candidates.length > 0)) {
      if (!valuation) valuation = f;
    } else {
      candidates.push(f);
    }
  }
  let amount = candidates[0] ?? null; // no raise word anywhere: the first figure, as before
  if (candidates.length > 1) {
    const raisePositions = [...s.matchAll(RAISE_ALL_RE)].map((m) => [m.index, m.index + m[0].length]);
    let best = raiseDistance(s, amount, raisePositions);
    for (const f of candidates.slice(1)) {
      const d = raiseDistance(s, f, raisePositions);
      if (d < best) { best = d; amount = f; } // ties keep the earlier figure
    }
  }
  const strip = (f) => (f ? { amount: f.amount, currency: f.currency, amountText: f.amountText } : null);
  return { amount: strip(amount), valuation: strip(valuation) };
}

/** Round amount of `text` -> { amount, currency, amountText } or null (valuation figures are skipped). */
export function parseAmount(text) {
  return scanField(text).amount;
}

/** Valuation figure of `text` -> { amount, currency, amountText } or null. */
export function parseValuation(text) {
  return scanField(text).valuation;
}

/** First stage keyword in `text` -> normalised stage string or null. 'pre-seed' beats 'seed'. */
export function parseStage(text) {
  const s = String(text ?? '');
  if (PRE_SEED_RE.test(s)) return 'pre-seed';
  const m = STAGE_RE.exec(s);
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (word.startsWith('series')) return `series ${m[2].toLowerCase()}`;
  return word;
}

/**
 * parseFunding(title, summary) ->
 * { amount: number|null, currency: 'USD'|'EUR'|'GBP'|'INR'|null, amountText: string|null,
 *   stage: 'pre-seed'|'seed'|'series a'..'series h'|'bridge'|'growth'|'debt'|'grant'|null,
 *   amountFrom: 'title'|'summary'|null, stageFrom: 'title'|'summary'|null, parsedFrom: 'title'|'summary'|null,
 *   valuation: number|null, valuationCurrency: ...|null, valuationText: string|null, valuationFrom: 'title'|'summary'|null }
 * `amountFrom` / `stageFrom` / `valuationFrom` name the field each value came from (the page labels each with its
 * own field); `parsedFrom` is the amount's field, or the stage's field when there is no amount. The valuation is a
 * figure the text calls a valuation: it is reported separately and is never the amount.
 */
export function parseFunding(title, summary = '') {
  const fields = [['title', title], ['summary', summary]];
  let amount = null;
  let valuation = null;
  let stage = null;
  let amountFrom = null;
  let valuationFrom = null;
  let stageFrom = null;
  for (const [name, text] of fields) {
    const scan = scanField(text);
    if (!amount && scan.amount) {
      amount = scan.amount;
      amountFrom = name;
    }
    if (!valuation && scan.valuation) {
      valuation = scan.valuation;
      valuationFrom = name;
    }
    if (!stage) {
      const found = parseStage(text);
      if (found) {
        stage = found;
        stageFrom = name;
      }
    }
  }
  return {
    amount: amount?.amount ?? null,
    currency: amount?.currency ?? null,
    amountText: amount?.amountText ?? null,
    stage,
    amountFrom,
    stageFrom,
    parsedFrom: amountFrom ?? stageFrom,
    valuation: valuation?.amount ?? null,
    valuationCurrency: valuation?.currency ?? null,
    valuationText: valuation?.amountText ?? null,
    valuationFrom,
  };
}
