/*
 * Integration test for the restaurant module's Phase 1 inventory: menu
 * items, supplies, and food ingredients, each scoped to a company (Star
 * Bar Restaurant / Bamboo Garden). Requires `npm run migrate && npm run
 * seed` first, same as the other test files.
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

async function companyId(adminToken, name) {
  var companies = await (await fetch(base + '/api/companies', { headers: authed(adminToken) })).json();
  var found = companies.find(function (c) { return c.name === name; });
  if (!found) throw new Error('Company not found: ' + name);
  return found.id;
}

test('restaurant menu items: permission-gated, company-scoped, active toggle', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var isreal = await login('isreal.omozuafo@bplghana.com'); // department_manager
  var alice = await login('alice.kamau@bplghana.com'); // employee — no restaurant.manage

  var sbrId = await companyId(admin, 'Star Bar Restaurant');
  var bgnId = await companyId(admin, 'Bamboo Garden');

  var denied = await fetch(base + '/api/restaurant/menu-items', {
    method: 'POST', headers: jsonAuthed(alice),
    body: JSON.stringify({ companyId: sbrId, name: 'Jollof Rice', category: 'Mains', price: 45 })
  });
  assert.equal(denied.status, 403);

  var created = await fetch(base + '/api/restaurant/menu-items', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ companyId: sbrId, name: 'Jollof Rice', category: 'Mains', price: 45 })
  });
  assert.equal(created.status, 201);
  var item = await created.json();
  assert.equal(item.companyId, sbrId);
  assert.equal(item.price, 45);
  assert.equal(item.active, true);

  await fetch(base + '/api/restaurant/menu-items', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ companyId: bgnId, name: 'Grilled Tilapia', category: 'Mains', price: 60 })
  });

  var sbrList = await (await fetch(base + '/api/restaurant/menu-items?companyId=' + sbrId, { headers: authed(admin) })).json();
  assert.ok(sbrList.some(function (m) { return m.name === 'Jollof Rice'; }));
  assert.ok(!sbrList.some(function (m) { return m.name === 'Grilled Tilapia'; }));

  var deactivated = await (await fetch(base + '/api/restaurant/menu-items/' + item.id + '/active', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ active: false })
  })).json();
  assert.equal(deactivated.active, false);
});

test('restaurant supplies: stock adjustment cannot go negative, low-stock flag', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var isreal = await login('isreal.omozuafo@bplghana.com');
  var sbrId = await companyId(admin, 'Star Bar Restaurant');

  var created = await (await fetch(base + '/api/restaurant/supplies', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ companyId: sbrId, name: 'Napkins', category: 'Disposables', unit: 'pack', stockQty: 5, reorderLevel: 10, unitCost: 8 })
  })).json();
  assert.equal(created.stockQty, 5);
  assert.equal(created.lowStock, true);

  var restocked = await (await fetch(base + '/api/restaurant/supplies/' + created.id + '/stock', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ delta: 20, note: 'Weekly delivery' })
  })).json();
  assert.equal(restocked.stockQty, 25);
  assert.equal(restocked.lowStock, false);

  var overdraw = await fetch(base + '/api/restaurant/supplies/' + created.id + '/stock', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ delta: -100 })
  });
  assert.equal(overdraw.status, 400);

  var unchanged = await (await fetch(base + '/api/restaurant/supplies?companyId=' + sbrId, { headers: authed(admin) })).json();
  assert.equal(unchanged.find(function (s) { return s.id === created.id; }).stockQty, 25);
});

test('restaurant ingredients: expiry date tracked, expiringSoon flag, delete', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var isreal = await login('isreal.omozuafo@bplghana.com');
  var bgnId = await companyId(admin, 'Bamboo Garden');

  var soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  var created = await (await fetch(base + '/api/restaurant/ingredients', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ companyId: bgnId, name: 'Fresh Tilapia', unit: 'kg', stockQty: 10, reorderLevel: 3, unitCost: 25, expiryDate: soon })
  })).json();
  assert.equal(created.expiryDate.slice(0, 10), soon);
  assert.equal(created.expiringSoon, true);

  var removed = await fetch(base + '/api/restaurant/ingredients/' + created.id, {
    method: 'DELETE', headers: authed(isreal)
  });
  assert.equal(removed.status, 200);

  var list = await (await fetch(base + '/api/restaurant/ingredients?companyId=' + bgnId, { headers: authed(admin) })).json();
  assert.ok(!list.some(function (i) { return i.id === created.id; }));
});
