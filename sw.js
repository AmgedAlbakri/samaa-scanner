/* SAMAA MAJU Scanner — service worker
 * Caches the app shell so the PWA installs and the UI opens offline.
 * API calls (cross-origin POST to Apps Script) are always network-only —
 * we never cache product/login responses.
 */
var CACHE = 'samaa-scanner-v4';
var SHELL = [
  './',
  './index.html',
  './styles.css',
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
      // addAll fails the whole install if one file is missing; add individually to be resilient.
      return Promise.all(SHELL.map(function (url) {
        return c.add(url).catch(function () { /* ignore a single missing asset */ });
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
  // Only handle same-origin GET requests from the cache. Everything else
  // (POSTs to the Apps Script Web App, CDN scripts) goes straight to network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        // Cache newly fetched same-origin assets (e.g. first visit).
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        return res;
      }).catch(function () {
        // Offline and not cached — fall back to the shell for navigations.
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
