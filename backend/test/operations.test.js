/*
 * Integration test for the Operations modules (warehouses, suppliers, raw
 * batches, products, production, procurement, assets, maintenance).
 * Requires `npm run migrate && npm run seed` first.
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

test('seeded operations data is reachable: warehouses, suppliers, raw batches, products', async function () {
  var isreal = await login('isreal.omozuafo@bplghana.com');
  var warehouses = await (await fetch(base + '/api/warehouses', { headers: authed(isreal) })).json();
  assert.equal(warehouses.length, 3);
  var suppliers = await (await fetch(base + '/api/suppliers', { headers: authed(isreal) })).json();
  assert.equal(suppliers.length, 3);
  var rawBatches = await (await fetch(base + '/api/raw-batches', { headers: authed(isreal) })).json();
  assert.equal(rawBatches.length, 3);
  var products = await (await fetch(base + '/api/products', { headers: authed(isreal) })).json();
  assert.equal(products.length, 4);
});

test('production.create consumes raw stock, adds product stock, blocks over-consumption', async function () {
  var isreal = await login('isreal.omozuafo@bplghana.com');

  var rawBatches = await (await fetch(base + '/api/raw-batches', { headers: authed(isreal) })).json();
  var rb = rawBatches.find(function (r) { return r.batchNo === 'RB-2026-042'; });
  var products = await (await fetch(base + '/api/products', { headers: authed(isreal) })).json();
  var prod = products.find(function (p) { return p.sku === 'BPL-PNL-020'; });
  var startingStock = prod.currentStock;

  var res = await fetch(base + '/api/production', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ rawBatchId: rb.id, outputProductId: prod.id, productionLine: 'Treatment Line', inputQty: 200, outputQty: 15, wasteQty: 30, rejectedQty: 5 })
  });
  assert.equal(res.status, 201);
  var batch = await res.json();
  assert.equal(batch.efficiency, Math.round((15 / 200) * 100));

  var rawAfter = await (await fetch(base + '/api/raw-batches', { headers: authed(isreal) })).json();
  assert.equal(rawAfter.find(function (r) { return r.id === rb.id; }).quantity, rb.quantity - 200);

  var prodAfter = await (await fetch(base + '/api/products', { headers: authed(isreal) })).json();
  assert.equal(prodAfter.find(function (p) { return p.id === prod.id; }).currentStock, startingStock + 15);

  var overConsume = await fetch(base + '/api/production', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ rawBatchId: rb.id, outputProductId: prod.id, productionLine: 'X', inputQty: 999999, outputQty: 1 })
  });
  assert.equal(overConsume.status, 400);
});

test('procurement: request visible to requester, approval chain, cannot re-decide', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var isreal = await login('isreal.omozuafo@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var createRes = await fetch(base + '/api/procurement', {
    method: 'POST', headers: jsonAuthed(alice),
    body: JSON.stringify({ item: 'Test safety gloves', quantity: 5, estimatedPrice: 200, reason: 'Test run' })
  });
  assert.equal(createRes.status, 201);
  var request = await createRes.json();

  var aliceList = await (await fetch(base + '/api/procurement', { headers: authed(alice) })).json();
  assert.ok(aliceList.some(function (r) { return r.id === request.id; }));

  var decideRes = await fetch(base + '/api/procurement/' + request.id + '/decision', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(decideRes.status, 200);
  assert.equal((await decideRes.json()).status, 'approved');

  var decideAgain = await fetch(base + '/api/procurement/' + request.id + '/decision', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(decideAgain.status, 409);
});

test('assets + maintenance: create, list, service date update', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var denied = await fetch(base + '/api/assets', { method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ category: 'x', description: 'y' }) });
  assert.equal(denied.status, 403);

  var assetRes = await fetch(base + '/api/assets', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ category: 'Computer', description: 'Test laptop', purchasePrice: 8000 })
  });
  assert.equal(assetRes.status, 201);
  var asset = await assetRes.json();

  var maintRes = await fetch(base + '/api/maintenance', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ assetId: asset.id, technician: 'IT Support', cost: 300, faultReport: 'Battery replacement', downtimeHours: 1, nextServiceDate: '2027-01-01' })
  });
  assert.equal(maintRes.status, 201);

  var list = await (await fetch(base + '/api/maintenance', { headers: authed(admin) })).json();
  assert.ok(list.some(function (m) { return m.assetId === asset.id; }));
});
