// Startup Radar signals page (plan §3.2 item 18, D8/D9). Reads ./data/signals.json (src/signals/run.js output) and
// renders one section per signal in exactly one of three states: ok (data), unavailable since <time> — <error> (with
// the carried-over data labelled by its own time) or not configured. Every number is printed as it is in the JSON;
// outbound links go through extLink() after safeHttpUrl(); the page computes nothing.

import { absoluteTime, hostnameOf, safeHttpUrl } from './format.js';
import { clear, el, extLink, fetchJson, timeEl } from './ui.js';
import { createLensPage, num, textCell, th, tx } from './lens.js';

const SIGNALS_URL = './data/signals.json';
const DASH = '\u2014';

const els = { status: document.getElementById('status'), list: document.getElementById('signals') };
const lens = createLensPage({ page: 'signals', getList: () => [], findItem: () => null, buildUrl: () => location.pathname });

let payload = null;
let loadError = '';

const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
/** New-tab extLink for an http(s) URL, plain text otherwise (the data comes from third-party APIs). */
const link = (url, text) => (safeHttpUrl(url) ? extLink(safeHttpUrl(url), text || url) : tx(text || url || DASH));
const dateText = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : DASH);
const list = (v) => (Array.isArray(v) ? v : []);

function table(caption, heads, rows, { stack = true } = {}) {
  return el('div', { className: 'table-scroll' }, [
    el('table', { className: `data-table${stack ? ' stack' : ''}` }, [
      el('caption', { text: caption }),
      el('thead', {}, [el('tr', {}, heads.map(([text, className, title]) => th(text, className, title)))]),
      el('tbody', {}, rows),
    ]),
  ]);
}

const emptyNote = (text) => el('p', { className: 'empty-note', text });

// -- renderers (one per signal id; the id is the file name in src/signals/) --

function askHn(data) {
  const posts = list(data.posts);
  if (!posts.length) return emptyNote('No posts in this fetch.');
  return table(`${num(posts.length)} newest Ask HN / Tell HN posts, as returned by the Hacker News API`, [['Post'], ['Points', 'num'], ['Comments', 'num'], ['Posted']], posts.map((p) => el('tr', {}, [
    el('th', { scope: 'row' }, [link(p.hnUrl, str(p.title) || '(untitled)')]),
    textCell('Points', num(p.points), 'num'),
    textCell('Comments', num(p.comments), 'num'),
    el('td', { 'data-label': 'Posted' }, [p.createdAt ? timeEl(p.createdAt) : tx(DASH)]),
  ])));
}

function github(data) {
  const repos = list(data.repos);
  const starsHead = str(data.label) || 'stars since creation (<= 7 days)';
  const note = el('p', { className: 'coverage', text: `Repositories created since ${str(data.since) || 'unknown'}, ordered by stars by the GitHub search API \u00b7 ${data.authenticated ? 'authenticated request' : 'unauthenticated request (10 searches per minute)'}.` });
  if (!repos.length) return el('div', {}, [note, emptyNote('No repositories in this fetch.')]);
  return el('div', {}, [note, table(`${num(repos.length)} most-starred repositories created in the last 7 days`, [['Repository'], ['Description', 'wide'], ['Language'], [starsHead, 'num'], ['Topics']], repos.map((r) => el('tr', {}, [
    el('th', { scope: 'row' }, [link(r.url, str(r.fullName) || '(unnamed)')]),
    textCell('Description', str(r.description) || DASH, 'wide'),
    textCell('Language', str(r.language) || DASH),
    textCell(starsHead, num(r.stars), 'num'),
    el('td', { 'data-label': 'Topics' }, [list(r.topics).length ? el('span', { className: 'badge-row' }, list(r.topics).map((t) => el('span', { className: 'badge badge-tag', text: str(t) }))) : tx(DASH)]),
  ])))]);
}

