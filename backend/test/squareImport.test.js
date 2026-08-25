/*
 * Tests for the one-time Square historical import (squareImport.service.js
 * + routes/square.routes.js's POST /api/square/import). Real Square API
 * calls are never exercised here — SQUARE_ACCESS_TOKEN isn't set in this
 * test environment, so square.service.js refuses before any network call,
 * which is itself the behavior under test for the "not configured" case.
 * The pure mapping/conversion helpers (money, name-building, line-item
 * shaping) are unit-tested directly against representative Square API JSON
 * shapes, since those are the parts most likely to silently miscompute a
 * real financial figure.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var squareImport = require('../src/services/squareImport.service');

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

test('POST /api/square/import is forbidden without settings.manage', async function () {
  var alice = await login('alice.kamau@bplghana.com');
  var res = await fetch(base + '/api/square/import', { method: 'POST', headers: jsonAuthed(alice) });
  assert.equal(res.status, 403);
});

test('POST /api/square/import fails clearly when SQUARE_ACCESS_TOKEN is not set', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var res = await fetch(base + '/api/square/import', { method: 'POST', headers: jsonAuthed(admin) });
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.match(body.error.message, /Square is not configured/);
});

test('minorToMajor divides Square minor-unit integers by 100', function () {
  assert.equal(squareImport.minorToMajor({ amount: 12345, currency: 'USD' }), 123.45);
  assert.equal(squareImport.minorToMajor({ amount: 0, currency: 'USD' }), 0);
  assert.equal(squareImport.minorToMajor(null), 0);
  assert.equal(squareImport.minorToMajor(undefined), 0);
});

test('squareCustomerName prefers company name, then given+family, then email/phone, then a fallback', function () {
  assert.equal(squareImport.squareCustomerName({ company_name: 'Acme Ltd', given_name: 'Jane' }), 'Acme Ltd');
  assert.equal(squareImport.squareCustomerName({ given_name: 'Jane', family_name: 'Doe' }), 'Jane Doe');
  assert.equal(squareImport.squareCustomerName({ given_name: 'Jane' }), 'Jane');
  assert.equal(squareImport.squareCustomerName({ email_address: 'jane@example.com' }), 'jane@example.com');
  assert.equal(squareImport.squareCustomerName({ phone_number: '+233555000111' }), '+233555000111');
  assert.equal(squareImport.squareCustomerName({}), 'Square Customer');
});

test('squareAddressLine joins the present parts with commas and skips missing ones', function () {
  assert.equal(
    squareImport.squareAddressLine({ address_line_1: '12 Spintex Rd', locality: 'Accra', country: 'GH' }),
    '12 Spintex Rd, Accra, GH'
  );
  assert.equal(squareImport.squareAddressLine(null), '');
  assert.equal(squareImport.squareAddressLine({}), '');
});

test('mapPaymentMethod maps Square source_type onto the payments table CHECK constraint values', function () {
  assert.equal(squareImport.mapPaymentMethod('CARD'), 'card');
  assert.equal(squareImport.mapPaymentMethod('CASH'), 'cash');
  assert.equal(squareImport.mapPaymentMethod('WALLET'), 'mobile_money');
  assert.equal(squareImport.mapPaymentMethod('SQUARE_ACCOUNT'), 'mobile_money');
  assert.equal(squareImport.mapPaymentMethod('BANK_ACCOUNT'), 'bank_transfer');
  assert.equal(squareImport.mapPaymentMethod('SOMETHING_UNKNOWN'), 'bank_transfer');
});

test('buildOrderLineItems maps real Square order line items, falling back to a single summary line when the order has none', function () {
  var withItems = squareImport.buildOrderLineItems({
    line_items: [
      { name: 'Bamboo Cutting Board', quantity: '2', base_price_money: { amount: 5000, currency: 'USD' }, total_money: { amount: 10000, currency: 'USD' }, catalog_object_id: 'VAR1' },
      { name: 'Custom item', quantity: '1', total_money: { amount: 2500, currency: 'USD' } }
    ]
  }, { VAR1: { id: 'row-1', code: 'BCB-001' } });

  assert.equal(withItems.length, 2);
  assert.deepEqual(withItems[0], { itemNo: 'BCB-001', description: 'Bamboo Cutting Board', qty: 2, unit: 'each', unitPrice: 50, discount: 0, discountType: 'fixed', taxRate: 0 });
  assert.equal(withItems[1].unitPrice, 25); // no base_price_money -> derived from total_money / qty

  var noItems = squareImport.buildOrderLineItems({ total_money: { amount: 99900, currency: 'USD' }, line_items: [] }, {});
  assert.equal(noItems.length, 1);
  assert.equal(noItems[0].description, 'Square order total');
  assert.equal(noItems[0].unitPrice, 999);
});
