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
var { pool } = require('../src/db/pool');
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

test('upsertGroupedMenuItem groups a multi-variation Square item into one menu item plus variation rows, idempotently, and deactivates any pre-existing flat per-variation rows', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var companyId = await starBarId(admin);
  var company = await restaurantSquareImport.requireCompany(companyId);

  var stamp = 'TEST-' + Date.now();
  var fakeItem = { id: stamp + '-ITEM', is_deleted: false, item_data: { name: 'Test Grouped Dish ' + stamp, categories: [] } };
  var variationA = { id: stamp + '-VAR-A', is_deleted: false, item_variation_data: { name: 'Small', price_money: { amount: 500, currency: 'USD' } } };
  var variationB = { id: stamp + '-VAR-B', is_deleted: false, item_variation_data: { name: 'Large', price_money: { amount: 1200, currency: 'USD' } } };

  // A leftover flat row from before grouping shipped — same shape
  // upsertMenuItem would have created for variationA on an older import.
  var legacyFlatRes = await pool.query(
    "INSERT INTO restaurant_menu_items (company_id, name, category, price, active, external_id, source) " +
    "VALUES ($1,$2,'General',5,true,$3,'square') RETURNING id",
    [company.id, 'Test Grouped Dish ' + stamp + ' — Small', variationA.id]
  );
  var legacyFlatId = legacyFlatRes.rows[0].id;

  try {
    var result = await restaurantSquareImport.upsertGroupedMenuItem(company, fakeItem, [variationA, variationB], {});
    assert.ok(result.menuItemId);
    assert.notEqual(result.menuItemId, legacyFlatId);
    assert.equal(Object.keys(result.variationRowIdByExternalId).length, 2);

    var variationRows = await pool.query('SELECT name, price FROM restaurant_menu_item_variations WHERE menu_item_id = $1 ORDER BY sort_order', [result.menuItemId]);
    assert.deepEqual(variationRows.rows.map(function (r) { return r.name; }), ['Small', 'Large']);
    assert.equal(Number(variationRows.rows[0].price), 5);
    assert.equal(Number(variationRows.rows[1].price), 12);

    // The legacy flat row is superseded, not deleted (real orders may still reference it).
    var legacyAfter = await pool.query('SELECT active FROM restaurant_menu_items WHERE id = $1', [legacyFlatId]);
    assert.equal(legacyAfter.rows[0].active, false);

    // Re-running with the same Square ids must be idempotent: same parent, same variation rows, no duplicates.
    var result2 = await restaurantSquareImport.upsertGroupedMenuItem(company, fakeItem, [variationA, variationB], {});
    assert.equal(result2.menuItemId, result.menuItemId);
    assert.equal(result2.variationRowIdByExternalId[variationA.id], result.variationRowIdByExternalId[variationA.id]);
    assert.equal(result2.variationRowIdByExternalId[variationB.id], result.variationRowIdByExternalId[variationB.id]);
    var variationCount = await pool.query('SELECT count(*) AS n FROM restaurant_menu_item_variations WHERE menu_item_id = $1', [result.menuItemId]);
    assert.equal(Number(variationCount.rows[0].n), 2);

    await pool.query('DELETE FROM restaurant_menu_item_variations WHERE menu_item_id = $1', [result.menuItemId]);
    await pool.query('DELETE FROM restaurant_menu_items WHERE id = $1', [result.menuItemId]);
  } finally {
    await pool.query('DELETE FROM restaurant_menu_items WHERE id = $1', [legacyFlatId]);
  }
});
