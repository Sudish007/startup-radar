import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SECTORS, SECTOR_LABELS, sectorLabel, tagSectors } from '../src/lib/sectors.js';

const EXPECTED_IDS = ['ai', 'fintech', 'health', 'climate', 'devtools', 'security', 'edtech', 'commerce', 'saas', 'hardware', 'mobility', 'media', 'consumer', 'gaming', 'space'];

// [title, summary, expected ids in table order]
const FIXTURES = [
  // single sector
  ['OpenAI releases a new GPT model', '', ['ai']],
  ['Startup builds LLM copilots for lawyers', '', ['ai']],
  ['Machine learning for weather forecasting', '', ['ai']],
  ['Stripe launches new payments API for marketplaces', '', ['fintech', 'devtools', 'commerce']],
  ['Neobank for freelancers raises $5M', '', ['fintech']],
  ['BNPL provider expands to Mexico', '', ['fintech']],
  ['Telehealth platform for rural clinics', '', ['health']],
  ['Biotech startup targets rare disease therapeutics', '', ['health']],
  ['Solar startup cuts battery costs', '', ['climate']],
  ['Carbon removal company signs offtake deal', '', ['climate']],
  ['Open-source CLI for Postgres migrations', '', ['devtools']],
  ['Kubernetes observability for small teams', '', ['devtools']],
  ['Zero-trust identity for contractors', '', ['security']],
  ['Phishing detection for Slack', '', ['security']],
  ['Edtech startup helps teachers grade essays', '', ['edtech']],
  ['Tutoring marketplace for K-12 students', '', ['edtech', 'commerce']],
  ['D2C grocery brand opens dark stores', '', ['commerce']],
  ['Shopify app for merchants', '', ['commerce']],
  ['No-code workflow automation for HR teams', '', ['saas']],
  ['CRM for real-estate agents', '', ['ai', 'saas']],
  ['Humanoid robots enter the warehouse', '', ['hardware', 'mobility']],
  ['Drone startup maps farms with new sensors', '', ['hardware']],
  ['Freight startup digitises trucking', '', ['mobility']],
  ['Last-mile delivery fleet goes electric', '', ['mobility']],
  ['Podcast platform adds video', '', ['media']],
  ['Creator economy tools for newsletters', '', ['media']],
  ['Dating app for pet owners', '', ['consumer']],
  ['Travel planner for solo backpackers', '', ['consumer']],
  ['Community bank opens a branch', '', ['fintech']],
  ['Indie game studio ships on Steam', '', ['gaming']],
  ['Esports team raises a seed round', '', ['gaming']],
  ['Satellite startup books a SpaceX rocket', '', ['space']],
  ['Defense tech company wins Pentagon contract', '', ['space']],
  // multi-sector
  ['Acme raises $4M to bring LLM copilots to community banks', '', ['ai', 'fintech']],
  ['AI diagnostics for hospitals', '', ['ai', 'health']],
  ['Open-source security scanner for Docker images', '', ['devtools', 'security']],
  ['EV charging network for delivery fleets', '', ['climate', 'mobility']],
  // summary contributes
  ['Acme launches', 'A fintech wallet for gig workers', ['fintech']],
  ['Show HN: my side project', 'An AI agent that writes SQL', ['ai', 'devtools']],
  // negatives: word boundaries and unrelated words
  ['Heavy rain floods the valley', '', []],
  ['Email newsletter service for bakeries', '', ['media']],
  ['Brainstorming tips for founders', '', []],
  ['Top 5 apps this week', '', []],
  ['Airline announces new route', '', []],
  ['Mailbox redesign ships', '', []],
  ['Paint company rebrands', '', []],
  ['', '', []],
];

describe('sectors', () => {
  test('SECTORS has the 15 ids and labels in table order', () => {
    assert.deepEqual(SECTORS.map((s) => s.id), EXPECTED_IDS);
    assert.deepEqual(SECTOR_LABELS, {
      ai: 'AI/ML', fintech: 'Fintech', health: 'Health & Bio', climate: 'Climate & Energy', devtools: 'Devtools & Infra',
      security: 'Security', edtech: 'Edtech', commerce: 'Marketplace & Commerce', saas: 'SaaS & Productivity',
      hardware: 'Hardware & Robotics', mobility: 'Mobility & Logistics', media: 'Media & Creator', consumer: 'Consumer & Social',
      gaming: 'Gaming', space: 'Space & Defense',
    });
    for (const s of SECTORS) {
      assert.ok(s.re instanceof RegExp, s.id);
      assert.ok(s.re.flags.includes('i'), `${s.id} is case-insensitive`);
      assert.ok(!s.re.flags.includes('g'), `${s.id} must not be global (lastIndex state)`);
      assert.ok(s.re.source.startsWith('\\b') && s.re.source.endsWith('\\b'), `${s.id} is word-bounded`);
    }
  });

  test('sectorLabel maps known ids and falls back to the id', () => {
    assert.equal(sectorLabel('ai'), 'AI/ML');
    assert.equal(sectorLabel('space'), 'Space & Defense');
    assert.equal(sectorLabel('nope'), 'nope');
    assert.equal(sectorLabel(undefined), '');
  });

  test(`at least 40 fixtures (${FIXTURES.length})`, () => {
    assert.ok(FIXTURES.length >= 40);
  });

  for (const [title, summary, expected] of FIXTURES) {
    test(`tagSectors(${JSON.stringify(title)}, ${JSON.stringify(summary)}) -> ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(tagSectors(title, summary), expected);
    });
  }

  test('summary defaults to empty and non-string input is tolerated', () => {
    assert.deepEqual(tagSectors('Fintech for farmers'), ['fintech']);
    assert.deepEqual(tagSectors(null, undefined), []);
    assert.deepEqual(tagSectors('AI', null), ['ai']);
  });

  test('ids are unique and in table order regardless of match order', () => {
    const ids = tagSectors('Space robots play games on a fintech AI platform');
    assert.deepEqual(ids, ['ai', 'fintech', 'hardware', 'gaming', 'space']);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('is case-insensitive', () => {
    assert.deepEqual(tagSectors('FINTECH'), ['fintech']);
    assert.deepEqual(tagSectors('ai'), ['ai']);
  });
});
