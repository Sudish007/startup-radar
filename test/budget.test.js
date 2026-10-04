// Payload budget of the frontend (design.md section 21): the HTML + CSS + JS a
// page loads stays under 120 000 bytes uncompressed, theme.js fits in 1 KB, no
// third-party script and no Google Fonts anywhere.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BUDGET = 120_000;
const HOME = ['index.html', 'styles.css', 'theme.js', 'ui.js', 'app.js', 'filter.js', 'format.js', 'radar.js'];
const SOURCES = ['sources.html', 'styles.css', 'sources.css', 'theme.js', 'ui.js', 'format.js', 'sources.js'];
// Loaded after `load` like sw.js (design.md section 21 excludes post-load PWA plumbing from the first-render budget); bounded here.
const DEFERRED = ['pwa.js', 'sw.js'];
const DEFERRED_BUDGET = 10_000;

const size = (name) => fs.statSync(path.join(PUBLIC_DIR, name)).size;
const read = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

describe('frontend payload budget', () => {
  test('home bundle < 120000 bytes', () => {
    const rows = HOME.map((f) => [f, size(f)]);
    const total = rows.reduce((n, [, b]) => n + b, 0);
    console.log('| file | bytes |');
    console.log('|---|---|');
    for (const [f, b] of rows) console.log(`| ${f} | ${b} |`);
    console.log(`| home total | ${total} |`);
    console.log(`| sources total | ${SOURCES.reduce((n, f) => n + size(f), 0)} |`);
    for (const f of DEFERRED) console.log(`| ${f} (after load, not in the first-render budget) | ${size(f)} |`);
    assert.ok(total < BUDGET, `home set is ${total} bytes`);
  });

  test('sources bundle < 120000 bytes', () => {
    const total = SOURCES.reduce((n, f) => n + size(f), 0);
    assert.ok(total < BUDGET, `sources set is ${total} bytes`);
  });

  test('deferred PWA scripts (pwa.js + sw.js) stay small', () => {
    const total = DEFERRED.reduce((n, f) => n + size(f), 0);
    assert.ok(total < DEFERRED_BUDGET, `deferred set is ${total} bytes`);
  });

  test('theme.js <= 1024 bytes', () => {
    assert.ok(size('theme.js') <= 1024, `${size('theme.js')} bytes`);
  });

  test('no third-party scripts or Google Fonts', () => {
    for (const name of ['index.html', 'sources.html']) {
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
