// Startup Radar trends page (plan §2.3 item 9). Reads ./data/trends.json (counts computed at build time by
// src/trends.js) and ./data/items.json for the example buttons / drawer. DOM via ui.js el() only (strict CSP);
// sparklines are real SVG polylines of the weekly counts with HTML axis labels.

import { absoluteTime } from './format.js';
import { clear, el, fetchJson } from './ui.js';
import { createItemStore, createLensPage, num, textCell, th, wireOpeners } from './lens.js';

const TRENDS_URL = './data/trends.json';
const SVG_NS = 'http://www.w3.org/2000/svg';
const KIND_TEXT = { token: 'word', bigram: 'word pair' };
const PLOT_W = 120;
const PLOT_H = 48;

const $ = (id) => document.getElementById(id);
const els = {
  method: $('method'), status: $('status'), termsWindow: $('terms-window'), termsTbody: document.querySelector('#terms-table tbody'),
  termsCaption: $('terms-caption'), sectorGrid: $('sector-grid'), kindTable: $('kind-table'), regionTable: $('region-table'),
};

const items = createItemStore();
let trends = null;
let loadError = '';
let exampleList = []; // items referenced by the rendered example buttons, in page order (drawer prev/next)

const buildUrl = (key) => (key ? `${location.pathname}?item=${key}` : location.pathname);
const lens = createLensPage({ page: 'trends', getList: () => exampleList, findItem: (key) => items.find(key), buildUrl });

const dayText = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

// -- rising terms --

function exampleButton(key) {
  const item = items.peek(key);
  const title = item ? item.title || '(untitled)' : 'Open item (older)';
  const b = el('button', { type: 'button', className: 'example btn-secondary', dataset: { openKey: key }, title: `Open: ${title}` }, [el('span', { text: title })]);
  return b;
}

function renderTerms() {
  clear(els.termsTbody);
  exampleList = [];
  const seen = new Set();
  for (const t of trends.terms) {
    const examples = el('div', { className: 'examples' });
    for (const key of Array.isArray(t.examples) ? t.examples.slice(0, 5) : []) {
      examples.append(exampleButton(key));
      const item = items.peek(key);
      if (item && !seen.has(key)) { seen.add(key); exampleList.push(item); }
    }
    els.termsTbody.append(el('tr', { className: 'term-row' }, [
      el('th', { scope: 'row', className: 'term nowrap', text: t.term }),
      textCell('Kind', KIND_TEXT[t.kind] || String(t.kind), 'nowrap'),
      textCell('This week', num(t.thisWeek), 'num'),
      textCell('Avg/week before', num(t.priorWeeklyAvg), 'num'),
      textCell('Rise', num(t.rise), 'num'),
      textCell('Ratio', t.ratio === null ? 'new' : `${num(t.ratio)}\u00d7`, 'num'),
      el('td', { 'data-label': 'Examples', className: 'wide' }, [examples]),
    ]));
  }
  if (!trends.terms.length) {
    els.termsTbody.append(el('tr', {}, [el('td', { colspan: '7', className: 'dim', text: 'No term reached 5 mentions this week.' })]));
  }
  const tw = trends.thisWeek;
  const pr = trends.prior;
  els.termsWindow.textContent = `This week = ISO week ${tw.id} (${dayText(tw.from)} \u2013 ${dayText(tw.to)}, partial); prior = ${pr.weeks} weeks ${dayText(pr.from)} \u2013 ${dayText(pr.to)}. Terms are words or adjacent word pairs from titles and summaries; "new" means no mention in the prior weeks.`;
  els.termsCaption.textContent = `${trends.terms.length} terms with at least 5 mentions this week, sorted by rise (this week minus the prior weekly average)`;
}

// -- sparklines --

function sparkline(row, weeks, partialWeek) {
  const counts = row.counts.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0));
  const max = Math.max(0, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  const n = counts.length;
  const x = (i) => (n > 1 ? (i / (n - 1)) * PLOT_W : PLOT_W / 2);
  const y = (v) => (max > 0 ? PLOT_H - (v / max) * PLOT_H : PLOT_H);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('viewBox', `0 0 ${PLOT_W} ${PLOT_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${row.label}: items per ISO week, ${weeks[0]} to ${weeks[n - 1]} (partial): ${counts.join(', ')}. Maximum ${max}.`);
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', counts.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' '));
  svg.append(line);
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'spark-dot');
  dot.setAttribute('cx', x(n - 1).toFixed(2));
  dot.setAttribute('cy', y(counts[n - 1]).toFixed(2));
  dot.setAttribute('r', '2');
  svg.append(dot);
  const last = weeks[n - 1];
  return el('figure', { className: 'spark' }, [
    el('figcaption', {}, [el('span', { text: row.label }), el('span', { className: 'n', text: `${num(total)} in ${n} weeks` })]),
    el('div', { className: 'spark-plot' }, [
      el('div', { className: 'spark-y', 'aria-hidden': 'true' }, [el('span', { text: String(max) }), el('span', { text: '0' })]),
      svg,
    ]),
    el('div', { className: 'spark-x', 'aria-hidden': 'true' }, [el('span', { text: weeks[0] }), el('span', { text: last === partialWeek ? `${last} \u00b7 partial` : last })]),
  ]);
}

function renderSectors() {
  clear(els.sectorGrid);
  for (const row of trends.bySector) els.sectorGrid.append(sparkline(row, trends.weeks, trends.partialWeek));
}

// -- weekly tables --

function renderWeekly(table, rows, label) {
  const headRow = table.querySelector('thead tr');
  const tbody = table.querySelector('tbody');
  clear(headRow);
  clear(tbody);
  headRow.append(th(label));
  for (const w of trends.weeks) headRow.append(th(w === trends.partialWeek ? `${w} (partial)` : w, 'num'));
  for (const row of rows) {
    const tr = el('tr', {}, [el('th', { scope: 'row', text: row.label })]);
    row.counts.forEach((v, i) => tr.append(el('td', { className: `num${trends.weeks[i] === trends.partialWeek ? ' partial' : ''}`, text: num(v) })));
    tbody.append(tr);
  }
}

function renderAll() {
  if (!trends) {
    els.status.setAttribute('role', 'alert');
    els.status.textContent = `Could not load trends: ${loadError}`;
    els.method.hidden = true;
    for (const id of ['terms', 'sectors', 'kinds', 'regions']) $(id).hidden = true;
    return;
  }
  els.method.textContent = trends.method;
  els.status.textContent = `${num(trends.items)} items in the 90-day window \u00b7 counts generated ${absoluteTime(trends.generatedAt)}`;
  renderTerms();
  renderSectors();
  renderWeekly(els.kindTable, trends.byKind, 'Kind');
  renderWeekly(els.regionTable, trends.byRegion, 'Region');
}

async function loadTrends() {
  try {
    const body = await fetchJson(TRENDS_URL);
    if (!body || !Array.isArray(body.terms) || !Array.isArray(body.weeks) || !Array.isArray(body.bySector)) throw new Error('unexpected response');
    trends = body;
  } catch (err) {
    trends = null;
    loadError = err.message;
  }
}

async function init() {
  wireOpeners(document.getElementById('main'), lens.open);
  const [stats] = await Promise.all([lens.loadStats(), items.load().catch(() => []), loadTrends()]);
  items.setArchiveItems(stats?.archiveItems);
  renderAll();
  await lens.start();
}

init();
