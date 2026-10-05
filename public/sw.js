// Startup Radar service worker (hand-written, no Workbox). Versioned app-shell
// precache, network-first data, cache-first fonts/icons. Every URL is derived
// from the registration scope so the same file works at the origin root
// (Express) and under /startup-radar/ (GitHub Pages).
//
// __BUILD_VERSION__ is replaced by src/build-static.js (dist/) and by the
// Express GET /sw.js route. When the token survives (an ad-hoc static server),
// the worker runs in pass-through mode: nothing is precached or intercepted.

const VERSION = '__BUILD_VERSION__';
const PASS_THROUGH = VERSION.startsWith('__');
const SHELL_CACHE = `sr-shell-${VERSION}`;
const DATA_CACHE = 'sr-data';
const STATIC_CACHE = 'sr-static';
const STATIC_MAX = 24;
const SHELL = ['./', './index.html', './sources.html', './styles.css', './sources.css', './theme.js', './ui.js', './app.js', './filter.js', './format.js', './radar.js', './sources.js', './nav.js', './shell.js', './drawer.js', './notebook-store.js', './related.js', './text.js', './pwa.js', './icons.svg', './manifest.webmanifest'];

const SCOPE = self.registration.scope;
const scopePath = new URL(SCOPE).pathname;
const DATA = new URL('./data/', SCOPE).href;
const FONTS = new URL('./fonts/', SCOPE).href;
const ICONS = new URL('./icons/', SCOPE).href;
const SHELL_URLS = new Set(SHELL.map((u) => new URL(u, SCOPE).href));
const NAV_PATHS = new Map([
  [scopePath, 'index.html'],
  [`${scopePath}index.html`, 'index.html'],
  [`${scopePath}sources.html`, 'sources.html'],
  [`${scopePath}sources`, 'sources.html'],
]);

self.addEventListener('install', (event) => {
  if (PASS_THROUGH) return;
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL.map((u) => new Request(new URL(u, SCOPE), { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('sr-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function withHeaders(response, extra) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function navigation(shell, request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(new URL(`./${shell}`, SCOPE).href);
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return new Response('Startup Radar is offline and not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function dataFetch(request, bareUrl) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.status === 200) {
      const copy = withHeaders(res.clone(), { 'X-Startup-Radar-Cached-At': new Date().toISOString() });
      await cache.put(bareUrl, copy);
    }
    return res;
  } catch (err) {
    const cached = await cache.match(bareUrl, { ignoreSearch: true });
    if (!cached) throw err;
    return withHeaders(cached, {
      'X-Startup-Radar-Cache': 'fallback',
      'X-Startup-Radar-Cached-At': cached.headers.get('X-Startup-Radar-Cached-At') || '',
    });
  }
}

async function cacheFirst(cacheName, request, max) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.status === 200) {
    await cache.put(request, res.clone());
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(old);
  }
  return res;
}

async function shellFetch(bareUrl, request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(bareUrl);
  return cached || fetch(request);
}

self.addEventListener('fetch', (event) => {
  if (PASS_THROUGH) return;
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const bare = url.origin + url.pathname;
  if (request.mode === 'navigate') {
    const shell = NAV_PATHS.get(url.pathname);
    if (!shell) return; // data files, manifest, icons, API routes, unknown paths: the browser fetches them itself
    event.respondWith(navigation(shell, request));
    return;
  }
  if (bare.startsWith(DATA)) {
    event.respondWith(dataFetch(request, bare));
    return;
  }
  if (bare.startsWith(FONTS) || bare.startsWith(ICONS)) {
    event.respondWith(cacheFirst(STATIC_CACHE, request, STATIC_MAX));
    return;
  }
  if (SHELL_URLS.has(bare)) {
    event.respondWith(shellFetch(bare, request));
  }
  // Everything else (API routes, /health, unknown same-origin paths) falls through without respondWith.
});
