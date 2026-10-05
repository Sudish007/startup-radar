import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFunding, parseAmount, parseStage } from '../src/lib/funding-parse.js';
import { FX, toUsd } from '../src/lib/fx-rates.js';

// [title, summary, expected]
const FIXTURES = [
  ['Acme raises $4M seed', '', { amount: 4_000_000, currency: 'USD', amountText: '$4M', stage: 'seed', parsedFrom: 'title' }],
  ['Beta lands $12 million Series A', '', { amount: 12_000_000, currency: 'USD', amountText: '$12 million', stage: 'series a', parsedFrom: 'title' }],
  ['Gamma secures Rs 50 crore', '', { amount: 500_000_000, currency: 'INR', amountText: 'Rs 50 crore', stage: null, parsedFrom: 'title' }],
  ['Delta bags EUR 4M pre-seed', '', { amount: 4_000_000, currency: 'EUR', amountText: 'EUR 4M', stage: 'pre-seed', parsedFrom: 'title' }],
  ['Epsilon closes £2.5m round', '', { amount: 2_500_000, currency: 'GBP', amountText: '\u00A32.5m', stage: null, parsedFrom: 'title' }],
  ['Zeta raises $1.2B Series D', '', { amount: 1_200_000_000, currency: 'USD', amountText: '$1.2B', stage: 'series d', parsedFrom: 'title' }],
  ['Eta raises $750k', '', { amount: 750_000, currency: 'USD', amountText: '$750k', stage: null, parsedFrom: 'title' }],
  ['Theta nabs US$ 10 mn', '', { amount: 10_000_000, currency: 'USD', amountText: 'US$ 10 mn', stage: null, parsedFrom: 'title' }],
  ['Iota raises \u20B9120 crore from Peak XV', '', { amount: 1_200_000_000, currency: 'INR', amountText: '\u20B9120 crore', stage: null, parsedFrom: 'title' }],
  ['Kappa wins grant of $500,000', '', { amount: 500_000, currency: 'USD', amountText: '$500,000', stage: 'grant', parsedFrom: 'title' }],
  ['Lambda announces funding', 'The startup raised $3.5M in a seed round led by Y.', { amount: 3_500_000, currency: 'USD', amountText: '$3.5M', stage: 'seed', parsedFrom: 'summary' }],
  ['Mu closes Series B for $30M', '', { amount: 30_000_000, currency: 'USD', amountText: '$30M', stage: 'series b', parsedFrom: 'title' }],
  ['Nu raises Rs. 25 lakh angel round', '', { amount: 2_500_000, currency: 'INR', amountText: 'Rs. 25 lakh', stage: null, parsedFrom: 'title' }],
  ['Xi secures 20 crore', '', { amount: 200_000_000, currency: 'INR', amountText: '20 crore', stage: null, parsedFrom: 'title' }],
  ['Omicron raises 5 million euros', '', { amount: 5_000_000, currency: 'EUR', amountText: '5 million euros', stage: null, parsedFrom: 'title' }],
  ['Pi lands 12m GBP', '', { amount: 12_000_000, currency: 'GBP', amountText: '12m GBP', stage: null, parsedFrom: 'title' }],
  ['Rho raises 4 million dollars', '', { amount: 4_000_000, currency: 'USD', amountText: '4 million dollars', stage: null, parsedFrom: 'title' }],
  ['Sigma secures INR 80 crore Series C', '', { amount: 800_000_000, currency: 'INR', amountText: 'INR 80 crore', stage: 'series c', parsedFrom: 'title' }],
  ['Tau raises $2bn', '', { amount: 2_000_000_000, currency: 'USD', amountText: '$2bn', stage: null, parsedFrom: 'title' }],
  ['Upsilon raises $100MM growth round', '', { amount: 100_000_000, currency: 'USD', amountText: '$100MM', stage: 'growth', parsedFrom: 'title' }],
  ['Phi takes on $15M in venture debt', '', { amount: 15_000_000, currency: 'USD', amountText: '$15M', stage: 'debt', parsedFrom: 'title' }],
  ['Chi raises \u20AC7.5 million bridge round', '', { amount: 7_500_000, currency: 'EUR', amountText: '\u20AC7.5 million', stage: 'bridge', parsedFrom: 'title' }],
  ['Psi raises $1,250,000 pre-seed round', '', { amount: 1_250_000, currency: 'USD', amountText: '$1,250,000', stage: 'pre-seed', parsedFrom: 'title' }],
  ['Omega raises $6M seed extension and pre-seed follow-on', '', { amount: 6_000_000, currency: 'USD', amountText: '$6M', stage: 'pre-seed', parsedFrom: 'title' }],
  ['Alpha2 raises $8M Series A2', '', { amount: 8_000_000, currency: 'USD', amountText: '$8M', stage: 'series a', parsedFrom: 'title' }],
  ['Title with $2M', 'Summary with $9M', { amount: 2_000_000, currency: 'USD', amountText: '$2M', stage: null, parsedFrom: 'title' }],
  ['Stage only in title: Series E', 'Amount only here: $40M', { amount: 40_000_000, currency: 'USD', amountText: '$40M', stage: 'series e', parsedFrom: 'summary' }],
  ['Seed-stage startup launches', '', { amount: null, currency: null, amountText: null, stage: 'seed', parsedFrom: 'title' }],
  // the kind filter (classifyKind) decides what is a funding story; a market size still parses
  ['A $10 billion market for robot lawnmowers', '', { amount: 10_000_000_000, currency: 'USD', amountText: '$10 billion', stage: null, parsedFrom: 'title' }],
  // negatives
  ['Top 5 apps this week', '', { amount: null, currency: null, amountText: null, stage: null, parsedFrom: null }],
  ['Version 2.5 ships with 3 new features', '', { amount: null, currency: null, amountText: null, stage: null, parsedFrom: null }],
  ['Series of outages hits the growth team', '', { amount: null, currency: null, amountText: null, stage: null, parsedFrom: null }],
  ['Bridge the gap: 4 kids build an app', '', { amount: null, currency: null, amountText: null, stage: null, parsedFrom: null }],
  ['Seeds of change for 10 Monday meetings', '', { amount: null, currency: null, amountText: null, stage: null, parsedFrom: null }],
  ['', '', { amount: null, currency: null, amountText: null, stage: null, parsedFrom: null }],
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
    assert.deepEqual(parseFunding(null, undefined), { amount: null, currency: null, amountText: null, stage: null, parsedFrom: null });
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
