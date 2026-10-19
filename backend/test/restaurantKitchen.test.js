// The kitchen display (restaurantKitchen.service.js, migration 0152): the
// till sends an open table's new round and a charged sale to the kitchen,
// each dish to the station that cooks its category; what is taken off
// after it was sent is cancelled; the screen marks dishes done, a ticket
// with every dish done is ready, then served, and can be called back; the
// till sees what is ready; removing an open table or voiding a sale cancels
// what was not served. A restaurant with no stations sends nothing. Test
// data uses the ZQK company code.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var kitchen = require('../src/services/restaurantKitchen.service');
var pinAuth = require('../src/lib/pinAuth');
var { buildContext } = require('../src/services/context.service');

var PIN = '7461', OTHER_PIN = '7462';
var company, other, cashier, waiter, table, table2, fish, rice, beer, water, token, otherToken, admin, staff, grill, bar;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code IN ('ZQK', 'ZQL')")).rows.map(function (r) { return r.id; });
  if (!cos.length) return;
  await pool.query('DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))', [cos]);
  await pool.query('DELETE FROM restaurant_orders WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))', [cos]);
  await pool.query('DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM restaurant_menu_item_variations WHERE menu_item_id IN (SELECT id FROM restaurant_menu_items WHERE company_id = ANY($1))', [cos]);
  await pool.query('DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM restaurant_tables WHERE company_id = ANY($1)', [cos]);
  await pool.query("DELETE FROM audit_logs WHERE action LIKE 'restaurant.kds.%' AND summary LIKE '%Zqk%'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQK-%'");
  await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
}
async function person(code, first, dept, pin) {
  return (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqk', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pin ? pinAuth.hashPin(pin) : null])).rows[0].id;
}
async function dish(name, category, price) {
  return (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, $2, $3, $4, true) RETURNING id', [company.id, name, category, price])).rows[0].id;
}
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function names(t) { return t.items.map(function (i) { return [i.name, i.qty, i.status]; }); }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [[pinAuth.hashPin(PIN), pinAuth.hashPin(OTHER_PIN)]]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQK', 'Zqk Kitchen House') RETURNING *")).rows[0];
  other = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQL', 'Zql Cafe') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQKF', 'Zqk Floor', $1) RETURNING id", [company.id])).rows[0].id;
  var dept2 = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQLF', 'Zql Floor', $1) RETURNING id", [other.id])).rows[0].id;
  cashier = await person('ZQK-1', 'Ama', dept, PIN);
  waiter = await person('ZQK-2', 'Yaw', dept);
  await person('ZQK-3', 'Esi', dept2, OTHER_PIN);
  table = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqk T5') RETURNING id", [company.id])).rows[0].id;
  table2 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqk T6') RETURNING id", [company.id])).rows[0].id;
  fish = await dish('Zqk grilled fish', 'Zqk Grill', 120);
  rice = await dish('Zqk fried rice', 'Zqk Wok', 60);
  beer = await dish('Zqk lager', 'Zqk Bar', 20);
  water = await dish('Zqk water', 'Zqk Shop', 5);
  token = (await pos.login(PIN, '10.9.8.1')).token;
  otherToken = (await pos.login(OTHER_PIN, '10.9.8.2')).token;
  admin = await ctxFor('kelvin.duho@bplghana.com');
  staff = await ctxFor('alice.kamau@bplghana.com');
});
test.after(async function () { await cleanup(); await pool.end(); });

test('no stations, nothing sent: the kitchen display is off', async function () {
  await pos.openDrawerSession(token, 0);
  var o = await pos.createOrder(token, { items: [{ menuItemId: fish, qty: 1 }], paymentMethod: 'mobile_money' });
  assert.equal(o.kitchenTicket, null);
  assert.deepEqual(await kitchen.tillSummary(token), { inUse: false, cooking: 0, ready: [] });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM restaurant_kitchen_tickets WHERE company_id = $1', [company.id])).rows[0].n, 0);
});

