var webpush = require('web-push');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var config = require('../config');

// Web Push — the notification that pops up on a phone, an iPad or a
// desktop even when nobody has Bamboo OS open.
//
// How this differs from the chime in the header: that one needs the page
// to be open and only plays where somebody is already looking. This hands
// the message to the browser vendor's push service (Google's, Mozilla's,
// Apple's), which wakes the device's own service worker and draws a real
// system notification. The sound is the operating system's notification
// sound — a web app cannot choose it, and should not be able to.
//
// Two things about the platforms are worth knowing and are not our bugs:
//
//   * On iPhone and iPad this works ONLY for a site the person has added
//     to their Home Screen, on iOS 16.4 or later. In plain Safari the
//     subscribe call simply isn't there. The frontend detects that and
//     says so rather than failing silently — see lib/pushNotifications.js.
//   * A subscription goes stale on its own: reinstalling the app, clearing
//     site data or the push service rotating it. The push service answers
//     404 or 410 for those, which is the signal to delete the row. Any
//     other failure is left alone and retried next time.

var VAPID_SUBJECT = 'mailto:info@bplghana.com';

var cachedKeys = null;

// Returns the server's VAPID keypair, generating and storing it the first
// time. Environment variables win if this deployment would rather manage
// the pair itself.
//
// The INSERT is ON CONFLICT DO NOTHING followed by a re-read rather than a
// plain insert, because two requests arriving together would otherwise
// both generate a pair and one would overwrite the other — leaving devices
// subscribed against a public key the server no longer holds.
async function vapidKeys() {
  if (cachedKeys) return cachedKeys;
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    cachedKeys = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
    return cachedKeys;
  }
  var existing = await pool.query('SELECT public_key, private_key FROM push_vapid_keys WHERE id = 1');
  if (!existing.rows[0]) {
    var fresh = webpush.generateVAPIDKeys();
    await pool.query(
      'INSERT INTO push_vapid_keys (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING',
      [fresh.publicKey, fresh.privateKey]
    );
    existing = await pool.query('SELECT public_key, private_key FROM push_vapid_keys WHERE id = 1');
  }
  cachedKeys = { publicKey: existing.rows[0].public_key, privateKey: existing.rows[0].private_key };
  return cachedKeys;
}

// What a browser needs before it can subscribe. Public by design — it is
// the server's public key, and it is useless without the matching private
// half.
async function publicKey() {
  var keys = await vapidKeys();
  return { publicKey: keys.publicKey };
}

function validSubscription(sub) {
  return !!(sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint)
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string');
}

// Registers this device against the signed-in employee.
//
// The endpoint is unique, so a device that re-subscribes (a new sign-in, a
// permission re-grant, the same iPad handed to a different person) updates
// the existing row instead of creating a second one — and crucially moves
// it to whoever is signed in now, so the previous person stops receiving
// notifications on a device that is no longer theirs.
async function subscribe(ctx, sub, userAgent) {
  if (!validSubscription(sub)) fail('invalid', 'That is not a usable push subscription.');
  await pool.query(
    'INSERT INTO push_subscriptions (employee_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5) ' +
    'ON CONFLICT (endpoint) DO UPDATE SET employee_id = EXCLUDED.employee_id, p256dh = EXCLUDED.p256dh, ' +
    '  auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent',
    [ctx.employee.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(userAgent || '').slice(0, 300)]
  );
  return { ok: true };
}

// Only ever removes the caller's own device. Without the employee_id
// clause, anyone who learned another device's endpoint could switch that
// person's notifications off.
async function unsubscribe(ctx, endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND employee_id = $2',
    [String(endpoint || ''), ctx.employee.id]);
  return { ok: true };
}

// Delivers one notification to every device an employee has registered.
// Never throws: a push that cannot be delivered must not take down the
// action that triggered it — somebody's leave request is approved whether
// or not their phone was reachable.
async function sendToEmployee(employeeId, payload) {
  var keys;
  try { keys = await vapidKeys(); } catch { return { sent: 0, failed: 0, pruned: 0 }; }

  var subs = (await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE employee_id = $1', [employeeId])).rows;
  if (!subs.length) return { sent: 0, failed: 0, pruned: 0 };

  var body = JSON.stringify(payload);
  var options = { vapidDetails: { subject: VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 60 * 60 * 24 };

  var sent = 0, failed = 0, pruned = 0;
  var stale = [];
  await Promise.all(subs.map(async function (s) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, options);
      sent += 1;
    } catch (err) {
      // 404/410 mean this subscription is gone for good — the app was
      // uninstalled, site data cleared, or the push service rotated it.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) { stale.push(s.id); pruned += 1; }
      else failed += 1;
    }
  }));

  if (stale.length) {
    await pool.query('DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])', [stale]);
  }
  if (sent) {
    await pool.query('UPDATE push_subscriptions SET last_sent_at = now() WHERE employee_id = $1', [employeeId]);
  }
  return { sent: sent, failed: failed, pruned: pruned };
}

// Lets the signed-in person confirm this device actually works, without
// waiting for something real to happen to them.
async function sendTest(ctx) {
  var result = await sendToEmployee(ctx.employee.id, {
    title: 'Bamboo OS',
    body: 'Pop-up notifications are working on this device.',
    link: null
  });
  if (!result.sent) fail('invalid', 'No device on this account could be reached. Turn pop-up alerts on here first.');
  return result;
}

module.exports = {
  publicKey: publicKey, subscribe: subscribe, unsubscribe: unsubscribe,
  sendToEmployee: sendToEmployee, sendTest: sendTest,
  // exported for tests
  vapidKeys: vapidKeys, validSubscription: validSubscription
};
