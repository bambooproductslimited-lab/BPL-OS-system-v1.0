// The table's service (migration 0169): courses that wait at the kitchen
// until called, seats and guests, allergens and an order's allergy alert,
// menus by time of day and happy hours, tickets printed for a station
// without a screen — and the back office's reports over the sales brought
// in from Square. Fake Zqy data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var kitchen = require('../src/services/restaurantKitchen.service');
var tables = require('../src/services/restaurantTableOrders.service');
var times = require('../src/services/restaurantTillTimes.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7561', kojo: '7562', yaw: '7563' };
var IP = '10.9.8.1';
var company, people = {}, tok = {}, soup, stew, cake, juice, eggs, t1, t2, t3, grill, bar;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQY'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_table_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_refund_items WHERE refund_id IN (SELECT id FROM restaurant_refunds WHERE company_id = ANY($1))', 'DELETE FROM restaurant_refunds WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_payments WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_stock_moves WHERE company_id = ANY($1)', 'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_tables WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) {
      try { await pool.query(q, [cos]); } catch (e) { if (e.code !== '42P01') throw e; }
    }
  }
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQY-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqy', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
async function settings(s) { await access.saveSettings(tok.kojo, { settings: s }, IP); }
async function dish(name, category, price) {
  return (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, $2, $3, $4, true) RETURNING id', [company.id, name, category, price])).rows[0].id;
}
function cash(total) { return [{ method: 'cash', currency: 'GHS', tendered: total }]; }
function hhmm(d) { return d.toISOString().slice(11, 16); }
function around(minutes) { return { from: hhmm(new Date(Date.now() - 60 * 60000)), to: hhmm(new Date(Date.now() + minutes * 60000)) }; }
function later() { return { from: hhmm(new Date(Date.now() + 120 * 60000)), to: hhmm(new Date(Date.now() + 180 * 60000)) }; }
async function ticketsOf(tabId) {
  return (await pool.query('SELECT t.*, (SELECT json_agg(json_build_object(\'name\', i.name, \'qty\', i.qty, \'seat\', i.seat, \'course\', i.course, \'allergens\', i.allergens, \'status\', i.status) ORDER BY i.name, i.seat) FROM restaurant_kitchen_items i WHERE i.ticket_id = t.id) AS items ' +
    'FROM restaurant_kitchen_tickets t WHERE t.tab_id = $1 OR t.order_id = $1 ORDER BY t.course, t.created_at', [tabId])).rows;
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQY', 'Zqy Grill') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQYF', 'Zqy Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQY-1', 'Ama', dept);
  await person('kojo', 'ZQY-2', 'Kojo', dept);
  await person('yaw', 'ZQY-3', 'Yaw', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'waiter')", [company.id, people.kojo, people.yaw]);
  soup = await dish('Zqy pepper soup', 'Zqy Starters', 30);
  stew = await dish('Zqy groundnut stew', 'Zqy Mains', 60);
  cake = await dish('Zqy cake', 'Zqy Desserts', 25);
  juice = await dish('Zqy sobolo', 'Zqy Drinks', 15);
  eggs = await dish('Zqy egg stew', 'Zqy Breakfast', 40);
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name, qr_token) VALUES ($1, 'Zqy T1', 'zqyqrtable0001') RETURNING id", [company.id])).rows[0].id;
  t2 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqy T2') RETURNING id", [company.id])).rows[0].id;
  t3 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqy T3') RETURNING id", [company.id])).rows[0].id;
  grill = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zqy Kitchen', '{}', true) RETURNING id", [company.id])).rows[0].id;
  bar = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else, print_tickets) VALUES ($1, 'Zqy Bar', '{\"Zqy Drinks\"}', false, true) RETURNING id", [company.id])).rows[0].id;
  for (var k of ['ama', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the clock: windows past midnight and on some days', function () {
  var at = function (iso) { return new Date(iso); };
  assert.equal(times.isOn({ from: '17:00', to: '19:00' }, at('2026-10-23T18:10:00Z')), true);
  assert.equal(times.isOn({ from: '17:00', to: '19:00' }, at('2026-10-23T19:00:00Z')), false);
  // 22:00–02:00: Friday night counts on Friday, its small hours too.
  assert.equal(times.isOn({ from: '22:00', to: '02:00', days: [5] }, at('2026-10-23T23:30:00Z')), true);
  assert.equal(times.isOn({ from: '22:00', to: '02:00', days: [5] }, at('2026-10-24T01:30:00Z')), true);
  assert.equal(times.isOn({ from: '22:00', to: '02:00', days: [5] }, at('2026-10-25T01:30:00Z')), false);
  assert.equal(times.isOn({ from: '06:00', to: '11:30', days: [1, 2, 3, 4, 5] }, at('2026-10-25T08:00:00Z')), false);
  assert.deepEqual(times.cleanAllergens(['peanuts', 'gluten', 'chocolate', 'peanuts']), ['peanuts', 'gluten']);
});

