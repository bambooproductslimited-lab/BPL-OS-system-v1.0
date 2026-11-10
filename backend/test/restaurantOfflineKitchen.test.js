// Orders taken while the till had no internet (pages/till/tillOffline.js)
// reach the server when it is back. The kitchen had them then — by word of
// mouth, on a ticket the till printed, or through the print hub — so their
// kitchen tickets are kept for the record already served: not printed
// again, not on the kitchen screens, no alert to the cashier, courses still
// waiting not cooked again (restaurantKitchen fire offlineAt, migration
// 0215). What is sent after the internet is back goes as before. Fake Zpo
// data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var kitchen = require('../src/services/restaurantKitchen.service');
var printers = require('../src/services/restaurantPrinters.service');
var tables = require('../src/services/restaurantTableOrders.service');
var access = require('../src/services/restaurantTillAccess.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7751', kojo: '7752', yaw: '7753' };
var IP = '10.9.6.1';
var company, people = {}, tok = {}, menu = {}, table, printerId;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZPO'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_print_jobs WHERE company_id = ANY($1)', 'DELETE FROM restaurant_printers WHERE company_id = ANY($1)', 'DELETE FROM restaurant_print_links WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
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
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZPO-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zpo', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
async function dish(name, category) {
  menu[name] = (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, $2, $3, 40, true) RETURNING id', [company.id, name, category])).rows[0].id;
}
function minutesAgo(n) { return new Date(Date.now() - n * 60000).toISOString(); }
async function ticketsOf(where, arg) {
  var rows = (await pool.query('SELECT * FROM restaurant_kitchen_tickets WHERE ' + where + ' = $1 ORDER BY created_at, course', [arg])).rows;
  for (var r of rows) r.items = (await pool.query('SELECT name, qty, status, done_at FROM restaurant_kitchen_items WHERE ticket_id = $1 ORDER BY name', [r.id])).rows;
  return rows;
}
async function kitchenJobs() {
  return (await pool.query("SELECT doc FROM restaurant_print_jobs WHERE printer_id = $1 AND kind = 'kitchen' AND status <> 'printed' ORDER BY created_at", [printerId])).rows
    .map(function (r) { return r.doc.pages[0].map(function (l) { return l.text || ''; }).join('\n'); });
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZPO', 'Zpo Outage Grill') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZPOF', 'Zpo Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZPO-1', 'Ama', dept);
  await person('kojo', 'ZPO-2', 'Kojo', dept);
  await person('yaw', 'ZPO-3', 'Yaw', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'waiter')", [company.id, people.kojo, people.yaw]);
  await dish('Zpo pepper soup', 'Zpo Starters');
  await dish('Zpo groundnut stew', 'Zpo Mains');
  await dish('Zpo sobolo', 'Zpo Drinks');
  table = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zpo T1') RETURNING id", [company.id])).rows[0].id;
  var station = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zpo Kitchen', '{}', true) RETURNING id", [company.id])).rows[0].id;
  for (var k of ['ama', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
  // The kitchen's printer, on the network (CloudPRNT), printing the kitchen's tickets.
  var link = await printers.linkOf(company.id);
  await printers.poll(link, { printerMAC: '00:11:62:cc:00:01', statusCode: '200%20OK' }, '10.9.6.20');
  printerId = (await pool.query('SELECT id FROM restaurant_printers WHERE company_id = $1', [company.id])).rows[0].id;
  await printers.manage(tok.kojo, { action: 'save', id: printerId, name: 'Zpo Kitchen printer', stationIds: [station] }, IP, 'http://zpo.example.test');
});
test.after(async function () { await cleanup(); await pool.end(); });

