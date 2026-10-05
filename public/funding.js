// Startup Radar funding page (plan §2.3 item 10, D6). Reads ./data/funding.json (funding-kind items with
// `funding` parsed from the headline/summary and `usdApprox` at static FX rates, computed by src/funding.js).
// Controls are URL-synced (relative replaceState); approx. USD is used only to sort and to sum.

import { compareNewestFirst } from './filter.js';
import { METHOD_LABELS, REGION_LABELS, absoluteTime, compactMoney, regionLabel } from './format.js';
import { clear, el, fetchJson, timeEl } from './ui.js';
import { keyOf } from './drawer.js';
import { createLensPage, itemLink, itemParam, num, textCell, tx, wireOpeners } from './lens.js';

const FUNDING_URL = './data/funding.json';
const SINCE_DAYS = { '7d': 7, '30d': 30, '90d': null };
const DEFAULT_SINCE = '90d';
const DEFAULT_SORT = 'date';
const SECTOR_TITLE = `${METHOD_LABELS.sectors} (title + summary)`;

const $ = (id) => document.getElementById(id);
const els = {
  method: $('method'), status: $('status'), count: $('count'), stage: $('stage'), sector: $('sector'), region: $('region'), sort: $('sort'),
  chips: Array.from(document.querySelectorAll('#controls button.chip')), tbody: document.querySelector('#funding-table tbody'),
  coverage: $('coverage'), sectorTotals: document.querySelector('#sector-totals tbody'), stageTotals: document.querySelector('#stage-totals tbody'),
  fxNote: $('fx-note'), fxTbody: document.querySelector('#fx-table tbody'),
};

const state = { stage: '', sector: '', region: '', since: DEFAULT_SINCE, sort: DEFAULT_SORT };
let funding = null;
let loadError = '';
let sectorLabel = {}; // id -> label (funding.totals.bySector)
let knownStages = [];
let currentList = [];

const buildUrl = (key) => {
  const p = new URLSearchParams();
  if (state.stage) p.set('stage', state.stage);
  if (state.sector) p.set('sector', state.sector);
  if (state.region) p.set('region', state.region);
  if (state.since !== DEFAULT_SINCE) p.set('since', state.since);
  if (state.sort !== DEFAULT_SORT) p.set('sort', state.sort);
  if (key) p.set('item', key);
  const qs = p.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
};

const findItem = (key) => (funding ? funding.items.find((it) => keyOf(it) === key) ?? null : null);
const lens = createLensPage({ page: 'funding', getList: () => currentList, findItem, buildUrl, sections: [fundingSection] });