test('courses: the mains wait at the kitchen until called; paying sends what still waits', async function () {
  await assert.rejects(settings({ courses: { on: true, names: [] } }), /Name at least one course/);
  await settings({ courses: { on: true, names: ['Starters', 'Mains', 'Desserts'], categories: { 'Zqy Starters': 1, 'Zqy Mains': 2, 'Zqy Desserts': 3, 'Zqy Drinks': 0 } } });
  var tab = await pos.saveTab(tok.yaw, { tableId: t1, fulfillment: 'dine_in', guests: 2,
    items: [{ menuItemId: soup, qty: 2 }, { menuItemId: stew, qty: 2 }, { menuItemId: juice, qty: 2 }, { menuItemId: cake, qty: 1, course: 3 }] });
  assert.equal(tab.firedCourse, 1);
  assert.deepEqual(tab.kitchen.held, [2, 3]);
  var tk = await ticketsOf(tab.id);
  assert.deepEqual(tk.map(function (t) { return [t.course, t.status]; }), [[1, 'cooking'], [2, 'held'], [3, 'held']]);
  assert.deepEqual(tk[0].items.map(function (i) { return i.name; }), ['Zqy pepper soup', 'Zqy sobolo']);
  assert.equal(tk[0].number, tk[1].number);
  assert.equal(tk[1].guests, 2);
  // The kitchen sees what is coming, apart from what to cook.
  var board = await kitchen.board(tok.kojo, {});
  assert.ok(board.held.some(function (t) { return t.course === 2 && t.items[0].name === 'Zqy groundnut stew'; }));
  assert.ok(!board.cooking.some(function (t) { return t.course === 2 && t.tableName === 'Zqy T1'; }));
  assert.deepEqual(board.courses, ['Starters', 'Mains', 'Desserts']);
  await assert.rejects(kitchen.serveTicket(tok.kojo, tk[1].id, 'kds'), /waits to be called/);
  // The mains called: cooked now, their time from now.
  var called = await pos.fireCourse(tok.yaw, tab.id, {});
  assert.deepEqual(called.called, ['Mains']);
  assert.equal(called.firedCourse, 2);
  tk = await ticketsOf(tab.id);
  assert.deepEqual(tk.map(function (t) { return [t.course, t.status]; }), [[1, 'cooking'], [2, 'cooking'], [3, 'held']]);
  assert.ok(tk[1].fired_at);
  // Another main after they were called goes at once; the dessert still waits.
  tab = await pos.saveTab(tok.yaw, { id: tab.id, tableId: t1, fulfillment: 'dine_in', items: tab.lines.map(function (l) { return { menuItemId: l.menuItemId, qty: l.qty, course: l.course }; }).concat([{ menuItemId: stew, qty: 1 }]) });
  tk = await ticketsOf(tab.id);
  assert.equal(tk.filter(function (t) { return t.status === 'cooking'; }).length, 3);
  assert.equal(tk.filter(function (t) { return t.status === 'held'; }).length, 1);
  // Paid: the dessert nobody called is cooked now.
  var sale = await pos.createOrder(tok.ama, { tabId: tab.id, tableId: t1, fulfillment: 'dine_in', payments: cash(500),
    items: tab.lines.map(function (l) { return { menuItemId: l.menuItemId, qty: l.qty, course: l.course }; }) });
  assert.equal(sale.guests, 2);
  tk = await ticketsOf(sale.id);
  assert.equal(tk.filter(function (t) { return t.status === 'held'; }).length, 0);
  assert.ok(sale.items.some(function (i) { return i.name === 'Zqy cake' && i.course === 3; }));
  var log = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'till.course'", [company.id])).rows;
  assert.ok(/Called Mains for Zqy T1/.test(log[0].summary));
  // Nothing left to call.
  var t2tab = await pos.saveTab(tok.yaw, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: stew, qty: 1 }] });
  assert.deepEqual(t2tab.kitchen.held || [], []);
  await assert.rejects(pos.fireCourse(tok.yaw, t2tab.id, {}), /Nothing is waiting/);
  await pos.removeTab(tok.kojo, t2tab.id);
  await settings({ courses: { on: false, names: ['Starters', 'Mains', 'Desserts'], categories: {} } });
});

