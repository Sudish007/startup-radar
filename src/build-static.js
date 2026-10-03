import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildSnapshot } from './export.js';
import { createHttp } from './lib/http.js';
import { createRefresh, formatSummaryTable } from './refresh.js';
import { fetchSnapshot, importSnapshotItems, importSnapshotStatuses } from './snapshot.js';
import { loadSources } from './sources/index.js';

function writeJson(filePath, value) {
  const text = JSON.stringify(value);
  fs.writeFileSync(filePath, text);
  return Buffer.byteLength(text);
}

const kb = (bytes) => (bytes / 1024).toFixed(1);

/**
 * Build the static site into `outDir`:
 * open the DB, import the previous snapshot (optional), run one live refresh cycle,
 * fail when no source returned items, otherwise copy public/ and write data/*.json.
 * Returns { exitCode, summary?, counts? }.
 */
export async function runBuild({
  sources,
  http,
  env = process.env,
  log = console.log,
  outDir,
  publicDir,
  dbPath,
  snapshotUrl = null,
  now = new Date(),
  buildVersion = env.GITHUB_SHA?.slice(0, 12) ?? now.toISOString().replace(/\D/g, '').slice(0, 14),
}) {
  const db = openDb(dbPath);
  try {
    let imported = 0;
    if (snapshotUrl) {
      const snap = await fetchSnapshot(snapshotUrl, { http, log });
      const previous = [...(snap.items ?? []), ...(snap.archive ?? [])];
      if (snap.items || snap.archive) {
        imported = importSnapshotItems(db, sources, previous, { log, nowIso: now.toISOString(), url: snapshotUrl }).imported;
      }
      importSnapshotStatuses(db, sources, snap.sources);
    } else {
      log('[build] snapshot: PREVIOUS_SNAPSHOT_URL not set, starting empty');
    }

    const summary = await createRefresh({ db, http, sources, env, log: () => {} }).runRefreshCycle();
    for (const line of formatSummaryTable(sources, summary, env)) log(line);

    const live = summary.sources.filter((r) => r.ok && r.count > 0);
    if (live.length === 0) {
      log('[build] FAIL: no source returned items');
      return { exitCode: 1, summary };
    }

    const snapshot = buildSnapshot({ db, sources, env, now });

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.cpSync(publicDir, outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
    // Version the service worker's precache (the token also exists in src/app.js's /sw.js route).
    const swPath = path.join(outDir, 'sw.js');
    if (fs.existsSync(swPath)) {
      fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replaceAll('__BUILD_VERSION__', String(buildVersion)));
      log(`[build] sw version ${buildVersion}`);
    }
    const dataDir = path.join(outDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const itemsBytes = writeJson(path.join(dataDir, 'items.json'), snapshot.items);
    const archiveBytes = snapshot.archive ? writeJson(path.join(dataDir, 'archive.json'), snapshot.archive) : 0;
    writeJson(path.join(dataDir, 'sources.json'), snapshot.sources);
    writeJson(path.join(dataDir, 'stats.json'), snapshot.stats);

    const liveCount = live.reduce((n, r) => n + r.count, 0);
    const okCount = summary.sources.filter((r) => r.ok).length;
    const exported = snapshot.items.length + (snapshot.archive?.length ?? 0);
    const counts = {
      imported,
      live: liveCount,
      sourcesOk: okCount,
      sourcesEnabled: summary.sources.length,
      exported,
      items: snapshot.items.length,
      itemsBytes,
      archive: snapshot.archive?.length ?? 0,
      archiveBytes,
    };
    log(
      `[build] imported ${imported} from snapshot, fetched ${liveCount} live (${okCount} sources OK of ${summary.sources.length} enabled), ` +
        `exported ${exported} items (items.json ${counts.items} items / ${kb(itemsBytes)} KB` +
        (snapshot.archive ? `, archive.json ${counts.archive} items / ${kb(archiveBytes)} KB` : '') +
        ')',
    );
    return { exitCode: 0, summary, counts };
  } finally {
    db.close();
  }
}

async function main() {
  const config = loadConfig();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-radar-build-'));
  try {
    const sources = await loadSources();
    const http = createHttp(config);
    const result = await runBuild({
      sources,
      http,
      env: process.env,
      log: console.log,
      outDir: path.resolve('dist'),
      publicDir: path.resolve('public'),
      dbPath: path.join(tmp, 'startup-radar.db'),
      snapshotUrl: process.env.PREVIOUS_SNAPSHOT_URL?.trim() || null,
    });
    return result.exitCode;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
