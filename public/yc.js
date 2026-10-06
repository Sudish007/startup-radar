// Startup Radar YC page (plan §2.3 item 11, §0.1). Reads ./data/yc.json (src/yc-lens.js over the yc adapter's
// three newest batches) and ./data/items.json to know which companies are also feed items (drawer) - every other
// company name is an outbound link to its YC page. Groups, tag counts and team-size buckets are counted here
// from the companies of the selected batches, so the numbers always match the rows shown.

import { absoluteTime, hostnameOf, safeHttpUrl } from './format.js';
import { clear, el, extLink, fetchJson } from './ui.js';
import { createItemStore, createLensPage, itemLink, itemParam, num, wireOpeners } from './lens.js';

const YC_URL = './data/yc.json';
const MAX_TAGS = 40;

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), attribution: $('attribution'), chips: $('batch-chips'), groups: $('industry-groups'), industriesNote: $('industries-note'),
  tagList: $('tag-list'), tagsNote: $('tags-note'), teamBars: $('team-bars'), teamNote: $('team-note'),
};

const items = createItemStore();
const state = { batch: '' };
let yc = null;
let loadError = '';
let knownBatches = [];
let feedList = []; // feed items among the rendered companies, in page order (drawer prev/next)

const buildUrl = (key) => {
  const p = new URLSearchParams();
  if (state.batch) p.set('batch', state.batch);
  if (key) p.set('item', key);
  const qs = p.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
};
const lens = createLensPage({ page: 'yc', getList: () => feedList, findItem: (key) => items.find(key), buildUrl });

function readState() {
  const batch = new URLSearchParams(location.search).get('batch') || '';
  state.batch = knownBatches.includes(batch) ? batch : '';
}

const syncLocation = () => lens.replaceUrl(buildUrl(lens.drawer.isOpen() ? lens.drawer.key() : itemParam()));

const selected = () => (state.batch ? yc.companies.filter((c) => c.batch === state.batch) : yc.companies);