test('an open order taken with no internet: kept served, not printed, not on the screens, no alert; the next round goes as before', async function () {
  var at = minutesAgo(25);
  var tab = await pos.saveTab(tok.yaw, { clientRef: 'zpooffline0001', offlineAt: at, tableId: table, waiterId: people.yaw, fulfillment: 'dine_in',
    items: [{ menuItemId: menu['Zpo pepper soup'], qty: 2 }, { menuItemId: menu['Zpo groundnut stew'], qty: 1 }] });
  var tk = await ticketsOf('tab_id', tab.id);
  assert.equal(tk.length, 1);
  assert.equal(tk[0].status, 'served');
  assert.ok(tk[0].served_at && tk[0].offline_at, 'served, with when it was taken');
  assert.ok(Math.abs(new Date(tk[0].offline_at) - new Date(at)) < 2000);
  assert.deepEqual(tk[0].items.map(function (i) { return [i.name, Number(i.qty), i.status]; }), [['Zpo groundnut stew', 1, 'done'], ['Zpo pepper soup', 2, 'done']]);
  assert.deepEqual(await kitchenJobs(), [], 'not printed again');
  var board = await kitchen.board(tok.yaw, { station: 'all' });
  assert.equal(board.cooking.length + board.ready.length + (board.recent || []).length, 0, 'not on the kitchen screens');
  assert.deepEqual((await tables.inbox(tok.ama)).sent, [], 'no alert for the cashier');
  var log = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'till.kitchen'", [company.id])).rows[0].summary;
  assert.ok(/^Taken with no internet at \d\d:\d\d \(the kitchen had it then\), kept as #\d+: Zpo T1/.test(log), log);
  // Sent again by a till still catching up: nothing new.
  var again = await pos.saveTab(tok.yaw, { clientRef: 'zpooffline0001', offlineAt: at, tableId: table, waiterId: people.yaw, items: [{ menuItemId: menu['Zpo pepper soup'], qty: 2 }] });
  assert.equal(again.replayed, true);
  // The internet back: a drink added goes to the kitchen as usual, alone.
  await pos.saveTab(tok.yaw, { id: tab.id, tableId: table, waiterId: people.yaw, fulfillment: 'dine_in',
    items: [{ menuItemId: menu['Zpo pepper soup'], qty: 2 }, { menuItemId: menu['Zpo groundnut stew'], qty: 1 }, { menuItemId: menu['Zpo sobolo'], qty: 1 }] });
  tk = await ticketsOf('tab_id', tab.id);
  assert.deepEqual(tk.map(function (t) { return t.status; }), ['served', 'cooking']);
  assert.deepEqual(tk[1].items.map(function (i) { return i.name; }), ['Zpo sobolo']);
  var jobs = await kitchenJobs();
  assert.equal(jobs.length, 1);
  assert.ok(/1 x Zpo sobolo/.test(jobs[0]) && !/soup|stew/.test(jobs[0]), jobs[0]);
  await pool.query("UPDATE restaurant_print_jobs SET status = 'printed' WHERE printer_id = $1", [printerId]);
  await pos.removeTab(tok.kojo, tab.id);
});

test('a sale taken with no internet a week ago: on the books then, its ticket kept served; sent again, nothing new', async function () {
  var at = new Date(Date.now() - 6 * 86400000).toISOString();
  var order = await pos.createOrder(tok.ama, { clientRef: 'zpooffline0002', takenAt: at, fulfillment: 'togo', payments: [{ method: 'cash', currency: 'GHS', tendered: 200 }],
    items: [{ menuItemId: menu['Zpo groundnut stew'], qty: 2 }] });
  var tk = await ticketsOf('order_id', order.id);
  assert.deepEqual(tk.map(function (t) { return [t.status, !!t.offline_at]; }), [['served', true]]);
  assert.ok(Math.abs(new Date(tk[0].offline_at) - new Date(at)) < 2000, 'kept with the day it was taken');
  assert.deepEqual(await kitchenJobs(), []);
  var again = await pos.createOrder(tok.ama, { clientRef: 'zpooffline0002', takenAt: at, fulfillment: 'togo', payments: [{ method: 'cash', currency: 'GHS', tendered: 200 }],
    items: [{ menuItemId: menu['Zpo groundnut stew'], qty: 2 }] });
  assert.equal(again.replayed, true);
  assert.equal((await ticketsOf('order_id', order.id)).length, 1);
});

test('an open order paid with no internet: its courses still waiting are kept served, not cooked again', async function () {
  await access.saveSettings(tok.kojo, { settings: { courses: { on: true, names: ['Starters', 'Mains'], categories: { 'Zpo Starters': 1, 'Zpo Mains': 2, 'Zpo Drinks': 0 } } } }, IP);
  var items = [{ menuItemId: menu['Zpo pepper soup'], qty: 1 }, { menuItemId: menu['Zpo groundnut stew'], qty: 1 }];
  var tab = await pos.saveTab(tok.yaw, { tableId: table, waiterId: people.yaw, fulfillment: 'dine_in', items: items });
  var tk = await ticketsOf('tab_id', tab.id);
  assert.deepEqual(tk.map(function (t) { return [t.course, t.status]; }), [[1, 'cooking'], [2, 'held']]);
  var printed = (await kitchenJobs()).length;
  await pos.createOrder(tok.ama, { tabId: tab.id, clientRef: 'zpooffline0003', takenAt: minutesAgo(3), tableId: table, fulfillment: 'dine_in',
    payments: [{ method: 'cash', currency: 'GHS', tendered: 200 }], items: items });
  tk = (await pool.query('SELECT course, status, offline_at FROM restaurant_kitchen_tickets WHERE company_id = $1 AND course = 2 ORDER BY created_at DESC LIMIT 1', [company.id])).rows[0];
  assert.deepEqual([tk.status, !!tk.offline_at], ['served', true]);
  assert.equal((await kitchenJobs()).length, printed, 'the mains not printed again');
  await access.saveSettings(tok.kojo, { settings: { courses: { on: false, names: ['Starters', 'Mains'] } } }, IP);
});
