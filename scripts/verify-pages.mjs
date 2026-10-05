#!/usr/bin/env node
// HTTP-level end-to-end check of a deployed Startup Radar base URL (Node >= 22, no deps).
//
//   node scripts/verify-pages.mjs <baseUrl> [--max-age-hours N]
//
// Works against http://localhost:3000 (Express), a local sub-path simulation such as
// http://localhost:8080/startup-radar and the live GitHub Pages site. Prints one
// PASS/FAIL line per check plus `N checks, M failed`; exits 1 on any failure.

const EXPORT_MAX_DAYS = 90; // mirrors EXPORT_LIMITS.maxDays in src/export.js
const MAX_ITEMS = 3000; // EXPORT_LIMITS.maxItems
const PRIMARY_MAX_ITEMS = 800; // EXPORT_LIMITS.primaryMaxItems
const MIN_SOURCES = 21;
const MIN_EXPLORE = 10;
const REQUIRED_ITEM_FIELDS = ['id', 'title', 'url', 'source', 'kind', 'region', 'publishedAt'];
const HTML_PAGES = ['index.html', 'sources.html', 'trends.html', 'funding.html', 'yc.html', 'notebook.html'];
const CSS_FILES = ['styles.css', 'sources.css', 'pages.css'];
const JS_FILES = ['app.js', 'filter.js', 'sources.js', 'trends.js', 'funding.js', 'yc.js', 'notebook.js', 'lens.js', 'theme.js', 'ui.js', 'format.js', 'radar.js', 'nav.js', 'shell.js', 'drawer.js', 'text.js', 'notebook-store.js', 'notebook-tools.js', 'related.js', 'pwa.js', 'sw.js'];
const TEXT_FILES = [...HTML_PAGES, ...CSS_FILES, ...JS_FILES, 'icons.svg', 'manifest.webmanifest'];
const STATIC_FILES = [
  ...TEXT_FILES,
  'fonts/geist-latin-wght-normal.woff2', 'fonts/geist-mono-latin-wght-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon.svg',
];
const TRENDS_WEEKS = 12; // src/trends.js TRENDS_WEEKS
const SECTOR_COUNT = 15; // src/lib/sectors.js SECTORS
const YC_JSON_MAX_BYTES = 300_000; // src/build-static.js YC_JSON_MAX_BYTES
const YC_MIN_COMPANIES = 100;
const YC_BATCHES = 3; // src/sources/yc.js BATCH_COUNT
const YC_ATTRIBUTION = 'Source: yc-oss open API mirror of ycombinator.com, refreshed hourly';
const ICON_FILES = ['icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];
const FETCH_TIMEOUT_MS = 20_000;

const results = [];

function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`;
  console.log(line);
  results.push(Boolean(ok));
  return Boolean(ok);
}

function parseArgs(argv) {
  let base = null;
  let maxAgeHours = 3;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--max-age-hours') {
      maxAgeHours = Number(argv[i + 1]);
      i += 1;
    } else if (a.startsWith('--max-age-hours=')) {
      maxAgeHours = Number(a.slice('--max-age-hours='.length));
    } else if (!base) {
      base = a;
    }
  }
  if (!base || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    console.error('usage: node scripts/verify-pages.mjs <baseUrl> [--max-age-hours N]');
    process.exit(2);
  }
  return { base: base.endsWith('/') ? base : `${base}/`, maxAgeHours };
}

async function get(url, accept) {
  const res = await fetch(url, {
    headers: { Accept: accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function getText(url) {
  return get(url, 'text/html, text/css, application/javascript, */*');
}

async function getJson(url) {
  const bust = `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`;
  const res = await get(bust, 'application/json');
  let body = null;
  try {
    body = JSON.parse(res.text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// Leading-slash URL patterns that would break under a sub-path. `//` (protocol-relative) is allowed.
const HTML_ABSOLUTE_RE = /(?:href|src)="\/(?!\/)/;
const JS_ABSOLUTE_RES = [/'\/api\//, /'\/data\//, /fetch\('\//, /"\/api\//, /"\/data\//, /fetch\("\//];

function isIso(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

async function main() {
  const { base, maxAgeHours } = parseArgs(process.argv.slice(2));
  const now = Date.now();
  console.log(`base url: ${base}`);
  console.log(`max age:  ${maxAgeHours} h`);
  console.log('');

  // --- static files -------------------------------------------------------
  const files = {};
  for (const name of STATIC_FILES) {
    try {
      const res = await getText(new URL(name, base).href);
      files[name] = res;
      check(`${name} -> 200`, res.status === 200, `HTTP ${res.status}, ${res.text.length} bytes`);
    } catch (err) {
      files[name] = null;
      check(`${name} -> 200`, false, err.message);
    }
  }

  const index = files['index.html']?.text ?? '';
  check('index.html references ./styles.css and ./app.js', index.includes('href="./styles.css"') && index.includes('src="./app.js"'));
  check('index.html has the CSP meta tag', /http-equiv="Content-Security-Policy"/.test(index));
  check('index.html links the manifest, theme.js and viewport-fit=cover', index.includes('rel="manifest" href="./manifest.webmanifest"') && index.includes('src="./theme.js"') && index.includes('viewport-fit=cover'));
  const sourcesHtml = files['sources.html']?.text ?? '';
  check('sources.html references ./styles.css and ./sources.js', sourcesHtml.includes('href="./styles.css"') && sourcesHtml.includes('src="./sources.js"'));
  for (const name of ['trends.html', 'funding.html', 'yc.html', 'notebook.html']) {
    const text = files[name]?.text ?? '';
    const script = name.replace(/\.html$/, '.js');
    check(`${name} references ./styles.css, ./pages.css and ./${script}, has one bare <h1>`, text.includes('href="./styles.css"') && text.includes('href="./pages.css"') && text.includes(`src="./${script}"`) && (text.match(/<h1[\s>]/g) || []).length === 1 && /<h1>/.test(text));
  }
  const notebookHtml = files['notebook.html']?.text ?? '';
  check("notebook.html carries the browser-only banner 'Stored in this browser only — export to keep it.'", notebookHtml.includes('<p class="notice" id="notice">Stored in this browser only \u2014 export to keep it.</p>'));
  for (const name of HTML_PAGES) {
    const text = files[name]?.text ?? '';
    const m = HTML_ABSOLUTE_RE.exec(text);
    check(`${name} has no leading-slash href/src`, text.length > 0 && !m, m ? `found ${m[0]}` : '');
  }
  for (const name of JS_FILES) {
    const text = files[name]?.text ?? '';
    const hit = JS_ABSOLUTE_RES.map((re) => re.exec(text)).find(Boolean);
    check(`${name} has no '/api/, '/data/ or fetch('/ patterns`, text.length > 0 && !hit, hit ? `found ${hit[0]}` : '');
  }
  for (const name of CSS_FILES) {
    const css = files[name]?.text ?? '';
    check(`${name} has no url(/...) references`, css.length > 0 && !/url\(\s*['"]?\/(?!\/)/.test(css));
  }
  const sw = files['sw.js']?.text ?? '';
  check('sw.js has its build version injected (no __BUILD_VERSION__ token)', sw.length > 0 && !sw.includes('__BUILD_VERSION__'), /const VERSION = '([^']*)'/.exec(sw)?.[1] ?? 'no VERSION line');
  const thirdParty = TEXT_FILES.filter((name) => /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(files[name]?.text ?? ''));
  check('no Google Fonts reference in any text file', thirdParty.length === 0, thirdParty.join(', '));
  for (const name of ['fonts/geist-latin-wght-normal.woff2', 'fonts/geist-mono-latin-wght-normal.woff2']) {
    const res = files[name];
    check(`${name} is served (200, non-empty)`, Boolean(res) && res.status === 200 && res.text.length > 1000, res ? `${res.text.length} chars, ${res.headers.get('content-type')}` : '');
  }

  // --- manifest + icons --------------------------------------------------------
  let manifest = null;
  try {
    manifest = JSON.parse(files['manifest.webmanifest']?.text ?? '');
  } catch {
    manifest = null;
  }
  check('manifest.webmanifest parses as JSON', Boolean(manifest), manifest ? `content-type ${files['manifest.webmanifest']?.headers.get('content-type')}` : 'parse error');
  if (manifest) {
    const manifestUrl = new URL('manifest.webmanifest', base);
    const startUrl = new URL(manifest.start_url ?? '', manifestUrl);
    const idOk = !('id' in manifest) || new URL(manifest.id, startUrl.origin).href === startUrl.href;
    check('manifest start_url and scope are ./ and id is absent (or equals the resolved start_url)', manifest.start_url === './' && manifest.scope === './' && idOk, `start_url ${manifest.start_url}, scope ${manifest.scope}, id ${'id' in manifest ? manifest.id : 'absent'} -> ${startUrl.href}`);
    check('manifest is standalone with three icons', manifest.display === 'standalone' && Array.isArray(manifest.icons) && manifest.icons.length === 3 && manifest.icons.every((i) => typeof i.src === 'string' && i.src.startsWith('./icons/')), `${manifest.icons?.length ?? 0} icons`);
  }
  for (const name of ICON_FILES) {
    try {
      const res = await fetch(new URL(name, base).href, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const bytes = Buffer.from(await res.arrayBuffer());
      const isPng = bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      check(`${name} -> 200 image/png`, res.status === 200 && /image\/png/.test(res.headers.get('content-type') ?? '') && isPng, `HTTP ${res.status}, ${res.headers.get('content-type')}, ${isPng ? `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}` : 'not a PNG'}`);
    } catch (err) {
      check(`${name} -> 200 image/png`, false, err.message);
    }
  }

  // --- data/items.json ------------------------------------------------------
  let items = null;
  try {
    const res = await getJson(new URL('data/items.json', base).href);
    items = Array.isArray(res.body) ? res.body : null;
    check('data/items.json -> 200 JSON array', res.status === 200 && Array.isArray(res.body), `HTTP ${res.status}`);
  } catch (err) {
    check('data/items.json -> 200 JSON array', false, err.message);
  }
  if (items) {
    check(`data/items.json has 1..${MAX_ITEMS} items`, items.length >= 1 && items.length <= MAX_ITEMS, `${items.length} items`);
    const missing = items.filter((it) => !it || REQUIRED_ITEM_FIELDS.some((f) => it[f] === undefined || it[f] === null) || typeof it.source?.id !== 'string' || typeof it.source?.name !== 'string');
    check('every item has id, title, url, source{id,name}, kind, region, publishedAt', missing.length === 0, `${missing.length} items missing fields`);
    let ordered = true;
    for (let i = 1; i < items.length; i += 1) {
      const a = String(items[i - 1].publishedAt ?? '');
      const b = String(items[i].publishedAt ?? '');
      if (a < b || (a === b && Number(items[i - 1].id) < Number(items[i].id))) {
        ordered = false;
        break;
      }
    }
    check('data/items.json is newest first (publishedAt desc, id desc)', ordered, items.length ? `first ${items[0].publishedAt}, last ${items[items.length - 1].publishedAt}` : '');
    const floor = now - (EXPORT_MAX_DAYS + 1) * 86_400_000;
    const stale = items.filter((it) => {
      const t = Date.parse(it.publishedAt);
      return Number.isNaN(t) || t < floor;
    });
    check(`every item is within ${EXPORT_MAX_DAYS} days (+1 day slack; future dates allowed)`, stale.length === 0, `${stale.length} older items`);
    const urls = new Set(items.map((it) => it.url));
    check('data/items.json has no duplicate urls', urls.size === items.length, `${items.length} items, ${urls.size} unique urls`);
  }

  // --- data/sources.json ------------------------------------------------------
  try {
    const res = await getJson(new URL('data/sources.json', base).href);
    const body = res.body;
    const ok = res.status === 200 && body && Array.isArray(body.sources) && Array.isArray(body.exploreMore);
    check('data/sources.json -> 200 with sources[] and exploreMore[]', ok, `HTTP ${res.status}`);
    if (ok) {
      check(`data/sources.json lists >= ${MIN_SOURCES} sources`, body.sources.length >= MIN_SOURCES, `${body.sources.length} sources`);
      check(`data/sources.json lists >= ${MIN_EXPLORE} explore links`, body.exploreMore.length >= MIN_EXPLORE, `${body.exploreMore.length} links`);
      const keys = ['id', 'name', 'homepage', 'kind', 'region', 'enabled', 'itemCount'];
      const bad = body.sources.filter((s) => keys.some((k) => s[k] === undefined));
      check('every source has id, name, homepage, kind, region, enabled, itemCount', bad.length === 0, `${bad.length} bad entries`);
      const withSuccess = body.sources.filter((s) => s.enabled && s.lastSuccessAt).length;
      check('at least one enabled source has a lastSuccessAt', withSuccess >= 1, `${withSuccess} sources`);
    }
  } catch (err) {
    check('data/sources.json -> 200 with sources[] and exploreMore[]', false, err.message);
  }

  // --- data/stats.json ------------------------------------------------------
  let archiveItems = null;
  try {
    const res = await getJson(new URL('data/stats.json', base).href);
    const body = res.body;
    const ok = res.status === 200 && body && typeof body === 'object';
    check('data/stats.json -> 200 JSON object', ok, `HTTP ${res.status}`);
    if (ok) {
      const ageH = isIso(body.generatedAt) ? (now - Date.parse(body.generatedAt)) / 3_600_000 : NaN;
      check(`data/stats.json generatedAt is an ISO date within ${maxAgeHours} h`, Number.isFinite(ageH) && ageH <= maxAgeHours && ageH > -1, `generatedAt ${body.generatedAt}, age ${Number.isFinite(ageH) ? ageH.toFixed(2) : '?'} h`);
      check('data/stats.json archiveItems is a number', typeof body.archiveItems === 'number' && Number.isFinite(body.archiveItems), `archiveItems ${body.archiveItems}`);
      check('data/stats.json lastRefresh ?? generatedAt is a real time', isIso(body.lastRefresh ?? body.generatedAt), `lastRefresh ${body.lastRefresh}`);
      if (typeof body.archiveItems === 'number') archiveItems = body.archiveItems;
    }
  } catch (err) {
    check('data/stats.json -> 200 JSON object', false, err.message);
  }

  // --- data/archive.json ------------------------------------------------------
  try {
    const res = await getJson(new URL('data/archive.json', base).href);
    if (res.status === 404) {
      check('data/archive.json -> 404 (no split) and stats.archiveItems is 0', archiveItems === 0, `archiveItems ${archiveItems}`);
    } else if (res.status === 200 && Array.isArray(res.body)) {
      const archive = res.body;
      const primaryLast = items && items.length ? String(items[items.length - 1].publishedAt ?? '') : '';
      const firstArchive = archive.length ? String(archive[0].publishedAt ?? '') : '';
      check('data/archive.json -> 200 array consistent with the split', archive.length >= 1 && archiveItems === archive.length && (items ? items.length <= PRIMARY_MAX_ITEMS : true) && firstArchive <= primaryLast, `${archive.length} archived, primary ${items ? items.length : '?'} items, archiveItems ${archiveItems}`);
    } else {
      check('data/archive.json -> 404 or 200 array', false, `HTTP ${res.status}`);
    }
  } catch (err) {
    check('data/archive.json -> 404 or 200 array', false, err.message);
  }

  // --- data/trends.json (FEAT-003) ------------------------------------------------
  try {
    const res = await getJson(new URL('data/trends.json', base).href);
    const body = res.body;
    const ok = res.status === 200 && body && Array.isArray(body.terms) && Array.isArray(body.weeks) && Array.isArray(body.bySector);
    check('data/trends.json -> 200 with terms[], weeks[], bySector[]', ok, `HTTP ${res.status}`);
    if (ok) {
      check(`data/trends.json has ${TRENDS_WEEKS} weeks and ${SECTOR_COUNT} sectors with ${TRENDS_WEEKS} counts each`, body.weeks.length === TRENDS_WEEKS && body.bySector.length === SECTOR_COUNT && body.bySector.every((s) => Array.isArray(s.counts) && s.counts.length === TRENDS_WEEKS && s.counts.every((n) => Number.isInteger(n) && n >= 0)), `${body.weeks.length} weeks, ${body.bySector.length} sectors`);
      check('data/trends.json generatedAt is ISO and method is a sentence', isIso(body.generatedAt) && typeof body.method === 'string' && body.method.length > 40, `generatedAt ${body.generatedAt}`);
      const badTerms = body.terms.filter((t) => typeof t.term !== 'string' || !Number.isInteger(t.thisWeek) || typeof t.priorWeeklyAvg !== 'number' || typeof t.rise !== 'number' || !Array.isArray(t.examples) || t.examples.length > 5);
      check('data/trends.json terms carry term, thisWeek, priorWeeklyAvg, rise and <= 5 examples', badTerms.length === 0, `${body.terms.length} terms, ${badTerms.length} bad`);
    }
  } catch (err) {
    check('data/trends.json -> 200 with terms[], weeks[], bySector[]', false, err.message);
  }

  // --- data/funding.json (FEAT-003) ------------------------------------------------
  try {
    const res = await getJson(new URL('data/funding.json', base).href);
    const body = res.body;
    const ok = res.status === 200 && body && Array.isArray(body.items) && body.totals && Array.isArray(body.totals.bySector) && Array.isArray(body.totals.byStage) && body.coverage && body.fx;
    check('data/funding.json -> 200 with items[], totals.bySector[], totals.byStage[], coverage, fx', ok, `HTTP ${res.status}`);
    if (ok) {
      const c = body.coverage;
      check('data/funding.json coverage.items >= coverage.withAmount >= 0 and items.length === coverage.items', Number.isInteger(c.items) && Number.isInteger(c.withAmount) && c.items >= c.withAmount && c.withAmount >= 0 && body.items.length === c.items, `${c.withAmount} of ${c.items} with an amount, ${c.withStage} with a stage`);
      check('data/funding.json fx.asOf is a date and rates include USD = 1', typeof body.fx.asOf === 'string' && !Number.isNaN(Date.parse(body.fx.asOf)) && body.fx.rates && body.fx.rates.USD === 1, `asOf ${body.fx.asOf}, ${Object.keys(body.fx.rates || {}).length} currencies`);
      const bad = body.items.filter((it) => it.kind !== 'funding' || !it.funding || typeof it.funding !== 'object' || !('usdApprox' in it));
      check('every funding item is kind funding with funding{} and usdApprox', bad.length === 0, `${body.items.length} items, ${bad.length} bad`);
    }
  } catch (err) {
    check('data/funding.json -> 200 with items[], totals.bySector[], totals.byStage[], coverage, fx', false, err.message);
  }

  // --- data/yc.json (FEAT-003) ------------------------------------------------
  try {
    const url = `${new URL('data/yc.json', base).href}?v=${Date.now()}`;
    const res = await get(url, 'application/json');
    let body = null;
    try { body = JSON.parse(res.text); } catch { body = null; }
    const bytes = Buffer.byteLength(res.text);
    const ok = res.status === 200 && body && Array.isArray(body.companies) && Array.isArray(body.batches) && Array.isArray(body.byIndustry);
    check('data/yc.json -> 200 with companies[], batches[], byIndustry[]', ok, `HTTP ${res.status}, ${bytes} bytes`);
    if (ok) {
      check(`data/yc.json <= ${YC_JSON_MAX_BYTES} bytes`, bytes <= YC_JSON_MAX_BYTES, `${bytes} bytes`);
      check(`data/yc.json lists >= ${YC_MIN_COMPANIES} companies in ${YC_BATCHES} batches`, body.companies.length >= YC_MIN_COMPANIES && body.batches.length === YC_BATCHES, `${body.companies.length} companies, ${body.batches.length} batches`);
      check('data/yc.json carries the verbatim attribution line', body.attribution === YC_ATTRIBUTION, String(body.attribution));
      const industries = body.byIndustry.reduce((n, r) => n + (r.count || 0), 0);
      check('data/yc.json byIndustry counts sum to companies.length and no company carries long_description', industries === body.companies.length && body.companies.every((c) => !('long_description' in c) && typeof c.key === 'string'), `${industries} vs ${body.companies.length}`);
    }
  } catch (err) {
    check('data/yc.json -> 200 with companies[], batches[], byIndustry[]', false, err.message);
  }

  const failed = results.filter((r) => !r).length;
  console.log('');
  console.log(`${results.length} checks, ${failed} failed`);
  // Let the event loop drain instead of process.exit(): on Windows, exiting while
  // fetch keep-alive sockets are still open can trip a libuv assertion in Node 24.
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
