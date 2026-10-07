// public/resources-data.js (plan §3.2 item 20): 4 groups, 16 links, https only, unique URLs and names, one short
// honest note each (no superlatives). The live reachability check is scripts/check-links.mjs (network, not here).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOURCE_GROUPS } from '../public/resources-data.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const links = RESOURCE_GROUPS.flatMap((g) => g.links);
const SUPERLATIVE = /\b(best|top|#1|ultimate)\b/i;

describe('resources data', () => {
  test('4 groups in the documented order with 4 links each (16 links)', () => {
    assert.deepEqual(RESOURCE_GROUPS.map((g) => g.title), ['Idea sources', 'Reports', 'Communities', 'Learning']);
    assert.deepEqual(RESOURCE_GROUPS.map((g) => g.links.length), [4, 4, 4, 4]);
    assert.equal(links.length, 16);
  });

  test('every link has a name, an https URL and a note <= 160 chars without superlatives', () => {
    for (const l of links) {
      assert.ok(typeof l.name === 'string' && l.name.trim().length >= 3, `name: ${l.name}`);
      assert.match(l.url, /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^\s"'<>]*)?$/i, `url: ${l.url}`);
      assert.equal(new URL(l.url).href, l.url, `${l.url} is already normalised`);
      assert.ok(typeof l.note === 'string' && l.note.trim().length >= 20 && l.note.length <= 160, `note length ${l.note.length}: ${l.note}`);
      assert.doesNotMatch(l.note, SUPERLATIVE, `superlative in: ${l.note}`);
      assert.doesNotMatch(l.name, SUPERLATIVE, `superlative in: ${l.name}`);
      assert.match(l.note.trim(), /[.!]$/, `note ends a sentence: ${l.note}`);
      assert.equal((l.note.match(/[.!?](\s|$)/g) || []).length, 1, `one sentence: ${l.note}`);
    }
  });

  test('URLs and names are unique; the probed BVP and Sequoia URLs are the ones that answered 200', () => {
    assert.equal(new Set(links.map((l) => l.url)).size, 16);
    assert.equal(new Set(links.map((l) => l.name.toLowerCase())).size, 16);
    assert.ok(links.some((l) => l.url === 'https://www.bvp.com/atlas/state-of-the-cloud-2024'), 'BVP 2024 (the 2025 URL is 404)');
    assert.ok(links.some((l) => l.url === 'https://www.sequoiacap.com/arc/'));
  });

  test('resources.js and resources.html are link-only (no fetch of outside pages, extLink for every link)', () => {
    const js = fs.readFileSync(path.join(PUBLIC_DIR, 'resources.js'), 'utf8');
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'resources.html'), 'utf8');
    assert.ok(js.includes("from './resources-data.js'"));
    assert.ok(js.includes('extLink(link.url, link.name'), 'links are created with extLink');
    assert.equal(/fetch\(/.test(js.replace(/\/\/.*$/gm, '')), false, 'resources.js fetches nothing itself');
    assert.ok(html.includes('Links only \u2014 nothing here is fetched or counted.'), 'intro states the link-only nature');
  });
});
