/* Fin.AI PWA service worker: cache-first app shell, network-only API.
 *
 * The app shell (HTML + the JS + icons + manifest) is cached cache-first so
 * the app opens offline. API calls (POSTs to the online coach) always go to
 * the network. The online coach is remote-only — there is no local model to
 * cache.
 */
const CACHE = 'finances-pwa-v74.71';
const SHELL = ['./', './index.html', './app.js', './chat.js', './ai.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png', './favicon.png',
  './fonts/Inter-latin.woff2', './fonts/SpaceGrotesk-latin.woff2']; // v74.24 look upgrade: self-hosted type (offline too)

self.addEventListener('install', (e) => {
  e.waitUntil(
    // v74.41: every shell file is fetched with cache:'reload' — straight from
    // the network, never from the browser's HTTP cache (GitHub Pages lets it
    // keep files ~10 min), so a new version can never be cached with the OLD
    // app.js inside it (the "tap the banner and it reverts" bug).
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // let API POSTs hit the network directly
  // v74.39: the Settings "Check for update & restart" button asks for fresh
  // copies (cache: 'no-store' / 'reload') — those must reach the network,
  // not this cache, or the button would only ever see the old shell.
  if (req.cache === 'no-store' || req.cache === 'reload') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  if (url.origin !== self.location.origin) return; // online coach etc.: network only

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