test('stations are set up from the menu\'s categories, one station to a category', async function () {
  await assert.rejects(kitchen.createStation(staff, { companyId: company.id, name: 'Zqk Grill station' }), /restaurant.manage/);
  grill = await kitchen.createStation(admin, { companyId: company.id, name: 'Zqk Kitchen', categories: ['Zqk Grill', ' zqk grill ', 'Zqk Wok'], everythingElse: true });
  assert.deepEqual(grill.categories, ['Zqk Grill', 'Zqk Wok'], 'each category once, as first given');
  bar = await kitchen.createStation(admin, { companyId: company.id, name: 'Zqk Bar', categories: ['Zqk Bar'] });
  await assert.rejects(kitchen.createStation(admin, { companyId: company.id, name: 'Zqk Wok station', categories: ['ZQK WOK'] }), /already cooked at Zqk Kitchen/);
  await assert.rejects(kitchen.createStation(admin, { companyId: company.id, name: 'zqk bar' }), /already has a station/);
  // The bar takes everything else from now on (only one station can).
  bar = await kitchen.updateStation(admin, bar.id, { everythingElse: true });
  var ov = await kitchen.kitchenOverview(admin, company.id);
  assert.equal(ov.inUse, true);
  assert.deepEqual(ov.stations.map(function (s) { return [s.name, s.everythingElse]; }), [['Zqk Kitchen', false], ['Zqk Bar', true]]);
  assert.deepEqual(ov.categories.map(function (c) { return [c.name, c.stationName]; }), [['Zqk Bar', 'Zqk Bar'], ['Zqk Grill', 'Zqk Kitchen'], ['Zqk Shop', 'Zqk Bar'], ['Zqk Wok', 'Zqk Kitchen']]);
  // Nothing takes the shop's water once the bar stops taking everything else.
  bar = await kitchen.updateStation(admin, bar.id, { everythingElse: false });
  assert.equal((await kitchen.kitchenOverview(admin, company.id)).categories.find(function (c) { return c.name === 'Zqk Shop'; }).stationName, null);
});

test('an open table: each round goes as a ticket, dishes to their stations; taken off is cancelled', async function () {
  var tab = await pos.saveTab(token, { tableId: table, waiterId: waiter, kitchenNote: 'Zqk no pepper', items: [{ menuItemId: fish, qty: 2 }, { menuItemId: beer, qty: 3 }, { menuItemId: water, qty: 1 }] });
  assert.equal(tab.kitchenTicket.number, 1);
  var all = await kitchen.board(token, { station: 'all' });
  assert.equal(all.cooking.length, 1);
  var t1 = all.cooking[0];
  assert.deepEqual([t1.number, t1.tableName, t1.waiterName, t1.note, t1.label], [1, 'Zqk T5', 'Yaw Zqk', 'Zqk no pepper', 'Zqk T5']);
  assert.deepEqual(names(t1), [['Zqk grilled fish', 2, 'cooking'], ['Zqk lager', 3, 'cooking']], 'the water goes nowhere');
  var atGrill = await kitchen.board(token, { station: grill.id });
  assert.deepEqual(names(atGrill.cooking[0]), [['Zqk grilled fish', 2, 'cooking']]);
  assert.deepEqual(atGrill.cooking[0].elsewhere, [{ name: 'Zqk lager', qty: 3, stationName: 'Zqk Bar' }], 'what the other stations are making for it');

  // Saved again unchanged: nothing new to send.
  var again = await pos.saveTab(token, { id: tab.id, tableId: table, waiterId: waiter, items: [{ menuItemId: fish, qty: 2 }, { menuItemId: beer, qty: 3 }, { menuItemId: water, qty: 1 }] });
  assert.equal(again.kitchenTicket, null);
  // A second round: one more beer and a rice; one fish taken off.
  var round2 = await pos.saveTab(token, { id: tab.id, tableId: table, waiterId: waiter, items: [{ menuItemId: fish, qty: 1 }, { menuItemId: beer, qty: 4 }, { menuItemId: rice, qty: 1 }, { menuItemId: water, qty: 1 }] });
  assert.equal(round2.kitchenTicket.number, 2);
  all = await kitchen.board(token, { station: 'all' });
  assert.deepEqual(all.cooking.map(function (t) { return t.number; }), [1, 2]);
  assert.deepEqual(names(all.cooking[0]), [['Zqk grilled fish', 1, 'cooking'], ['Zqk lager', 3, 'cooking'], ['Zqk grilled fish', 1, 'cancelled']]);
  assert.deepEqual(names(all.cooking[1]), [['Zqk lager', 1, 'cooking'], ['Zqk fried rice', 1, 'cooking']]);
  assert.equal((await kitchen.board(otherToken, { station: 'all' })).cooking.length, 0, 'another restaurant never sees it');
  await assert.rejects(kitchen.board(token, { station: '00000000-0000-0000-0000-000000000000' }), /not set up/);
});

