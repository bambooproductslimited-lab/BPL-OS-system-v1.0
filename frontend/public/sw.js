// App-wide service worker for the installed PWA — registered from
// main.jsx with scope '/'. Distinct from kiosk-sw.js (scope '/kiosk'),
// which keeps its own separate cache; service workers with overlapping
// scopes don't conflict, the most specific scope wins for a given URL, so
// /kiosk stays controlled by its own worker and everything else by this
// one.
//
// Same rule as the kiosk worker: only ever cache GET requests for the app
// shell itself (HTML/JS/CSS/images), never /api/ calls — the app's data
// must always come from a real network request, never a stale cached
// response. This just makes the installed app open instantly (and survive
// a dropped connection for the shell itself) rather than providing any
// real offline data access.
//
// Bump CACHE_NAME on any change here so old caches get cleared on
// activate. v2: fixes a real bug — cache-first for the navigation itself
// (this file's original behavior) could permanently strand an installed
// PWA on a stale index.html referencing content-hashed JS/CSS filenames
// from a build no longer on the server, once enough redeploys had
// happened since that device last did a background refresh (see the
// identical fix in kiosk-sw.js, where this was caught on a real device).
var CACHE_NAME = 'bamboo-app-v2';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(['/']); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME && k.indexOf('bamboo-kiosk-') !== 0; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || req.url.indexOf('/api/') !== -1) return;
  // Let the kiosk's own service worker handle /kiosk requests entirely.
  if (new URL(req.url).pathname.indexOf('/kiosk') === 0) return;

  // The navigation itself goes network-first: whenever there's a
  // connection, always fetch the real, current index.html — never let a
  // device get stuck on a stale cached shell that references content-
  // hashed JS/CSS from a build that's since been replaced. Only fall back
  // to whatever's cached when the network genuinely fails.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (cached) { return cached || caches.match('/'); });
      })
    );
    return;
  }

  // Everything else is a content-hashed asset (JS/CSS/images) — its
  // filename changes whenever its content does, so a cache hit is always
  // correct forever. Cache-first is the right call here.
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
