// Startup Radar digest page (plan §3.2 item 19, D10). Reads ./data/digest.json (src/digest.js: 12 ISO weeks, oldest
// first, last = current partial week) and ./data/items.json (+ archive.json on demand) for the drawer. The week is
// URL state (?week=YYYY-Www, relative replaceState); the default is the newest complete week. Every number is printed
// as it is in the JSON and each list states the metric it is ordered by.

import { METHOD_LABELS, absoluteTime, compactMoney, safeHttpUrl } from './format.js';
import { clear, el, extLink, fetchJson, timeEl } from './ui.js';
import { createItemStore, createLensPage, itemLink, itemParam, num, textCell, th, tx, wireOpeners } from './lens.js';

const DIGEST_URL = './data/digest.json';
const WEEK_RE = /^\d{4}-W\d{2}$/;
const KIND_TEXT = { token: 'word', bigram: 'word pair' };
const DASH = '\u2014';

const $ = (id) => document.getElementById(id);
const els = {
  method: $('method'), status: $('status'), week: $('week'), prev: $('week-prev'), next: $('week-next'), range: $('week-range'),
  rounds: document.querySelector('#rounds-table tbody'), roundsCaption: $('rounds-caption'),
  launches: document.querySelector('#launches-table tbody'), launchesCaption: $('launches-caption'),
  ycList: $('yc-list'), ycEmpty: $('yc-empty'),
  terms: document.querySelector('#terms-table tbody'), termsCaption: $('terms-caption'),
  highlights: $('highlights'), highlightLists: $('highlight-lists'),
};

const items = createItemStore();
let digest = null;
let loadError = '';
let weekIds = [];
let selected = null; // week id
let drawerList = []; // feed items referenced on the page, in page order (drawer prev/next)

const buildUrl = (key) => {
  const p = new URLSearchParams();
  if (selected) p.set('week', selected);
  if (key) p.set('item', key);
  const qs = p.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
};
const lens = createLensPage({ page: 'digest', getList: () => drawerList, findItem: (key) => items.find(key), buildUrl });

