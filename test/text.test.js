import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STOPWORDS, significantTokens, singularize, bigrams } from '../public/text.js';
import { tokenize } from '../public/filter.js';

describe('text helpers', () => {
  test('STOPWORDS contains the feed boilerplate the plan names', () => {
    for (const w of ['show', 'hn', 'launch', 'ask', 'tell', 'startup', 'startups', 'company', 'companies', 'new', 'app',
      'platform', 'yc', 'via', 'inc', 'ltd', 'raises', 'raised', 'million', 'funding', 'round', 'series', 'seed',
      'announces', 'launches', 'today', 'the', 'and', 'for', 'with']) {
      assert.ok(STOPWORDS.has(w), w);
    }
    for (const w of STOPWORDS) assert.equal(w, w.toLowerCase(), `${w} is lowercase`);
  });

  test('significantTokens drops stopwords, short tokens and pure numbers', () => {
    assert.deepEqual(significantTokens('Show HN: a new AI app for the 2026 season'), ['season']);
    assert.deepEqual(significantTokens('Acme raises $4M to bring LLM copilots to community banks'), ['acme', 'bring', 'llm', 'copilot', 'community', 'bank']);
    assert.deepEqual(significantTokens(''), []);
    assert.deepEqual(significantTokens(undefined), []);
    assert.deepEqual(significantTokens('12 345 6789'), []);
    assert.deepEqual(significantTokens('v2 k8s gpt4'), ['k8s', 'gpt4']);
  });

  test('significantTokens uses the shared tokenizer (diacritics folded, lowercase)', () => {
    assert.deepEqual(tokenize('Café Résumé'), ['cafe', 'resume']);
    assert.deepEqual(significantTokens('Café Résumé'), ['cafe', 'resume']);
  });

  test('singularize strips a final s only when safe', () => {
    assert.equal(singularize('robots'), 'robot');
    assert.equal(singularize('copilots'), 'copilot');
    assert.equal(singularize('apps'), 'apps'); // length 4: untouched
    assert.equal(singularize('cats'), 'cats');
    assert.equal(singularize('glass'), 'glass');
    assert.equal(singularize('focus'), 'focus');
    assert.equal(singularize('analysis'), 'analysis');
    assert.equal(singularize('status'), 'status');
    assert.equal(singularize('robot'), 'robot');
  });

  test('significantTokens de-pluralises and re-checks stopwords after that', () => {
    assert.deepEqual(significantTokens('robots drones sensors'), ['robot', 'drone', 'sensor']);
    assert.deepEqual(significantTokens('tools platforms'), []);
  });

  test('significantTokens keeps order and repeats (counting happens downstream)', () => {
    assert.deepEqual(significantTokens('robot robot drone'), ['robot', 'robot', 'drone']);
  });

  test('bigrams joins adjacent pairs with a space', () => {
    assert.deepEqual(bigrams(['machine', 'learning', 'model']), ['machine learning', 'learning model']);
    assert.deepEqual(bigrams(['solo']), []);
    assert.deepEqual(bigrams([]), []);
  });
});
