// The till and the kitchen screen on their own websites (frontend
// tools/build-site.mjs): their addresses may call the till's API (/api/pos)
// from the browser, and no other part of the OS.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var config = require('../src/config');

var server, base;
test.before(async function () {
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(function () { server.close(); });

async function preflight(path, origin) {
  var r = await fetch(base + path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' } });
  return r.headers.get('access-control-allow-origin');
}

test('the till and kitchen screen sites reach /api/pos and nothing else', async function () {
  assert.deepEqual(config.restaurantSiteOrigins, ['https://pos.starbartema.com', 'https://kds.starbartema.com']);
  assert.equal(await preflight('/api/pos/login', 'https://pos.starbartema.com'), 'https://pos.starbartema.com');
  assert.equal(await preflight('/api/pos/kds/items/x', 'https://kds.starbartema.com'), 'https://kds.starbartema.com');
  var login = await fetch(base + '/api/pos/login', { method: 'POST', headers: { Origin: 'https://kds.starbartema.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '00' }) });
  assert.equal(login.headers.get('access-control-allow-origin'), 'https://kds.starbartema.com');
  // Not the rest of the OS, and not other addresses.
  assert.equal(await preflight('/api/auth/login', 'https://pos.starbartema.com'), null);
  assert.equal(await preflight('/api/restaurant/kitchen', 'https://kds.starbartema.com'), null);
  assert.equal(await preflight('/api/posters', 'https://pos.starbartema.com'), null);
  assert.equal(await preflight('/api/pos/login', 'https://pos.example.com'), null);
  // The OS's own address still reaches both.
  var own = config.corsOrigin[0];
  assert.equal(await preflight('/api/pos/login', own), own);
  assert.equal(await preflight('/api/auth/login', own), own);
});