// Week bounds are UTC instants (Mon 00:00Z .. Sun 23:59:59.999Z): format them in UTC so every timezone sees Mon – Sun.
const dayText = (iso) => new Date(iso).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const usdText = (n) => (typeof n === 'number' && Number.isFinite(n) ? `\u2248 $${compactMoney(n)}` : DASH);
const usdTitle = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${METHOD_LABELS.usd}: ${n.toLocaleString()} USD` : 'no parseable amount');
const defaultWeek = () => [...digest.weeks].reverse().find((w) => !w.partial)?.week ?? digest.weeks.at(-1)?.week ?? null;
const current = () => digest.weeks.find((w) => w.week === selected) ?? null;

// -- state <-> URL --

function readState() {
  const w = new URLSearchParams(location.search).get('week') || '';
  selected = WEEK_RE.test(w) && weekIds.includes(w) ? w : defaultWeek();
}

const syncLocation = () => lens.replaceUrl(buildUrl(lens.drawer.isOpen() ? lens.drawer.key() : itemParam()));

function syncControls() {
  els.week.value = selected ?? '';
  const i = weekIds.indexOf(selected);
  els.prev.disabled = i <= 0;
  els.next.disabled = i < 0 || i >= weekIds.length - 1;
}

// -- rendering --

/** Title cell: in-app link when the key is a feed item (items.json / archive expected), else a plain new-tab link. */
function titleLink(row, text) {
  const key = str(row.key);
  if (!key) return safeHttpUrl(row.url) ? extLink(safeHttpUrl(row.url), text) : tx(text);
  const item = items.peek(key);
  if (item && !drawerList.includes(item)) drawerList.push(item);
  // an older key lives in archive.json (loaded by the store on the first miss); a vanished item toasts on open
  return itemLink(key, text);
}

function renderRounds(week) {
  clear(els.rounds);
  for (const r of week.rounds) {
    els.rounds.append(el('tr', { dataset: { key: str(r.key) } }, [
      el('th', { scope: 'row' }, [titleLink(r, str(r.title) || '(untitled)')]),
      el('td', { 'data-label': 'Amount' }, [tx(str(r.amountText) || DASH), r.amountText ? el('span', { className: 'cell-note', text: `${METHOD_LABELS.headline}${r.currency ? ` \u00b7 ${r.currency}` : ''}` }) : null]),
      textCell('Stage', str(r.stage) || DASH, 'nowrap'),
      textCell('Source', str(r.source) || DASH),
      el('td', { 'data-label': 'Date' }, [r.publishedAt ? timeEl(r.publishedAt) : tx(DASH)]),
      el('td', { 'data-label': 'approx. USD', className: 'num', title: usdTitle(r.usdApprox), text: usdText(r.usdApprox) }),
    ]));
  }
  if (!week.rounds.length) els.rounds.append(el('tr', {}, [el('td', { colspan: '6', className: 'dim', text: 'No funding item of this week had a parseable amount.' })]));
  els.roundsCaption.textContent = `${num(week.rounds.length)} funding items with a parsed amount, ranked by ${str(week.rounds[0]?.metric) || 'approx. USD at static rates'}`;
}

function renderLaunches(week) {
  clear(els.launches);
  for (const l of week.launches) {
    els.launches.append(el('tr', { dataset: { key: str(l.key) } }, [
      el('th', { scope: 'row' }, [titleLink(l, str(l.title) || '(untitled)')]),
      el('td', { 'data-label': 'Metric', className: 'num' }, [tx(num(l.value)), el('span', { className: 'cell-note metric', text: str(l.metric) || 'unknown metric' })]),
      textCell('Source', str(l.source) || DASH),
      el('td', { 'data-label': 'Date' }, [l.publishedAt ? timeEl(l.publishedAt) : tx(DASH)]),
    ]));
  }
  if (!week.launches.length) els.launches.append(el('tr', {}, [el('td', { colspan: '4', className: 'dim', text: 'No launch of this week carried HN points or PH votes.' })]));
  const metrics = [...new Set(week.launches.map((l) => str(l.metric)).filter(Boolean))];
  els.launchesCaption.textContent = `${num(week.launches.length)} launches, ordered by ${metrics.length ? metrics.join(' / ') : 'HN points / PH votes'} (stated per row)`;
}

function renderYc(week) {
  clear(els.ycList);
  for (const c of week.ycNew) {
    const name = str(c.name) || '(unnamed)';
    const key = str(c.key);
    // same guard as titleLink: a company that is also a rounds/launches row is listed once in the drawer order
    const title = key && items.peek(key) ? titleLink(c, name) : safeHttpUrl(c.url) ? extLink(safeHttpUrl(c.url), name) : tx(name);
    els.ycList.append(el('li', { className: 'company-row' }, [
      el('h3', {}, [title]),
      c.oneLiner ? el('p', { className: 'one-liner', text: str(c.oneLiner) }) : null,
      el('p', { className: 'meta' }, [el('span', { text: str(c.batch) || 'batch unknown' }), el('span', {}, [tx('launched '), c.launchedAt ? timeEl(c.launchedAt) : tx(DASH)])]),
    ]));
  }
  els.ycEmpty.hidden = week.ycNew.length > 0;
  els.ycEmpty.textContent = week.ycNew.length ? '' : 'No YC company of the three newest batches has a launch date in this week.';
}

function renderTerms(week) {
  clear(els.terms);
  for (const t of week.risingTerms) {
    els.terms.append(el('tr', { className: 'term-row' }, [
      el('th', { scope: 'row', className: 'term nowrap', text: str(t.term) }),
      textCell('Kind', KIND_TEXT[t.kind] || str(t.kind), 'nowrap'),
      textCell('This week', num(t.thisWeek), 'num'),
      textCell('Avg/week before', num(t.priorWeeklyAvg), 'num'),
      textCell('Rise', num(t.rise), 'num'),
    ]));
  }
  if (!week.risingTerms.length) els.terms.append(el('tr', {}, [el('td', { colspan: '5', className: 'dim', text: 'No term reached the minimum number of mentions in this week.' })]));
  els.termsCaption.textContent = `${num(week.risingTerms.length)} terms with the largest rise in this week versus the 4 weeks before`;
}

function highlightTable(caption, heads, rows) {
  return el('div', { className: 'table-scroll' }, [el('table', { className: 'data-table stack' }, [el('caption', { text: caption }), el('thead', {}, [el('tr', {}, heads.map(([t, c]) => th(t, c)))]), el('tbody', {}, rows)])]);
}

function renderHighlights(week) {
  clear(els.highlightLists);
  const h = week.signalHighlights;
  els.highlights.hidden = !week.partial || !h || typeof h !== 'object';
  if (els.highlights.hidden) return;
  const repos = Array.isArray(h.repos) ? h.repos : [];
  const models = Array.isArray(h.models) ? h.models : [];
  const starsHead = str(repos[0]?.label) || 'stars since creation (<= 7 days)';
  els.highlightLists.append(
    repos.length
      ? el('div', {}, [staleNote(h.github), highlightTable(`${num(repos.length)} new GitHub repositories by stars`, [['Repository'], [starsHead, 'num']], repos.map((r) => el('tr', {}, [el('th', { scope: 'row' }, [safeHttpUrl(r.url) ? extLink(safeHttpUrl(r.url), str(r.fullName) || '(unnamed)') : tx(str(r.fullName))]), textCell(starsHead, num(r.stars), 'num')])))])
      : el('p', { className: 'empty-note', text: 'No GitHub highlight in this build (signal unavailable).' }),
    models.length
      ? el('div', {}, [staleNote(h.huggingface), highlightTable(`${num(models.length)} Hugging Face models in the API's trending order`, [['#', 'num'], ['Model'], ['Likes', 'num'], ['Downloads', 'num']], models.map((m) => el('tr', {}, [textCell('#', num(m.position), 'num'), el('th', { scope: 'row' }, [safeHttpUrl(m.url) ? extLink(safeHttpUrl(m.url), str(m.id) || '(unnamed)') : tx(str(m.id))]), textCell('Likes', num(m.likes), 'num'), textCell('Downloads', num(m.downloads), 'num')])))])
      : el('p', { className: 'empty-note', text: 'No Hugging Face highlight in this build (signal unavailable).' }),
  );
}

