/*
 * Integration test for the restaurant module's Phase 2 POS: PIN-based till
 * login (shared kiosk_pin_hash/rate limiter, verified separately in
 * kiosk.test.js), the resulting session token gating menu reads and order
 * creation, live re-pricing against the menu, and the management-side
 * order list/void. Requires `npm run migrate && npm run seed` first.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var kioskService = require('../src/services/kiosk.service');
var { pool } = require('../src/db/pool');

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

// The demo seed only populates BPL with employees — Star Bar Restaurant/
// Bamboo Garden are real registered companies with real departments (see
// migration 0032) but no seeded staff, so a POS test needs to create its
// own throwaway employee in the target restaurant's first department.
async function makeEmployeeInCompany(adminToken, companyName, email) {
  var companies = await (await fetch(base + '/api/companies', { headers: authed(adminToken) })).json();
  var company = companies.find(function (c) { return c.name === companyName; });
  if (!company || !company.departments.length) throw new Error('No department found in company: ' + companyName);
  var created = await (await fetch(base + '/api/employees', {
    method: 'POST', headers: jsonAuthed(adminToken),
    body: JSON.stringify({
      firstName: 'Test', lastName: 'Cashier', email: email, departmentId: company.departments[0].id,
      positionTitle: 'Cashier', employmentType: 'casual'
    })
  })).json();
  return created.id;
}

test('restaurant POS: PIN login scopes a session to the cashier\'s own company, wrong PIN rejected', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var sbrId = await companyId(admin, 'Star Bar Restaurant');
  var sbrEmpId = await makeEmployeeInCompany(admin, 'Star Bar Restaurant', 'pos-test-1@bplghana.com');

  var ctx = { can: function () { return true; }, user: { id: null }, employee: { id: sbrEmpId } };
  await kioskService.setPin(ctx, sbrEmpId, '7788');

  var wrong = await fetch(base + '/api/pos/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0000' })
  });
  assert.equal(wrong.status, 400);

  var right = await fetch(base + '/api/pos/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '7788' })
  });
  assert.equal(right.status, 200);
  var session = await right.json();
  assert.equal(session.companyId, sbrId);
  assert.ok(session.token);

  var noAuthMenu = await fetch(base + '/api/pos/menu');
  assert.equal(noAuthMenu.status, 401);

  var menu = await fetch(base + '/api/pos/menu', { headers: authed(session.token) });
  assert.equal(menu.status, 200);

  await fetch(base + '/api/employees/' + sbrEmpId + '/terminate', { method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ reason: 'test cleanup' }) });
  await fetch(base + '/api/employees/purge-terminated', { method: 'POST', headers: authed(admin) });
});

test('restaurant POS: order creation re-prices against the live menu, order number sequential, management list + void', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var isreal = await login('isreal.omozuafo@bplghana.com'); // department_manager
  var sbrId = await companyId(admin, 'Star Bar Restaurant');
  var sbrEmpId = await makeEmployeeInCompany(admin, 'Star Bar Restaurant', 'pos-test-2@bplghana.com');

  var menuItem = await (await fetch(base + '/api/restaurant/menu-items', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ companyId: sbrId, name: 'Test Jollof', category: 'Mains', price: 45 })
  })).json();

  var ctx = { can: function () { return true; }, user: { id: null }, employee: { id: sbrEmpId } };
  await kioskService.setPin(ctx, sbrEmpId, '7799');
  var session = await (await fetch(base + '/api/pos/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '7799' })
  })).json();

  // A client-supplied price should be ignored — the server re-prices from
  // the live menu item, not whatever the till's cart happened to send.
  var order = await (await fetch(base + '/api/pos/orders', {
    method: 'POST', headers: jsonAuthed(session.token),
    body: JSON.stringify({ items: [{ menuItemId: menuItem.id, qty: 2, unitPrice: 1 }], paymentMethod: 'cash' })
  })).json();
  assert.equal(order.subtotal, 90);
  assert.equal(order.total, 90);
  assert.equal(order.items[0].unitPrice, 45);
  assert.match(order.orderNo, /^SBR-\d{6}$/);

  var badItem = await fetch(base + '/api/pos/orders', {
    method: 'POST', headers: jsonAuthed(session.token),
    body: JSON.stringify({ items: [{ menuItemId: '00000000-0000-0000-0000-000000000000', qty: 1 }] })
  });
  assert.equal(badItem.status, 400);

  var list = await (await fetch(base + '/api/restaurant/orders?companyId=' + sbrId, { headers: authed(admin) })).json();
  assert.ok(list.some(function (o) { return o.id === order.id; }));

  var voided = await fetch(base + '/api/restaurant/orders/' + order.id + '/void', { method: 'POST', headers: authed(isreal) });
  assert.equal(voided.status, 200);
  var listAfter = await (await fetch(base + '/api/restaurant/orders?companyId=' + sbrId, { headers: authed(admin) })).json();
  assert.equal(listAfter.find(function (o) { return o.id === order.id; }).status, 'voided');

  // restaurant_orders.cashier_id has no ON DELETE action (a sale stays
  // attributed to whoever made it even if they later leave) — purging the
  // test employee would hit that FK if their order is still on record, so
  // clean up the order first.
  await pool.query('DELETE FROM restaurant_orders WHERE id = $1', [order.id]);
  await fetch(base + '/api/employees/' + sbrEmpId + '/terminate', { method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ reason: 'test cleanup' }) });
  await fetch(base + '/api/employees/purge-terminated', { method: 'POST', headers: authed(admin) });
  await pool.query('DELETE FROM restaurant_menu_items WHERE id = $1', [menuItem.id]);
});
