import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFunding, parseAmount, parseStage } from '../src/lib/funding-parse.js';
import { FX, toUsd } from '../src/lib/fx-rates.js';

/** Expected parseFunding() result: parsedFrom is the amount's field, else the stage's. */
const exp = (amount, currency, amountText, stage, amountFrom, stageFrom) => ({ amount, currency, amountText, stage, amountFrom, stageFrom, parsedFrom: amountFrom ?? stageFrom });
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

  test('parseAmount and parseStage are exported for reuse', () => {
    assert.deepEqual(parseAmount('about $3k'), { amount: 3000, currency: 'USD', amountText: '$3k' });
    assert.equal(parseAmount('no money here'), null);
    assert.equal(parseStage('Series H round'), 'series h');
    assert.equal(parseStage('Series-B'), 'series b');
    assert.equal(parseStage('preseed'), 'pre-seed');
    assert.equal(parseStage('nothing'), null);
  });

  test('the regex is stateless across calls', () => {
    assert.equal(parseAmount('$4M').amount, 4_000_000);
    assert.equal(parseAmount('$4M').amount, 4_000_000);
    assert.equal(parseAmount('x $5M').amount, 5_000_000);
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
