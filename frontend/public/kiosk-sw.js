// Service worker for the clock-in/out kiosk (/kiosk) — registered from
// KioskPage.jsx with scope '/kiosk' only, so it never touches any other
// part of Bamboo OS. Its one job is caching the kiosk's own app shell
// (the built JS/CSS and the index.html the SPA fallback serves for /kiosk)
// so the page itself still loads with zero connectivity, not just when the
// API is unreachable — a kiosk iPad that loses wifi entirely still needs
// to show the PIN pad.
//
// Bump CACHE_NAME on any change here so old caches get cleared on activate
// (harmless if forgotten — just means a stale cache lingers as dead weight
// until the next bump, never served, since cache lookups are exact-URL).
var CACHE_NAME = 'bamboo-kiosk-v1';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(['/kiosk', '/']); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  // Only ever cache GET requests for the app shell itself. API calls
  // (POST /kiosk/clock, wherever the backend actually lives) must always
  // hit the real network untouched — the offline queue in KioskPage.jsx
  // depends on seeing a genuine network failure, not a cached response.
  if (req.method !== 'GET' || req.url.indexOf('/api/') !== -1) return;

  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      // Cache-first: instant load offline; still refreshes the cache in
      // the background when online so the next deploy's assets get picked
      // up after a normal reload.
      return cached || network;
    })
  );
});
