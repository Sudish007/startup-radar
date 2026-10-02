import fs from 'node:fs';

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function optional(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > 0 ? s : null;
}

/**
 * Build the runtime configuration from environment variables.
 * Loads ./.env first when present (Node's built-in loader, no dotenv).
 */
export function loadConfig(env = process.env) {
  if (fs.existsSync('.env')) {
    try {
      process.loadEnvFile('.env');
    } catch {
      // ignore unreadable .env; explicit environment still applies
    }
  }

  const publicUrl = optional(env.PUBLIC_URL) ?? 'http://localhost:3000';

  return {
    port: toInt(env.PORT, 3000),
    dataDir: optional(env.DATA_DIR) ?? './data',
    refreshMinutes: clamp(toInt(env.REFRESH_MINUTES, 30), 5, 1440),
    adminToken: optional(env.ADMIN_TOKEN),
    producthuntToken: optional(env.PRODUCTHUNT_TOKEN),
    crunchbaseApiKey: optional(env.CRUNCHBASE_API_KEY),
    enableReddit: env.ENABLE_REDDIT === 'true',
    publicUrl,
    userAgent: `StartupRadar/1.0 (+${publicUrl})`,
    fetchTimeoutMs: 15000,
    maxBodyBytes: 5_000_000,
  };
}
