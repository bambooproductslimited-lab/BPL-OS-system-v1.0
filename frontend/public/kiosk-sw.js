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
// v2: fixes a real bug — cache-first for the navigation itself (this file's
// original behavior) could permanently strand a kiosk device on a stale
// index.html referencing content-hashed JS/CSS filenames from a build no
// longer on the server, once enough redeploys had happened since that
// device's first visit. Bumped so every already-installed kiosk (including
// any already wedged on the old bug) clears its cache and self-heals.
var CACHE_NAME = 'bamboo-kiosk-v2';

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

  // The navigation itself (loading /kiosk) goes network-first: whenever
  // there's a connection, always fetch the real, current index.html —
  // never let a device get stuck on a stale cached shell that references
  // content-hashed JS/CSS from a build that's since been replaced (see the
  // CACHE_NAME v2 comment above — this was a real bug, not hypothetical).
  // Only fall back to whatever's cached when the network genuinely fails,
  // which is the true "offline kiosk" case this worker exists for.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (cached) { return cached || caches.match('/kiosk'); });
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
