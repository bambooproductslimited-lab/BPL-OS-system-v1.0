/*
 * Integration test for the YouTube and Twitch OAuth connect flows
 * (youtubeOAuth.service.js, twitchOAuth.service.js + routes/oauth.routes.js
 * + routes/marketing.routes.js). This sandbox has no real client id/secret
 * configured for either, so it can only exercise the parts that don't
 * require actually talking to Google/Twitch: permission gating and the
 * clean error paths for "not configured", "not connected yet", and an
 * invalid/expired OAuth state. Requires `npm run migrate && npm run seed`
 * first, same as the other test files.
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

['youtube', 'twitch'].forEach(function (platform) {
  test(platform + ' oauth: start is permission-gated and fails cleanly when not configured', async function () {
    var admin = await login('kelvin.duho@bplghana.com');
    var alice = await login('alice.kamau@bplghana.com'); // plain employee — no marketing.manage

    var denied = await fetch(base + '/api/marketing/oauth/' + platform + '/start', { method: 'POST', headers: authed(alice) });
    assert.equal(denied.status, 403);

    var notConfigured = await fetch(base + '/api/marketing/oauth/' + platform + '/start', { method: 'POST', headers: authed(admin) });
    assert.equal(notConfigured.status, 400);
    var body = await notConfigured.json();
    assert.match(body.error.message, /not configured/);
  });

  test(platform + ' oauth: callback with an invalid/expired state redirects with an error, never crashes', async function () {
    var res = await fetch(base + '/api/marketing/oauth/' + platform + '/callback?code=x&state=not-a-real-state', { redirect: 'manual' });
    assert.equal(res.status, 302);
    var location = res.headers.get('location');
    assert.match(location, new RegExp(platform + '=error'));
  });

  test(platform + ' sync: permission-gated, fails cleanly when not connected yet', async function () {
    var admin = await login('kelvin.duho@bplghana.com');
    var alice = await login('alice.kamau@bplghana.com');

    var denied = await fetch(base + '/api/marketing/' + platform + '/sync', { method: 'POST', headers: authed(alice) });
    assert.equal(denied.status, 403);

    var notConnected = await fetch(base + '/api/marketing/' + platform + '/sync', { method: 'POST', headers: authed(admin) });
    assert.equal(notConnected.status, 400);
    var body = await notConnected.json();
    assert.match(body.error.message, /not connected/);
  });
});

test('youtube and twitch channels are seeded and exposed on the integrations catalogue', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var channels = await (await fetch(base + '/api/marketing/channels', { headers: authed(admin) })).json();
  var keys = channels.map(function (c) { return c.key; });
  assert.ok(keys.includes('youtube'));
  assert.ok(keys.includes('twitch'));

  var integrations = await (await fetch(base + '/api/settings/integrations', { headers: authed(admin) })).json();
  var ids = integrations.map(function (i) { return i.id; });
  assert.ok(ids.includes('youtube'));
  assert.ok(ids.includes('twitch'));
});