test('seats and guests: each dish for its seat, to the kitchen and the sale; spend per guest', async function () {
  var tab = await pos.saveTab(tok.yaw, { tableId: t2, fulfillment: 'dine_in', guests: 3,
    items: [{ menuItemId: stew, qty: 1, seat: 1 }, { menuItemId: stew, qty: 1, seat: 2 }, { menuItemId: juice, qty: 1, seat: 2 }, { menuItemId: juice, qty: 1, seat: 3 }] });
  assert.equal(tab.guests, 3);
  assert.deepEqual(tab.lines.map(function (l) { return l.seat; }), [1, 2, 2, 3]);
  var tk = await ticketsOf(tab.id);
  assert.deepEqual(tk[0].items.filter(function (i) { return i.name === 'Zqy groundnut stew'; }).map(function (i) { return i.seat; }), [1, 2]);
  // Seat 2 pays for theirs; the rest stays open, with its seats.
  var mine = tab.lines.filter(function (l) { return l.seat === 2; });
  var sale = await pos.createOrder(tok.ama, { tabId: tab.id, keepRest: true, tableId: t2, fulfillment: 'dine_in', payments: cash(200),
    items: mine.map(function (l) { return { menuItemId: l.menuItemId, qty: l.qty, seat: l.seat }; }) });
  assert.deepEqual(sale.items.map(function (i) { return i.seat; }), [2, 2]);
  var rest = (await pos.tabRows(company.id, ' AND t.id = $2', [tab.id]))[0];
  assert.deepEqual(rest.lines.map(function (l) { return l.seat; }), [1, 3]);
  // Seat 1 cannot pay for seat 3's drink as if it were theirs.
  await assert.rejects(pos.createOrder(tok.ama, { tabId: tab.id, keepRest: true, tableId: t2, fulfillment: 'dine_in', payments: cash(200),
    items: [{ menuItemId: juice, qty: 1, seat: 1 }] }), /does not have that many/);
  var last = await pos.createOrder(tok.ama, { tabId: tab.id, tableId: t2, fulfillment: 'dine_in', payments: cash(200), items: rest.lines.map(function (l) { return { menuItemId: l.menuItemId, qty: l.qty, seat: l.seat }; }) });
  assert.equal(last.guests, 3);
  var rep = await access.salesReport(tok.kojo, {}, IP);
  assert.ok(rep.totals.guests >= 3 && rep.totals.perGuest > 0, JSON.stringify(rep.totals));
});

test('allergens: the menu says what a dish has; an allergy alert goes on the ticket and the printed chit', async function () {
  var m = await access.menu(tok.kojo, { action: 'save', item: { id: stew, name: 'Zqy groundnut stew', category: 'Zqy Mains', price: 60, allergens: ['peanuts', 'chocolate', 'celery'] } }, IP);
  assert.deepEqual(m.items.find(function (i) { return i.id === stew; }).allergens, ['peanuts', 'celery']);
  var tiles = await pos.menuForSession(tok.ama);
  assert.deepEqual(tiles.find(function (t) { return t.id === stew; }).allergens, ['peanuts', 'celery']);
  var tab = await pos.saveTab(tok.yaw, { tableId: t3, fulfillment: 'dine_in', allergy: { list: ['peanuts', 'nonsense'], note: 'Zqy seat 2: peanuts' },
    items: [{ menuItemId: stew, qty: 1, seat: 2 }, { menuItemId: juice, qty: 2, seat: 2 }] });
  assert.deepEqual(tab.allergy, { list: ['peanuts'], note: 'Zqy seat 2: peanuts' });
  var tk = await ticketsOf(tab.id);
  assert.deepEqual(tk[0].allergens, ['peanuts']);
  assert.equal(tk[0].allergy, 'Zqy seat 2: peanuts');
  assert.deepEqual(tk[0].items.find(function (i) { return i.name === 'Zqy groundnut stew'; }).allergens, ['peanuts', 'celery']);
  // The bar has no screen: its chit is printed at the till, with the alert.
  assert.equal(tab.chits.length, 1);
  assert.equal(tab.chits[0].station, 'Zqy Bar');
  assert.deepEqual(tab.chits[0].items.map(function (i) { return [i.qty, i.name, i.seat]; }), [[2, 'Zqy sobolo', 2]]);
  assert.deepEqual(tab.chits[0].allergens, ['peanuts']);
  var board = await kitchen.board(tok.kojo, {});
  var mine = board.cooking.find(function (t) { return t.tableName === 'Zqy T3'; });
  assert.equal(mine.allergy, 'Zqy seat 2: peanuts');
  assert.deepEqual(mine.items.find(function (i) { return i.name === 'Zqy groundnut stew'; }).allergens, ['peanuts', 'celery']);
  // A station's printing is turned off in the till's settings.
  var scr = await access.kitchenScreens(tok.kojo, { action: 'stationPrint', id: bar, printTickets: false }, IP);
  assert.equal(scr.stations.find(function (s) { return s.id === bar; }).printTickets, false);
  var more = await pos.saveTab(tok.yaw, { id: tab.id, tableId: t3, fulfillment: 'dine_in', items: [{ menuItemId: stew, qty: 1, seat: 2 }, { menuItemId: juice, qty: 3, seat: 2 }] });
  assert.equal(more.chits.length, 0);
  await access.kitchenScreens(tok.kojo, { action: 'stationPrint', id: bar, printTickets: true }, IP);
  await pos.removeTab(tok.kojo, tab.id);
});

