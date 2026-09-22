import { api } from '../api/client';

// Turning pop-up notifications on for THIS device.
//
// Three separate things have to be true before a notification can appear
// on somebody's phone or desktop, and they fail differently, so this
// module reports which one is missing rather than a single "didn't work":
//
//   1. The browser has to support the Push API and service workers at all.
//   2. The person has to grant notification permission — which the browser
//      only asks for from inside a real click, and which, once denied,
//      cannot be asked for again from script. Only the browser's own site
//      settings can undo that, so the UI has to say so.
//   3. The device has to register a subscription with its vendor's push
//      service, which we then store server-side so the backend can deliver.
//
// The iPhone/iPad case is the one that surprises people: Apple supports
// Web Push only for a site added to the Home Screen, on iOS 16.4 or later.
// In ordinary Safari there is no PushManager at all. That is not a failure
// to report as an error — it is an instruction to add the app to the Home
// Screen, so it is detected separately (see iosNeedsInstall).

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function permissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

function isApple() {
  // iPadOS reports itself as a Mac, so the touch-point check is what
  // separates an iPad from a desktop Safari.
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

// True when this is an iPhone/iPad in ordinary Safari, where pop-ups can
// only work once the app is on the Home Screen.
export function iosNeedsInstall() {
  return isApple() && !isStandalone() && !('PushManager' in window);
}

// base64url, the form a VAPID public key arrives in, to the Uint8Array
// the subscribe call wants.
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function readyRegistration() {
  // Registered in main.jsx; ready resolves once it is active. On a first
  // ever visit this can genuinely take a moment.
  return navigator.serviceWorker.ready;
}

// Returns 'on' | 'denied' | 'unsupported' | 'failed'. Must be called from
// a real user gesture — every browser refuses to prompt otherwise.
export async function enablePush() {
  if (!pushSupported()) return 'unsupported';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  try {
    const registration = await readyRegistration();
    // An existing subscription is reused rather than replaced: the
    // endpoint is the device's identity, and re-subscribing needlessly
    // would orphan the row already stored against it.
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await api.get('/push/public-key');
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true, // required; the browser will not allow silent pushes
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }
    await api.post('/push/subscribe', { subscription: sub.toJSON() });
    return 'on';
  } catch {
    return 'failed';
  }
}

export async function disablePush() {
  if (!pushSupported()) return;
  try {
    const registration = await readyRegistration();
    const sub = await registration.pushManager.getSubscription();
    if (!sub) return;
    // Tell the server first: if unsubscribing locally succeeded but the
    // server still held the row, it would keep pushing to a dead endpoint
    // until the push service returned 410.
    await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  } catch { /* nothing useful to tell the person if teardown fails */ }
}

// Whether THIS device is currently subscribed — permission alone isn't
// enough to say so, since site data can be cleared without the permission
// being revoked.
export async function isEnabledHere() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try {
    const registration = await readyRegistration();
    return !!(await registration.pushManager.getSubscription());
  } catch {
    return false;
  }
}

export async function sendTestPush() {
  return api.post('/push/test', {});
}
