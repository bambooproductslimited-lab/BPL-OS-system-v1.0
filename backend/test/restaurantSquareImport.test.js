/*
 * Tests for the Restaurant module's per-restaurant historical Square import
 * (restaurantSquareImport.service.js + POST /api/restaurant/square-import).
 * Real Square API calls are never exercised here — no
 * SQUARE_ACCESS_TOKEN_<CODE> is set in this test environment, so the
 * service refuses before any network call, which is itself the behavior
 * under test for the "not configured" case. Pure mapping/naming helpers are
 * unit-tested directly against representative Square API JSON shapes.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var restaurantSquareImport = require('../src/services/restaurantSquareImport.service');

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
function jsonAuthed(token) { return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }; }

async function starBarId(token) {
  var res = await fetch(base + '/api/companies', { headers: jsonAuthed(token) });
  var companies = await res.json();
  var sbr = companies.find(function (c) { return c.code === 'SBR'; });
  assert.ok(sbr, 'expected Star Bar Restaurant (code SBR) to exist');
  return sbr.id;
}

test('POST /api/restaurant/square-import is forbidden without restaurant.manage', async function () {
  var alice = await login('alice.kamau@bplghana.com'); // employee — no restaurant.manage
  var admin = await login('kelvin.duho@bplghana.com');
  var companyId = await starBarId(admin);
  var res = await fetch(base + '/api/restaurant/square-import', {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ companyId: companyId })
  });
  assert.equal(res.status, 403);
});

test('POST /api/restaurant/square-import fails clearly when that company has no Square token set', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var companyId = await starBarId(admin);
  var res = await fetch(base + '/api/restaurant/square-import', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ companyId: companyId })
  });
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.match(body.error.message, /Square is not configured for Star Bar Restaurant/);
  assert.match(body.error.message, /SQUARE_ACCESS_TOKEN_SBR/);
});

test('POST /api/restaurant/square-import 404s for an unknown company', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var res = await fetch(base + '/api/restaurant/square-import', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ companyId: '00000000-0000-0000-0000-000000000000' })
  });
  assert.equal(res.status, 404);
});

test('minorToMajor divides Square minor-unit integers by 100', function () {
  assert.equal(restaurantSquareImport.minorToMajor({ amount: 4500, currency: 'USD' }), 45);
  assert.equal(restaurantSquareImport.minorToMajor(null), 0);
});

test('menuItemName uses the item name alone for a default "Regular" variation, else appends the variation name', function () {
  var item = { item_data: { name: 'Jollof Rice' } };
  assert.equal(
    restaurantSquareImport.menuItemName(item, { item_variation_data: { name: 'Regular' } }),
    'Jollof Rice'
  );
  assert.equal(
    restaurantSquareImport.menuItemName(item, { item_variation_data: { name: '' } }),
    'Jollof Rice'
  );
  assert.equal(
    restaurantSquareImport.menuItemName(item, { item_variation_data: { name: 'Large' } }),
    'Jollof Rice — Large'
  );
});

test('mapTenderType maps Square tender types onto restaurant_orders.payment_method values', function () {
  assert.equal(restaurantSquareImport.mapTenderType('CARD'), 'card');
  assert.equal(restaurantSquareImport.mapTenderType('CASH'), 'cash');
  assert.equal(restaurantSquareImport.mapTenderType('WALLET'), 'mobile_money');
  assert.equal(restaurantSquareImport.mapTenderType('SQUARE_ACCOUNT'), 'mobile_money');
  assert.equal(restaurantSquareImport.mapTenderType('BANK_ACCOUNT'), 'bank_transfer');
  assert.equal(restaurantSquareImport.mapTenderType('SOMETHING_UNKNOWN'), 'other');
});