test('the kitchen printer: the till prints what it sends; what reaches the kitchen without it waits for one till to print it', async function () {
  async function waiting() { return (await kitchen.printQueue(tok.ama)).chits; }
  assert.deepEqual(await waiting(), []);
  // Sent from the till: its bar ticket comes back to print, and does not wait.
  var tab = await pos.saveTab(tok.yaw, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: juice, qty: 1 }, { menuItemId: stew, qty: 1 }] });
  assert.equal(tab.chits.length, 1);
  assert.ok(tab.chits[0].ticketId);
  assert.deepEqual(await waiting(), []);
  await pos.removeTab(tok.kojo, tab.id);
  // From a table's QR code, straight to the kitchen: nobody at the till printed it.
  await settings({ qrOrders: { on: true, straightToKitchen: true } });
  var placed = await tables.place('zqyqrtable0001', { items: [{ menuItemId: juice, qty: 2 }, { menuItemId: stew, qty: 1 }] }, '10.9.8.41');
  assert.equal(placed.order.status, 'accepted');
  var w = await waiting();
  assert.equal(w.length, 1);
  assert.equal(w[0].station, 'Zqy Bar');
  assert.equal(w[0].tableName, 'Zqy T1');
  assert.deepEqual(w[0].items.map(function (i) { return [i.qty, i.name]; }), [[2, 'Zqy sobolo']]);
  // One till takes it; another asking at the same time gets nothing.
  await assert.rejects(kitchen.takePrints(tok.ama, { ids: [] }), /Say which tickets/);
  var took = await kitchen.takePrints(tok.ama, { ids: [w[0].ticketId] });
  assert.equal(took.chits.length, 1);
  assert.equal(took.chits[0].station, 'Zqy Bar');
  assert.deepEqual((await kitchen.takePrints(tok.kojo, { ids: [w[0].ticketId] })).chits, []);
  assert.deepEqual(await waiting(), []);
  var log = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'till.kitchenPrinted'", [company.id])).rows;
  assert.equal(log.length, 1);
  assert.ok(/printed at the kitchen printer/.test(log[0].summary));
  // A station that does not print never waits; the next round from the table does.
  var open = (await pool.query('SELECT id FROM restaurant_open_tabs WHERE company_id = $1 AND table_id = $2', [company.id, t1])).rows[0].id;
  await tables.place('zqyqrtable0001', { items: [{ menuItemId: stew, qty: 1 }] }, '10.9.8.41');
  assert.deepEqual(await waiting(), []);
  await settings({ qrOrders: { on: true, straightToKitchen: false } });
  // Accepted on the till: the till prints it as it accepts.
  var asked = await tables.place('zqyqrtable0001', { items: [{ menuItemId: juice, qty: 1 }] }, '10.9.8.41');
  var row = (await pool.query("SELECT id FROM restaurant_table_orders WHERE company_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1", [company.id])).rows[0];
  assert.ok(asked.ref);
  var ok = await tables.accept(tok.yaw, row.id, {});
  assert.equal(ok.chits.length, 1);
  assert.deepEqual(ok.chits[0].items.map(function (i) { return [i.qty, i.name]; }), [[1, 'Zqy sobolo']]);
  assert.deepEqual(await waiting(), []);
  await pos.removeTab(tok.kojo, open);
});

