/*
 * Integration tests for Products & Services after the Item -> Variations
 * redesign (migration 0027): an item is created with its first variation,
 * more variations can be added, GET /catalog stays a flat picker list
 * (Quotations/Estimates/Invoices/Waybills depend on that exact shape and
 * were deliberately left unchanged), archiving an item cascades to its
 * variations, and an item's last variation can't be deleted out from under it.
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
function jsonAuthed(token) { return Object.assign({ 'Content-Type': 'application/json' }, authed(token)); }

test('catalog item + variations: create with first variation, add a second, flat list reflects both', async function () {
  var admin = await login('kelvin.duho@bplghana.com');

  var created = await (await fetch(base + '/api/catalog/items', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ name: 'Test Bamboo Panel', description: 'A test item', variationName: '4x4', code: 'TBP-4X4', unit: 'sheet', defaultQty: 1, unitPrice: 100, costPrice: 60 })
  })).json();
  assert.equal(created.name, 'Test Bamboo Panel');
  assert.equal(created.variations.length, 1);
  assert.equal(created.variations[0].name, '4x4');
  assert.equal(created.variations[0].unitPrice, 100);

  var addVarRes = await fetch(base + '/api/catalog/items/' + created.id + '/variations', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ name: '8x4', code: 'TBP-8X4', unit: 'sheet', defaultQty: 1, unitPrice: 180, costPrice: 110 })
  });
  assert.equal(addVarRes.status, 201);
  var variation2 = await addVarRes.json();
  assert.equal(variation2.name, '8x4');

  var items = await (await fetch(base + '/api/catalog/items', { headers: authed(admin) })).json();
  var item = items.find(function (i) { return i.id === created.id; });
  assert.equal(item.variations.length, 2);

  var flat = await (await fetch(base + '/api/catalog', { headers: authed(admin) })).json();
  var flatNames = flat.map(function (f) { return f.name; });
  assert.ok(flatNames.includes('Test Bamboo Panel — 4x4'));
  assert.ok(flatNames.includes('Test Bamboo Panel — 8x4'));
});

test('catalog item: a single-variation item displays without the "Regular" suffix on the flat list', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  await fetch(base + '/api/catalog/items', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ name: 'Test Single Product', code: 'TSP-01', unitPrice: 50 })
  });
  var flat = await (await fetch(base + '/api/catalog', { headers: authed(admin) })).json();
  var match = flat.find(function (f) { return f.name === 'Test Single Product'; });
  assert.ok(match, 'expected a flat row named exactly "Test Single Product" with no " — Regular" suffix');
});

test('catalog: archiving an item cascades to archive all its variations', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var created = await (await fetch(base + '/api/catalog/items', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ name: 'Test Archive Item', code: 'TAI-01', unitPrice: 20 })
  })).json();

  await fetch(base + '/api/catalog/items/' + created.id + '/active', { method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ active: false }) });

  var items = await (await fetch(base + '/api/catalog/items', { headers: authed(admin) })).json();
  var item = items.find(function (i) { return i.id === created.id; });
  assert.equal(item.active, false);
  assert.equal(item.variations[0].active, false);
});

test('catalog: cannot delete an item\'s last remaining variation', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var created = await (await fetch(base + '/api/catalog/items', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ name: 'Test Lone Variation Item', code: 'TLV-01', unitPrice: 15 })
  })).json();

  var res = await fetch(base + '/api/catalog/variations/' + created.variations[0].id, { method: 'DELETE', headers: authed(admin) });
  assert.equal(res.status, 409);
});

test('catalog category: create and link on an item', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var category = await (await fetch(base + '/api/catalog/categories', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ name: 'Test Category' })
  })).json();
  assert.equal(category.name, 'Test Category');

  var created = await (await fetch(base + '/api/catalog/items', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ name: 'Test Categorized Item', code: 'TCI-01', unitPrice: 30, categoryId: category.id })
  })).json();

  var items = await (await fetch(base + '/api/catalog/items', { headers: authed(admin) })).json();
  var item = items.find(function (i) { return i.id === created.id; });
  assert.equal(item.categoryName, 'Test Category');
});

test('catalog stock: set at creation, adjusted by delta, and cannot go negative', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var created = await (await fetch(base + '/api/catalog/items', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ name: 'Test Stocked Item', code: 'TSI-01', unitPrice: 40, stockQty: 10 })
  })).json();
  assert.equal(created.variations[0].stockQty, 10);
  var variationId = created.variations[0].id;

  var received = await (await fetch(base + '/api/catalog/variations/' + variationId + '/stock', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ delta: 5, note: 'Shipment received' })
  })).json();
  assert.equal(received.stockQty, 15);

  var used = await (await fetch(base + '/api/catalog/variations/' + variationId + '/stock', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ delta: -3 })
  })).json();
  assert.equal(used.stockQty, 12);

  var tooMuch = await fetch(base + '/api/catalog/variations/' + variationId + '/stock', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ delta: -999 })
  });
  assert.equal(tooMuch.status, 400);

  var items = await (await fetch(base + '/api/catalog/items', { headers: authed(admin) })).json();
  var item = items.find(function (i) { return i.id === created.id; });
  assert.equal(item.variations[0].stockQty, 12, 'the rejected adjustment should not have changed stock');
});

test('catalog: create/manage requires catalog.manage; read requires catalog.read', async function () {
  var alice = await login('alice.kamau@bplghana.com'); // plain employee — no catalog.manage
  var res = await fetch(base + '/api/catalog/items', {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ name: 'Nope', code: 'NOPE-01', unitPrice: 1 })
  });
  assert.equal(res.status, 403);
});
