/*
 * Integration tests for the WhatsApp Business Cloud API webhook
 * (whatsapp.service.js + routes/whatsapp.routes.js) and the GA4 website
 * sync (googleAnalytics.service.js + routes/marketing.routes.js). Neither
 * has real credentials in this sandbox, so — same as youtubeTwitchOAuth's
 * test file — this only exercises what doesn't require actually talking
 * to Meta/Google: the webhook handshake/event-handling shape and the
 * clean "not configured" / permission-gating error paths. Requires
 * `npm run migrate && npm run seed` first.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
// Set before requiring ../src/app (which loads src/config.js, evaluated
// once at require time) so the webhook's signature check has something to
// verify against — isValidSignature() now fails closed (rejects every
// POST) when META_APP_SECRET isn't set, per the security fix that made the
// old "no secret configured -> let it through" behavior a real auth
// bypass. META_APP_ID stays unset, so config.meta.configured (which also
// requires appId) is still false for every other Meta-OAuth "not
// configured" test in this suite — only the signature check is affected.
process.env.META_APP_SECRET = 'test-only-whatsapp-webhook-secret';
var app = require('../src/app');

function signedWebhookHeaders(bodyString) {
  var sig = crypto.createHmac('sha256', process.env.META_APP_SECRET).update(bodyString).digest('hex');
  return { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + sig };
}

var server;
var base;

test.before(function (t, done) {
  server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); });
});
test.after(function () { server.close(); });

async function login(email) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  return (await res.json()).token;
}
function authed(token) { return { Authorization: 'Bearer ' + token }; }

test('whatsapp webhook: GET verification fails cleanly when not configured', async function () {
  var res = await fetch(base + '/api/marketing/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=echo-me');
  assert.equal(res.status, 403);
});

test('whatsapp webhook: POST logs an inbox item, and re-delivery of the same message id is not duplicated', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var channels = await (await fetch(base + '/api/marketing/channels', { headers: authed(admin) })).json();
  var whatsappChannel = channels.find(function (c) { return c.key === 'whatsapp'; });
  assert.ok(whatsappChannel, 'whatsapp channel should be seeded');

  async function countInbox() {
    var items = await (await fetch(base + '/api/marketing/inbox?channelId=' + whatsappChannel.id, { headers: authed(admin) })).json();
    return items.length;
  }
  var before = await countInbox();

  var payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-test',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          contacts: [{ profile: { name: 'Test Customer' }, wa_id: '233240000999' }],
          messages: [{ from: '233240000999', id: 'wamid.TESTMSG001', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Is bamboo flooring in stock?' } }]
        }
      }]
    }]
  };

  var body = JSON.stringify(payload);
  var post1 = await fetch(base + '/api/marketing/whatsapp/webhook', {
    method: 'POST', headers: signedWebhookHeaders(body), body: body
  });
  assert.equal(post1.status, 200);
  var afterFirst = await countInbox();
  assert.equal(afterFirst, before + 1);

  // Meta retries undelivered webhooks — the same message id arriving twice
  // must not create a second inbox item.
  var post2 = await fetch(base + '/api/marketing/whatsapp/webhook', {
    method: 'POST', headers: signedWebhookHeaders(body), body: body
  });
  assert.equal(post2.status, 200);
  var afterSecond = await countInbox();
  assert.equal(afterSecond, afterFirst);
});

test('whatsapp webhook: POST with a missing/wrong signature is rejected, not silently accepted', async function () {
  var payload = { object: 'whatsapp_business_account', entry: [] };
  var body = JSON.stringify(payload);

  var noSig = await fetch(base + '/api/marketing/whatsapp/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body
  });
  assert.equal(noSig.status, 403);

  var wrongSig = await fetch(base + '/api/marketing/whatsapp/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
    body: body
  });
  assert.equal(wrongSig.status, 403);
});

test('whatsapp reply: fails cleanly when WhatsApp is not configured on the server', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var channels = await (await fetch(base + '/api/marketing/channels', { headers: authed(admin) })).json();
  var whatsappChannel = channels.find(function (c) { return c.key === 'whatsapp'; });
  var items = await (await fetch(base + '/api/marketing/inbox?channelId=' + whatsappChannel.id + '&status=open', { headers: authed(admin) })).json();
  assert.ok(items.length > 0, 'expected at least one open seeded WhatsApp inbox item');

  var res = await fetch(base + '/api/marketing/inbox/' + items[0].id + '/reply', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(admin)),
    body: JSON.stringify({ replyBody: 'Yes, 40sqm is in stock.' })
  });
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.match(body.error.message, /not configured/);
});

test('website sync: permission-gated and fails cleanly when not configured', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var denied = await fetch(base + '/api/marketing/website/sync', { method: 'POST', headers: authed(alice) });
  assert.equal(denied.status, 403);

  var notConfigured = await fetch(base + '/api/marketing/website/sync', { method: 'POST', headers: authed(admin) });
  assert.equal(notConfigured.status, 400);
  var body = await notConfigured.json();
  assert.match(body.error.message, /not configured/);
});

test('whatsapp and website integrations reflect live server config, not a DB toggle', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var integrations = await (await fetch(base + '/api/settings/integrations', { headers: authed(admin) })).json();
  var whatsapp = integrations.find(function (i) { return i.id === 'whatsappbusiness'; });
  var website = integrations.find(function (i) { return i.id === 'googleanalytics'; });
  assert.ok(whatsapp);
  assert.ok(website);
  // No env credentials in this sandbox, so both should read as not connected.
  assert.equal(whatsapp.connected, false);
  assert.equal(website.connected, false);
});