/** Map<value, count> sorted count desc, then value asc (same order as src/yc-lens.js sortedRows). */
function countRows(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** '1' -> [1,1], '2-5' -> [2,5], '51+' -> [51, Infinity], 'unknown' -> null (bucket labels come from yc.json). */
function bucketRange(label) {
  let m = /^(\d+)-(\d+)$/.exec(label);
  if (m) return [Number(m[1]), Number(m[2])];
  m = /^(\d+)\+$/.exec(label);
  if (m) return [Number(m[1]), Number.POSITIVE_INFINITY];
  m = /^(\d+)$/.exec(label);
  if (m) return [Number(m[1]), Number(m[1])];
  return null;
}

// -- rendering --

function renderChips() {
  clear(els.chips);
  const all = el('button', { type: 'button', className: 'chip', dataset: { batch: '' }, 'aria-pressed': state.batch === '' ? 'true' : 'false', text: `All \u00b7 ${num(yc.companies.length)}` });
  all.addEventListener('click', () => { state.batch = ''; applyChange(); });
  els.chips.append(all);
  for (const b of yc.batches) {
    const chip = el('button', { type: 'button', className: 'chip', dataset: { batch: b.batch }, 'aria-pressed': state.batch === b.batch ? 'true' : 'false', text: `${b.batch} \u00b7 ${num(b.count)}` });
    chip.addEventListener('click', () => { state.batch = b.batch; applyChange(); });
    els.chips.append(chip);
  }
}

function syncChips() {
  for (const b of els.chips.querySelectorAll('button.chip')) b.setAttribute('aria-pressed', b.dataset.batch === state.batch ? 'true' : 'false');
}

function companyRow(c) {
  const inFeed = items.has(c.key);
  const ycUrl = safeHttpUrl(c.url);
  let name;
  if (inFeed) name = itemLink(c.key, c.name);
  else if (ycUrl) name = extLink(ycUrl, c.name, { title: 'YC company page (opens in a new tab)' });
  else name = el('span', { text: c.name });
  const meta = el('p', { className: 'meta' });
  for (const [label, value] of [['Batch', c.batch], ['Status', c.status], ['Stage', c.stage], ['Location', c.location]]) {
    if (value) meta.append(el('span', { title: label, text: value }));
  }
  if (c.subindustry && c.subindustry !== c.industry) meta.append(el('span', { title: 'Subindustry', text: c.subindustry }));
  if (typeof c.teamSize === 'number') meta.append(el('span', { title: 'Team size', text: `team ${num(c.teamSize)}` }));
  const site = safeHttpUrl(c.website);
  if (site) meta.append(extLink(site, hostnameOf(site), { ariaLabel: `${c.name} website, ${hostnameOf(site)} (opens in a new tab)` }));
  const row = el('li', { className: 'company-row' }, [el('h3', {}, [name])]);
  if (c.oneLiner) row.append(el('p', { className: 'one-liner', text: c.oneLiner }));
  row.append(meta);
  return row;
}

function renderGroups(list) {
  clear(els.groups);
  feedList = [];
  const groups = new Map();
  for (const c of list) {
    const key = c.industry ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  ordered.forEach(([industry, companies], i) => {
    const ul = el('ul', { className: 'company-list' });
    for (const c of companies) {
      ul.append(companyRow(c));
      if (items.has(c.key)) feedList.push(items.peek(c.key));
    }
    els.groups.append(el('details', { className: 'industry-group', open: i === 0 }, [
      el('summary', {}, [el('span', { text: industry }), el('span', { className: 'n', text: `${num(companies.length)} ${companies.length === 1 ? 'company' : 'companies'}` })]),
      ul,
    ]));
  });
  els.industriesNote.textContent = `${num(list.length)} companies in ${num(ordered.length)} industries${state.batch ? ` (${state.batch})` : ` (all ${num(yc.batches.length)} batches)`}; the largest group is open. Industry, status, stage and location are YC's own fields.`;
}

function renderTags(list) {
  clear(els.tagList);
  const rows = countRows(list.flatMap((c) => (Array.isArray(c.tags) ? c.tags : []))).slice(0, MAX_TAGS);
  for (const [tag, count] of rows) els.tagList.append(el('li', {}, [el('span', { className: 'tag', text: tag }), el('span', { className: 'n', text: num(count) })]));
  const tagged = list.filter((c) => Array.isArray(c.tags) && c.tags.length).length;
  els.tagsNote.textContent = `Top ${num(rows.length)} of YC's own tags by number of companies carrying them; ${num(tagged)} of ${num(list.length)} companies have tags (up to 5 each).`;
}

function renderTeam(list) {
  clear(els.teamBars);
  const buckets = Array.isArray(yc.teamSize?.buckets) ? yc.teamSize.buckets : [];
  const counts = buckets.map(() => 0);
  const unknownIdx = buckets.indexOf('unknown');
  for (const c of list) {
    const n = typeof c.teamSize === 'number' && Number.isFinite(c.teamSize) && c.teamSize >= 1 ? c.teamSize : null;
    let idx = unknownIdx;
    if (n !== null) {
      const hit = buckets.findIndex((b) => { const r = bucketRange(b); return r && n >= r[0] && n <= r[1]; });
      if (hit >= 0) idx = hit;
    }
    if (idx >= 0) counts[idx] += 1;
  }
  const max = Math.max(1, ...counts);
  buckets.forEach((label, i) => {
    const bar = el('span', { className: 'bar', 'aria-hidden': 'true' });
    bar.style.width = `${(counts[i] / max) * 100}%`;
    els.teamBars.append(el('li', { className: 'bar-row' }, [
      el('span', { className: 'bar-label', text: label === 'unknown' ? 'unknown' : `${label} people` }),
      el('span', { className: 'bar-track' }, [bar]),
      el('span', { className: 'bar-n', text: num(counts[i]) }),
    ]));
  });
  const known = list.length - (unknownIdx >= 0 ? counts[unknownIdx] : 0);
  els.teamNote.textContent = `Number of companies per team-size bucket (YC's team_size field); ${num(known)} of ${num(list.length)} companies state a team size. Bar length is proportional to the count.`;
}

function renderAll() {
  if (!yc) {
    els.status.setAttribute('role', 'alert');
    els.status.textContent = `Could not load the YC companies: ${loadError}`;
    for (const id of ['controls', 'industries', 'tags', 'team']) $(id).hidden = true;
    return;
  }
  els.attribution.textContent = yc.attribution;
  els.status.textContent = `${num(yc.companies.length)} companies in ${num(yc.batches.length)} batches \u00b7 generated ${absoluteTime(yc.generatedAt)}`;
  renderLists();
}

function renderLists() {
  const list = selected();
  renderGroups(list);
  renderTags(list);
  renderTeam(list);
}

function applyChange() {
  syncChips();
  syncLocation();
  renderLists();
}

async function loadYc() {
  try {
    const body = await fetchJson(YC_URL);
    if (!body || !Array.isArray(body.companies) || !Array.isArray(body.batches) || !Array.isArray(body.byIndustry)) throw new Error('unexpected response');
    yc = body;
    knownBatches = body.batches.map((b) => b.batch);
  } catch (err) {
    yc = null;
    loadError = err.message;
  }
}

async function init() {
  wireOpeners(document.getElementById('main'), lens.open);
  const [stats] = await Promise.all([lens.loadStats(), items.load().catch(() => []), loadYc()]);
  items.setArchiveItems(stats?.archiveItems);
  if (yc) {
    readState();
    renderChips();
    syncLocation();
  }
  renderAll();
  await lens.start({ onPopstate: () => { readState(); syncChips(); renderLists(); } });
}

init();
