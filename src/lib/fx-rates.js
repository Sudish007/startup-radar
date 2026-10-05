// Static FX table (plan D6). `rates[c]` = US dollars per one unit of currency `c`, 3 significant digits,
// derived from the ECB euro reference rates published on `asOf` (EUR/USD 1.1204, EUR/GBP 0.84720,
// EUR/INR 107.8915). Used only to sort and sum funding amounts; every display says "approx. USD at static rates".

export const FX = Object.freeze({
  asOf: '2026-10-05',
  source: 'ECB reference rates',
  rates: Object.freeze({ USD: 1, EUR: 1.12, GBP: 1.32, INR: 0.0104 }),
});

/** amount in `currency` -> approximate USD (rounded to whole dollars), or null when unknown. */
export function toUsd(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const rate = FX.rates[currency];
  if (typeof rate !== 'number') return null;
  return Math.round(amount * rate);
}