function rankedRows(rows, labelOf, cells) {
  return rows.map((m, i) => el('tr', {}, [
    textCell('Rank', num(i + 1), 'num'),
    el('th', { scope: 'row' }, [link(m.url, labelOf(m))]),
    ...cells(m),
  ]));
}

function hf(data) {
  const models = list(data.models);
  const spaces = list(data.spaces);
  return el('div', { className: 'two-col' }, [
    models.length
      ? table(`${num(models.length)} models in the API's trending order`, [['#', 'num'], ['Model'], ['Likes', 'num'], ['Downloads', 'num'], ['Pipeline', 'wide']], rankedRows(models, (m) => str(m.id) || '(unnamed)', (m) => [textCell('Likes', num(m.likes), 'num'), textCell('Downloads', num(m.downloads), 'num'), textCell('Pipeline', str(m.pipelineTag) || DASH, 'wide')]))
      : emptyNote('No models in this fetch.'),
    spaces.length
      ? table(`${num(spaces.length)} spaces in the API's trending order`, [['#', 'num'], ['Space'], ['Likes', 'num'], ['SDK']], rankedRows(spaces, (s) => str(s.id) || '(unnamed)', (s) => [textCell('Likes', num(s.likes), 'num'), textCell('SDK', str(s.sdk) || DASH)]))
      : emptyNote('No spaces in this fetch.'),
  ]);
}

function hiring(data) {
  const keywords = list(data.keywords).filter((k) => k && typeof k.term === 'string');
  const max = Math.max(1, ...keywords.map((k) => (typeof k.comments === 'number' ? k.comments : 0)));
  const groups = [];
  for (const k of keywords) {
    const g = str(k.group) || 'other';
    if (!groups.includes(g)) groups.push(g);
  }
  const head = el('p', { className: 'coverage' }, [tx('Thread: '), link(data.threadUrl, str(data.threadTitle) || 'Who is hiring?'), tx(` \u00b7 ${str(data.label) || `mentions in ${num(data.comments)} comments`}. Bar width = mentions / the largest count (${num(max)}); the number is the count.`)]);
  if (!keywords.length) return el('div', {}, [head, emptyNote('No keyword counts in this fetch.')]);
  return el('div', {}, [head, el('div', { className: 'lens-grid' }, groups.map((g) => el('div', { className: 'bar-group' }, [
    el('h3', { text: g }),
    el('ul', { className: 'bar-list' }, keywords.filter((k) => (str(k.group) || 'other') === g).map((k) => {
      const bar = el('span', { className: 'bar', 'aria-hidden': 'true' });
      bar.style.width = `${((typeof k.comments === 'number' ? k.comments : 0) / max) * 100}%`;
      return el('li', { className: 'bar-row' }, [
        el('span', { className: 'bar-label', text: k.term }),
        el('span', { className: 'bar-track' }, [bar]),
        el('span', { className: 'bar-n', text: num(k.comments) }),
      ]);
    })),
  ])))]);
}

function sbir(data) {
  const rows = list(data.solicitations);
  if (!rows.length) return emptyNote('The API returned no open solicitations in this fetch.');
  return table(`${num(rows.length)} open solicitations listed by the sbir.gov API`, [['Solicitation'], ['Agency'], ['Closes', 'nowrap']], rows.map((s) => el('tr', {}, [
    el('th', { scope: 'row' }, [link(s.url, str(s.title) || '(untitled)')]),
    textCell('Agency', str(s.agency) || DASH),
    textCell('Closes', dateText(s.closeDate), 'nowrap'),
  ])));
}

function producthunt(data) {
  const topics = list(data.topics);
  if (!topics.length) return emptyNote('No topics in this fetch.');
  return table(`${num(topics.length)} Product Hunt topics with the most followers`, [['Topic'], ['Followers', 'num'], ['Posts', 'num']], topics.map((t) => el('tr', {}, [
    el('th', { scope: 'row' }, [link(t.url, str(t.name) || str(t.slug) || '(unnamed)')]),
    textCell('Followers', num(t.followersCount), 'num'),
    textCell('Posts', num(t.postsCount), 'num'),
  ])));
}

