/*
 * Integration test for the TikTok OAuth connect flow (tiktokOAuth.service.js
 * + routes/oauth.routes.js). This sandbox has no real TIKTOK_CLIENT_KEY/
 * SECRET configured, so it can only exercise the parts that don't require
 * actually talking to TikTok: permission gating and the clean error paths
 * for "not configured", "not connected yet", and an invalid/expired OAuth
 * state. The full happy path (real token exchange, sync) needs live
 * TikTok credentials and is exercised manually against the real service.
 * Requires `npm run migrate && npm run seed` first, same as the other test
 * files.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');

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

test('tiktok oauth: start is permission-gated and fails cleanly when not configured', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com'); // plain employee — no marketing.manage

  var denied = await fetch(base + '/api/marketing/oauth/tiktok/start', { method: 'POST', headers: authed(alice) });
  assert.equal(denied.status, 403);

  // This sandbox has no TIKTOK_CLIENT_KEY/SECRET set, so even a permitted
  // user gets a clear "not configured" error rather than a confusing crash.
  var notConfigured = await fetch(base + '/api/marketing/oauth/tiktok/start', { method: 'POST', headers: authed(admin) });
  assert.equal(notConfigured.status, 400);
  var body = await notConfigured.json();
  assert.match(body.error.message, /not configured/);
});

test('tiktok oauth: callback with an invalid/expired state redirects with an error, never crashes', async function () {
  var res = await fetch(base + '/api/marketing/oauth/tiktok/callback?code=x&state=not-a-real-state', { redirect: 'manual' });
  assert.equal(res.status, 302);
  var location = res.headers.get('location');
  assert.match(location, /tiktok=error/);
});

test('tiktok sync: permission-gated, fails cleanly when not connected yet', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var denied = await fetch(base + '/api/marketing/tiktok/sync', { method: 'POST', headers: authed(alice) });
  assert.equal(denied.status, 403);

  var notConnected = await fetch(base + '/api/marketing/tiktok/sync', { method: 'POST', headers: authed(admin) });
  assert.equal(notConnected.status, 400);
  var body = await notConnected.json();
  assert.match(body.error.message, /not connected/);
});
