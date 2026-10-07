import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFunding, parseAmount, parseStage, parseValuation, scanField } from '../src/lib/funding-parse.js';
import { FX, toUsd } from '../src/lib/fx-rates.js';

/** Expected parseFunding() result: parsedFrom is the amount's field, else the stage's; no valuation unless `val` is given. */
const exp = (amount, currency, amountText, stage, amountFrom, stageFrom, val = null) => ({
  amount, currency, amountText, stage, amountFrom, stageFrom, parsedFrom: amountFrom ?? stageFrom,
  valuation: val?.amount ?? null, valuationCurrency: val?.currency ?? null, valuationText: val?.text ?? null, valuationFrom: val?.from ?? null,
});
const val = (amount, currency, text, from = 'title') => ({ amount, currency, text, from });
const NONE = exp(null, null, null, null, null, null);

// [title, summary, expected]
const FIXTURES = [
  ['Acme raises $4M seed', '', exp(4_000_000, 'USD', '$4M', 'seed', 'title', 'title')],
  ['Beta lands $12 million Series A', '', exp(12_000_000, 'USD', '$12 million', 'series a', 'title', 'title')],
  ['Gamma secures Rs 50 crore', '', exp(500_000_000, 'INR', 'Rs 50 crore', null, 'title', null)],
  ['Delta bags EUR 4M pre-seed', '', exp(4_000_000, 'EUR', 'EUR 4M', 'pre-seed', 'title', 'title')],
  ['Epsilon closes £2.5m round', '', exp(2_500_000, 'GBP', '\u00A32.5m', null, 'title', null)],
  ['Zeta raises $1.2B Series D', '', exp(1_200_000_000, 'USD', '$1.2B', 'series d', 'title', 'title')],
  ['Eta raises $750k', '', exp(750_000, 'USD', '$750k', null, 'title', null)],
  ['Theta nabs US$ 10 mn', '', exp(10_000_000, 'USD', 'US$ 10 mn', null, 'title', null)],
  ['Iota raises \u20B9120 crore from Peak XV', '', exp(1_200_000_000, 'INR', '\u20B9120 crore', null, 'title', null)],
  ['Kappa wins grant of $500,000', '', exp(500_000, 'USD', '$500,000', 'grant', 'title', 'title')],
  ['Lambda announces funding', 'The startup raised $3.5M in a seed round led by Y.', exp(3_500_000, 'USD', '$3.5M', 'seed', 'summary', 'summary')],
  ['Mu closes Series B for $30M', '', exp(30_000_000, 'USD', '$30M', 'series b', 'title', 'title')],
  ['Nu raises Rs. 25 lakh angel round', '', exp(2_500_000, 'INR', 'Rs. 25 lakh', null, 'title', null)],
  ['Xi secures 20 crore', '', exp(200_000_000, 'INR', '20 crore', null, 'title', null)],
  ['Omicron raises 5 million euros', '', exp(5_000_000, 'EUR', '5 million euros', null, 'title', null)],
  ['Pi lands 12m GBP', '', exp(12_000_000, 'GBP', '12m GBP', null, 'title', null)],
  ['Rho raises 4 million dollars', '', exp(4_000_000, 'USD', '4 million dollars', null, 'title', null)],
  ['Sigma secures INR 80 crore Series C', '', exp(800_000_000, 'INR', 'INR 80 crore', 'series c', 'title', 'title')],
  ['Tau raises $2bn', '', exp(2_000_000_000, 'USD', '$2bn', null, 'title', null)],
  ['Upsilon raises $100MM growth round', '', exp(100_000_000, 'USD', '$100MM', 'growth', 'title', 'title')],
  ['Phi takes on $15M in venture debt', '', exp(15_000_000, 'USD', '$15M', 'debt', 'title', 'title')],
  ['Chi raises \u20AC7.5 million bridge round', '', exp(7_500_000, 'EUR', '\u20AC7.5 million', 'bridge', 'title', 'title')],
  ['Psi raises $1,250,000 pre-seed round', '', exp(1_250_000, 'USD', '$1,250,000', 'pre-seed', 'title', 'title')],
  ['Omega raises $6M seed extension and pre-seed follow-on', '', exp(6_000_000, 'USD', '$6M', 'pre-seed', 'title', 'title')],
  ['Alpha2 raises $8M Series A2', '', exp(8_000_000, 'USD', '$8M', 'series a', 'title', 'title')],
  ['Title with $2M', 'Summary with $9M', exp(2_000_000, 'USD', '$2M', null, 'title', null)],
  ['Stage only in title: Series E', 'Amount only here: $40M', exp(40_000_000, 'USD', '$40M', 'series e', 'summary', 'title')],
  // a title amount with a summary-only stage: each value is labelled with its own field (review-phase-1 iteration 2 #5)
  ['Acme raises $4M', 'The round is the seed round led by Y.', exp(4_000_000, 'USD', '$4M', 'seed', 'title', 'summary')],
  ['Seed-stage startup launches', '', exp(null, null, null, 'seed', null, 'title')],
  ['Startup launches', 'A pre-seed company with no amount.', exp(null, null, null, 'pre-seed', null, 'summary')],
  // the kind filter (classifyKind) decides what is a funding story; a market size still parses
  ['A $10 billion market for robot lawnmowers', '', exp(10_000_000_000, 'USD', '$10 billion', null, 'title', null)],
  // valuations are not round amounts (funding parser fix; the three ElevenLabs headlines of 2026-W40)
  ['AI voice startup ElevenLabs doubles valuation to $22B', '', exp(null, null, null, null, null, null, val(22_000_000_000, 'USD', '$22B'))],
  ['ElevenLabs doubles valuation to $22bn with tender offer', '', exp(null, null, null, null, null, null, val(22_000_000_000, 'USD', '$22bn'))],
  ["ElevenLabs' valuation doubles to $22BN, as completes $300M employee tender offer", '', exp(300_000_000, 'USD', '$300M', null, 'title', null, val(22_000_000_000, 'USD', '$22BN'))],
  ['Acme raises $50M Series B at a $1B valuation', '', exp(50_000_000, 'USD', '$50M', 'series b', 'title', 'title', val(1_000_000_000, 'USD', '$1B'))],
  ['Zomint Raises \u20B936 Cr To Scale Wealth Management Platform', '', exp(360_000_000, 'INR', '\u20B936 Cr', null, 'title', null)],
  ['Startup valued at $2B after $100M round', '', exp(100_000_000, 'USD', '$100M', null, 'title', null, val(2_000_000_000, 'USD', '$2B'))],
  ['Unicorn Foo hits $5B valuation', '', exp(null, null, null, null, null, null, val(5_000_000_000, 'USD', '$5B'))],
  ['Foo secures \u20AC4M pre-seed', '', exp(4_000_000, 'EUR', '\u20AC4M', 'pre-seed', 'title', 'title')],
  // more valuation shapes seen on the live site
  ['Kevin Mandia\u2019s new \u2018agent swarm\u2019 security startup Armadin raises $255.5M at $2.5B valuation', '', exp(255_500_000, 'USD', '$255.5M', null, 'title', null, val(2_500_000_000, 'USD', '$2.5B'))],
  ['a16z-backed EliseAI raises $350M, doubles valuation to $4B', '', exp(350_000_000, 'USD', '$350M', null, 'title', null, val(4_000_000_000, 'USD', '$4B'))],
  ['Etched fields funding offers at $40B+ valuation, sources say', '', exp(null, null, null, null, null, null, val(40_000_000_000, 'USD', '$40B'))],
  ['Valor, Atreides, and Sequoia back AI startup Flow Engineering at $750M valuation', '', exp(null, null, null, null, null, null, val(750_000_000, 'USD', '$750M'))],
  ['Meet Tab, which emerged from stealth with a $300M valuation', '', exp(null, null, null, null, null, null, val(300_000_000, 'USD', '$300M'))],
  ['Beta raises $20M at $200M post-money valuation', '', exp(20_000_000, 'USD', '$20M', null, 'title', null, val(200_000_000, 'USD', '$200M'))],
  ['Gamma raises $30M at $300M', '', exp(30_000_000, 'USD', '$30M', null, 'title', null, val(300_000_000, 'USD', '$300M'))],
  ['Delta hits $1B valuation after raising $100M', '', exp(100_000_000, 'USD', '$100M', null, 'title', null, val(1_000_000_000, 'USD', '$1B'))],
  ['Sequoia values Epsilon at $5B', '', exp(null, null, null, null, null, null, val(5_000_000_000, 'USD', '$5B'))],
  ['Zeta is now worth $3B', '', exp(null, null, null, null, null, null, val(3_000_000_000, 'USD', '$3B'))],
  // "unicorn" before a raise word or a round noun does not turn the round into a valuation
  ['Egyptian fintech unicorn MNT-Halan secures $76.5m securitisation deals', '', exp(76_500_000, 'USD', '$76.5m', null, 'title', null)],
  ['Eta becomes a unicorn with $150M Series C', '', exp(150_000_000, 'USD', '$150M', 'series c', 'title', 'title')],
  // the amount is the figure next to the raise word, not simply the first one
  ['At 19, founder raises $11M for Ghost, maker of a $3,499 computer for personal AI', '', exp(11_000_000, 'USD', '$11M', null, 'title', null)],
  ['Report: $2M in grants flowed to Theta, which now raises $9M', '', exp(9_000_000, 'USD', '$9M', null, 'title', null)],
  // a valuation in the title with the round in the summary (each value labelled with its field)
  ['Iota doubles valuation to $8B', 'The company raised $400M in the Series F round.', exp(400_000_000, 'USD', '$400M', 'series f', 'summary', 'summary', val(8_000_000_000, 'USD', '$8B'))],
  ['Kappa raises $40M', 'The round values the company at $900M.', exp(40_000_000, 'USD', '$40M', null, 'title', null, val(900_000_000, 'USD', '$900M', 'summary'))],
  ['RobCo hits unicorn valuation in employee share sale', 'The Munich robotics startup is now valued at \u20AC892.4 million.', exp(null, null, null, null, null, null, val(892_400_000, 'EUR', '\u20AC892.4 million', 'summary'))],
  // a conversion in brackets restates the figure before it (live EU-Startups summary); the original currency is kept
  ['Munich-based RobCo becomes a robotics unicorn as valuation doubles in nine months', 'RobCo today announced that it has surpassed an \u20AC892.4 million ($1 billion) valuation in a transaction that combines new investment and an employee secondary share sale.', exp(null, null, null, null, null, null, val(892_400_000, 'EUR', '\u20AC892.4 million', 'summary'))],
  ['Lambda raises \u20AC20M ($22M) Series A', '', exp(20_000_000, 'EUR', '\u20AC20M', 'series a', 'title', 'title')],
  ['Mu secures $5M, or about \u20AC4.6M, in seed funding', '', exp(5_000_000, 'USD', '$5M', 'seed', 'title', 'title')],
  // "closes its fund at $X" has no round figure before the "at": a fund size, not a valuation (live Tech.eu summary)
  ['DIG Ventures closes Fund III', 'European venture capital firm DIG Ventures has closed its third fund at $120 million to invest in early-stage companies.', exp(120_000_000, 'USD', '$120 million', null, 'summary', null)],
  // "deals worth" is an aggregate of money raised, not a valuation (live Tech.eu newsletter summary)
  ['Weekly round-up', 'This week, we tracked more than 70 tech funding deals worth over \u20AC3.9 billion and over 5 exits.', exp(3_900_000_000, 'EUR', '\u20AC3.9 billion', null, 'summary', null)],
  ['Nu raises $4B', 'Nvidia-backed Nu is raising up to $4 billion at a $14.5 billion pre-money valuation ahead of a planned IPO.', exp(4_000_000_000, 'USD', '$4B', null, 'title', null, val(14_500_000_000, 'USD', '$14.5 billion', 'summary'))],
  // negatives
  ['Top 5 apps this week', '', NONE],
  ['Version 2.5 ships with 3 new features', '', NONE],
  ['Series of outages hits the growth team', '', NONE],
  ['Bridge the gap: 4 kids build an app', '', NONE],
  ['Seeds of change for 10 Monday meetings', '', NONE],
  ['', '', NONE],
];

