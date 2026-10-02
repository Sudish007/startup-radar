import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KINDS, REGIONS } from '../lib/classify.js';

const ID_RE = /^[a-z0-9_]+$/;

function validate(source, file, seen) {
  const where = `source file ${file}`;
  if (!source || typeof source !== 'object') throw new Error(`${where}: default export must be an object`);
  if (typeof source.id !== 'string' || !ID_RE.test(source.id)) throw new Error(`${where}: invalid id`);
  if (source.id !== path.basename(file, '.js')) throw new Error(`${where}: id "${source.id}" must equal the filename`);
  if (seen.has(source.id)) throw new Error(`${where}: duplicate id "${source.id}"`);
  if (typeof source.name !== 'string' || !source.name) throw new Error(`${where}: name must be a string`);
  if (typeof source.homepage !== 'string' || !source.homepage) throw new Error(`${where}: homepage must be a string`);
  if (!KINDS.includes(source.kind)) throw new Error(`${where}: kind "${source.kind}" not in ${KINDS.join('|')}`);
  if (!REGIONS.includes(source.region)) throw new Error(`${where}: region "${source.region}" not in ${REGIONS.join('|')}`);
  if (typeof source.enabled !== 'function') throw new Error(`${where}: enabled must be a function`);
  if (typeof source.fetch !== 'function') throw new Error(`${where}: fetch must be a function`);
  if (source.requires !== undefined && source.requires !== null && typeof source.requires !== 'string') {
    throw new Error(`${where}: requires must be a string or null`);
  }
}

/** Import every adapter in this directory. Adding a source = adding one file. */
export async function loadSources() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .sort();

  const seen = new Set();
  const sources = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const source = mod.default;
    validate(source, file, seen);
    seen.add(source.id);
    sources.push({ requires: null, ...source });
  }
  return sources.sort((a, b) => a.id.localeCompare(b.id));
}

export function sourceMap(sources) {
  return new Map(sources.map((s) => [s.id, s]));
}
