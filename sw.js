/* SAMAA MAJU Scanner — service worker
 * NETWORK-FIRST for the app shell: staff always get the latest code when online,
 * and the cache is only a fallback so the UI still opens offline. (The old
 * cache-first strategy served stale code for days — every deploy "looked the same"
 * on the phones because the cached app.js never got replaced.)
 * API calls (cross-origin POST to Apps Script) are always network-only — never cached.
 */
var CACHE = 'samaa-scanner-v27';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './i18n.js',
  './app.js',
  './config.js',
  './manifest.json',
  './brand/logo-transparent.png',
  './brand/icon-192.png',
  './brand/icon-512.png',
  './brand/icon-512-maskable.png',
  './brand/apple-touch-icon-180.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Fetch each shell file with {cache:'reload'} so the browser's HTTP cache can't
      // hand us a STALE copy to store — the new cache always gets the freshest files.
      return Promise.all(SHELL.map(function (url) {
        return fetch(new Request(url, { cache: 'reload' }))
          .then(function (res) { if (res && res.ok) return c.put(url, res); })
          .catch(function () { /* ignore a single missing/unfetchable asset */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // Only handle same-origin GET. Everything else (POSTs to Apps Script, CDN scripts)
  // goes straight to the network untouched.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }
  // NETWORK-FIRST: try the network, update the cache with the fresh response, and only
  // fall back to the cache when offline. This guarantees the phones run the latest code.
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
