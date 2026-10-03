# Startup Radar

A small, self-hosted aggregator for discovering new startups: product launches, funding news and
accelerator batches, pulled from public feeds and APIs into one searchable, filterable page.
It runs as a single Node.js process with a SQLite database, refreshes itself on a timer, and can
be deployed to [Railway](https://railway.com) in a few minutes.

It only aggregates sources that publish a public feed or API. Paid databases (Crunchbase,
PitchBook, Dealroom and others) are listed as links; nothing is scraped from them. Vote counts,
points and funding amounts are shown only when the source provides them; the app never invents
metrics.

## Contents

1. [What it is](#1-what-it-is)
2. [Sources](#2-sources)
3. [Requirements](#3-requirements)
4. [Quick start](#4-quick-start)
5. [Configuration](#5-configuration)
6. [API](#6-api)
7. [How refresh works](#7-how-refresh-works)
8. [Deploy to Railway](#8-deploy-to-railway)
9. [Railway limits and cost](#9-railway-limits-and-cost)
10. [Screenshots](#10-screenshots)
11. [Adding a source](#11-adding-a-source)
12. [Tests](#12-tests)
13. [Security notes](#13-security-notes)
14. [License](#14-license)

## 1. What it is

Startup Radar fetches 19 public sources every `REFRESH_MINUTES` (default 30), normalizes each
entry to one row (title, URL, summary, source, kind, region, published date), de-duplicates by
URL and stores everything in SQLite. The web UI at `/` lists items newest first and lets you
filter by kind (launch, funding, news, accelerator), region (USA, Europe, Asia, India, Latin
America, Africa, global, or an All / USA / World toggle), source and time window, and search
titles and summaries with full-text search. `/sources` shows every adapter with its last fetch
status, last error and item count, followed by an "Explore more" list of directories that are
links only. A read-only JSON API backs the UI.

## 2. Sources

Every source below was probed live on 2026-10-02. "Aggregated by default" sources need no
credentials. "Optional" sources are implemented but off unless you set an environment variable.
"Links only" sources are shown on `/sources` as links and are never fetched, each with the reason.

### Aggregated by default (19)

| Source | Kind | Region | Feed type | Link |
|---|---|---|---|---|
| Hacker News — Show HN | launch | global | JSON API (Algolia `search_by_date`, `tags=show_hn`) | [news.ycombinator.com/show](https://news.ycombinator.com/show) |
| Hacker News — Launch HN | launch | global | JSON API (Algolia, query `"Launch HN"`) | [news.ycombinator.com](https://news.ycombinator.com/) |
| Product Hunt | launch | global | Atom feed (`/feed`; GraphQL API when `PRODUCTHUNT_TOKEN` is set) | [producthunt.com](https://www.producthunt.com/) |
| Y Combinator — newest batches | accelerator | usa | JSON (`yc-oss.github.io/api` meta + the two newest batch files) | [ycombinator.com/companies](https://www.ycombinator.com/companies) |
| BetaList | launch | global | Atom feed (official FeedBurner feed; the on-site `/feed` URLs are 404) | [betalist.com](https://betalist.com/) |
| Launching Next | launch | global | RSS feed | [launchingnext.com](https://www.launchingnext.com/) |
| TechCrunch — Startups | news | usa | RSS feed | [techcrunch.com/category/startups](https://techcrunch.com/category/startups/) |
| TechCrunch — Venture | news | usa | RSS feed | [techcrunch.com/category/venture](https://techcrunch.com/category/venture/) |
| Crunchbase News | news | usa | RSS feed (the news site, not the Crunchbase database) | [news.crunchbase.com](https://news.crunchbase.com/) |
| Sifted | news | europe | RSS feed | [sifted.eu](https://sifted.eu/) |
| Tech.eu | news | europe | RSS feed | [tech.eu](https://tech.eu/) |
| EU-Startups | news | europe | RSS feed (official FeedBurner mirror; the site's own feed is behind a Cloudflare challenge) | [eu-startups.com](https://www.eu-startups.com/) |
| Inc42 | news | india | RSS feed | [inc42.com](https://inc42.com/) |
| YourStory | news | india | RSS feed (`/feed`; `/rss` is blocked) | [yourstory.com](https://yourstory.com/) |
| TechCabal | news | africa | RSS feed | [techcabal.com](https://techcabal.com/) |
| Disrupt Africa | news | africa | RSS feed | [disruptafrica.com](https://disruptafrica.com/) |
| LatamList | news | latam | RSS feed | [latamlist.com](https://latamlist.com/) |
| Tech Collective (SE Asia) | news | asia | RSS feed | [techcollectivesea.com](https://www.techcollectivesea.com/) |
| Vulcan Post | news | asia | RSS feed (occasionally slow; the 15 s timeout isolates it) | [vulcanpost.com](https://vulcanpost.com/) |

Items from news sources are re-labelled `funding` when the title or summary reads like a funding
announcement (see [How refresh works](#7-how-refresh-works)). Product Hunt items have no vote
counts unless `PRODUCTHUNT_TOKEN` is configured, because the public feed does not include them.

### Optional (off unless configured)

| Source | Enable with | Notes |
|---|---|---|
| Reddit — r/SideProject + r/startups | `ENABLE_REDDIT=true` | Uses the Atom endpoints (`new.rss`); Reddit's JSON endpoints returned 403 and `r/startups` returned 429 on every probe, so shared cloud IPs are likely to be rate-limited. One subreddit failing does not fail the source. |
| Product Hunt (GraphQL API) | `PRODUCTHUNT_TOKEN` | Replaces the Atom feed with the v2 GraphQL API and adds vote counts. A failing token is reported as an error on `/sources` rather than silently falling back to the feed. |
| Crunchbase — funding rounds (API) | `CRUNCHBASE_API_KEY` | Crunchbase v4 `searches/funding_rounds`. Shown as "not configured" on `/sources` without a key. The response mapping follows the v4 docs and has not been verified against a live key. |

### Links only (not aggregated)

| Site | Why it is a link |
|---|---|
| [Crunchbase](https://www.crunchbase.com/discover/organization.companies) | Paid database; the API adapter above needs `CRUNCHBASE_API_KEY` |
| [PitchBook](https://pitchbook.com/) | Paid private-market database |
| [CB Insights](https://www.cbinsights.com/) | Paid market-intelligence platform |
| [Dealroom](https://dealroom.co/) | Paid startup and VC database |
| [Tracxn](https://tracxn.com/) | Paid private-company intelligence |
| [Harmonic](https://harmonic.ai/) | Paid startup-discovery data for investors |
| [Seedtable](https://www.seedtable.com/) | Curated rankings; no public feed |
| [Wellfound](https://wellfound.com/startups) | Startup profiles and jobs; no public feed |
| [Indie Hackers](https://www.indiehackers.com/products) | No public feed (`/feed.xml`, `/rss` are 404) |
| [Tech in Asia](https://www.techinasia.com/) | Feed blocks automated clients (403) |
| [e27](https://e27.co/) | Feed behind Cloudflare (403) |
| [Uneed](https://www.uneed.best/) | Unreachable during verification (connect timeout) |
| [Tiny Startups](https://www.tinystartups.com/) | No feed |
| [StartupBase](https://startupbase.io/) | Only a blog feed exists, not the launch listings |

## 3. Requirements

- Node.js 22 or newer. `better-sqlite3` 13 (the SQLite binding) requires Node 22+, and it ships
  prebuilt binaries for Linux, macOS and Windows, so no compiler or Python is needed for
  `npm install`. `engines.node` in `package.json` is `>=22`; Railway reads it and builds with
  Node 22.
- Outbound HTTPS access to the sources above.
- Nothing else: SQLite is embedded and the frontend is static files.

## 4. Quick start

```bash
npm install
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
npm start                   # http://localhost:3000, first refresh starts right after listen
```

Other commands:

```bash
npm run fetch:once          # run one refresh cycle, print a per-source table, exit
npm run dev                 # same as start, restarts on file changes (node --watch)
npm test                    # unit + API tests (node --test), no network needed
```

The database is created on first start in `DATA_DIR` (default `./data/startup-radar.db`); the
directory is created if it does not exist. The first refresh cycle usually finishes within a few
seconds; `/` shows "Last refreshed never" until then.

## 5. Configuration

All settings come from environment variables. A `.env` file in the working directory is loaded
at startup if present (Node's built-in loader, no `dotenv`); explicit environment variables win.
Copy `.env.example` to get started.

| Variable | Default | Used by | Notes |
|---|---|---|---|
| `PORT` | `3000` | server | Railway injects it; the server binds `process.env.PORT` on `0.0.0.0`. |
| `DATA_DIR` | `./data` | db | SQLite directory, created if missing; DB file `startup-radar.db`. On Railway set `/data` (the volume mount path). |
| `REFRESH_MINUTES` | `30` | refresh | Integer, clamped to 5..1440. |
| `ADMIN_TOKEN` | unset | app | Enables `POST /api/refresh` (Bearer token). Unset → the route answers 404. Generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. |
| `PRODUCTHUNT_TOKEN` | unset | producthunt | Developer Token from producthunt.com/v2/oauth/applications → create app → "Developer Token". Switches Product Hunt to the GraphQL API (adds votes). |
| `CRUNCHBASE_API_KEY` | unset | crunchbase | Enables the Crunchbase v4 funding-rounds adapter. |
| `ENABLE_REDDIT` | `false` | reddit | `true` enables r/SideProject + r/startups (Atom). Off by default because Reddit answered 403/429 during verification. |
| `PUBLIC_URL` | `http://localhost:3000` | config | Used in the outbound `User-Agent: StartupRadar/1.0 (+<PUBLIC_URL>)`. Set it to your Railway domain. |

Fixed constants (not configurable): 15 s timeout per source, 5 MB maximum response body,
API `limit` default 30 / maximum 100, summaries truncated to 300 characters.

## 6. API

All endpoints return JSON. `GET` endpoints need no authentication and are read-only.
`/api/*` and `/health` responses carry `Cache-Control: no-store`. Errors are
`{ "error": "<message>" }` without stack traces.

### `GET /health`

Returns `200 {"ok": true, "items": <int>, "lastRefresh": "<ISO 8601>" | null}` immediately, even
while a refresh is running. Railway uses this path as the deployment health check.

### `GET /api/items`

Query parameters (all optional):

| Param | Rule |
|---|---|
| `kind` | one of `launch`, `funding`, `news`, `accelerator`; anything else → 400 |
| `region` | one of `usa`, `europe`, `asia`, `india`, `latam`, `africa`, `global`, or `world` (= everything except `usa`); anything else → 400 |
| `source` | comma-separated adapter ids (e.g. `hn_show,techcrunch`); an unknown id → 400 |
| `q` | search text, max 200 characters; full-text search (SQLite FTS5) with a `LIKE` fallback |
| `since` | ISO 8601 date; only items published at or after it; unparsable → 400 |
| `page` | integer ≥ 1, default 1, max 10000 |
| `limit` | integer 1..100, default 30; out-of-range values are clamped and echoed back |

Response:

```json
{
  "items": [
    {
      "id": 1,
      "title": "…",
      "url": "https://…",
      "source": { "id": "techcrunch", "name": "TechCrunch — Startups" },
      "kind": "funding",
      "region": "usa",
      "summary": "…",
      "publishedAt": "2026-10-02T14:03:00.000Z",
      "fetchedAt": "2026-10-02T14:30:01.123Z",
      "extra": { "author": "…" }
    }
  ],
  "page": 1,
  "limit": 30,
  "total": 752,
  "hasMore": true
}
```

Items are ordered by `publishedAt` descending. `extra` holds whatever the source provided and
nothing else: `points`/`comments`/`author`/`hnUrl` (Hacker News), `batch` (Launch HN, YC),
`votes`/`website` (Product Hunt API), `batch`/`website`/`location`/`industry`/`teamSize`/`status`
(YC), `moneyRaisedUsd`/`currency`/`investmentType`/`organization` (Crunchbase API).

### `GET /api/sources`

`{ "sources": [...], "exploreMore": [...] }`. Each source has `id`, `name`, `homepage`, `kind`,
`region`, `enabled`, `requires` (the variable needed when disabled, else `null`), `lastRunAt`,
`lastSuccessAt`, `lastError`, `lastDurationMs`, `lastItemCount` and `itemCount` (rows in the DB).
`exploreMore` is the links-only list (`name`, `url`, `note`).

### `GET /api/stats`

`{ "items", "lastRefresh", "last24h", "last7d", "bySource": {}, "byKind": {}, "byRegion": {} }`.

### `POST /api/refresh`

Triggers one refresh cycle and waits for it. No request body.

| Condition | Response |
|---|---|
| `ADMIN_TOKEN` not set | `404 {"error":"not found"}` (the route does not exist as far as callers can tell) |
| Header missing or token mismatch | `401 {"error":"unauthorized"}` (constant-time comparison) |
| A cycle is already running | `409 {"running": true}` |
| Success | `200 {"ok": true, "durationMs": <int>, "sources": [{ "id", "ok", "count", "error", "durationMs" }]}` |

### Examples

```bash
curl http://localhost:3000/health
curl "http://localhost:3000/api/items?kind=funding&region=usa&limit=5"
curl "http://localhost:3000/api/items?q=ai&since=2026-10-01T00:00:00Z"
curl "http://localhost:3000/api/items?source=hn_show,producthunt&region=world"
curl http://localhost:3000/api/sources
curl http://localhost:3000/api/stats
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/api/refresh
```

## 7. How refresh works

1. `npm start` opens the database, loads every adapter in `src/sources/`, starts listening on
   `PORT`, and only then starts the scheduler. The first cycle runs immediately in the background,
   so `/health` and the UI answer while it is still fetching. A cycle then runs every
   `REFRESH_MINUTES`.
2. All enabled sources are fetched concurrently. Each one has a 15 s timeout and a 5 MB response
   cap; every outbound request goes through one HTTP client that sets the `User-Agent`.
3. Failures are isolated: a source that errors or times out is recorded in `source_status`
   (`lastError`, shown on `/sources`) and the other sources still complete. Only one cycle runs at
   a time; overlapping triggers share the in-flight cycle.
4. Each raw entry is normalized: title trimmed and limited to 300 characters, URL must be
   `http(s)`, HTML is stripped from the summary and it is truncated to 300 characters, the date is
   converted to ISO 8601 UTC (the source's own date; YC uses `launched_at`; the fetch time is used
   only when a source has no date at all). Entries that fail validation are dropped and counted.
5. De-duplication is by normalized URL: lower-cased host, `utm_*`, `ref` and `fbclid` parameters
   removed, fragment removed, trailing slash removed, default port removed. The normalized URL is
   `UNIQUE` in the database. Re-fetching the same source updates the mutable fields
   (title, summary, kind, region, extra); a different source posting the same URL is ignored
   (first source wins).
6. Classification: an item from a `news` source becomes `funding` when its title or summary
   matches the funding pattern (`raises|raised|secures|closes|lands|bags|nabs … $` or
   `seed|pre-seed|series A–H|funding round|valuation`). The region defaults to the source's region
   and is overridden by case-sensitive proper-noun rules (India, Europe, Asia, Latin America,
   Africa) found in the title, summary or location.

`npm run fetch:once` runs exactly one cycle from the command line and prints a per-source table
(`source | status | items | ms | error`), including disabled sources and the variable they need.
It exits 0 when at least one enabled source succeeded.

## 8. Deploy to Railway

The repo contains two Railway configuration files:

- `.railway/railway.ts` is the authoritative one. It is Railway's current infrastructure-as-code
  format (`railway/iac` SDK, already in `devDependencies` as `railway@3.12.0`) and declares the
  `startup-radar` service (`npm start`, health check `/health`, 100 s health-check timeout,
  `DATA_DIR=/data`, `REFRESH_MINUTES=30`, `TZ=UTC`, `NODE_ENV=production`) plus a 1 GB volume
  `startup-radar-data` mounted at `/data`. It sets no restart policy, so Railway's default restart
  policy applies.
- `railway.json` is the older Config-as-Code format, kept for existing services. Railway has
  deprecated it: new services do not read it and the files stop being read on 2026-12-01. It
  declares the same thing (builder `RAILPACK`, `npm start`, `/health`, 100 s timeout, restart
  `ON_FAILURE` with 10 retries).

Railway builds with Railpack (the default builder) and picks Node 22 from `engines.node`.
`npm install` uses the prebuilt `better-sqlite3` binary for Linux, so there is no native compile
step. Railway injects `PORT`; the server binds it on `0.0.0.0`.

### (a) From GitHub

1. Push this repository to GitHub (`git remote add origin <your repo url>` then
   `git push -u origin main`).
2. Open [railway.com/new](https://railway.com/new) → **Deploy from GitHub repo** → pick the
   repository. Railway builds with Railpack and picks Node 22 from `engines.node`.
3. Add a volume: right-click the project canvas → **Volume** → attach it to the service → mount
   path `/data`.
4. Service → **Variables**: set `DATA_DIR=/data` and `PUBLIC_URL=https://<your-domain>`
   (optionally `ADMIN_TOKEN`, `PRODUCTHUNT_TOKEN`, `CRUNCHBASE_API_KEY`, `ENABLE_REDDIT`,
   `REFRESH_MINUTES`).
5. Service → **Settings → Networking → Generate Domain**. Open `https://<your-domain>/health`;
   it should return `{"ok":true,...}`.

Every push to `main` redeploys.

### (b) From the CLI

Install the CLI with `npm i -g @railway/cli` (on Windows use npm or Scoop; the shell installer
needs WSL), then:

```bash
railway login
railway init -n startup-radar
railway up
railway domain
railway volume add -m /data
railway variable set DATA_DIR=/data PUBLIC_URL=https://<domain>
```

Declarative alternative using `.railway/railway.ts` (the SDK is already in `devDependencies`):

```bash
npm install
railway login
railway link          # or: railway init
railway config plan   # shows what would change
railway config apply  # creates/updates the service, volume and variables
```

### (c) The volume and `DATA_DIR=/data`

Railway's filesystem is replaced on every deploy. The SQLite database must live on a volume to
survive redeploys, so the volume is mounted at `/data` and `DATA_DIR=/data` points the app at it
(the app creates the directory and the DB file if they are missing). A volume can be attached to
one service, and a service with a volume has one active deployment at a time, so redeploys of
this service have a brief downtime while the old deployment stops and the new one starts.

### (d) Optional environment variables

`ADMIN_TOKEN` (enables `POST /api/refresh`), `PRODUCTHUNT_TOKEN`, `CRUNCHBASE_API_KEY`,
`ENABLE_REDDIT=true`, `REFRESH_MINUTES`. See [Configuration](#5-configuration). Set them in the
Railway Variables tab or with `railway variable set NAME=value`.

### (e) Without a volume

The app still works without a volume: the database is created in `./data` inside the container,
and the first refresh cycle fills it within seconds. It is just ephemeral: history resets on each
deploy, and anything older than what the feeds still list is lost.

## 9. Railway limits and cost

Verified on 2026-10-02 at docs.railway.com/reference/pricing/plans:

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | $1/month usage credit; 1 replica, 0.5 GB RAM, 1 vCPU, 0.5 GB volume |
| Trial | one-time $5 credit, valid 30 days | |
| Hobby | $5/month | $5 of usage included; volumes up to 5 GB |

Usage pricing: RAM $10 per GB-month, CPU $20 per vCPU-month, volumes $0.15 per GB-month,
egress $0.05 per GB. Builds are free.

This single always-on service idles around 100–200 MB RAM, which is roughly $1–2/month of usage.
The Free plan's 0.5 GB volume cap is more than enough for the database (a few MB after days of
refreshes); the 1 GB volume in `.railway/railway.ts` assumes the Hobby plan, so lower `sizeMB` to
`512` if you stay on Free.

## 10. Screenshots

Captured from a local run with real data by `scripts/screenshots.py`.

![Home page: masthead with "Last refreshed", filter bar (kind, region, All/USA/World toggle, sources, search, time chips) and a list of startup cards newest first](docs/screenshots/home.png)

![Home page filtered to kind=funding and USA scope: the result count and cards update to show only USA funding items](docs/screenshots/home-filtered.png)

![Home page on a 390 px wide mobile viewport: single column, full-width controls and cards](docs/screenshots/home-mobile.png)

![Sources page: a table of all 21 adapters with enabled state, kind, region, last successful fetch, last error and item count, followed by the links-only list](docs/screenshots/sources.png)

## 11. Adding a source

A source is one file in `src/sources/<id>.js` whose default export follows this contract. The
registry imports every `*.js` in that folder at startup, validates the shape and sorts by id;
no registration step is needed. The `id` must match the filename.

```js
export default {
  id: 'techcrunch',                 // [a-z0-9_]+, unique, equals the filename
  name: 'TechCrunch — Startups',
  homepage: 'https://techcrunch.com/category/startups/',
  kind: 'news',                     // launch | funding | news | accelerator (default for its items)
  region: 'usa',                    // usa | europe | asia | india | latam | africa | global
  enabled: (env) => true,           // e.g. (env) => Boolean(env.MY_API_KEY)
  requires: null,                   // shown on /sources when disabled, e.g. 'MY_API_KEY'
  async fetch(ctx) {
    // ctx = { http, rss, env, signal, log }
    // return [{ title, url, summary, publishedAt, kind?, region?, extra? }]
  },
};
```

For the common "one RSS or Atom feed" case use the factory, which is what most adapters are:

```js
import { makeRssSource } from '../lib/rss.js';

export default makeRssSource({
  id: 'example_news',
  name: 'Example News',
  homepage: 'https://example.com/',
  feedUrl: 'https://example.com/feed/',
  kind: 'news',
  region: 'europe',
  // optional: enabled, requires, mapItem(item) => raw item | null
});
```

Rules: make network calls only through `ctx.http.fetchText` / `ctx.http.fetchJson` or
`ctx.rss.fetchFeed` (they add the User-Agent, timeout and size cap and honour `ctx.signal`);
use the source's own canonical page as `url`; put source-specific numbers in `extra` and only
when the source actually provides them. Add a fixture-based test in `test/sources.test.js` and
a row to the table in this README.

## 12. Tests

```bash
npm test
```

Runs `node --test` over `test/*.test.js` (78 tests in 20 suites, no network, about a second):

- `normalize.test.js`: URL normalization (tracking parameters, fragments, trailing slashes),
  HTML stripping and entity decoding, truncation, date parsing, `normalizeItem` validation.
- `classify.test.js`: funding regex positives and negatives, kind left alone for non-news
  sources, region keyword rules.
- `rss.test.js`: Atom and RSS 2.0 fixtures → raw item mapping, `makeRssSource`.
- `sources.test.js`: adapter mappings from fixtures (Hacker News, Launch HN, YC batch picking,
  Product Hunt Atom and GraphQL, Reddit boilerplate stripping, Crunchbase, BetaList) and registry
  validation.
- `db.test.js`: in-memory schema, upsert de-duplication (`?utm_source=x` and the clean URL
  become one row), first-source-wins, search, filters, pagination, status rows.
- `app.test.js`: the HTTP app on an ephemeral port: `/health` shape, `/api/items` validation and
  clamping, `/api/refresh` 404/401/409/200, HTML pages, security headers.

`scripts/screenshots.py` captures the four screenshots above and asserts the frontend rules in a
real browser (body font 16 px, nothing below 12 px, controls at least 40 px tall, rendered
filter results equal to the API's answer for the same query, no horizontal overflow). It needs
Python with `playwright` installed and a local Edge or Chrome; it launches the browser via
Playwright's `channel` option so no browser download is required. With the server running:

```powershell
# generic
python scripts/screenshots.py
# dev machine: the Python venv one level above the repo, Edge channel (default)
..\.venv\Scripts\python.exe scripts\screenshots.py
# use Chrome instead of Edge, or point at another server
$env:PW_CHANNEL = "chrome"; $env:BASE_URL = "http://localhost:4000"; python scripts/screenshots.py
```

## 13. Security notes

- The site and the `GET` API are public and read-only by design; there is no user login.
- `POST /api/refresh` is the only write endpoint. It exists only when `ADMIN_TOKEN` is set,
  requires `Authorization: Bearer <token>`, compares tokens in constant time and never logs
  the token. Without `ADMIN_TOKEN` it returns 404.
- Every response carries `Content-Security-Policy: default-src 'self'; img-src 'self' data:;
  object-src 'none'; base-uri 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin` and `X-Frame-Options: DENY`; `x-powered-by`
  is disabled. The frontend has no inline scripts or styles and builds the DOM with
  `createElement`/`textContent`, never `innerHTML` with source data. Outbound links use
  `rel="noopener noreferrer"`.
- All SQL is parameterized; full-text queries are tokenized and quoted before reaching FTS5;
  API enums are whitelisted and `page`/`limit` are bounded. Only `http:`/`https:` URLs are stored.
- Outbound requests send an identifying `User-Agent`, time out after 15 s and read at most 5 MB.
  Only documented feeds and APIs are fetched; nothing is scraped from HTML pages.
- Errors are returned as `{ "error" }` without stack traces.
- There is no built-in rate limiting. If you expose the API publicly and expect heavy traffic,
  put a proxy or CDN with rate limits in front of it.
- Keep `.env` out of git (it is in `.gitignore`); `.env.example` contains placeholders only.

## 14. License

[MIT](LICENSE). Copyright (c) 2026 Startup Radar contributors.
