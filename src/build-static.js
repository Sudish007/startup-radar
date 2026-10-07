import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildDerived } from './derived.js';
import { buildSnapshot } from './export.js';
import { createHttp } from './lib/http.js';
import { createRefresh, formatSummaryTable } from './refresh.js';
import { EMPTY_SIGNALS, formatSignalsTable, runSignals } from './signals/run.js';
import { loadSignals } from './signals/index.js';
import { fetchSnapshot, importSnapshotItems, importSnapshotStatuses } from './snapshot.js';
import { loadSources } from './sources/index.js';

function writeJson(filePath, value) {
  const text = JSON.stringify(value);
  fs.writeFileSync(filePath, text);
  return Buffer.byteLength(text);
}

const kb = (bytes) => (bytes / 1024).toFixed(1);

/** yc.json above this size fails the build (plan: ~230 KB expected for 3 batches). */
export const YC_JSON_MAX_BYTES = 300_000;

/**
 * Build the static site into `outDir`:
 * open the DB, import the previous snapshot (optional), run one live refresh cycle,
 * fail when no source returned items, otherwise copy public/ and write data/*.json.
 * Returns { exitCode, summary?, counts? }.
 */
export async function runBuild({
  sources,
  signals = [],
  http,
  env = process.env,
  log = console.log,
  outDir,
  publicDir,
  dbPath,
  snapshotUrl = null,
  publicUrl = env.PUBLIC_URL?.trim() || 'http://localhost:3000',
  now = new Date(),
  buildVersion = env.GITHUB_SHA?.slice(0, 12) ?? now.toISOString().replace(/\D/g, '').slice(0, 14),
}) {
  const db = openDb(dbPath);
  try {
    let imported = 0;
    let previousSignals = null;
    if (snapshotUrl) {
      const snap = await fetchSnapshot(snapshotUrl, { http, log });
      const previous = [...(snap.items ?? []), ...(snap.archive ?? [])];
      if (snap.items || snap.archive) {
        imported = importSnapshotItems(db, sources, previous, { log, nowIso: now.toISOString(), url: snapshotUrl }).imported;
      }
      importSnapshotStatuses(db, sources, snap.sources);
      previousSignals = snap.signals ?? null;
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

    // Signals (plan D8) run after the sources cycle; a failing signal keeps the previous snapshot's payload
    // and never affects the exit code.
    let signalsResult = { ...EMPTY_SIGNALS, generatedAt: now.toISOString() };
    if (signals.length > 0) {
      try {
        signalsResult = await runSignals({ signals, http, env, previous: previousSignals, now, log: () => {} });
      } catch (err) {
        log(`[build] signals: run failed: ${err?.message ?? err}`);
      }
      for (const line of formatSignalsTable(signals, signalsResult)) log(line);
    }

    const snapshot = buildSnapshot({ db, sources, env, now });
    const derived = buildDerived({ db, sources, env, now, signals: signalsResult, publicUrl });

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
    const trendsBytes = writeJson(path.join(dataDir, 'trends.json'), derived.trends);
    const fundingBytes = writeJson(path.join(dataDir, 'funding.json'), derived.funding);
    const ycBytes = writeJson(path.join(dataDir, 'yc.json'), derived.yc);
    const signalsBytes = writeJson(path.join(dataDir, 'signals.json'), derived.signals);
    const digestBytes = writeJson(path.join(dataDir, 'digest.json'), derived.digest);
    fs.writeFileSync(path.join(outDir, 'feed.xml'), derived.feedXml);
    const feedBytes = Buffer.byteLength(derived.feedXml);
    log(`[build] derived trends.json ${kb(trendsBytes)} KB, funding.json ${kb(fundingBytes)} KB, yc.json ${kb(ycBytes)} KB`);
    log(`[build] derived signals.json ${kb(signalsBytes)} KB, digest.json ${kb(digestBytes)} KB, feed.xml ${kb(feedBytes)} KB`);
    if (ycBytes > YC_JSON_MAX_BYTES) {
      log(`[build] FAIL: yc.json is ${ycBytes} bytes (limit ${YC_JSON_MAX_BYTES})`);
      return { exitCode: 1, summary };
    }

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
      trendsBytes,
      fundingBytes,
      ycBytes,
      signalsBytes,
      digestBytes,
      feedBytes,
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
    const signals = await loadSignals();
    const http = createHttp(config);
    const result = await runBuild({
      sources,
      signals,
      http,
      env: process.env,
      log: console.log,
      outDir: path.resolve('dist'),
      publicDir: path.resolve('public'),
      dbPath: path.join(tmp, 'startup-radar.db'),
      snapshotUrl: process.env.PREVIOUS_SNAPSHOT_URL?.trim() || null,
      publicUrl: config.publicUrl,
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
