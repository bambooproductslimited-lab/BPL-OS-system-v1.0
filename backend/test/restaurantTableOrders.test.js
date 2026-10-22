// Ordering from the table by its QR code (restaurantTableOrders, migration
// 0166), and the till's sales and open orders sent again after it was
// offline (restaurantPos clientRef, migration 0167). Fake Zqt data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var tables = require('../src/services/restaurantTableOrders.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7521', kojo: '7522', yaw: '7523', esi: '7524' };
var IP = '10.9.8.1';
var company, people = {}, tok = {}, rice, juice, soup, t1, t2, t3;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQT'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_table_calls WHERE company_id = ANY($1)', 'DELETE FROM restaurant_table_orders WHERE company_id = ANY($1)',
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
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQT-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqt', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
function codeOf(url) { return url.split('/q/')[1]; }
async function setQr(settings) {
  var s = await pos.login(PINS.kojo, IP, 'till');
  await require('../src/services/restaurantTillAccess.service').saveSettings(s.token, { settings: settings }, IP);
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQT', 'Zqt Garden') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTF', 'Zqt Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQT-1', 'Ama', dept);
  await person('kojo', 'ZQT-2', 'Kojo', dept);
  await person('yaw', 'ZQT-3', 'Yaw', dept);
  await person('esi', 'ZQT-4', 'Esi', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'waiter'), ($1, $4, 'kitchen')", [company.id, people.kojo, people.yaw, people.esi]);
  rice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqt jollof', 'Zqt Mains', 50, true) RETURNING id", [company.id])).rows[0].id;
  juice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active, online) VALUES ($1, 'Zqt sobolo', 'Zqt Drinks', 15, true, false) RETURNING id", [company.id])).rows[0].id;
  soup = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active, track_stock, stock_qty) VALUES ($1, 'Zqt light soup', 'Zqt Mains', 40, true, true, 1) RETURNING id", [company.id])).rows[0].id;
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqt T1') RETURNING id", [company.id])).rows[0].id;
  t2 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqt T2') RETURNING id", [company.id])).rows[0].id;
  t3 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqt T3') RETURNING id", [company.id])).rows[0].id;
  await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zqt Kitchen', '{}', true)", [company.id]);
  for (var k of ['ama', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
});
test.after(async function () { await cleanup(); await pool.end(); });