test('the screen: dishes done, a ticket ready when all are, served, called back; the till sees it ready', async function () {
  var all = await kitchen.board(token, { station: 'all' });
  var t1 = all.cooking[0];
  var fishLine = t1.items.find(function (i) { return i.name === 'Zqk grilled fish' && i.status === 'cooking'; });
  await assert.rejects(kitchen.setItemDone(token, t1.items.find(function (i) { return i.status === 'cancelled'; }).id, true), /taken off/);
  await assert.rejects(kitchen.setItemDone(otherToken, fishLine.id, true), /no longer on the screen/);
  assert.equal((await kitchen.setItemDone(token, fishLine.id, true)).status, 'cooking', 'the beer is still to come');
  // The bar finishes its part of #1: the ticket is ready.
  assert.equal((await kitchen.finishTicket(token, t1.id, bar.id)).status, 'ready');
  var atGrill = await kitchen.board(token, { station: grill.id });
  assert.deepEqual(atGrill.cooking.map(function (t) { return t.number; }), [2]);
  assert.deepEqual(atGrill.ready.map(function (t) { return t.number; }), [1]);
  var till = await kitchen.tillSummary(token);
  assert.deepEqual([till.inUse, till.cooking, till.ready.map(function (r) { return [r.number, r.tableName, r.dishes]; })], [true, 1, [[1, 'Zqk T5', 4]]]);

  await assert.rejects(kitchen.serveTicket(token, all.cooking[1].id), /still cooking/);
  assert.equal((await kitchen.serveTicket(token, t1.id)).status, 'served');
  all = await kitchen.board(token, { station: 'all' });
  assert.deepEqual([all.cooking.length, all.ready.length, all.recent.map(function (t) { return t.number; })], [1, 0, [1]]);
  await assert.rejects(kitchen.setItemDone(token, fishLine.id, false), /Call it back/);
  assert.equal((await kitchen.recallTicket(token, t1.id)).status, 'ready');
  await kitchen.setItemDone(token, fishLine.id, false);
  assert.equal((await kitchen.board(token, { station: 'all' })).cooking[0].number, 1, 'back to cooking');
  await kitchen.finishTicket(token, t1.id, 'all');
  await kitchen.serveTicket(token, t1.id);
});

