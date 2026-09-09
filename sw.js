/* Finance PWA service worker: cache-first app shell, network-only API, and
 * cache-through for the offline-brain runtime (v43).
 *
 * The offline brain loads transformers.js + onnxruntime from the jsDelivr CDN
 * (pinned versions) and the model weights from the Hugging Face hub:
 *  - jsDelivr requests are cached here, cache-first, so the runtime works
 *    offline after the first load;
 *  - the model weights are cached by transformers.js itself in Cache Storage
 *    (the "transformers-cache" caches). That cache must NOT be deleted on
 *    activate, or the phone would re-download ~250 MB on every app update.
 *  - everything else (the Hugging Face hub, …) stays network-only.
 */
const CACHE = 'finances-pwa-v43';
const SHELL = ['./', './index.html', './app.js', './chat.js', './ai.js', './model-worker.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const RUNTIME_CDN = 'https://cdn.jsdelivr.net';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
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
        // keep the current shell AND the offline-brain model cache
        .filter((k) => k !== CACHE && !k.startsWith('transformers-cache'))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // let API POSTs hit the network directly
  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  if (url.origin === RUNTIME_CDN) {
    // offline-brain runtime (pinned versions): cache-first so it works offline
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        });
      })
    );
    return;
  }
  if (url.origin !== self.location.origin) return; // HF hub etc.: network only

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
