// Service worker for the kitchen screen (/kds, or the whole of its own
// website, kds.<restaurant>) — registered from KdsPage.jsx, its scope that
// alone, as the till's (pos-sw.js) is. A kitchen tablet that starts again
// after a power cut, with the internet still down, opens the screen from
// here: it shows the last tickets it had, and in outage mode takes new ones
// from the print hub on the restaurant's network (pages/till/outage.js).
// The tickets themselves are never this worker's doing.
//
// Bump CACHE_NAME on any change here so old caches get cleared on activate.
// v2: an HTML page saved under an app file's name (the server's
//     answer while a file was missing) is never kept or used; this new
//     name clears every copy kept before.
var CACHE_NAME = 'bamboo-kds-v2';
// An HTML page, where an app file (script, style, picture) was asked for.
function isPage(res) { return (res.headers.get('content-type') || '').indexOf('text/html') === 0; }


self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(['/kds', '/']); })
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
  // (menu load, order create, PIN login) always hit the real network
  // untouched: the page knows when they fail and keeps what it made itself,
  // openly (the menu it last loaded, the sales waiting to be sent), rather
  // than a cached answer passing for the server's.
  if (req.method !== 'GET' || req.url.indexOf('/api/') !== -1) return;
  // Nor anything from another site (Google Fonts): fetched from in here it
  // would answer to this worker's Content-Security-Policy, whose
  // connect-src does not list it, and fail — the page's own rules let it
  // load as a stylesheet and a font.
  if (new URL(req.url).origin !== self.location.origin) return;

  // The navigation itself (loading /kds) goes network-first: whenever
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
        return caches.match(req).then(function (cached) { return cached || caches.match('/kds').then(function (k) { return k || caches.match('/'); }); });
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
      // Never a page under an app file's name: a server that answers a
      // missing file with its home page (200, text/html) would otherwise
      // be kept here and break the app on this device for good. Not kept,
      // and one kept before is thrown away and fetched again.
      if (cached && isPage(cached)) cached = null;
      var network = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic' && !isPage(res)) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
