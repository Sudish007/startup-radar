// public/funding-group.js: conservative same-story grouping of funding items (funding parser fix, defect 2).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_RULE, GROUP_WINDOW_MS, companyTokens, compareUsdDesc, groupFunding, isTitleCase, sameFigure, sameStory, withinWindow } from '../public/funding-group.js';
import { buildFunding } from '../src/funding.js';

const NOW = new Date('2026-10-07T15:00:00.000Z');
const at = (daysAgo, hour = 10) => {
  const d = new Date(NOW.getTime() - daysAgo * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

let seq = 0;
function item(title, source, publishedAt, overrides = {}) {
  seq += 1;
  return { id: seq, title, summary: '', url: `https://x.test/${seq}`, kind: 'funding', region: 'global', publishedAt, source: { id: source.toLowerCase(), name: source }, extra: {}, ...overrides };
}

/** The 2026-W40 ElevenLabs story plus unrelated rounds, through buildFunding() (amounts, valuations, usdApprox). */
function fixture() {
  const items = [
    item('AI voice startup ElevenLabs doubles valuation to $22B', 'TechCrunch', at(7, 18)),
    item('ElevenLabs doubles valuation to $22bn with tender offer', 'Sifted', at(7, 12)),
    item("ElevenLabs' valuation doubles to $22BN, as completes $300M employee tender offer", 'Tech.eu', at(7, 9)),
    item('Spiko raises $90m in Series B backed by Index Ventures and Speedinvest', 'Sifted', at(1, 12)),
    item('NEA leads Spiko\u2019s $90M Series B to expand access to cash yield', 'Tech.eu', at(1, 8)),
    item('Paris- and London-based Spiko raises nearly \u20AC80 million to help businesses put idle cash to work', 'EU-Startups', at(1, 7)),
    item('Lumio Raises $12 Mn To Scale Consumer Electronics Portfolio', 'Inc42', at(0, 9)),
    item('Consumer tech brand Lumio raises $12M led by Blume Ventures', 'YourStory', at(0, 7)),
    item('Restate lands $20M as the need for durable infrastructure increases with AI agents', 'TechCrunch', at(7, 15)),
    item('Berlin-based Restate raises $20M', 'Tech.eu', at(7, 10)),
    item('Voice AI startup Vocca raises $20m to automate patient phone calls', 'Sifted', at(1, 10)),
    item('Owkin alum raises $25m seed to build world model for human cells', 'Sifted', at(0, 8)),
    item('Furientis lands $25M from Benchmark to mass-produce low-cost missile interceptors', 'TechCrunch', at(1, 20)),
    item('RobCo hits unicorn valuation in employee share sale', 'Sifted', at(2, 10)),
  ];
  return buildFunding(items, { now: NOW }).items;
}

const byTitle = (list, prefix) => list.find((it) => it.title.startsWith(prefix));

describe('companyTokens', () => {
  test('sentence-case headlines: capitalised words of 4+ letters minus stopwords, generic and place words', () => {
    assert.deepEqual([...companyTokens('AI voice startup ElevenLabs doubles valuation to $22B')], ['elevenlabs']);
    assert.deepEqual([...companyTokens("ElevenLabs' valuation doubles to $22BN, as completes $300M employee tender offer")], ['elevenlabs']);
    assert.deepEqual([...companyTokens('NEA leads Spiko\u2019s $90M Series B to expand access to cash yield')], ['spiko'], 'possessive stripped, NEA too short, Series generic');
    assert.deepEqual([...companyTokens('Egyptian fintech unicorn MNT-Halan secures $76.5m securitisation deals')], ['halan'], 'nationality dropped, hyphen splits');
    assert.deepEqual([...companyTokens('Exclusive: Hadrian raises $40m as AI cyberattacks accelerate')], ['hadrian']);
    assert.deepEqual([...companyTokens('Edtech firm byteXL raises $9M as investors back college-linked AI skilling model')], ['bytexl'], 'an inner capital counts');
    assert.deepEqual([...companyTokens('Startup valued at $2B after $100M round')], []);
    assert.deepEqual([...companyTokens('')], []);
    assert.deepEqual([...companyTokens(null)], []);
  });

  test('Title Case headlines: only the words before the first money figure or raise verb', () => {
    assert.equal(isTitleCase('Zomint Raises \u20B936 Cr To Scale Wealth Management Platform'), true);
    assert.equal(isTitleCase('AI voice startup ElevenLabs doubles valuation to $22B'), false);
    assert.deepEqual([...companyTokens('Zomint Raises \u20B936 Cr To Scale Wealth Management Platform')], ['zomint']);
    assert.deepEqual([...companyTokens('Exclusive: IPO-Bound StockGro Raises \u20B9110 Cr From Existing Backers')], ['stockgro']);
    assert.deepEqual([...companyTokens('Sunfox Technologies Bags $7 Mn To Scale Cardiac Diagnostics Platform Spandan')], ['sunfox']);
    assert.deepEqual([...companyTokens('North America\u2019s Startup Funding Falls In Q3 As AI Giants Eye The Public Markets')], [], 'no figure and no raise verb -> no token');
    assert.deepEqual([...companyTokens('Skin In The Game: Why Banks Are Taking Stakes In AI Labs')], []);
  });
});

describe('sameFigure / withinWindow / sameStory', () => {
  test('equal approx. USD amounts group; different amounts never do, whatever the valuation says', () => {
    const f = fixture();
    const sifted = byTitle(f, 'Spiko raises $90m');
    const nea = byTitle(f, 'NEA leads');
    const eu = byTitle(f, 'Paris- and London-based Spiko');
    assert.equal(sameFigure(sifted, nea), true);
    assert.equal(sameFigure(sifted, eu), false, '$90M vs EUR 80M');
    assert.equal(sameStory(sifted, nea), true);
    assert.equal(sameStory(sifted, eu), false);
    const a = { usdApprox: 5e6, funding: { valuation: 1e9, valuationCurrency: 'USD' } };
    const b = { usdApprox: 6e6, funding: { valuation: 1e9, valuationCurrency: 'USD' } };
    assert.equal(sameFigure(a, b), false, 'two different amounts are never the same figure');
  });

  test('an amount-less report joins a round only through an equal valuation in the same currency', () => {
    const f = fixture();
    const tc = byTitle(f, 'AI voice startup ElevenLabs');
    const sifted = byTitle(f, 'ElevenLabs doubles');
    const techeu = byTitle(f, "ElevenLabs'");
    assert.equal(tc.usdApprox, null);
    assert.equal(sifted.usdApprox, null);
    assert.equal(techeu.usdApprox, 300_000_000);
    assert.equal(sameFigure(techeu, tc), true, '$22B valuation on both sides');
    assert.equal(sameFigure(tc, sifted), true);
    assert.equal(sameFigure({ usdApprox: null, funding: { valuation: 22e9, valuationCurrency: 'USD' } }, { usdApprox: null, funding: { valuation: 22e9, valuationCurrency: 'EUR' } }), false, 'currency must match');
    assert.equal(sameFigure({ usdApprox: null, funding: { valuation: null } }, { usdApprox: 1e6, funding: { valuation: null } }), false, 'nothing shared -> no group');
    const robco = byTitle(f, 'RobCo');
    assert.equal(sameFigure(robco, tc), false);
  });

  test('withinWindow is 3 days either way and rejects unparseable dates', () => {
    assert.equal(GROUP_WINDOW_MS, 3 * 86_400_000);
    assert.equal(withinWindow({ publishedAt: at(0) }, { publishedAt: at(3) }), true);
    assert.equal(withinWindow({ publishedAt: at(3) }, { publishedAt: at(0) }), true);
    assert.equal(withinWindow({ publishedAt: at(0) }, { publishedAt: at(3, 9) }), false, '3 days and one hour');
    assert.equal(withinWindow({ publishedAt: 'nope' }, { publishedAt: at(0) }), false);
    const f = fixture();
    const restate = byTitle(f, 'Restate lands');
    const vocca = byTitle(f, 'Voice AI startup Vocca');
    assert.equal(sameFigure(restate, vocca), true, 'both $20M');
    assert.equal(sameStory(restate, vocca), false, 'different companies, 6 days apart');
    assert.equal(sameStory(byTitle(f, 'Owkin'), byTitle(f, 'Furientis')), false, 'same $25M, same week, no shared company token');
  });
});

describe('groupFunding', () => {
  test('one row per story, led by the newest item with an amount; the rest hang off it as "also reported by"', () => {
    const groups = groupFunding(fixture());
    const titles = groups.map((g) => [g.item.title.split(' ').slice(0, 2).join(' '), g.also.map((a) => a.source.name)]);
    assert.deepEqual(titles, [
      ["ElevenLabs' valuation", ['TechCrunch', 'Sifted']],
      ['Spiko raises', ['Tech.eu']],
      ['Paris- and', []],
      ['Owkin alum', []],
      ['Furientis lands', []],
      ['Voice AI', []],
      ['Restate lands', ['Tech.eu']],
      ['Lumio Raises', ['YourStory']],
      ['RobCo hits', []],
    ]);
    const eleven = groups[0];
    assert.equal(eleven.item.usdApprox, 300_000_000, 'the $300M tender offer leads and is ranked by its real amount');
    assert.deepEqual(eleven.also.map((a) => a.usdApprox), [null, null], 'the valuation-only reports are attached, never ranked');
    assert.ok(eleven.also[0].publishedAt > eleven.also[1].publishedAt, 'the also-list is newest first');
    assert.equal(groups.reduce((n, g) => n + 1 + g.also.length, 0), 14, 'every item appears exactly once');
    assert.equal(groups.find((g) => g.item.title.startsWith('Spiko raises')).item.source.name, 'Sifted', 'newest of the two $90M reports leads');
  });

  test('the default order is approx. USD descending, amount-less items last, newest first within a tie', () => {
    const f = fixture();
    const sorted = [...f].sort(compareUsdDesc);
    const usd = sorted.map((it) => it.usdApprox ?? -1);
    assert.deepEqual(usd, [...usd].sort((a, b) => b - a));
    assert.ok(sorted.at(-1).usdApprox === null);
    const tie = sorted.filter((it) => it.usdApprox === 20_000_000).map((it) => it.publishedAt);
    assert.deepEqual(tie, [...tie].sort().reverse());
  });

  test('a custom comparator decides the order and therefore the lead (src/digest.js breaks ties by title)', () => {
    const f = fixture();
    const byTitleAsc = (a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
    const groups = groupFunding(f, byTitleAsc);
    const leads = groups.map((g) => g.item.title);
    assert.deepEqual(leads, [...leads].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'leads follow the comparator');
    const eleven = groups.find((g) => g.item.title.startsWith('AI voice startup ElevenLabs'));
    assert.deepEqual(eleven.also.map((a) => a.source.name), ['Sifted', 'Tech.eu'], 'with this order the TechCrunch report leads');
  });

  test('never groups two items with different amounts, even with the same company name on the same day', () => {
    const a = { title: 'Acme raises $4M seed', publishedAt: at(1), usdApprox: 4e6, funding: { valuation: null } };
    const b = { title: 'Acme raises $5M seed', publishedAt: at(1), usdApprox: 5e6, funding: { valuation: null } };
    const c = { title: 'Acme raises $4M seed round led by Y', publishedAt: at(1, 9), usdApprox: 4e6, funding: { valuation: null } };
    const groups = groupFunding([a, b, c]);
    assert.deepEqual(groups.map((g) => [g.item.title, g.also.length]), [['Acme raises $5M seed', 0], ['Acme raises $4M seed', 1]]);
    assert.equal(groups[1].also[0], c);
  });

  test('empty input, items without titles or dates', () => {
    assert.deepEqual(groupFunding([]), []);
    const groups = groupFunding([{ title: null, publishedAt: null, usdApprox: 1 }, { title: 'Acme raises $1', publishedAt: 'x', usdApprox: 1 }]);
    assert.equal(groups.length, 2);
    assert.ok(groups.every((g) => g.also.length === 0));
  });

  test('the rule label names the three conditions', () => {
    assert.match(GROUP_RULE, /^grouped: same parsed amount \(or valuation\) and shared company name, published within 3 days$/);
  });
});
