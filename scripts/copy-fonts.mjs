#!/usr/bin/env node
// Copy the two self-hosted Geist variable fonts (latin subset only) and their
// OFL-1.1 licence from the pinned @fontsource-variable packages into public/fonts/.
//
//   npm run fonts:copy
//
// The woff2 files are committed so both hosts (GitHub Pages and Express) serve
// them without a build step; this script exists to refresh them when the pinned
// package version changes. It exits 1 when a copied file's byte size differs
// from the size recorded here, which catches a silent package change.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'fonts');

const FILES = [
  {
    from: path.join(ROOT, 'node_modules', '@fontsource-variable', 'geist', 'files', 'geist-latin-wght-normal.woff2'),
    to: path.join(OUT_DIR, 'geist-latin-wght-normal.woff2'),
    bytes: 29400,
  },
  {
    from: path.join(ROOT, 'node_modules', '@fontsource-variable', 'geist-mono', 'files', 'geist-mono-latin-wght-normal.woff2'),
    to: path.join(OUT_DIR, 'geist-mono-latin-wght-normal.woff2'),
    bytes: 23128,
  },
  {
    from: path.join(ROOT, 'node_modules', '@fontsource-variable', 'geist', 'LICENSE'),
    to: path.join(OUT_DIR, 'LICENSE-OFL.txt'),
    bytes: null, // licence text: any size
  },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
let failed = false;
for (const f of FILES) {
  if (!fs.existsSync(f.from)) {
    console.error(`[fonts] missing ${path.relative(ROOT, f.from)} (run npm install first)`);
    failed = true;
    continue;
  }
  fs.copyFileSync(f.from, f.to);
  const size = fs.statSync(f.to).size;
  if (f.bytes !== null && size !== f.bytes) {
    console.error(`[fonts] ${path.relative(ROOT, f.to)}: ${size} bytes, expected ${f.bytes}`);
    failed = true;
  } else {
    console.log(`[fonts] ${path.relative(ROOT, f.to)} (${size} bytes)`);
  }
}
process.exitCode = failed ? 1 : 0;
