import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/lib/http.js';
import { loadSignals, validateSignal } from '../src/signals/index.js';
import { countSignalItems, formatSignalsTable, runSignals, SIGNAL_TIMEOUT_MS } from '../src/signals/run.js';
import askHn, { ASK_HN_URL, mapAskHn } from '../src/signals/ask_hn.js';
import github, { GITHUB_LABEL, mapGithub, requestHeaders, searchUrl, sinceDate } from '../src/signals/github_new_repos.js';
import hf, { HF_MODELS_URL, HF_SPACES_URL, mapHf } from '../src/signals/hf_trending.js';
import hiring, { buildHiringData, commentsUrl, countKeywords, findHiringThread, HIRING_KEYWORDS, parseMonth, termRegex } from '../src/signals/hn_hiring.js';
import sbir, { mapSbir, SBIR_API_URL } from '../src/signals/sbir.js';
import phTopics, { mapTopics, PH_GRAPHQL_URL } from '../src/signals/producthunt_topics.js';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const T0 = NOW.toISOString();

const sig = (id, fetch, extra = {}) => ({ id, name: id, homepage: `https://${id}.test/`, description: 'counts', enabled: () => true, requires: null, fetch, ...extra });

describe('loadSignals / validateSignal', () => {
  test('the registry loads the six signals in id order with the full contract', async () => {
    const signals = await loadSignals();
    assert.deepEqual(signals.map((s) => s.id), ['ask_hn', 'github_new_repos', 'hf_trending', 'hn_hiring', 'producthunt_topics', 'sbir']);
    for (const s of signals) {
      assert.equal(typeof s.name, 'string');
      assert.match(s.homepage, /^https:\/\//);
      assert.ok(s.description.length > 20, `${s.id} description`);
      assert.equal(typeof s.enabled, 'function');
      assert.equal(typeof s.fetch, 'function');
      assert.ok(s.requires === null || typeof s.requires === 'string');
    }
    assert.equal(signals.find((s) => s.id === 'producthunt_topics').requires, 'PRODUCTHUNT_TOKEN');
    assert.equal(signals.find((s) => s.id === 'producthunt_topics').enabled({}), false);
    assert.equal(signals.find((s) => s.id === 'producthunt_topics').enabled({ PRODUCTHUNT_TOKEN: 'x' }), true);
    assert.ok(signals.filter((s) => s.id !== 'producthunt_topics').every((s) => s.enabled({})));
  });

  test('validation rejects a bad id, an id/filename mismatch, duplicates and missing fields', () => {
    const good = sig('ask_hn', async () => ({}));
    assert.doesNotThrow(() => validateSignal(good, 'ask_hn.js'));
    assert.throws(() => validateSignal(good, 'other.js'), /must equal the filename/);
    assert.throws(() => validateSignal({ ...good, id: 'Ask-HN' }, 'Ask-HN.js'), /invalid id/);
    assert.throws(() => validateSignal(good, 'ask_hn.js', new Set(['ask_hn'])), /duplicate id/);
    assert.throws(() => validateSignal({ ...good, description: '' }, 'ask_hn.js'), /description must be a string/);
    assert.throws(() => validateSignal({ ...good, enabled: true }, 'ask_hn.js'), /enabled must be a function/);
    assert.throws(() => validateSignal({ ...good, fetch: null }, 'ask_hn.js'), /fetch must be a function/);
    assert.throws(() => validateSignal({ ...good, requires: 7 }, 'ask_hn.js'), /requires must be a string or null/);
    assert.throws(() => validateSignal(null, 'ask_hn.js'), /must be an object/);
  });
});

describe('runSignals', () => {
  test('isolation: one throwing signal leaves the others ok; the result keeps registry order', async () => {
    const order = [];
    const signals = [
      sig('a', async () => { order.push('a'); return { posts: [1, 2] }; }),
      sig('b', async () => { throw new HttpError(403, 'https://b.test/api'); }),
      sig('c', () => { throw new Error('sync boom'); }),
      sig('d', async () => 'not an object'),
    ];
    const logs = [];
    const r = await runSignals({ signals, http: {}, env: {}, previous: null, now: NOW, log: (l) => logs.push(l) });
    assert.equal(r.generatedAt, T0);
    assert.deepEqual(r.signals.map((s) => [s.id, s.enabled, s.ok]), [['a', true, true], ['b', true, false], ['c', true, false], ['d', true, false]]);
    const [a, b, c, d] = r.signals;
    assert.deepEqual(Object.keys(a), ['id', 'name', 'homepage', 'description', 'requires', 'enabled', 'ok', 'fetchedAt', 'lastSuccessAt', 'error', 'unavailableSince', 'data', 'durationMs']);
    assert.equal(a.fetchedAt, T0);
    assert.equal(a.lastSuccessAt, T0);
    assert.equal(a.error, null);
    assert.equal(a.unavailableSince, null);
    assert.deepEqual(a.data, { posts: [1, 2] });
    assert.equal(b.error, 'HTTP 403 for https://b.test/api');
    assert.equal(b.unavailableSince, T0, 'no previous -> unavailable since now');
    assert.equal(b.lastSuccessAt, null);
    assert.equal(b.data, null);
    assert.equal(c.error, 'sync boom');
    assert.equal(d.error, 'adapter did not return an object');
    assert.ok(logs.some((l) => l === '[signals] a: OK in ' + a.durationMs + ' ms'));
    assert.ok(logs.some((l) => l.startsWith('[signals] b: FAIL after') && l.endsWith('HTTP 403 for https://b.test/api')));
  });

  test('carry-over: failure keeps previous data/lastSuccessAt, unavailableSince is monotonic, success resets it', async () => {
    const previous = {
      generatedAt: '2026-10-05T10:00:00.000Z',
      signals: [
        { id: 'a', ok: false, lastSuccessAt: '2026-10-05T09:00:00.000Z', unavailableSince: '2026-10-05T10:00:00.000Z', data: { posts: ['old'] } },
        { id: 'b', ok: false, lastSuccessAt: '2026-10-05T09:00:00.000Z', unavailableSince: '2026-10-05T10:00:00.000Z', data: { posts: ['old-b'] } },
        null,
        { notAnId: true },
      ],
    };
    const signals = [sig('a', async () => { throw new Error('still down'); }), sig('b', async () => ({ posts: ['fresh'] }))];
    const r = await runSignals({ signals, http: {}, env: {}, previous, now: NOW, log: () => {} });
    const [a, b] = r.signals;
    assert.equal(a.ok, false);
    assert.equal(a.error, 'still down');
    assert.equal(a.fetchedAt, T0);
    assert.equal(a.lastSuccessAt, '2026-10-05T09:00:00.000Z');
    assert.equal(a.unavailableSince, '2026-10-05T10:00:00.000Z', 'kept from the previous run, not reset to now');
    assert.deepEqual(a.data, { posts: ['old'] });
    assert.equal(b.ok, true);
    assert.equal(b.unavailableSince, null);
    assert.equal(b.lastSuccessAt, T0);
    assert.deepEqual(b.data, { posts: ['fresh'] });
  });

  test('disabled signals report not configured (<requires>) without running fetch', async () => {
    let ran = false;
    const gated = sig('ph', async () => { ran = true; return {}; }, { enabled: (env) => Boolean(env.PRODUCTHUNT_TOKEN), requires: 'PRODUCTHUNT_TOKEN' });
    const off = sig('off', async () => ({}), { enabled: () => false });
    const r = await runSignals({ signals: [gated, off], http: {}, env: {}, now: NOW, log: () => {} });
    assert.equal(ran, false);
    assert.deepEqual(r.signals[0], { id: 'ph', name: 'ph', homepage: 'https://ph.test/', description: 'counts', requires: 'PRODUCTHUNT_TOKEN', enabled: false, ok: false, fetchedAt: null, lastSuccessAt: null, error: 'not configured (PRODUCTHUNT_TOKEN)', unavailableSince: null, data: null, durationMs: 0 });
    assert.equal(r.signals[1].error, 'not configured (disabled)');
    const on = await runSignals({ signals: [gated], http: {}, env: { PRODUCTHUNT_TOKEN: 't' }, now: NOW, log: () => {} });
    assert.equal(on.signals[0].enabled, true);
    assert.equal(ran, true);
  });

  test('ctx carries http, env, now, an AbortSignal and log', async () => {
    let seen;
    const http = { fetchJson: async () => ({}) };
    await runSignals({ signals: [sig('a', async (ctx) => { seen = ctx; return {}; })], http, env: { X: '1' }, now: NOW, log: () => {} });
    assert.equal(seen.http, http);
    assert.deepEqual(seen.env, { X: '1' });
    assert.equal(seen.now, NOW);
    assert.ok(seen.signal instanceof AbortSignal);
    assert.equal(typeof seen.log, 'function');
    assert.equal(SIGNAL_TIMEOUT_MS, 15000);
  });

  test('formatSignalsTable prints one row per signal with status, items, ms and error plus the footer', async () => {
    const signals = [
      sig('ask_hn', async () => ({ posts: [1, 2, 3] })),
      sig('sbir', async () => { throw new Error('HTTP 403'); }),
      sig('ph', async () => ({}), { enabled: () => false, requires: 'PRODUCTHUNT_TOKEN' }),
    ];
    const prev = { signals: [{ id: 'sbir', data: { solicitations: [1] }, lastSuccessAt: T0, unavailableSince: null }] };
    const r = await runSignals({ signals, http: {}, env: {}, previous: prev, now: NOW, log: () => {} });
    const lines = formatSignalsTable(signals, r);
    // status column width = 'not configured (PRODUCTHUNT_TOKEN)'.length = 34
    assert.equal(lines[0], `signal | ${'status'.padEnd(34)} | items | ms     | error`);
    assert.equal(lines[1], `-------+-${'-'.repeat(34)}-+-------+--------+------`);
    assert.match(lines[2], /^ask_hn \| OK {33}\| 3 {5}\| \d+ {4,6}\| $/);
    assert.match(lines[3], /^sbir {3}\| FAIL \(previous kept\) {15}\| 1 {5}\| \d+ {4,6}\| HTTP 403$/);
    assert.equal(lines[4], 'ph     | not configured (PRODUCTHUNT_TOKEN) | -     | 0      | ');
    assert.equal(lines[5], '');
    assert.equal(lines[6], '1/2 enabled signals OK');
    assert.equal(countSignalItems({ models: [1, 2], spaces: [3], label: 'x' }), 3);
    assert.equal(countSignalItems(null), 0);
  });
});

describe('ask_hn', () => {
  const FIXTURE = {
    hits: [
      { author: 'alice', created_at: '2026-10-05T11:00:00.000Z', num_comments: 4, objectID: '49950001', points: 12, story_text: '<p>Hi</p>', title: 'Ask HN: What is your stack?', _tags: ['ask_hn'] },
      { author: 'bob', created_at: '2026-10-05T10:00:00.000Z', num_comments: 0, objectID: '49950002', points: 1, title: 'Tell HN: We shipped', _tags: ['ask_hn'] },
      { objectID: '49950003', title: '' },
      null,
    ],
    nbHits: 3,
  };
  test('mapAskHn keeps title, HN url, points, comments, createdAt, author and drops empty hits', () => {
    const d = mapAskHn(FIXTURE);
    assert.deepEqual(d, {
      posts: [
        { title: 'Ask HN: What is your stack?', hnUrl: 'https://news.ycombinator.com/item?id=49950001', points: 12, comments: 4, createdAt: '2026-10-05T11:00:00.000Z', author: 'alice' },
        { title: 'Tell HN: We shipped', hnUrl: 'https://news.ycombinator.com/item?id=49950002', points: 1, comments: 0, createdAt: '2026-10-05T10:00:00.000Z', author: 'bob' },
      ],
    });
    assert.deepEqual(mapAskHn({}), { posts: [] });
  });
  test('fetch calls the Algolia URL with the ctx signal', async () => {
    const calls = [];
    const http = { fetchJson: async (url, opts) => { calls.push({ url, opts }); return FIXTURE; } };
    const d = await askHn.fetch({ http, env: {}, signal: 'S', now: NOW });
    assert.equal(d.posts.length, 2);
    assert.equal(calls[0].url, ASK_HN_URL);
    assert.equal(calls[0].url, 'https://hn.algolia.com/api/v1/search_by_date?tags=ask_hn&hitsPerPage=50');
    assert.equal(calls[0].opts.signal, 'S');
    assert.ok(askHn.description.startsWith('50 newest Ask HN / Tell HN posts'));
  });
});

describe('github_new_repos', () => {
  const FIXTURE = {
    total_count: 3337670,
    incomplete_results: false,
    items: [
      { full_name: 'acme/fast', html_url: 'https://github.com/acme/fast', description: ' A  very fast\nthing ', stargazers_count: 1200, language: 'Rust', topics: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], created_at: '2026-10-01T00:00:00Z' },
      { full_name: 'x/long', html_url: 'https://github.com/x/long', description: 'd'.repeat(260), stargazers_count: 10, language: null, topics: [], created_at: '2026-10-02T00:00:00Z' },
      { full_name: 'no/url' },
    ],
  };
  test('sinceDate / searchUrl: created:>= 7 days ago, stars desc, 50 per page', () => {
    assert.equal(sinceDate(NOW), '2026-09-28');
    assert.equal(searchUrl(NOW), 'https://api.github.com/search/repositories?q=created%3A%3E%3D2026-09-28&sort=stars&order=desc&per_page=50');
    assert.equal(github.homepage, 'https://github.com/trending', 'the Source link is not a fixed-date search');
  });
  test('requestHeaders adds Authorization only when GITHUB_TOKEN is set', () => {
    assert.deepEqual(requestHeaders({}), { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    assert.deepEqual(requestHeaders({ GITHUB_TOKEN: '  ' }), { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    assert.deepEqual(requestHeaders({ GITHUB_TOKEN: 'ghs_abc' }), { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ghs_abc' });
  });
  test('mapGithub: label, since, authenticated flag, description <= 200, topics <= 8, invalid rows dropped', () => {
    const d = mapGithub(FIXTURE, { now: NOW, authenticated: true });
    assert.equal(d.since, '2026-09-28');
    assert.equal(d.authenticated, true);
    assert.equal(d.label, GITHUB_LABEL);
    assert.equal(d.label, 'stars since creation (<= 7 days)');
    assert.equal(d.repos.length, 2);
    assert.deepEqual(d.repos[0], { fullName: 'acme/fast', url: 'https://github.com/acme/fast', description: 'A very fast thing', stars: 1200, language: 'Rust', topics: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], createdAt: '2026-10-01T00:00:00Z' });
    assert.equal(d.repos[1].description.length, 200);
    assert.ok(d.repos[1].description.endsWith('…'));
    assert.equal(d.repos[1].language, null);
    assert.deepEqual(mapGithub(null, { now: NOW }).repos, []);
  });
  test('fetch passes the headers and reports authenticated from env', async () => {
    const calls = [];
    const http = { fetchJson: async (url, opts) => { calls.push({ url, opts }); return FIXTURE; } };
    const anon = await github.fetch({ http, env: {}, signal: 'S', now: NOW });
    assert.equal(anon.authenticated, false);
    assert.equal(calls[0].url, searchUrl(NOW));
    assert.equal('Authorization' in calls[0].opts.headers, false);
    assert.equal(calls[0].opts.signal, 'S');
    const auth = await github.fetch({ http, env: { GITHUB_TOKEN: 't' }, signal: 'S', now: NOW });
    assert.equal(auth.authenticated, true);
    assert.equal(calls[1].opts.headers.Authorization, 'Bearer t');
  });
});

describe('hf_trending', () => {
  const MODELS = [
    { _id: '1', id: 'org/model-a', likes: 500, trendingScore: 99.5, private: false, downloads: 123456, tags: ['x'], pipeline_tag: 'text-generation', library_name: 'transformers', createdAt: '2026-09-30T00:00:00.000Z', modelId: 'org/model-a' },
    { _id: '2', id: 'org/model-b', likes: 20, trendingScore: 50, private: false, downloads: 10, tags: [], createdAt: '2026-10-01T00:00:00.000Z', modelId: 'org/model-b' },
    { _id: '3' },
  ];
  const SPACES = [
    { _id: 's1', id: 'user/space-a', likes: 80, trendingScore: 70, private: false, sdk: 'gradio', tags: [], createdAt: '2026-10-02T00:00:00.000Z' },
  ];
  test('mapHf: models and spaces in API order with urls, never the trendingScore value', () => {
    const d = mapHf(MODELS, SPACES);
    assert.deepEqual(d.models, [
      { id: 'org/model-a', url: 'https://huggingface.co/org/model-a', likes: 500, downloads: 123456, pipelineTag: 'text-generation', library: 'transformers', createdAt: '2026-09-30T00:00:00.000Z' },
      { id: 'org/model-b', url: 'https://huggingface.co/org/model-b', likes: 20, downloads: 10, pipelineTag: null, library: null, createdAt: '2026-10-01T00:00:00.000Z' },
    ]);
    assert.deepEqual(d.spaces, [{ id: 'user/space-a', url: 'https://huggingface.co/spaces/user/space-a', likes: 80, sdk: 'gradio', createdAt: '2026-10-02T00:00:00.000Z' }]);
    const text = JSON.stringify(d);
    assert.equal(text.includes('trendingScore'), false);
    assert.equal(text.includes('99.5'), false);
    assert.deepEqual(mapHf(null, undefined), { models: [], spaces: [] });
  });
  test('fetch requests models and spaces sorted by trendingScore', async () => {
    const calls = [];
    const http = { fetchJson: async (url) => { calls.push(url); return url.includes('/models') ? MODELS : SPACES; } };
    const d = await hf.fetch({ http, env: {}, signal: 'S', now: NOW });
    assert.deepEqual(calls.sort(), [HF_MODELS_URL, HF_SPACES_URL].sort());
    assert.equal(HF_MODELS_URL, 'https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=30');
    assert.equal(HF_SPACES_URL, 'https://huggingface.co/api/spaces?sort=trendingScore&direction=-1&limit=30');
    assert.equal(d.models.length, 2);
    assert.equal(d.spaces.length, 1);
    assert.ok(hf.description.includes('sorted by its own trending ranking'));
  });
});

describe('hn_hiring', () => {
  const STORIES = {
    hits: [
      { title: 'Ask HN: Who wants to be hired? (October 2026)', objectID: '49922570', author: 'whoishiring', created_at: '2026-10-01T15:00:00.000Z' },
      { title: 'Ask HN: Who is hiring? (October 2026)', objectID: '49922569', author: 'whoishiring', created_at: '2026-10-01T15:00:00.000Z', num_comments: 303 },
      { title: 'Ask HN: Who is hiring? (September 2026)', objectID: '49800000', author: 'whoishiring' },
    ],
  };
  const COMMENTS = {
    nbHits: 3,
    hits: [
      { author: 'a', comment_text: '<p>Acme | Founding Engineer | Remote (US) | <b>TypeScript</b>, Next.js, Postgres, AWS. We use LLMs.</p>', created_at: '2026-10-01T16:00:00.000Z', objectID: '1', parent_id: 49922569, story_id: 49922569, story_title: 'Ask HN: Who is hiring? (October 2026)' },
      { author: 'b', comment_text: 'Beta | Senior C++ / C# dev | Onsite Berlin | Visa sponsorship. Python, python, PYTHON. Golang welcome; go is not required.', created_at: '2026-10-01T17:00:00.000Z', objectID: '2', parent_id: 49922569, story_id: 49922569 },
      { author: 'c', comment_text: 'Gamma | Rust &amp; Kubernetes | Hybrid | Contract. Email: ai@gamma.io, no AI hype here.', created_at: '2026-10-01T18:00:00.000Z', objectID: '3', parent_id: 49922569, story_id: 49922569 },
    ],
  };
  test('findHiringThread skips "Who wants to be hired?" and picks the first "Who is hiring?"; parseMonth reads the month', () => {
    const t = findHiringThread(STORIES.hits);
    assert.equal(t.objectID, '49922569');
    assert.equal(parseMonth(t.title), 'October 2026');
    assert.equal(parseMonth('Ask HN: Who is hiring?'), null);
    assert.equal(findHiringThread([STORIES.hits[0]]), null);
    assert.equal(findHiringThread(null), null);
    assert.equal(commentsUrl('49922569'), 'https://hn.algolia.com/api/v1/search?tags=comment,story_49922569&hitsPerPage=1000');
  });
  test('termRegex: word boundaries, case-insensitive, escaped specials (c++, c#, next.js)', () => {
    assert.ok(termRegex('go').test('Go developer'));
    assert.ok(termRegex('go').test('go to our site'), 'the bare word also matches the English verb');
    assert.ok(hiring.description.includes('"go" is matched as a bare word'), 'and the description says so');
    assert.equal(termRegex('go').test('Golang and Django'), false, 'go inside golang/django does not count');
    assert.ok(termRegex('c++').test('Senior C++ dev'));
    assert.equal(termRegex('c++').test('c+ +'), false);
    assert.ok(termRegex('c#').test('C# / .NET'));
    assert.ok(termRegex('next.js').test('React, Next.js, Node'));
    assert.equal(termRegex('next.js').test('nextjs'), false);
    assert.ok(termRegex('machine learning').test('Machine  Learning engineer'));
    assert.ok(termRegex('ai').test('no AI hype'));
    assert.equal(termRegex('ai').test('email ai@gamma'), true, 'ai before @ is still a word (no letter/digit neighbour)');
    assert.equal(termRegex('ai').test('said'), false);
  });
  test('countKeywords counts distinct comments per term (not occurrences) across the five groups', () => {
    const texts = COMMENTS.hits.map((h) => h.comment_text.replace(/<[^>]+>/g, '').replace('&amp;', '&'));
    const kw = countKeywords(texts);
    const groups = [...new Set(kw.map((k) => k.group))];
    assert.deepEqual(groups, ['languages', 'frameworks', 'infra', 'LLM/AI', 'roles/modes']);
    assert.equal(kw.length, Object.values(HIRING_KEYWORDS).flat().length);
    const n = (term) => kw.find((k) => k.term === term).comments;
    assert.equal(n('python'), 1, 'three mentions in one comment count once');
    assert.equal(n('typescript'), 1);
    assert.equal(n('go'), 1);
    assert.equal(n('c++'), 1);
    assert.equal(n('c#'), 1);
    assert.equal(n('rust'), 1);
    assert.equal(n('next.js'), 1);
    assert.equal(n('react'), 0);
    assert.equal(n('postgres'), 1);
    assert.equal(n('aws'), 1);
    assert.equal(n('kubernetes'), 1);
    assert.equal(n('llm'), 0, '"LLMs" is not the bare term llm');
    assert.equal(n('ai'), 1);
    assert.equal(n('founding engineer'), 1);
    assert.equal(n('remote'), 1);
    assert.equal(n('onsite'), 1);
    assert.equal(n('hybrid'), 1);
    assert.equal(n('contract'), 1);
    assert.equal(n('visa'), 1);
    assert.equal(n('intern'), 0);
    assert.deepEqual(kw[0], { term: 'python', group: 'languages', comments: 1 });
  });
  test('buildHiringData: thread title/url/month, comment count, label and keywords from stripped HTML', () => {
    const d = buildHiringData(findHiringThread(STORIES.hits), COMMENTS.hits);
    assert.equal(d.threadTitle, 'Ask HN: Who is hiring? (October 2026)');
    assert.equal(d.threadUrl, 'https://news.ycombinator.com/item?id=49922569');
    assert.equal(d.month, 'October 2026');
    assert.equal(d.comments, 3);
    assert.equal(d.label, 'mentions in 3 comments of the October 2026 thread');
    assert.equal(d.keywords.find((k) => k.term === 'typescript').comments, 1, 'HTML tags stripped before matching');
    assert.equal(d.keywords.find((k) => k.term === 'rust').comments, 1, 'entities decoded');
    assert.deepEqual(Object.keys(d), ['threadTitle', 'threadUrl', 'month', 'comments', 'label', 'keywords']);
  });
  test('fetch: story search, then the comments of the matched thread; throws without a hiring thread', async () => {
    const calls = [];
    const http = { fetchJson: async (url) => { calls.push(url); return url.includes('story_') ? COMMENTS : STORIES; } };
    const d = await hiring.fetch({ http, env: {}, signal: 'S', now: NOW });
    assert.deepEqual(calls, [
      'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10',
      'https://hn.algolia.com/api/v1/search?tags=comment,story_49922569&hitsPerPage=1000',
    ]);
    assert.equal(d.comments, 3);
    const none = { fetchJson: async () => ({ hits: [STORIES.hits[0]] }) };
    await assert.rejects(() => hiring.fetch({ http: none, env: {}, signal: 'S' }), /no "Ask HN: Who is hiring\?" story/);
  });
});

describe('sbir', () => {
  test('mapSbir maps a JSON array (<= 50) and throws on anything else', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ solicitation_title: `Topic ${i}`, agency: 'DOD', close_date: '2026-11-01', sbir_solicitation_link: `https://www.sbir.gov/node/${i}` }));
    const d = mapSbir(rows);
    assert.equal(d.solicitations.length, 50);
    assert.deepEqual(d.solicitations[0], { title: 'Topic 0', agency: 'DOD', closeDate: '2026-11-01', url: 'https://www.sbir.gov/node/0' });
    assert.deepEqual(mapSbir([{ title: 'T', application_due_date: ['2026-12-01'] }]).solicitations[0], { title: 'T', agency: null, closeDate: '2026-12-01', url: 'https://www.sbir.gov/topics' });
    assert.throws(() => mapSbir({ message: 'Forbidden' }), /did not return a JSON array/);
    assert.throws(() => mapSbir(null), /did not return a JSON array/);
  });
  test('fetch surfaces the HttpError (403 -> link-only via homepage) and uses the sbir.gov API url', async () => {
    const http = { fetchJson: async (url) => { assert.equal(url, SBIR_API_URL); throw new HttpError(403, url); } };
    await assert.rejects(() => sbir.fetch({ http, env: {}, signal: 'S' }), (err) => err instanceof HttpError && err.status === 403);
    assert.equal(sbir.homepage, 'https://www.sbir.gov/topics');
    assert.equal(SBIR_API_URL, 'https://api.www.sbir.gov/public/api/solicitations?open=1');
    const r = await runSignals({ signals: [sbir], http, env: {}, now: NOW, log: () => {} });
    assert.equal(r.signals[0].ok, false);
    assert.equal(r.signals[0].error, 'HTTP 403 for https://api.www.sbir.gov/public/api/solicitations?open=1');
    assert.equal(r.signals[0].unavailableSince, T0);
    assert.equal(r.signals[0].homepage, 'https://www.sbir.gov/topics');
  });
});

describe('producthunt_topics', () => {
  const BODY = { data: { topics: { edges: [
    { node: { name: 'Artificial Intelligence', slug: 'artificial-intelligence', url: 'https://www.producthunt.com/topics/artificial-intelligence', followersCount: 500000, postsCount: 12000 } },
    { node: { name: 'Productivity', slug: 'productivity', url: 'https://www.producthunt.com/topics/productivity', followersCount: 400000, postsCount: 9000 } },
    { node: null },
  ] } } };
  test('enabled only with PRODUCTHUNT_TOKEN; mapTopics maps nodes and throws on GraphQL errors', () => {
    assert.equal(phTopics.enabled({}), false);
    assert.equal(phTopics.enabled({ PRODUCTHUNT_TOKEN: 'x' }), true);
    assert.equal(phTopics.requires, 'PRODUCTHUNT_TOKEN');
    assert.deepEqual(mapTopics(BODY), { topics: [
      { name: 'Artificial Intelligence', slug: 'artificial-intelligence', url: 'https://www.producthunt.com/topics/artificial-intelligence', followersCount: 500000, postsCount: 12000 },
      { name: 'Productivity', slug: 'productivity', url: 'https://www.producthunt.com/topics/productivity', followersCount: 400000, postsCount: 9000 },
    ] });
    assert.throws(() => mapTopics({ errors: [{ message: 'bad token' }] }), /Product Hunt GraphQL: bad token/);
    assert.deepEqual(mapTopics({}), { topics: [] });
  });
  test('fetch POSTs the topics query with the bearer token', async () => {
    const calls = [];
    const http = { fetchJson: async (url, opts) => { calls.push({ url, opts }); return BODY; } };
    const d = await phTopics.fetch({ http, env: { PRODUCTHUNT_TOKEN: 'tok' }, signal: 'S' });
    assert.equal(d.topics.length, 2);
    assert.equal(calls[0].url, PH_GRAPHQL_URL);
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok');
    assert.ok(JSON.parse(calls[0].opts.body).query.includes('topics(order: FOLLOWERS_COUNT, first: 20) { edges { node { name slug url followersCount postsCount } } }'));
  });
});