/** Same label the Signals page gives a carried-over payload; null when the signal's fetch behind this build succeeded. */
function staleNote(state) {
  if (!state || typeof state !== 'object' || state.ok !== false) return null;
  return el('p', { className: 'signal-state is-stale', text: `Carried over from an earlier fetch: last good data from ${absoluteTime(state.lastSuccessAt) || 'an unknown time'} \u2014 unavailable since ${absoluteTime(state.unavailableSince) || 'an unknown time'}` });
}

function renderWeek() {
  const week = current();
  drawerList = [];
  if (!week) return;
  els.range.textContent = `${week.week}: ${dayText(week.from)} \u2013 ${dayText(week.to)} (UTC)${week.partial ? ' (current week, partial)' : ''}`;
  renderRounds(week);
  renderLaunches(week);
  renderYc(week);
  renderTerms(week);
  renderHighlights(week);
  document.title = `Digest ${week.week} \u2014 Startup Radar`;
}

function fillWeeks() {
  clear(els.week);
  weekIds = digest.weeks.map((w) => w.week);
  for (const w of [...digest.weeks].reverse()) {
    els.week.append(el('option', { value: w.week, text: `${w.week} \u00b7 ${dayText(w.from)} \u2013 ${dayText(w.to)} (UTC)${w.partial ? ' (partial)' : ''}` }));
  }
}

function renderAll() {
  if (!digest) {
    els.status.setAttribute('role', 'alert');
    els.status.textContent = `Could not load the digest: ${loadError}`;
    els.method.hidden = true;
    for (const id of ['controls', 'rounds', 'launches', 'yc', 'terms', 'highlights']) $(id).hidden = true;
    return;
  }
  els.method.textContent = str(digest.method);
  els.status.textContent = `${num(digest.weeks.length)} ISO weeks \u00b7 generated ${absoluteTime(digest.generatedAt)}`;
  renderWeek();
}

// -- events --

function select(week) {
  if (!weekIds.includes(week)) return;
  selected = week;
  syncControls();
  syncLocation();
  renderWeek();
}

function wireEvents() {
  els.week.addEventListener('change', () => select(els.week.value));
  els.prev.addEventListener('click', () => select(weekIds[weekIds.indexOf(selected) - 1]));
  els.next.addEventListener('click', () => select(weekIds[weekIds.indexOf(selected) + 1]));
  $('controls').addEventListener('submit', (e) => e.preventDefault());
  wireOpeners(document.getElementById('main'), lens.open);
}

async function loadDigest() {
  try {
    const body = await fetchJson(DIGEST_URL);
    if (!body || !Array.isArray(body.weeks) || !body.weeks.every((w) => w && WEEK_RE.test(String(w.week)) && Array.isArray(w.rounds) && Array.isArray(w.launches) && Array.isArray(w.ycNew) && Array.isArray(w.risingTerms))) throw new Error('unexpected response');
    digest = body;
  } catch (err) {
    digest = null;
    loadError = err.message;
  }
}

async function init() {
  wireEvents();
  const [stats] = await Promise.all([lens.loadStats(), items.load().catch(() => []), loadDigest()]);
  items.setArchiveItems(stats?.archiveItems);
  if (digest) {
    fillWeeks();
    readState();
    syncControls();
    syncLocation();
  }
  renderAll();
  await lens.start({ onPopstate: () => { readState(); syncControls(); renderWeek(); } });
}

init();
