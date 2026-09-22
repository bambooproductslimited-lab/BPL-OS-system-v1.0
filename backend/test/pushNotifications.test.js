/*
 * Web Push — the pop-up notification on a phone, iPad or desktop.
 *
 * Nothing here touches the network, and that is deliberate: a test that
 * talked to Google's or Apple's push service would be slow, flaky, and
 * would need credentials nobody should require to run the suite.
 *
 * The split is along the line of what is ours to get right. Whether a
 * message is correctly signed and encrypted is web-push's job, and
 * generateRequestDetails() builds exactly the request it would send
 * without sending it — so that is asserted directly, once. Everything
 * else is our orchestration: which subscriptions a notification goes to,
 * what is in the payload, that a dead endpoint gets pruned, and that
 * notify() raises a pop-up only for a transaction that actually
 * committed. For those, the final send is stubbed.
 *
 * Requires `npm run migrate && npm run seed` first (the pretest hook does
 * both against the test database).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('node:crypto');
var webpush = require('web-push');
var { pool } = require('../src/db/pool');
var pushService = require('../src/services/push.service');
var { notify } = require('../src/utils/notify');

var MARK = 'PUSHTEST';

// Replaces the one call that would leave this machine. Records what the
// service asked to be sent, and can be told to fail a given endpoint the
// way a real push service reports a subscription that no longer exists.
var sentCalls = [];
var failEndpointWith = {};
var realSend = webpush.sendNotification;
webpush.sendNotification = function (subscription, payload, options) {
  sentCalls.push({ subscription: subscription, payload: payload, options: options });
  var status = failEndpointWith[subscription.endpoint];
  if (status) return Promise.reject(Object.assign(new Error('push service said ' + status), { statusCode: status }));
  return Promise.resolve({ statusCode: 201 });
};

test.after(async function () {
  webpush.sendNotification = realSend;
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint LIKE '%pushtest%'");
  await pool.query("DELETE FROM notifications WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE '" + MARK + "%')");
  await pool.query("DELETE FROM employees WHERE code LIKE '" + MARK + "%'");
  await pool.end();
});

var seq = 0;
async function person() {
  seq += 1;
  var dept = (await pool.query('SELECT id FROM departments LIMIT 1')).rows[0];
  return (await pool.query(
    'INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type) ' +
    "VALUES ($1, 'Push', 'Tester', $2, $3, current_date, 'active', 'permanent') RETURNING id",
    [MARK + '-' + seq, 'pushtester' + seq + '@bplghana.com', dept.id])).rows[0].id;
}
function ctxFor(id) { return { employee: { id: id }, can: function () { return true; } }; }

// Shaped exactly like a browser's subscription, with real keys — the
// encryption test below genuinely encrypts against them.
function subscriptionFor(label) {
  var ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: 'https://push.example.invalid/pushtest/' + label + '/' + (seq++),
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
  };
}

test('the VAPID keypair is generated once and then stays put', async function () {
  var first = await pushService.vapidKeys();
  assert.ok(first.publicKey && first.privateKey);

  var stored = (await pool.query('SELECT public_key FROM push_vapid_keys WHERE id = 1')).rows[0];
  assert.equal(stored.public_key, first.publicKey, 'the generated key is the one persisted');

  var again = await pushService.vapidKeys();
  assert.equal(again.publicKey, first.publicKey,
    'regenerating would silently break every device already subscribed');

  var exposed = await pushService.publicKey();
  assert.deepEqual(exposed, { publicKey: first.publicKey });
  assert.ok(!('privateKey' in exposed), 'the private half must never leave the server');
});

test('what goes on the wire is signed with our key and encrypted end to end', async function () {
  var keys = await pushService.vapidKeys();
  var sub = subscriptionFor('wire-check');
  var secret = 'Leave approved — two days';

  var request = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: sub.keys },
    JSON.stringify({ title: secret, body: 'x' }),
    { vapidDetails: { subject: 'mailto:info@bplghana.com', publicKey: keys.publicKey, privateKey: keys.privateKey } }
  );

  assert.match(request.headers.Authorization, /^vapid t=/, 'signed with the VAPID key');
  assert.ok(request.headers.Authorization.includes(keys.publicKey), 'and with OUR public key');
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(request.body.length > 0);
  assert.ok(!request.body.toString('latin1').includes(secret),
    'the push service relays this — it must not be able to read it');
});

test('a malformed subscription is refused', async function () {
  var id = await person();
  for (var bad of [null, {}, { endpoint: 'https://x' }, { endpoint: 'not-a-url', keys: { p256dh: 'a', auth: 'b' } }]) {
    await assert.rejects(function () { return pushService.subscribe(ctxFor(id), bad, 'test'); },
      function (e) { return e.code === 'invalid'; });
  }
});

test('a device re-subscribing updates its row, and follows whoever signs in on it', async function () {
  var alice = await person();
  var bob = await person();
  var sub = subscriptionFor('shared-ipad');

  await pushService.subscribe(ctxFor(alice), sub, 'iPad');
  await pushService.subscribe(ctxFor(alice), sub, 'iPad');
  var rows = (await pool.query('SELECT employee_id FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])).rows;
  assert.equal(rows.length, 1, 'one device is one row, however many times it registers');
  assert.equal(rows[0].employee_id, alice);

  await pushService.subscribe(ctxFor(bob), sub, 'iPad'); // the same iPad, someone else signed in
  rows = (await pool.query('SELECT employee_id FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].employee_id, bob,
    'the previous person must stop receiving on a device that is no longer theirs');
});

test('unsubscribe only ever removes your own device', async function () {
  var alice = await person();
  var bob = await person();
  var sub = subscriptionFor('alices-phone');
  await pushService.subscribe(ctxFor(alice), sub, 'phone');

  await pushService.unsubscribe(ctxFor(bob), sub.endpoint);
  assert.equal((await pool.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])).rowCount, 1,
    "knowing an endpoint must not let you switch off someone else's notifications");

  await pushService.unsubscribe(ctxFor(alice), sub.endpoint);
  assert.equal((await pool.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])).rowCount, 0);
});

test('a notification goes to every device that person has registered', async function () {
  var id = await person();
  var other = await person();
  sentCalls.length = 0;

  await pushService.subscribe(ctxFor(id), subscriptionFor('desktop'), 'Chrome');
  await pushService.subscribe(ctxFor(id), subscriptionFor('phone'), 'Android');
  await pushService.subscribe(ctxFor(other), subscriptionFor('someone-else'), 'Chrome');

  var result = await pushService.sendToEmployee(id, { title: 'Leave approved', body: 'Two days', link: 'leave', id: 'abc' });
  assert.equal(result.sent, 2, "both of this person's devices, and nobody else's");
  assert.equal(result.failed, 0);
  assert.equal(sentCalls.length, 2);

  var payload = JSON.parse(sentCalls[0].payload);
  assert.deepEqual(payload, { title: 'Leave approved', body: 'Two days', link: 'leave', id: 'abc' });
  assert.equal(sentCalls[0].options.vapidDetails.publicKey, (await pushService.vapidKeys()).publicKey);
});

test('a dead endpoint is pruned; a live one beside it still gets through', async function () {
  var id = await person();
  sentCalls.length = 0;
  var dead = subscriptionFor('uninstalled');
  var live = subscriptionFor('still-here');
  await pushService.subscribe(ctxFor(id), dead, 'old phone');
  await pushService.subscribe(ctxFor(id), live, 'current phone');

  failEndpointWith[dead.endpoint] = 410; // "gone" — uninstalled, or site data cleared
  var result = await pushService.sendToEmployee(id, { title: 'x', body: 'y' });
  delete failEndpointWith[dead.endpoint];

  assert.equal(result.pruned, 1);
  assert.equal(result.sent, 1, 'one dead device must not stop the others');
  assert.equal((await pool.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', [dead.endpoint])).rowCount, 0,
    'a subscription the push service says is gone should not be retried forever');
  assert.equal((await pool.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', [live.endpoint])).rowCount, 1,
    'the working one is left alone');
});

test('a temporary failure is counted but the device is kept', async function () {
  var id = await person();
  var sub = subscriptionFor('flaky');
  await pushService.subscribe(ctxFor(id), sub, 'phone');

  failEndpointWith[sub.endpoint] = 500; // the push service having a bad day
  var result = await pushService.sendToEmployee(id, { title: 'x', body: 'y' });
  delete failEndpointWith[sub.endpoint];

  assert.equal(result.failed, 1);
  assert.equal(result.pruned, 0);
  assert.equal((await pool.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])).rowCount, 1,
    'an outage at the push service must not unsubscribe anybody');
});

test('sending to somebody with no devices is a no-op, not an error', async function () {
  var id = await person();
  assert.deepEqual(await pushService.sendToEmployee(id, { title: 'x', body: 'y' }), { sent: 0, failed: 0, pruned: 0 });
});

// The integration that actually matters: every notification in Bamboo OS
// goes through notify(), and notify() must raise the pop-up only once its
// caller's transaction has committed.
test('notify() raises a pop-up once the transaction commits', async function () {
  var id = await person();
  sentCalls.length = 0;
  await pushService.subscribe(ctxFor(id), subscriptionFor('notify-path'), 'Chrome');

  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    await notify(client, id, 'New task assigned', 'Sand the slats', 'tasks');
    assert.equal(sentCalls.length, 0, 'nothing may go out while the transaction is still open');
    await client.query('COMMIT');
  } finally { client.release(); }

  await new Promise(function (r) { setTimeout(r, 400); });
  assert.equal(sentCalls.length, 1, 'the pop-up goes out after the commit');
  assert.equal(JSON.parse(sentCalls[0].payload).title, 'New task assigned');
});

test('a rolled-back transaction raises no pop-up', async function () {
  var id = await person();
  sentCalls.length = 0;
  await pushService.subscribe(ctxFor(id), subscriptionFor('rollback-path'), 'Chrome');

  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    await notify(client, id, 'Should never be seen', 'rolled back', 'tasks');
    await client.query('ROLLBACK');
  } finally { client.release(); }

  await new Promise(function (r) { setTimeout(r, 400); });
  assert.equal(sentCalls.length, 0,
    'announcing something that did not happen is worse than announcing nothing');
});