test('menus by time of day and happy hours, on the till and from the table', async function () {
  await assert.rejects(settings({ hours: { categories: { 'Zqy Breakfast': { from: '6am', to: '11:00' } } } }), /HH:MM/);
  await settings({ hours: { categories: { 'Zqy Breakfast': later() } } });
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqy Abena', customerPhone: '0244000001', payments: cash(100), items: [{ menuItemId: eggs, qty: 1 }] }), /is served from/);
  await settings({ hours: { categories: { 'Zqy Breakfast': around(60) } } });
  var ok = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqy Abena', customerPhone: '0244000001', payments: cash(100), items: [{ menuItemId: eggs, qty: 1 }] });
  assert.equal(ok.total, 40);
  // An open order keeps its breakfast after the hours change; no more can be added.
  var tab = await pos.saveTab(tok.yaw, { tableId: t3, fulfillment: 'dine_in', items: [{ menuItemId: eggs, qty: 1 }] });
  await settings({ hours: { categories: { 'Zqy Breakfast': later() } } });
  await pos.saveTab(tok.yaw, { id: tab.id, tableId: t3, fulfillment: 'dine_in', items: [{ menuItemId: eggs, qty: 1 }, { menuItemId: juice, qty: 1 }] });
  await assert.rejects(pos.saveTab(tok.yaw, { id: tab.id, tableId: t3, fulfillment: 'dine_in', items: [{ menuItemId: eggs, qty: 2 }] }), /is served from/);
  await pos.removeTab(tok.kojo, tab.id);
  await settings({ hours: { categories: {} } });

  // A happy hour on the drinks: anyone gives it while it is on.
  var hh = Object.assign({ name: 'Zqy Happy hour', percent: 50, categories: ['Zqy Drinks'] }, around(60));
  await settings({ happyHours: [hh] });
  var s = await access.settingsOf(company.id);
  var id = s.happyHours[0].id;
  var sale = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqy Kofi', customerPhone: '0244000002', payments: cash(100),
    items: [{ menuItemId: juice, qty: 2, discount: { presetId: id } }] });
  assert.equal(sale.total, 15);
  assert.equal(sale.items[0].discountName, 'Zqy Happy hour');
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqy Kofi', customerPhone: '0244000002', payments: cash(100),
    items: [{ menuItemId: stew, qty: 1, discount: { presetId: id } }] }), /is not on Zqy groundnut stew/);
  // From the table's QR code it comes by itself.
  var placed = await tables.place('zqyqrtable0001', { items: [{ menuItemId: juice, qty: 2 }, { menuItemId: stew, qty: 1 }] }, '10.9.8.40');
  var row = (await pool.query('SELECT items FROM restaurant_table_orders WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1', [company.id])).rows[0];
  assert.deepEqual(row.items.map(function (l) { return l.discount ? l.discount.presetId : null; }), [id, null]);
  assert.ok(placed.ref);
  // Over: not given any more.
  await settings({ happyHours: [Object.assign({}, hh, { id: id }, later())] });
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqy Kofi', customerPhone: '0244000002', payments: cash(100),
    items: [{ menuItemId: juice, qty: 1, discount: { presetId: id } }] }), /is not on now/);
  await settings({ happyHours: [] });
});

test('reports: the sales brought in from Square, with the month\'s report in the back office', async function () {
  var cashierId = people.ama;
  var o = (await pool.query(
    "INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, payment_method, status, created_at, source, source_name, external_id) " +
    "VALUES ($1, 'ZQY-SQ1', $2, 120, 120, 'card', 'completed', now() - interval '2 hours', 'square', 'Zqy Bolt Food', $3) RETURNING id", [company.id, cashierId, 'zqy-sq-' + crypto.randomUUID()])).rows[0];
  await pool.query("INSERT INTO restaurant_order_items (order_id, menu_item_id, name, qty, unit_price, line_total, sort_order) VALUES ($1, $2, 'Zqy groundnut stew', 2, 60, 120, 0)", [o.id, stew]);
  var all = await access.salesReport(tok.kojo, {}, IP);
  assert.equal(all.totals.fromSquare.sales, 1);
  assert.equal(all.totals.fromSquare.amount, 120);
  var sq = await access.salesReport(tok.kojo, { source: 'square' }, IP);
  assert.equal(sq.totals.sales, 1);
  assert.equal(sq.rows[0].source, 'square');
  assert.equal(sq.rows[0].sourceName, 'Zqy Bolt Food');
  var till = await access.salesReport(tok.kojo, { source: 'till' }, IP);
  assert.equal(till.totals.sales, all.totals.sales - 1);
  // A year at a time, no more.
  await assert.rejects(access.salesReport(tok.kojo, { from: '2024-01-01', to: '2025-06-01' }, IP), /at most a year/);
  var month = await access.monthlyReport(tok.kojo, {}, IP);
  assert.equal(month.month, new Date().toISOString().slice(0, 7));
  assert.equal(month.square.sales, 1);
  assert.ok(month.totals[month.month].net >= 120);
  assert.ok(month.items.some(function (i) { return i.name === 'Zqy groundnut stew'; }));
  await assert.rejects(access.monthlyReport(tok.ama, {}, IP), /manager/i);
});