describe('parseFunding', () => {
  test(`at least 25 fixtures (${FIXTURES.length})`, () => {
    assert.ok(FIXTURES.length >= 25);
  });

  for (const [title, summary, expected] of FIXTURES) {
    test(`${JSON.stringify(title)} / ${JSON.stringify(summary)}`, () => {
      assert.deepEqual(parseFunding(title, summary), expected);
    });
  }

  test('summary defaults to empty and tolerates non-strings', () => {
    assert.equal(parseFunding('raises $1M').amount, 1_000_000);
    assert.deepEqual(parseFunding(null, undefined), NONE);
  });

  test('parseAmount, parseValuation, scanField and parseStage are exported for reuse', () => {
    assert.deepEqual(parseAmount('about $3k'), { amount: 3000, currency: 'USD', amountText: '$3k' });
    assert.equal(parseAmount('no money here'), null);
    assert.equal(parseAmount('valued at $2B'), null, 'a valuation is not an amount');
    assert.deepEqual(parseValuation('valued at $2B'), { amount: 2_000_000_000, currency: 'USD', amountText: '$2B' });
    assert.equal(parseValuation('raises $2B'), null);
    assert.deepEqual(scanField('raises $50M at a $1B valuation'), { amount: { amount: 50_000_000, currency: 'USD', amountText: '$50M' }, valuation: { amount: 1_000_000_000, currency: 'USD', amountText: '$1B' } });
    assert.deepEqual(scanField(''), { amount: null, valuation: null });
    assert.equal(parseStage('Series H round'), 'series h');
    assert.equal(parseStage('Series-B'), 'series b');
    assert.equal(parseStage('preseed'), 'pre-seed');
    assert.equal(parseStage('nothing'), null);
  });

  test('the regex is stateless across calls', () => {
    assert.equal(parseAmount('$4M').amount, 4_000_000);
    assert.equal(parseAmount('$4M').amount, 4_000_000);
    assert.equal(parseAmount('x $5M').amount, 5_000_000);
    assert.equal(parseValuation('valuation to $22B').amount, 22_000_000_000);
    assert.equal(parseValuation('valuation to $22B').amount, 22_000_000_000);
  });

  test('a valuation-only headline has no amount and keeps its valuation apart (never ranked or summed)', () => {
    const f = parseFunding('AI voice startup ElevenLabs doubles valuation to $22B');
    assert.equal(f.amount, null);
    assert.equal(f.amountText, null);
    assert.equal(f.parsedFrom, null);
    assert.deepEqual([f.valuation, f.valuationCurrency, f.valuationText, f.valuationFrom], [22_000_000_000, 'USD', '$22B', 'title']);
  });
});

describe('fx-rates', () => {
  test('FX table has the four currencies with USD = 1 and a dated ECB source', () => {
    assert.deepEqual(Object.keys(FX.rates), ['USD', 'EUR', 'GBP', 'INR']);
    assert.equal(FX.rates.USD, 1);
    assert.match(FX.asOf, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(FX.source, 'ECB reference rates');
    assert.ok(FX.rates.EUR > 1 && FX.rates.EUR < 1.3);
    assert.ok(FX.rates.GBP > 1.1 && FX.rates.GBP < 1.6);
    assert.ok(FX.rates.INR > 0.009 && FX.rates.INR < 0.015);
  });

  test('toUsd converts with the table and returns null for unknowns', () => {
    assert.equal(toUsd(100, 'USD'), 100);
    assert.equal(toUsd(1_000_000, 'EUR'), Math.round(1_000_000 * FX.rates.EUR));
    assert.equal(toUsd(500_000_000, 'INR'), Math.round(500_000_000 * FX.rates.INR));
    assert.equal(toUsd(10, 'JPY'), null);
    assert.equal(toUsd(null, 'USD'), null);
    assert.equal(toUsd(Number.NaN, 'USD'), null);
  });
});
