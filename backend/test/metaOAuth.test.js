/*
 * Integration test for the Facebook/Instagram (Meta) OAuth connect flow
 * (metaOAuth.service.js + routes/oauth.routes.js + routes/marketing.routes.js).
 * This sandbox has no real META_APP_ID/SECRET configured, so it can only
 * exercise the parts that don't require actually talking to Meta:
 * permission gating and the clean error paths for "not configured",
 * "not connected yet", and an invalid/expired OAuth state or pending
 * page-selection token. The full happy path (real token exchange, page
 * picker, sync) needs live Meta credentials and is exercised manually
 * against the real service. Requires `npm run migrate && npm run seed`
 * first, same as the other test files.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var config = require('../src/config');

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

test('meta oauth: start is permission-gated and fails cleanly when not configured', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com'); // plain employee — no marketing.manage

  var denied = await fetch(base + '/api/marketing/oauth/meta/start', { method: 'POST', headers: authed(alice) });
  assert.equal(denied.status, 403);

  var notConfigured = await fetch(base + '/api/marketing/oauth/meta/start', { method: 'POST', headers: authed(admin) });
  assert.equal(notConfigured.status, 400);
  var body = await notConfigured.json();
  assert.match(body.error.message, /not configured/);
});

test('meta oauth: callback with an invalid/expired state redirects to the choose-page-error path, never crashes', async function () {
  var res = await fetch(base + '/api/marketing/oauth/meta/callback?code=x&state=not-a-real-state', { redirect: 'manual' });
  assert.equal(res.status, 302);
  var location = res.headers.get('location');
  assert.match(location, /meta=error/);
});

test('meta oauth: back to the OS address the person started from, never one off the list', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var keep = Object.assign({}, config.meta);
  Object.assign(config.meta, { appId: 'zq-app', appSecret: 'zq-secret', redirectUri: 'https://zq-api.example/api/marketing/oauth/meta/callback', configured: true });
  config.corsOrigin.push('https://zq-os.example');
  try {
    async function startFrom(origin) {
      var r = await fetch(base + '/api/marketing/oauth/meta/start', { method: 'POST', headers: Object.assign({ Origin: origin }, authed(admin)) });
      assert.equal(r.status, 200);
      return new URL((await r.json()).url).searchParams.get('state');
    }
    async function landing(state) {
      var r = await fetch(base + '/api/marketing/oauth/meta/callback?error=access_denied&state=' + state, { redirect: 'manual' });
      return r.headers.get('location');
    }
    assert.match(await landing(await startFrom('https://zq-os.example')), /^https:\/\/zq-os\.example\/socialtracker\?meta=error/);
    var elsewhere = await landing(await startFrom('https://zq-not-ours.example'));
    assert.ok(!/zq-not-ours/.test(elsewhere), 'an address not on the list is never used');
    assert.ok(elsewhere.indexOf(config.appUrl) === 0, 'the usual OS address instead');
  } finally {
    config.corsOrigin.splice(config.corsOrigin.indexOf('https://zq-os.example'), 1);
    Object.assign(config.meta, keep);
  }
});

test('meta pages: fails cleanly with a missing/expired pending token, never crashes', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var denied = await fetch(base + '/api/marketing/meta/pages?pending=whatever', { headers: authed(alice) });
  assert.equal(denied.status, 403);

  var expired = await fetch(base + '/api/marketing/meta/pages?pending=not-a-real-pending-token', { headers: authed(admin) });
  assert.equal(expired.status, 400);
  var body = await expired.json();
  assert.match(body.error.message, /expired/);

  var connectDenied = await fetch(base + '/api/marketing/meta/pages/somepage/connect', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(admin)), body: JSON.stringify({ pending: 'not-a-real-pending-token' })
  });
  assert.equal(connectDenied.status, 400);
});

test('facebook/instagram sync: permission-gated, fail cleanly when not connected yet', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var fbDenied = await fetch(base + '/api/marketing/facebook/sync', { method: 'POST', headers: authed(alice) });
  assert.equal(fbDenied.status, 403);
  var igDenied = await fetch(base + '/api/marketing/instagram/sync', { method: 'POST', headers: authed(alice) });
  assert.equal(igDenied.status, 403);

  var fbNotConnected = await fetch(base + '/api/marketing/facebook/sync', { method: 'POST', headers: authed(admin) });
  assert.equal(fbNotConnected.status, 400);
  var fbBody = await fbNotConnected.json();
  assert.match(fbBody.error.message, /not connected/);

  var igNotConnected = await fetch(base + '/api/marketing/instagram/sync', { method: 'POST', headers: authed(admin) });
  assert.equal(igNotConnected.status, 400);
  var igBody = await igNotConnected.json();
  assert.match(igBody.error.message, /not connected/);
});
