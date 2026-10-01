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
// v4: calls ring on the device with the OS closed (Answer / Decline).
// v5: a call buzzes harder and more often (every 3 s, long pulses) for the
//     minute it rings.
// v3: adds the Web Push handlers at the foot of this file.
// v2: fixed a real bug — cache-first for the navigation itself
// (this file's original behavior) could permanently strand an installed
// PWA on a stale index.html referencing content-hashed JS/CSS filenames
// from a build no longer on the server, once enough redeploys had
// happened since that device last did a background refresh (see the
// identical fix in kiosk-sw.js, where this was caught on a real device).
var CACHE_NAME = 'bamboo-app-v5';

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
  if (data.type === 'call') { event.waitUntil(ringCall(data)); return; }
  if (data.type === 'call-missed') { event.waitUntil(showMissedCall(data)); return; }
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

// ---------------------------------------------------------------------------
// Calls (calls.service.js). Someone calling rings this device even with the
// OS closed, as long as it is online: a pop-up with Answer and Decline that
// buzzes hard again every 3 seconds for as long as the call rings (a minute), the
// nearest a web app can come to a phone's own call screen. If the OS is
// open and on screen, its own ringing card shows instead. When the call
// ends unanswered, "Missed call" replaces the pop-up (same tag).

// The API's address, handed over when main.jsx registers this worker.
var API_URL = new URL(self.location.href).searchParams.get('api') || '';
// A closed web app cannot play a ringtone (no browser lets a closed site make
// sound), so the alert is made hard to miss instead: long vibration pulses,
// repeated every 3 seconds, each with the phone's notification sound.
var RING_FOR_MS = 60000, RING_EVERY_MS = 3000;
var RING_VIBRATE = [1200, 300, 1200, 300, 1200];

function callWords() {
  var lang = String((self.navigator && self.navigator.language) || 'en').slice(0, 2);
  if (lang === 'fr') return { answer: 'Répondre', video: 'Répondre en vidéo', decline: 'Refuser' };
  if (lang === 'zh') return { answer: '接听', video: '视频接听', decline: '拒绝' };
  return { answer: 'Answer', video: 'Answer with video', decline: 'Decline' };
}
function callTag(id) { return 'bamboo-call-' + id; }
function isAppWindow(w) {
  var url = new URL(w.url);
  return url.origin === self.location.origin && url.pathname.indexOf('/kiosk') !== 0 && url.pathname.indexOf('/pos') !== 0 && url.pathname.indexOf('/meet') !== 0;
}
function chatOf(link) { var p = String(link || '').split(':'); return p[0] === 'chat' ? p[1] : null; }
function wait(ms) { return new Promise(function (done) { setTimeout(done, ms); }); }
function ringingNow(callId) {
  return self.registration.getNotifications({ tag: callTag(callId) }).then(function (list) {
    return list.filter(function (n) { return n.data && n.data.type === 'call'; });
  });
}

function ringCall(data) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
    var shown = windows.filter(function (w) { return isAppWindow(w) && w.visibilityState === 'visible'; });
    shown.forEach(function (w) { try { w.postMessage({ type: 'bamboo-call' }); } catch { /* closing */ } });
    // Apple's browsers take a push that shows nothing as abuse, so there the
    // pop-up always shows; elsewhere an OS on screen rings by itself.
    var ua = self.navigator.userAgent || '';
    var apple = /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua));
    if (shown.length && !apple) return null;

    var words = callWords();
    var options = {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: callTag(data.callId),
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: RING_VIBRATE,
      actions: [
        { action: 'decline', title: words.decline },
        { action: 'answer', title: data.kind === 'video' ? words.video : words.answer }
      ],
      data: { type: 'call', callId: data.callId, link: data.link || null, declinePass: data.declinePass || null }
    };
    var title = data.title || 'Bamboo OS';
    var started = Date.now();
    // Buzz again while it's still ringing here: stop as soon as the pop-up is
    // gone (answered, declined, swiped away, or replaced by "Missed call").
    function again() {
      if (Date.now() - started >= RING_FOR_MS) {
        return ringingNow(data.callId).then(function (list) { list.forEach(function (n) { n.close(); }); });
      }
      return wait(RING_EVERY_MS).then(function () { return ringingNow(data.callId); }).then(function (list) {
        if (!list.length) return null;
        if (Date.now() - started >= RING_FOR_MS) { list.forEach(function (n) { n.close(); }); return null; }
        return self.registration.showNotification(title, options).then(again);
      });
    }
    return self.registration.showNotification(title, options).then(again);
  });
}

function showMissedCall(data) {
  return self.registration.showNotification(data.title || 'Missed call', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: callTag(data.callId),
    renotify: true,
    silent: false,
    data: { type: 'call-missed', link: data.link || null }
  });
}

// Decline on the pop-up: tells the OS without opening it. The pop-up carries
// a pass that can decline this one call for this one person, nothing else.
function declineCall(d) {
  if (!API_URL || !d.declinePass) return Promise.resolve();
  return fetch(API_URL + '/meet/call-decline', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: d.declinePass })
  }).catch(function () { /* it stops ringing for the caller after a minute anyway */ });
}

// Tapping the pop-up. The aim is to reuse a window that is already open
// rather than piling up new ones: if any Bamboo OS window exists, focus it
// and tell it where to go; only open a new one when there is none.
//
// The link format is the same one NotificationsBell.jsx uses —
// "message:<id>" for a conversation, otherwise a bare route name.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var d = event.notification.data || {};
  if (d.type === 'call' && event.action === 'decline') { event.waitUntil(declineCall(d)); return; }
  var link = d.link;
  var path = '/';
  // Answer, or a tap on the call pop-up itself: open the chat and join.
  if (d.type === 'call' && chatOf(link)) path = '/messages?chat=' + chatOf(link) + '&answer=' + d.callId;
  else if (link) {
    var parts = String(link).split(':');
    path = parts[0] === 'message' ? '/messages?peer=' + parts[1]
      : parts[0] === 'chat' ? '/messages?chat=' + parts[1]
      : '/' + parts[0];
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
