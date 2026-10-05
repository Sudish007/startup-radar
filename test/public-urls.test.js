// Sub-path safety of everything under public/: GitHub Pages serves the site
// from /startup-radar/, so a single leading-slash URL (or an absolute manifest
// id) would break the deployment. Also freezes the attribute-free <h1> that
// test/app.test.js matches with /<h1>/.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SCANNED_EXT = new Set(['.html', '.js', '.css', '.webmanifest']);

const FORBIDDEN = [
  /(?:href|src)="\/(?!\/)/,
  /'\/api\//,
  /'\/data\//,
  /"\/api\//,
  /"\/data\//,
  /fetch\('\//,
  /fetch\("\//,
  /url\(\s*['"]?\/(?!\/)/,
  /register\('\//,
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (SCANNED_EXT.has(path.extname(entry.name))) out.push(p);
  }
  return out;
}

const read = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
const HTML_FILES = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html')).sort();

describe('public/ sub-path safety', () => {
  test('no leading-slash or forbidden literals in public/ (incl. sw.js)', () => {
    const files = walk(PUBLIC_DIR);
    assert.ok(files.some((f) => path.basename(f) === 'sw.js'), 'sw.js is scanned');
    assert.ok(files.length >= 12, `scanned ${files.length} files`);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) {
        const m = re.exec(text);
        assert.equal(m, null, `${path.relative(PUBLIC_DIR, file)} matches ${re}: ${m && m[0]}`);
      }
    }
  });

  test('manifest start_url/scope are ./ and id is absent', () => {
    const manifest = JSON.parse(read('manifest.webmanifest'));
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    assert.equal('id' in manifest, false);
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.icons.length, 3);
    for (const icon of manifest.icons) {
      assert.ok(icon.src.startsWith('./icons/'), icon.src);
      assert.ok(fs.existsSync(path.join(PUBLIC_DIR, icon.src)), `${icon.src} exists`);
      assert.equal(icon.type, 'image/png');
    }
    assert.deepEqual(manifest.icons.map((i) => i.purpose), ['any', 'any', 'maskable']);
  });

  test('every public/*.html: literal references, head order, CSP, one attribute-free <h1>', () => {
    assert.ok(HTML_FILES.length >= 5, HTML_FILES.join());
    const csp = `default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'`;
    for (const name of HTML_FILES) {
      const text = read(name);
      const script = name === 'index.html' ? 'app.js' : name.replace(/\.html$/, '.js');
      for (const needle of ['href="./styles.css"', `src="./${script}"`, 'rel="manifest" href="./manifest.webmanifest"', 'src="./theme.js"', 'viewport-fit=cover', 'href="./icons/favicon.svg"', csp]) {
        assert.ok(text.includes(needle), `${name} contains ${needle}`);
      }
      // theme-color precedes theme.js, which precedes the stylesheet (no theme flash)
      assert.ok(text.indexOf('name="theme-color"') < text.indexOf('src="./theme.js"'), `${name} head order (theme-color before theme.js)`);
      assert.ok(text.indexOf('src="./theme.js"') < text.indexOf('href="./styles.css"'), `${name} head order (theme.js before styles.css)`);
      // one module script, this page's own
      const scripts = [...text.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]).filter((s) => s !== './theme.js');
      assert.deepEqual(scripts, [`./${script}`], `${name} loads only its own module`);
      // attribute-free <h1>, exactly once (test/app.test.js matches /<h1>/)
      assert.match(text, /<h1>/, `${name} has a bare <h1>`);
      assert.doesNotMatch(text, /<h1\s/, `${name} has no attributed <h1`);
      assert.equal((text.match(/<h1[\s>]/g) || []).length, 1, `${name} has exactly one h1`);
    }
    assert.ok(read('sources.html').includes('href="./sources.css"'));
    for (const name of ['trends.html', 'funding.html', 'yc.html']) {
      assert.ok(read(name).includes('href="./pages.css"'), `${name} loads pages.css`);
      assert.ok(read(name).includes(`<body class="page-${name.replace(/\.html$/, '')}">`), `${name} body.page-<name>`);
    }
  });

  test('#filters-open exists exactly once, inside the top bar', () => {
    const index = read('index.html');
    assert.equal((index.match(/id="filters-open"/g) || []).length, 1);
    const topbarEnd = index.indexOf('</header>');
    assert.ok(index.indexOf('id="filters-open"') < topbarEnd);
  });
});
