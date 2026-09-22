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
//
// v3: adds the Web Push handlers at the foot of this file.
// v2: fixed a real bug — cache-first for the navigation itself
// (this file's original behavior) could permanently strand an installed
// PWA on a stale index.html referencing content-hashed JS/CSS filenames
// from a build no longer on the server, once enough redeploys had
// happened since that device last did a background refresh (see the
// identical fix in kiosk-sw.js, where this was caught on a real device).
var CACHE_NAME = 'bamboo-app-v3';

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


// ---------------------------------------------------------------------------
// Web Push — the pop-up notification on a phone, iPad or desktop.
//
// This runs with no page open at all: the browser wakes this worker,
// hands it the message, and it has to draw the notification itself. The
// SOUND is the operating system's own notification sound, chosen by the
// device, not by us — `silent: false` below only says "not a silent one".
// (The chime in lib/notificationSound.js is a separate thing, for when the
// app is open and on screen.)
//
// The payload is whatever push.service.js sent: { title, body, link, id }.
// It is parsed defensively — a push with no body at all, or one the
// browser synthesises during a permission check, must still show something
// rather than throwing inside the worker.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  var title = data.title || 'Bamboo OS';
  var options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    silent: false,
    // Notifications that replace each other rather than stacking up: a tag
    // per notification id means a retry of the same one updates the
    // existing pop-up instead of showing it twice.
    tag: data.id ? 'bamboo-' + data.id : 'bamboo',
    renotify: true,
    data: { link: data.link || null }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the pop-up. The aim is to reuse a window that is already open
// rather than piling up new ones: if any Bamboo OS window exists, focus it
// and tell it where to go; only open a new one when there is none.
//
// The link format is the same one NotificationsBell.jsx uses —
// "message:<id>" for a conversation, otherwise a bare route name.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var link = event.notification.data && event.notification.data.link;
  var path = '/';
  if (link) {
    var parts = String(link).split(':');
    path = parts[0] === 'message' ? '/messages?peer=' + parts[1] : '/' + parts[0];
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        var url = new URL(windows[i].url);
        if (url.origin === self.location.origin && url.pathname.indexOf('/kiosk') !== 0 && url.pathname.indexOf('/pos') !== 0) {
          return windows[i].focus().then(function (w) {
            // postMessage rather than navigate(): the app is a single-page
            // router, so letting it route internally keeps the session and
            // avoids a full reload. navigate() is the fallback for a
            // client that will not take the message.
            try { (w || windows[0]).postMessage({ type: 'bamboo-open', path: path }); return w || windows[0]; }
            catch { return (w || windows[0]).navigate ? (w || windows[0]).navigate(path) : w; }
          });
        }
      }
      return self.clients.openWindow(path);
    })
  );
});
