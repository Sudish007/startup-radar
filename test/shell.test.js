// Shared-shell drift guard (plan D2): every public/*.html ships the same static nav list as public/nav.js NAV
// (no flash, no-JS fallback; screenshots.py and app.test.js read static HTML), exactly one nav.site-nav, no
// page-local help dialog / toasts / footer links (shell.js mounts them), one attribute-free <h1>.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOTO_ROWS, NAV, pageOf } from '../public/nav.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HTML_FILES = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html')).sort();
const read = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

/** [{ href, label, current }] of the static <ul id="site-nav-list"> (anchors in document order). */
function staticNav(html) {
  const m = /<ul id="site-nav-list">([\s\S]*?)<\/ul>/.exec(html);
  assert.ok(m, 'has <ul id="site-nav-list">');
  return [...m[1].matchAll(/<a href="([^"]+)"(?: aria-current="page")?>([^<]+)<\/a>/g)].map((a) => ({ href: a[1], label: a[2], current: a[0].includes('aria-current="page"') }));
}

describe('nav.js', () => {
  test('NAV has six pages with unique hrefs/pages and go-to keys for all but Sources', () => {
    assert.equal(NAV.length, 6);
    assert.deepEqual(NAV.map((n) => n.page), ['feed', 'trends', 'funding', 'yc', 'notebook', 'sources']);
    assert.deepEqual(NAV.map((n) => n.key), ['h', 't', 'f', 'y', 'n', null]);
    for (const n of NAV) assert.match(n.href, /^\.\/[a-z]+\.html$/, n.href);
    assert.equal(new Set(NAV.map((n) => n.href)).size, 6);
    assert.deepEqual(GOTO_ROWS, [[['g', 'h'], 'Go to Feed'], [['g', 't'], 'Go to Trends'], [['g', 'f'], 'Go to Funding'], [['g', 'y'], 'Go to YC'], [['g', 'n'], 'Go to Notebook']]);
  });

  test('pageOf maps pathnames at the root and under a sub-path', () => {
    assert.equal(pageOf('/'), 'feed');
    assert.equal(pageOf('/startup-radar/'), 'feed');
    assert.equal(pageOf('/index.html'), 'feed');
    assert.equal(pageOf('/startup-radar/trends.html'), 'trends');
    assert.equal(pageOf('/sources'), 'sources');
    assert.equal(pageOf('/sources.html'), 'sources');
    assert.equal(pageOf('/startup-radar/notebook.html'), 'notebook');
    assert.equal(pageOf('/nope.html'), null);
    assert.equal(pageOf(undefined), 'feed');
  });
});

describe('every public/*.html matches the shell contract', () => {
  assert.ok(HTML_FILES.length >= 2, HTML_FILES.join());
  for (const file of HTML_FILES) {
    test(`${file}: static nav list equals NAV in order, aria-current on its own page`, () => {
      const html = read(file);
      const links = staticNav(html);
      assert.deepEqual(links.map((l) => [l.href, l.label]), NAV.map((n) => [n.href, n.label]));
      const page = pageOf(`/${file}`);
      assert.ok(page, `${file} is a NAV page`);
      assert.deepEqual(links.filter((l) => l.current).map((l) => l.href), [NAV.find((n) => n.page === page).href]);
      assert.equal((html.match(/<nav class="site-nav"/g) || []).length, 1, 'exactly one nav.site-nav');
      assert.equal((html.match(/id="site-nav-list"/g) || []).length, 1);
    });

    test(`${file}: no page-local help dialog, toasts, footer links or nav toggle (shell.js mounts them)`, () => {
      const html = read(file);
      for (const needle of ['<dialog id="help"', 'id="toasts"', 'class="footer-links"', 'id="help-link"', 'id="install"', 'id="nav-toggle"', '<dialog id="detail"']) {
        assert.equal(html.includes(needle), false, `${file} contains ${needle}`);
      }
      assert.ok(html.includes('<footer class="site-footer">') && html.includes('<div class="wrap">'), 'footer.site-footer .wrap exists for the shared links');
    });

    test(`${file}: exactly one attribute-free <h1>`, () => {
      const html = read(file);
      assert.match(html, /<h1>/);
      assert.doesNotMatch(html, /<h1\s/);
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
    });
  }
});

describe('shell.js source contract', () => {
  const src = read('shell.js');
  test('mounts the documented ids/classes and the g-chord window', () => {
    for (const needle of ["id: 'nav-toggle'", "'aria-controls': ul.id", "id: 'help'", "id: 'toasts'", "id: 'detail'", "className: 'footer-links'", "id: 'help-link'", "id: 'install'", 'CHORD_MS = 800', 'location.assign(dest.href)', 'initTheme()', 'initHelp()', 'observeSticky()', 'fillHelp([...help, ...GOTO_ROWS])']) {
      assert.ok(src.includes(needle), `shell.js contains ${needle}`);
    }
  });
});