test('paying the table sends what was not sent and links its tickets to the sale', async function () {
  var tab = (await pos.listTabs(token))[0];
  var o = await pos.createOrder(token, { tabId: tab.id, tableId: table, waiterId: waiter, paymentMethod: 'cash', kitchenNote: 'Zqk to go',
    items: [{ menuItemId: fish, qty: 1 }, { menuItemId: beer, qty: 4 }, { menuItemId: rice, qty: 2 }, { menuItemId: water, qty: 1 }] });
  assert.equal(o.kitchenTicket.number, 3);
  var all = await kitchen.board(token, { station: 'all' });
  var t3 = all.cooking.find(function (t) { return t.number === 3; });
  assert.deepEqual([names(t3), t3.note], [[['Zqk fried rice', 1, 'cooking']], 'Zqk to go']);
  var linked = (await pool.query('SELECT number FROM restaurant_kitchen_tickets WHERE order_id = $1 ORDER BY number', [o.id])).rows.map(function (r) { return r.number; });
  assert.deepEqual(linked, [1, 2, 3]);
  // A counter sale goes whole, under its order number.
  var counter = await pos.createOrder(token, { items: [{ menuItemId: rice, qty: 1 }, { menuItemId: water, qty: 2 }], paymentMethod: 'cash' });
  var t4 = (await kitchen.board(token, { station: 'all' })).cooking.find(function (t) { return t.number === 4; });
  assert.deepEqual([t4.label, names(t4)], [counter.orderNo, [['Zqk fried rice', 1, 'cooking']]]);
  // Voided: what was not served is cancelled, and shown until cleared.
  await pos.voidOrder(admin, counter.id);
  t4 = (await kitchen.board(token, { station: 'all' })).cooking.find(function (t) { return t.number === 4; });
  assert.deepEqual([t4.status, names(t4)], ['cancelled', [['Zqk fried rice', 1, 'cancelled']]]);
  assert.equal((await kitchen.serveTicket(token, t4.id)).status, 'cancelled');
  assert.ok(!(await kitchen.board(token, { station: 'all' })).cooking.some(function (t) { return t.number === 4; }), 'cleared off the screen');
});

test('an open table removed: what the kitchen has not served is cancelled', async function () {
  var tab = await pos.saveTab(token, { tableId: table2, items: [{ menuItemId: fish, qty: 1 }, { menuItemId: beer, qty: 1 }] });
  var number = tab.kitchenTicket.number;
  await pos.removeTab(token, tab.id);
  var t = (await kitchen.board(token, { station: 'all' })).cooking.find(function (x) { return x.number === number; });
  assert.deepEqual([t.status, names(t).map(function (n) { return n[2]; })], ['cancelled', ['cancelled', 'cancelled']]);
  var till = await kitchen.tillSummary(token);
  assert.ok(!till.ready.some(function (r) { return r.number === number; }));
});

test('today in the kitchen, for the Restaurants page; stations changed and removed', async function () {
  await assert.rejects(kitchen.kitchenOverview({ can: function () { return false; } }, company.id), /restaurant.read/);
  var ov = await kitchen.kitchenOverview(admin, company.id);
  assert.equal(ov.today.tickets, 5);
  assert.equal(ov.today.cancelled, 2);
  assert.ok(ov.today.averageMinutes !== null && ov.today.averageMinutes >= 0);
  var g = ov.today.byStation.find(function (s) { return s.id === grill.id; });
  assert.ok(g.dishes >= 3);
  assert.deepEqual(ov.tickets.map(function (t) { return t.number; }), [5, 4, 3, 2, 1], 'newest first');
  await assert.rejects(kitchen.updateStation(admin, bar.id, { categories: ['Zqk Grill'] }), /already cooked at Zqk Kitchen/);
  await kitchen.updateStation(admin, grill.id, { active: false });
  await kitchen.updateStation(admin, bar.id, { categories: ['Zqk Bar', 'Zqk Grill'] });
  await assert.rejects(kitchen.updateStation(admin, grill.id, { active: true }), /already cooked at Zqk Bar/, 'turned back on, it cannot take a category another station now cooks');
  await kitchen.removeStation(admin, grill.id);
  await kitchen.removeStation(admin, bar.id);
  assert.equal((await kitchen.kitchenOverview(admin, company.id)).inUse, false);
  assert.equal((await kitchen.tillSummary(token)).inUse, false);
});
