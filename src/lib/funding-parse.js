// Funding amount + stage parser (plan D6). Pure text rules over the title first, then the summary.
// Displayed as "parsed from headline". Does not decide whether an item *is* a funding story -
// that is classifyKind() in ./classify.js - so "a $10 billion market" still yields an amount.

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

function currencyOf(token) {
  if (!token) return null;
  return CURRENCY_OF[token.toLowerCase()] ?? null;
}

/** First amount in `text` -> { amount, currency, amountText } or null. */
export function parseAmount(text) {
  const s = String(text ?? '');
  AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = AMOUNT_RE.exec(s)) !== null) {
    const [raw, prefix, number, multiplier, suffix] = m;
    const mult = multiplier ? multiplier.toLowerCase() : null;
    let currency = currencyOf(prefix) ?? currencyOf(suffix);
    if (!currency && mult && INR_ONLY_MULTIPLIERS.has(mult)) currency = 'INR';
    if (!currency) continue; // a bare number is not an amount
    const n = Number(number.replaceAll(',', ''));
    if (!Number.isFinite(n)) continue;
    const amount = Math.round(n * (mult ? MULTIPLIER_OF[mult] : 1));
    return { amount, currency, amountText: raw.trim() };
  }
  return null;
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
 *   parsedFrom: 'title'|'summary'|null }
 * `parsedFrom` names the field the amount came from (the stage's field when there is no amount).
 */
export function parseFunding(title, summary = '') {
  const fields = [['title', title], ['summary', summary]];
  let amount = null;
  let stage = null;
  let parsedFrom = null;
  let stageFrom = null;
  for (const [name, text] of fields) {
    if (!amount) {
      const found = parseAmount(text);
      if (found) {
        amount = found;
        parsedFrom = name;
      }
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
    parsedFrom: parsedFrom ?? stageFrom,
  };
}
