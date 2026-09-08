// Service worker for the restaurant POS till (/pos) — registered from
// RestaurantPosPage.jsx with scope '/pos' only, so it never touches any
// other part of Bamboo OS (see kiosk-sw.js, whose scope '/kiosk' this
// mirrors exactly for the same reason: a till device installed via "Add
// to Home Screen" needs its own app shell cached so the PIN pad and menu
// grid still load with zero connectivity, not just when the API is
// unreachable).
//
// Bump CACHE_NAME on any change here so old caches get cleared on
// activate (harmless if forgotten — just means a stale cache lingers as
// dead weight until the next bump, never served, since cache lookups are
// exact-URL).
var CACHE_NAME = 'bamboo-pos-v1';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(['/pos', '/']); })
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
  // (menu load, order create, PIN login) must always hit the real network
  // untouched — a till showing a stale cached menu or silently "succeeding"
  // a sale offline would be a real problem, not a convenience.
  if (req.method !== 'GET' || req.url.indexOf('/api/') !== -1) return;

  // The navigation itself (loading /pos) goes network-first: whenever
  // there's a connection, always fetch the real, current index.html —
  // never let a device get stuck on a stale cached shell that references
  // content-hashed JS/CSS from a build that's since been replaced. Only
  // fall back to whatever's cached when the network genuinely fails,
  // which is the true "offline till" case this worker exists for.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (cached) { return cached || caches.match('/pos'); });
      })
    );
    return;
  }

  // Everything else under this scope is a content-hashed asset (JS/CSS/
  // images) — its filename changes whenever its content does, so a cache
  // hit is always correct forever. Cache-first is the right call here:
  // instant load offline, and still refreshes in the background for
  // whatever gets fetched fresh.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
