import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKind, classifyRegion, KINDS, REGIONS } from '../src/lib/classify.js';

describe('classifyKind', () => {
  test('funding positives', () => {
    for (const title of ['Acme raises $5M seed', 'Startup secures $20M Series B', 'Fund closes $400M', 'pre-seed round']) {
      assert.equal(classifyKind('news', title), 'funding', title);
    }
  });

  test('funding negatives', () => {
    assert.equal(classifyKind('news', 'Acme launches new app'), 'news');
    assert.equal(classifyKind('news', 'How to raise your profile'), 'news');
  });

  test('leaves non-news kinds untouched', () => {
    assert.equal(classifyKind('launch', 'Acme raises $5M seed'), 'launch');
    assert.equal(classifyKind('accelerator', 'Series A valuation'), 'accelerator');
  });

  test('uses the summary too', () => {
    assert.equal(classifyKind('news', 'Acme update', 'The company raised $2M in a seed round'), 'funding');
  });

  test('enums are exported', () => {
    assert.deepEqual(KINDS, ['launch', 'funding', 'news', 'accelerator']);
    assert.deepEqual(REGIONS, ['usa', 'europe', 'asia', 'india', 'latam', 'africa', 'global']);
  });
});

describe('classifyRegion', () => {
  test('maps proper nouns to regions', () => {
    assert.equal(classifyRegion('global', 'Bengaluru startup launches'), 'india');
    assert.equal(classifyRegion('global', 'London fintech'), 'europe');
    assert.equal(classifyRegion('global', 'Lagos-based logistics'), 'africa');
    assert.equal(classifyRegion('global', 'S\u00e3o Paulo delivery app'), 'latam');
    assert.equal(classifyRegion('global', 'Singapore SaaS'), 'asia');
  });

  test('returns the default when nothing matches', () => {
    assert.equal(classifyRegion('usa', 'A new note-taking app'), 'usa');
  });

  test('is case-sensitive and word-bounded', () => {
    assert.equal(classifyRegion('global', 'a comparison of tools'), 'global');
    assert.equal(classifyRegion('global', 'chile pepper recipes'), 'global');
    assert.equal(classifyRegion('global', 'ukulele lessons'), 'global');
  });
});