var codes = {};
test('a manager prints the tables\' QR codes; a new code stops the old one', async function () {
  await assert.rejects(tables.qrCodes(tok.ama, {}, IP), /type a manager's PIN/);
  var q = await tables.qrCodes(tok.kojo, {}, IP);
  assert.deepEqual(q.tables.map(function (t) { return t.name; }), ['Zqt T1', 'Zqt T2', 'Zqt T3']);
  q.tables.forEach(function (t) { assert.match(t.url, /^https:\/\/online\.starbartema\.com\/q\/[A-Za-z0-9_-]{10,}$/); codes[t.name] = codeOf(t.url); });
  assert.deepEqual((await tables.qrCodes(tok.kojo, {}, IP)).tables.map(function (t) { return codeOf(t.url); }), q.tables.map(function (t) { return codeOf(t.url); }), 'the same codes each time');
  var renewed = await tables.qrCodes(tok.kojo, { renew: t3 }, IP);
  var newT3 = codeOf(renewed.tables.find(function (t) { return t.name === 'Zqt T3'; }).url);
  assert.notEqual(newT3, codes['Zqt T3']);
  await assert.rejects(tables.page(codes['Zqt T3']), /code is not working any more/);
  codes['Zqt T3'] = newT3;
  var p = await tables.page(codes['Zqt T1']);
  assert.deepEqual([p.restaurant.name, p.table.name, p.open, p.bill.total], ['Zqt Garden', 'Zqt T1', true, 0]);
  assert.deepEqual(p.items.map(function (i) { return i.name; }).sort(), ['Zqt jollof', 'Zqt light soup', 'Zqt sobolo'], 'every dish on the till\'s menu, the website\'s switches aside');
});

test('ordered at the table: it waits on the till; accepted onto the table\'s open order and to the kitchen, another round added; turned down; cancelled', async function () {
  await assert.rejects(tables.place(codes['Zqt T1'], { items: [] }, IP), /basket is empty/);
  await assert.rejects(tables.place(codes['Zqt T1'], { items: [{ menuItemId: rice, qty: 99 }] }, IP), /between 1 and 20/);
  await assert.rejects(tables.place(codes['Zqt T1'], { items: [{ menuItemId: rice, qty: 1 }], website: 'x' }, IP), /Something went wrong/);
  var a = await tables.place(codes['Zqt T1'], { name: 'Zqt Efua', note: 'Zqt no ice', items: [{ menuItemId: rice, qty: 2 }, { menuItemId: juice, qty: 1, note: 'cold' }] }, IP);
  assert.match(a.ref, /^Q-\d{4}$/);
  assert.deepEqual([a.order.stage, a.order.subtotal, a.order.canCancel], ['waiting', 115, true]);
  var box = await tables.inbox(tok.yaw);
  var mine = box.orders.find(function (o) { return o.ref === a.ref; });
  assert.deepEqual([mine.tableName, mine.name, mine.hasOpenOrder, mine.items.length], ['Zqt T1', 'Zqt Efua', false, 2]);
  // Accepted by the waiter: the table's open order, theirs, in the kitchen.
  var acc = await tables.accept(tok.yaw, mine.id, {});
  await assert.rejects(tables.accept(tok.yaw, mine.id, {}), /answered that order already/);
  var tab = (await pos.listTabs(tok.ama)).find(function (t) { return t.id === acc.tab.id; });
  assert.deepEqual([tab.tableName, tab.waiterName, tab.total], ['Zqt T1', 'Yaw Zqt', 115]);
  var ticket = (await pool.query('SELECT note FROM restaurant_kitchen_tickets WHERE tab_id = $1', [tab.id])).rows;
  assert.equal(ticket.length, 1);
  assert.match(ticket[0].note, /^Q-\d{4} \(ordered at the table\) · Zqt no ice$/);
  assert.equal((await tables.track(a.token)).stage, 'cooking');
  await pool.query("UPDATE restaurant_kitchen_tickets SET status = 'ready', ready_at = now() WHERE tab_id = $1", [tab.id]);
  assert.equal((await tables.track(a.token)).stage, 'ready');
  // A second round from the same table goes onto the same open order.
  var b = await tables.place(codes['Zqt T1'], { items: [{ menuItemId: rice, qty: 1 }] }, IP);
  var bId = (await tables.inbox(tok.ama)).orders.find(function (o) { return o.ref === b.ref; }).id;
  assert.equal((await tables.inbox(tok.ama)).orders.find(function (o) { return o.ref === b.ref; }).hasOpenOrder, true);
  await tables.accept(tok.ama, bId, {});
  tab = (await pos.listTabs(tok.ama)).find(function (t) { return t.id === acc.tab.id; });
  assert.equal(tab.total, 165);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM restaurant_kitchen_tickets WHERE tab_id = $1', [tab.id])).rows[0].n, 2, 'a new round for the kitchen');
  var page = await tables.page(codes['Zqt T1']);
  assert.equal(page.bill.total, 165, 'the table sees what it has had');
  // Turned down: the table sees why.
  var c = await tables.place(codes['Zqt T2'], { items: [{ menuItemId: rice, qty: 1 }] }, IP);
  var cId = (await tables.inbox(tok.ama)).orders.find(function (o) { return o.ref === c.ref; }).id;
  await assert.rejects(tables.reject(tok.ama, cId, {}), /Say why/);
  await tables.reject(tok.ama, cId, { reason: 'Zqt the kitchen is closed' });
  assert.deepEqual([(await tables.track(c.token)).stage, (await tables.track(c.token)).rejectReason], ['rejected', 'Zqt the kitchen is closed']);
  // Cancelled at the table while it waits.
  var d = await tables.place(codes['Zqt T2'], { items: [{ menuItemId: rice, qty: 1 }] }, IP);
  assert.equal((await tables.cancel(d.token)).stage, 'cancelled');
  await assert.rejects(tables.cancel(a.token), /gone to the kitchen already/);
  assert.equal((await tables.inbox(tok.ama)).orders.length, 0);
});

test('a waiter for every table: picked when the table has none; straight to the kitchen when the restaurant says so; off', async function () {
  await setQr({ requireWaiter: true });
  var e = await tables.place(codes['Zqt T2'], { items: [{ menuItemId: rice, qty: 1 }] }, IP);
  var eId = (await tables.inbox(tok.ama)).orders.find(function (o) { return o.ref === e.ref; }).id;
  await assert.rejects(tables.accept(tok.ama, eId, {}), /Pick the waiter/);
  var acc = await tables.accept(tok.ama, eId, { waiterId: people.yaw });
  assert.equal((await pos.listTabs(tok.ama)).find(function (t) { return t.id === acc.tab.id; }).waiterName, 'Yaw Zqt');
  // Straight to the kitchen: onto the table's open order with its waiter, no one at the till.
  await setQr({ requireWaiter: true, qrOrders: { on: true, straightToKitchen: true } });
  var f = await tables.place(codes['Zqt T2'], { items: [{ menuItemId: juice, qty: 2 }] }, IP);
  assert.equal(f.order.stage, 'cooking');
  assert.equal((await pos.listTabs(tok.ama)).find(function (t) { return t.id === acc.tab.id; }).total, 80);
  // …but a table nobody waits on yet still needs the till to pick one.
  var g = await tables.place(codes['Zqt T3'], { items: [{ menuItemId: juice, qty: 1 }] }, IP);
  assert.equal(g.order.stage, 'waiting');
  await setQr({ requireWaiter: false, qrOrders: { on: false, straightToKitchen: false } });
  assert.equal((await tables.page(codes['Zqt T3'])).open, false);
  await assert.rejects(tables.place(codes['Zqt T3'], { items: [{ menuItemId: rice, qty: 1 }] }, IP), /Ordering from the table is off/);
  await setQr({ qrOrders: { on: true, straightToKitchen: false } });
});

test('the table calls the waiter or asks for the bill: once until someone answers', async function () {
  await tables.call(codes['Zqt T1'], { kind: 'waiter' }, IP);
  await tables.call(codes['Zqt T1'], { kind: 'waiter' }, IP);
  var r = await tables.call(codes['Zqt T1'], { kind: 'bill' }, IP);
  assert.deepEqual(r.calls.map(function (c) { return c.kind; }).sort(), ['bill', 'waiter']);
  var box = await tables.inbox(tok.yaw);
  assert.deepEqual(box.calls.map(function (c) { return [c.tableName, c.kind]; }).sort(), [['Zqt T1', 'bill'], ['Zqt T1', 'waiter']]);
  for (var c of box.calls) await tables.answer(tok.yaw, c.id);
  await assert.rejects(tables.answer(tok.yaw, box.calls[0].id), /answered that already/);
  assert.equal((await tables.inbox(tok.yaw)).calls.length, 0);
  assert.equal((await tables.page(codes['Zqt T1'])).calls.length, 0);
});

test('offline: a sale or an order for the kitchen sent again is the one made already; a sale taken offline keeps its time and is not refused for stock', async function () {
  await assert.rejects(pos.createOrder(tok.ama, { clientRef: 'bad ref!', items: [{ menuItemId: rice, qty: 1 }], payments: [{ method: 'cash' }] }), /reference from the till is not right/);
  var takenAt = new Date(Date.now() - 20 * 60000).toISOString();
  var body = { clientRef: 'zqt-sale-0001', takenAt: takenAt, fulfillment: 'dine_in', tableId: t3, items: [{ menuItemId: rice, qty: 1 }], payments: [{ method: 'cash' }] };
  var one = await pos.createOrder(tok.ama, body);
  var two = await pos.createOrder(tok.ama, body);
  assert.equal(two.id, one.id);
  assert.equal(two.replayed, true);
  assert.equal(new Date(one.offlineAt).toISOString(), takenAt);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM restaurant_orders WHERE company_id = $1 AND client_ref = $2', [company.id, 'zqt-sale-0001'])).rows[0].n, 1);
  // Sent at the same moment twice: still one.
  var both = await Promise.all([1, 2].map(function () { return pos.createOrder(tok.ama, Object.assign({}, body, { clientRef: 'zqt-sale-0002' })); }));
  assert.equal(both[0].id, both[1].id);
  // Only one soup was left: sold twice while offline, both are on the books.
  await pos.createOrder(tok.ama, { clientRef: 'zqt-sale-0003', takenAt: takenAt, items: [{ menuItemId: soup, qty: 1 }], payments: [{ method: 'cash' }] });
  await assert.rejects(pos.createOrder(tok.ama, { items: [{ menuItemId: soup, qty: 1 }], payments: [{ method: 'cash' }] }), /sold out|left in stock/);
  var late = await pos.createOrder(tok.ama, { clientRef: 'zqt-sale-0004', takenAt: takenAt, items: [{ menuItemId: soup, qty: 1 }], payments: [{ method: 'cash' }] });
  assert.ok(late.id);
  // An open order sent to the kitchen offline, sent twice: one, one ticket.
  var tbody = { clientRef: 'zqt-tab-0001', fulfillment: 'dine_in', tableId: t3, items: [{ menuItemId: rice, qty: 2 }] };
  var tabA = await pos.saveTab(tok.yaw, tbody);
  var tabB = await pos.saveTab(tok.yaw, tbody);
  assert.equal(tabB.id, tabA.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM restaurant_kitchen_tickets WHERE tab_id = $1', [tabA.id])).rows[0].n, 1);
  var log = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'till.sale' AND summary LIKE '%taken offline%'", [company.id])).rows;
  assert.equal(log.length, 4);
});