const RENDERERS = { ask_hn: askHn, github_new_repos: github, hf_trending: hf, hn_hiring: hiring, sbir, producthunt_topics: producthunt };

function renderData(row) {
  const fn = RENDERERS[row.id];
  if (!fn) return emptyNote('This signal has no display yet; the data is in ./data/signals.json.');
  if (!row.data || typeof row.data !== 'object') return emptyNote('No data in this fetch.');
  return fn(row.data);
}

/** Link-only fallback when a signal failed and nothing was carried over. */
function linkOnly(row) {
  return el('p', { className: 'empty-note' }, [tx('No data to show. The source is reachable directly: '), link(row.homepage, hostnameOf(row.homepage)), tx('.')]);
}

// -- sections --

function section(row) {
  const state = !row.enabled ? 'not-configured' : row.ok ? 'ok' : 'unavailable';
  const id = `signal-${row.id}`;
  const attribution = el('p', { className: 'attribution' }, [
    tx('Source: '), link(row.homepage, hostnameOf(row.homepage)), tx(' \u00b7 '),
    ...(row.fetchedAt ? [tx('fetched '), timeEl(row.fetchedAt)] : [tx('not fetched')]),
  ]);
  const children = [el('h2', { id: `${id}-heading`, text: str(row.name) || row.id }), attribution, el('p', { className: 'method', text: str(row.description) })];
  if (state === 'not-configured') {
    children.push(el('p', { className: 'signal-state is-off', text: `not configured (${str(row.requires) || 'disabled'})` }));
  } else if (state === 'unavailable') {
    children.push(el('p', { className: 'signal-state is-fail', text: `unavailable since ${absoluteTime(row.unavailableSince) || 'unknown'} \u2014 ${str(row.error) || 'unknown error'}` }));
    if (row.data) {
      children.push(el('p', { className: 'signal-state is-stale', text: `last good data from ${absoluteTime(row.lastSuccessAt) || 'an unknown time'}` }));
      children.push(renderData(row));
    } else {
      children.push(linkOnly(row));
    }
  } else {
    children.push(renderData(row));
  }
  return el('section', { className: 'lens-section signal', id, 'aria-labelledby': `${id}-heading`, dataset: { signal: row.id, state } }, children);
}

function renderAll() {
  clear(els.list);
  if (!payload) {
    els.status.setAttribute('role', 'alert');
    els.status.textContent = `Could not load signals: ${loadError}`;
    return;
  }
  const rows = payload.signals.filter((s) => s && typeof s === 'object' && typeof s.id === 'string');
  if (!rows.length) {
    els.status.textContent = 'No signal data yet: the first refresh has not run.';
    els.list.append(emptyNote('Signals are fetched with each refresh; this page fills in after the first one.'));
    return;
  }
  const ok = rows.filter((s) => s.enabled && s.ok).length;
  const failed = rows.filter((s) => s.enabled && !s.ok).length;
  const off = rows.filter((s) => !s.enabled).length;
  els.status.textContent = `${num(rows.length)} signals \u00b7 ${num(ok)} fetched, ${num(failed)} unavailable, ${num(off)} not configured \u00b7 generated ${absoluteTime(payload.generatedAt) || 'unknown'}`;
  for (const row of rows) els.list.append(section(row));
}

async function loadSignals() {
  try {
    const body = await fetchJson(SIGNALS_URL);
    if (!body || typeof body !== 'object' || !Array.isArray(body.signals)) throw new Error('unexpected response');
    payload = body;
  } catch (err) {
    payload = null;
    loadError = err.message;
  }
}

async function init() {
  await Promise.all([lens.loadStats(), loadSignals()]);
  renderAll();
  await lens.start();
}

init();
