// Signal registry (plan D8): src/signals/*.js mirror src/sources/*.js. A signal is a separate dataset
// (data/signals.json) rather than feed items: { id (= filename), name, homepage, description, enabled(env),
// requires, fetch(ctx) -> data }. `description` is one honest sentence about what the numbers are.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ID_RE = /^[a-z0-9_]+$/;
const SKIP = new Set(['index.js', 'run.js']);

export function validateSignal(signal, file, seen = new Set()) {
  const where = `signal file ${file}`;
  if (!signal || typeof signal !== 'object') throw new Error(`${where}: default export must be an object`);
  if (typeof signal.id !== 'string' || !ID_RE.test(signal.id)) throw new Error(`${where}: invalid id`);
  if (signal.id !== path.basename(file, '.js')) throw new Error(`${where}: id "${signal.id}" must equal the filename`);
  if (seen.has(signal.id)) throw new Error(`${where}: duplicate id "${signal.id}"`);
  if (typeof signal.name !== 'string' || !signal.name) throw new Error(`${where}: name must be a string`);
  if (typeof signal.homepage !== 'string' || !signal.homepage) throw new Error(`${where}: homepage must be a string`);
  if (typeof signal.description !== 'string' || !signal.description) throw new Error(`${where}: description must be a string`);
  if (typeof signal.enabled !== 'function') throw new Error(`${where}: enabled must be a function`);
  if (typeof signal.fetch !== 'function') throw new Error(`${where}: fetch must be a function`);
  if (signal.requires !== undefined && signal.requires !== null && typeof signal.requires !== 'string') {
    throw new Error(`${where}: requires must be a string or null`);
  }
}

/** Import every adapter in this directory except index.js and run.js. Adding a signal = adding one file. */
export async function loadSignals() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith('.js') && !SKIP.has(f))
    .sort();

  const seen = new Set();
  const signals = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const signal = mod.default;
    validateSignal(signal, file, seen);
    seen.add(signal.id);
    signals.push({ requires: null, ...signal });
  }
  return signals.sort((a, b) => a.id.localeCompare(b.id));
}
