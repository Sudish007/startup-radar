import path from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createHttp } from './lib/http.js';
import { loadSources } from './sources/index.js';
import { createRefresh, createScheduler } from './refresh.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(path.join(config.dataDir, 'startup-radar.db'));
const sources = await loadSources();
const http = createHttp(config);
const refresh = createRefresh({ db, http, sources, env: process.env, log: console.log });
const scheduler = createScheduler(refresh, config.refreshMinutes);
const app = createApp({ db, sources, config, refresh });

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`listening on http://0.0.0.0:${config.port}`);
  // Refresh starts only once the server accepts connections so /health is up immediately.
  scheduler.start();
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Do not hang on long-lived connections.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
