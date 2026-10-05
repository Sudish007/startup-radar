// Payload budget of the frontend (design.md section 21, ceiling raised from 120 000 to 125 000 bytes
// by the polish pass: radar caption channel + spread, source-aware labels, plurals; to 130 000 by
// the radar fan fix: bucket-proportional sub-wedges, radial jitter, de-stacking, density tiers; and to
// 150 000 per page set by the ideas-engine task spec (shared shell + nav, drawer module, sector chips,
// bookmarks)): the HTML + CSS + JS a page loads stays under the ceiling uncompressed, theme.js fits in
// 1 KB, no third-party script and no Google Fonts anywhere. Sizes are measured as deployed (LF line
// endings), so an autocrlf checkout on Windows reports the same bytes as the Pages build.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BUDGET = 150_000; // task spec: per-page ceiling (plan D9)
const HOME = ['index.html', 'styles.css', 'theme.js', 'ui.js', 'app.js', 'filter.js', 'format.js', 'radar.js', 'nav.js', 'shell.js', 'drawer.js', 'notebook-store.js'];
const SOURCES = ['sources.html', 'styles.css', 'sources.css', 'theme.js', 'ui.js', 'format.js', 'sources.js', 'nav.js', 'shell.js'];
// Lens pages (FEAT-003): shell + drawer (drawer.js imports filter.js) + the shared lens.js runtime + pages.css.
const LENS_SHARED = ['styles.css', 'pages.css', 'theme.js', 'ui.js', 'format.js', 'nav.js', 'shell.js', 'drawer.js', 'filter.js', 'lens.js'];
const TRENDS = ['trends.html', ...LENS_SHARED, 'trends.js'];
const FUNDING = ['funding.html', ...LENS_SHARED, 'funding.js'];
const YC = ['yc.html', ...LENS_SHARED, 'yc.js'];
const PAGE_SETS = { home: HOME, sources: SOURCES, trends: TRENDS, funding: FUNDING, yc: YC };
// Loaded after `load` like sw.js, or lazily on the first drawer open (related.js + text.js); bounded here.
const DEFERRED = ['pwa.js', 'sw.js', 'related.js', 'text.js'];
const DEFERRED_BUDGET = 16_000;

const read = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
const size = (name) => Buffer.byteLength(read(name).replace(/\r\n/g, '\n'));
const total = (files) => files.reduce((n, f) => n + size(f), 0);

describe('frontend payload budget', () => {
  test(`home bundle < ${BUDGET} bytes`, () => {
    const rows = HOME.map((f) => [f, size(f)]);
    const sum = rows.reduce((n, [, b]) => n + b, 0);
    console.log('| file | bytes |');
    console.log('|---|---|');
    for (const [f, b] of rows) console.log(`| ${f} | ${b} |`);
    for (const f of ['pages.css', 'lens.js', 'trends.js', 'funding.js', 'yc.js', 'trends.html', 'funding.html', 'yc.html']) console.log(`| ${f} (lens pages) | ${size(f)} |`);
    for (const [name, files] of Object.entries(PAGE_SETS)) console.log(`| ${name} total | ${total(files)} |`);
    for (const f of DEFERRED) console.log(`| ${f} (after load, not in the first-render budget) | ${size(f)} |`);
    assert.ok(sum < BUDGET, `home set is ${sum} bytes`);
  });

  for (const [name, files] of Object.entries(PAGE_SETS)) {
    if (name === 'home') continue;
    test(`${name} bundle < ${BUDGET} bytes`, () => {
      const sum = total(files);
      assert.ok(sum < BUDGET, `${name} set is ${sum} bytes`);
    });
  }

  test('deferred scripts (pwa.js + sw.js + related.js + text.js) stay small', () => {
    const total = DEFERRED.reduce((n, f) => n + size(f), 0);
    assert.ok(total < DEFERRED_BUDGET, `deferred set is ${total} bytes`);
  });

  test('theme.js <= 1024 bytes', () => {
    assert.ok(size('theme.js') <= 1024, `${size('theme.js')} bytes`);
  });

  test('no third-party scripts or Google Fonts', () => {
    for (const name of ['index.html', 'sources.html', 'trends.html', 'funding.html', 'yc.html']) {
      const html = read(name);
      const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(srcs.length >= 2, `${name} has script tags`);
      for (const src of srcs) assert.ok(src.startsWith('./') && !/^(https?:)?\/\//.test(src), `${name}: off-origin script ${src}`);
      assert.equal(/fonts\.googleapis|fonts\.gstatic/.test(html), false, `${name} references Google Fonts`);
    }
    const css = read('styles.css');
    assert.equal(/fonts\.googleapis|fonts\.gstatic|@import/.test(css), false, 'styles.css references Google Fonts or imports');
    assert.equal(/url\(\s*['"]?https?:/.test(css), false, 'styles.css loads a remote resource');
  });
});
