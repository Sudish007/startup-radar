// DOM-safety guards for the frontend: every piece of feed text reaches the DOM
// through textContent (ui.js el()), external anchors are created only by
// extLink(), and no page embeds third-party content.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const JS_FILES = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.js'));
const HTML_FILES = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
const read = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

/** Source range of a top-level `export function <name>(...) { ... }` body (paren + brace matching). */
function functionBody(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} is exported`);
  let i = source.indexOf('(', start);
  let depth = 0;
  for (; i < source.length; i += 1) { // skip the parameter list (it may contain destructuring braces)
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') { depth -= 1; if (depth === 0) break; }
  }
  const open = source.indexOf('{', i);
  depth = 0;
  for (let j = open; j < source.length; j += 1) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}') {
      depth -= 1;
      if (depth === 0) return { start: open, end: j + 1, text: source.slice(open, j + 1) };
    }
  }
  throw new Error(`unterminated function ${name}`);
}

describe('public/*.js DOM safety', () => {
  test('no innerHTML/outerHTML/insertAdjacentHTML/document.write/eval/new Function/window.open', () => {
    assert.ok(JS_FILES.length >= 7, JS_FILES.join());
    for (const file of JS_FILES) {
      const text = read(file);
      for (const needle of ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write', 'eval(', 'new Function', 'window.open(']) {
        assert.equal(text.includes(needle), false, `${file} contains ${needle}`);
      }
    }
  });

  test("'_blank' only inside extLink", () => {
    const ui = read('ui.js');
    const body = functionBody(ui, 'extLink');
    for (const file of JS_FILES) {
      const text = read(file);
      let idx = text.indexOf('_blank');
      while (idx >= 0) {
        assert.equal(file, 'ui.js', `${file} sets _blank outside extLink`);
        assert.ok(idx > body.start && idx < body.end, `ui.js: _blank at ${idx} is outside extLink (${body.start}-${body.end})`);
        idx = text.indexOf('_blank', idx + 1);
      }
    }
    assert.ok(body.text.includes("rel = 'noopener noreferrer'"), 'extLink sets rel="noopener noreferrer"');
  });

  test('no iframe/embed/object', () => {
    for (const file of [...JS_FILES, ...HTML_FILES]) {
      const text = read(file).toLowerCase();
      for (const needle of ['<iframe', '<embed', '<object', "createelement('iframe')", "createelement('embed')", "createelement('object')"]) {
        assert.equal(text.includes(needle), false, `${file} contains ${needle}`);
      }
    }
  });

  test('no inline scripts, inline styles or inline handlers in the HTML (CSP)', () => {
    for (const file of HTML_FILES) {
      const text = read(file);
      assert.doesNotMatch(text, /<script(?![^>]*\ssrc=)[^>]*>/i, `${file}: inline <script>`);
      assert.doesNotMatch(text, /<style[\s>]/i, `${file}: inline <style>`);
      assert.doesNotMatch(text, /\sstyle="/i, `${file}: style attribute`);
      assert.doesNotMatch(text, /\son[a-z]+="/i, `${file}: inline event handler`);
      assert.doesNotMatch(text, /href="javascript:/i, `${file}: javascript: URL`);
    }
  });
});
