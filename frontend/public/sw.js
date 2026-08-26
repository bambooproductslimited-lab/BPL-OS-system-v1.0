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
// activate.
var CACHE_NAME = 'bamboo-app-v1';

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