const usdText = (n) => (typeof n === 'number' && Number.isFinite(n) ? `\u2248 $${compactMoney(n)}` : '\u2014');
const usdTitle = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${METHOD_LABELS.usd}: ${n.toLocaleString()} USD` : 'no parseable amount');
const sectorText = (item) => (Array.isArray(item.sectors) && item.sectors.length ? item.sectors.map((id) => sectorLabel[id] || id).join(', ') : '\u2014');
const parsedLabel = (f) => (f?.parsedFrom === 'summary' ? METHOD_LABELS.summary : f?.parsedFrom === 'title' ? METHOD_LABELS.headline : null);

// -- state <-> URL --

function readState() {
  const p = new URLSearchParams(location.search);
  const stage = p.get('stage') || '';
  state.stage = knownStages.includes(stage) ? stage : '';
  const sector = p.get('sector') || '';
  state.sector = Object.hasOwn(sectorLabel, sector) ? sector : '';
  const region = p.get('region') || '';
  state.region = Object.hasOwn(REGION_LABELS, region) ? region : '';
  const since = p.get('since') || DEFAULT_SINCE;
  state.since = Object.hasOwn(SINCE_DAYS, since) ? since : DEFAULT_SINCE;
  state.sort = p.get('sort') === 'usd' ? 'usd' : DEFAULT_SORT;
}

function syncControls() {
  els.stage.value = state.stage;
  els.sector.value = state.sector;
  els.region.value = state.region;
  els.sort.value = state.sort;
  for (const b of els.chips) b.setAttribute('aria-pressed', b.dataset.since === state.since ? 'true' : 'false');
}

const syncLocation = () => lens.replaceUrl(buildUrl(lens.drawer.isOpen() ? lens.drawer.key() : itemParam()));

// -- filtering --

function filtered() {
  const days = SINCE_DAYS[state.since];
  const cutoff = days ? Date.now() - days * 86_400_000 : null;
  const list = funding.items.filter((it) => {
    if (state.stage && (it.funding?.stage ?? 'unknown') !== state.stage) return false;
    if (state.sector && !(Array.isArray(it.sectors) && it.sectors.includes(state.sector))) return false;
    if (state.region && it.region !== state.region) return false;
    if (cutoff !== null) {
      const t = Date.parse(it.publishedAt);
      if (Number.isNaN(t) || t < cutoff) return false;
    }
    return true;
  });
  if (state.sort === 'usd') {
    list.sort((a, b) => {
      const ua = typeof a.usdApprox === 'number' ? a.usdApprox : -1;
      const ub = typeof b.usdApprox === 'number' ? b.usdApprox : -1;
      return ub - ua || compareNewestFirst(a, b);
    });
  } else {
    list.sort(compareNewestFirst);
  }
  return list;
}

// -- rendering --

function renderRow(item) {
  const key = keyOf(item);
  const f = item.funding || {};
  const amount = el('td', { 'data-label': 'Amount' }, [tx(f.amountText || '\u2014')]);
  const from = parsedLabel(f);
  if (from && (f.amountText || f.stage)) amount.append(el('span', { className: 'cell-note', text: from }));
  return el('tr', { dataset: { key } }, [
    el('th', { scope: 'row' }, [itemLink(key, item.title || '(untitled)')]),
    amount,
    textCell('Stage', f.stage || '\u2014', 'nowrap'),
    el('td', { 'data-label': 'Sectors', title: SECTOR_TITLE }, [tx(sectorText(item))]),
    textCell('Region', regionLabel(item.region), 'nowrap'),
    textCell('Source', item.source?.name || item.source?.id || ''),
    el('td', { 'data-label': 'Date' }, [item.publishedAt ? timeEl(item.publishedAt) : tx('\u2014')]),
    el('td', { 'data-label': 'approx. USD', className: 'num', title: usdTitle(item.usdApprox), text: usdText(item.usdApprox) }),
  ]);
}

function renderTable() {
  currentList = filtered();
  clear(els.tbody);
  for (const item of currentList) els.tbody.append(renderRow(item));
  if (!currentList.length) els.tbody.append(el('tr', {}, [el('td', { colspan: '8', className: 'dim', text: 'No funding items match these filters.' })]));
  const withAmount = currentList.filter((it) => typeof it.usdApprox === 'number').length;
  els.count.textContent = `${num(currentList.length)} of ${num(funding.items.length)} funding items \u00b7 ${num(withAmount)} with a parsed amount \u00b7 sorted by ${state.sort === 'usd' ? 'approx. USD' : 'date'}`;
}

function totalRow(label, t) {
  return el('tr', {}, [
    el('th', { scope: 'row', text: label }),
    textCell('Items', num(t.items), 'num'),
    textCell('With parsed amount', num(t.withAmount), 'num'),
    el('td', { 'data-label': 'Sum (approx. USD)', className: 'num', title: usdTitle(t.sumUsd), text: t.withAmount ? usdText(t.sumUsd) : '\u2014' }),
  ]);
}

function renderTotals() {
  const { totals, coverage } = funding;
  clear(els.sectorTotals);
  for (const t of totals.bySector) els.sectorTotals.append(totalRow(t.label, t));
  clear(els.stageTotals);
  for (const t of totals.byStage) els.stageTotals.append(totalRow(t.stage, t));
  els.coverage.textContent = `sum of parsed amounts: ${num(coverage.withAmount)} of ${num(coverage.items)} funding items had a parseable amount (${num(coverage.withStage)} had a stage). Sums add only the parsed amounts, converted to approx. USD at the static rates below.`;
}

function renderFx() {
  const fx = funding.fx || {};
  const rates = fx.rates || {};
  clear(els.fxTbody);
  for (const [cur, rate] of Object.entries(rates)) {
    els.fxTbody.append(el('tr', {}, [el('th', { scope: 'row', text: cur }), textCell('USD per unit', String(rate), 'num')]));
  }
  els.fxNote.textContent = `${METHOD_LABELS.usd}. Source: ${fx.source || 'unknown'}, as of ${fx.asOf || 'unknown'}; the rates are fixed in the build and are not live.`;
}

function fillOptions() {
  sectorLabel = {};
  for (const t of funding.totals.bySector) sectorLabel[t.id] = t.label;
  knownStages = funding.totals.byStage.map((t) => t.stage);
  for (const t of funding.totals.bySector) els.sector.append(el('option', { value: t.id, text: `${t.label} \u00b7 ${t.items}` }));
  for (const t of funding.totals.byStage) els.stage.append(el('option', { value: t.stage, text: `${t.stage} \u00b7 ${t.items}` }));
}

function renderAll() {
  if (!funding) {
    els.status.setAttribute('role', 'alert');
    els.status.textContent = `Could not load funding items: ${loadError}`;
    els.method.hidden = true;
    for (const id of ['controls', 'count', 'funding-table', 'usd-note', 'totals', 'fx']) $(id).hidden = true;
    return;
  }
  els.method.textContent = funding.method;
  els.status.textContent = `${num(funding.items.length)} funding items in the 90-day window \u00b7 generated ${absoluteTime(funding.generatedAt)}`;
  renderTable();
  renderTotals();
  renderFx();
}

/** Drawer section: the parsed funding fields with their method labels. */
function fundingSection(item) {
  const f = item.funding;
  if (!f) return null;
  const from = parsedLabel(f);
  const dl = el('dl', { className: 'detail-meta detail-funding' });
  dl.append(el('dt', { text: 'Amount' }), el('dd', {}, [tx(f.amountText || 'none parsed'), from && f.amountText ? el('span', { className: 'method', text: from }) : null]));
  dl.append(el('dt', { text: 'Stage' }), el('dd', {}, [tx(f.stage || 'none parsed'), from && f.stage ? el('span', { className: 'method', text: from }) : null]));
  dl.append(el('dt', { text: 'approx. USD' }), el('dd', { title: usdTitle(item.usdApprox) }, [tx(usdText(item.usdApprox)), typeof item.usdApprox === 'number' ? el('span', { className: 'method', text: METHOD_LABELS.usd }) : null]));
  if (Array.isArray(item.sectors) && item.sectors.length) dl.append(el('dt', { text: 'Sectors' }), el('dd', { title: SECTOR_TITLE, text: sectorText(item) }));
  return dl;
}

// -- events --

function applyChange() {
  syncControls();
  syncLocation();
  renderTable();
}

function wireEvents() {
  els.stage.addEventListener('change', () => { state.stage = els.stage.value; applyChange(); });
  els.sector.addEventListener('change', () => { state.sector = els.sector.value; applyChange(); });
  els.region.addEventListener('change', () => { state.region = els.region.value; applyChange(); });
  els.sort.addEventListener('change', () => { state.sort = els.sort.value === 'usd' ? 'usd' : DEFAULT_SORT; applyChange(); });
  for (const b of els.chips) b.addEventListener('click', () => { state.since = b.dataset.since; applyChange(); });
  $('controls').addEventListener('submit', (e) => e.preventDefault());
  wireOpeners(document.getElementById('main'), lens.open);
}

async function loadFunding() {
  try {
    const body = await fetchJson(FUNDING_URL);
    if (!body || !Array.isArray(body.items) || !body.totals || !Array.isArray(body.totals.bySector) || !body.coverage) throw new Error('unexpected response');
    funding = body;
  } catch (err) {
    funding = null;
    loadError = err.message;
  }
}

async function init() {
  wireEvents();
  await Promise.all([lens.loadStats(), loadFunding()]);
  if (funding) {
    fillOptions();
    readState();
    syncControls();
    syncLocation();
  }
  renderAll();
  await lens.start({ onPopstate: () => { readState(); syncControls(); renderTable(); } });
}

init();
