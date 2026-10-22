// The till's orders (migration 0157): dine in at a table, pickup at the
// counter, delivery with who, a phone and where; a note on each dish and
// dishes not on the menu; a bill split several ways, in cedis, US dollars or
// yuan at the manager's rate, by cash, Mobile Money, Alipay or WeChat Pay;
// VIP and IOU only for customers with those accounts; the floor map;
// tickets printed when the food is done; where each order's food stands;
// and the activity report. Test data uses the ZQO company code.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var money = require('../src/services/restaurantTillMoney.service');
var kitchen = require('../src/services/restaurantKitchen.service');
var access = require('../src/services/restaurantTillAccess.service');
var pinAuth = require('../src/lib/pinAuth');
var screens = require('../src/services/restaurantKdsScreens.service');

var PINS = { ama: '7491', kojo: '7492', yaw: '7493', esi: '7494' };
var IP = '10.9.8.1';
var company, people = {}, fish, rice, beer, t1, t2, tok = {}, grill, bar;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQO'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    await pool.query('DELETE FROM restaurant_vip_entries WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_refunds WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM restaurant_orders WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_guests WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_disputes WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_kds_screens WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_tables WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_activity WHERE company_id = ANY($1)', [cos]);
    await pool.query("DELETE FROM audit_logs WHERE action = 'restaurant.till.settings' AND entity_id = ANY($1::text[])", [cos]);
  }
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQO-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqo', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
async function dish(name, cat, price) {
  return (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, $2, $3, $4, true) RETURNING id', [company.id, name, cat, price])).rows[0].id;
}
function settingsAs(key, settings, extra) {
  return access.saveSettings(tok[key], Object.assign({ settings: settings || {} }, extra || {}), IP);
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQO', 'Zqo Lagoon Grill') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQOF', 'Zqo Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQO-1', 'Ama', dept);
  await person('kojo', 'ZQO-2', 'Kojo', dept);
  await person('yaw', 'ZQO-3', 'Yaw', dept);
  await person('esi', 'ZQO-4', 'Esi', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'waiter'), ($1, $4, 'kitchen')",
    [company.id, people.kojo, people.yaw, people.esi]);
  fish = await dish('Zqo grilled fish', 'Zqo Grill', 100);
  rice = await dish('Zqo jollof', 'Zqo Grill', 50);
  beer = await dish('Zqo lager', 'Zqo Bar', 20);
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqo T1') RETURNING id", [company.id])).rows[0].id;
  t2 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqo T2') RETURNING id", [company.id])).rows[0].id;
  grill = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zqo Grill', '{\"Zqo Grill\"}', true) RETURNING id", [company.id])).rows[0].id;
  bar = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories) VALUES ($1, 'Zqo Bar', '{\"Zqo Bar\"}') RETURNING id", [company.id])).rows[0].id;
  // The kitchen screen Esi signs in on, set up by the manager.
  var hello = await screens.hello(null, IP, 'Zqo tablet');
  await screens.claim(company.id, { id: people.kojo, first_name: 'Kojo', last_name: 'Zqo' }, { code: hello.code, name: 'Zqo pass' });
  for (var k of Object.keys(PINS)) tok[k] = (await pos.login(PINS[k], IP, k === 'esi' ? 'kds' : 'till', hello.screenToken)).token;
  await pos.openDrawerSession(tok.ama, 200);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('dine in needs its table, pickup is at the counter, delivery needs who, a phone and where', async function () {
  await assert.rejects(pos.saveTab(tok.ama, { fulfillment: 'dine_in', items: [{ menuItemId: fish, qty: 1 }] }), /Pick the table for this dine-in order/);
  var dine = await pos.saveTab(tok.ama, { fulfillment: 'dine_in', tableId: t1, items: [{ menuItemId: fish, qty: 1 }] });
  assert.deepEqual([dine.fulfillment, dine.tableName], ['dine_in', 'Zqo T1']);
  // Pickup: no table, waits under the customer's name at the counter.
  // A pickup says who it is for and a number to call when it is ready.
  await assert.rejects(pos.saveTab(tok.ama, { fulfillment: 'pickup', items: [{ menuItemId: rice, qty: 2 }] }), /A pickup needs the customer's name/);
  await assert.rejects(pos.saveTab(tok.ama, { fulfillment: 'pickup', customerName: 'Zqo Kofi', items: [{ menuItemId: rice, qty: 2 }] }), /A pickup needs a phone number/);
  var pick = await pos.saveTab(tok.ama, { fulfillment: 'pickup', tableId: t2, customerName: 'Zqo Kofi', customerPhone: '0200000992', items: [{ menuItemId: rice, qty: 2 }] });
  assert.deepEqual([pick.fulfillment, pick.tableId, pick.label], ['pickup', null, 'Zqo Kofi']);
  var board = await kitchen.board(tok.esi, { station: 'all' });
  var pt = board.cooking.find(function (t) { return t.id && t.label === 'Zqo Kofi'; });
  assert.deepEqual([pt.tableName, pt.fulfillment], ['Counter', 'pickup']);
  // Delivery: who, a phone and where, each asked for.
  await assert.rejects(pos.saveTab(tok.ama, { fulfillment: 'delivery', customerName: 'Zqo Abla', items: [{ menuItemId: fish, qty: 1 }] }), /phone number/);
  await assert.rejects(pos.saveTab(tok.ama, { fulfillment: 'delivery', customerName: 'Zqo Abla', customerPhone: '0200000101', items: [{ menuItemId: fish, qty: 1 }] }), /location/);
  var del = await pos.saveTab(tok.ama, { fulfillment: 'delivery', customerName: 'Zqo Abla', customerPhone: '0200000101', deliveryAddress: 'Zqo Street 4, by the school', items: [{ menuItemId: fish, qty: 1 }] });
  assert.deepEqual([del.customerName, del.customerPhone, del.deliveryAddress, del.label], ['Zqo Abla', '0200000101', 'Zqo Street 4, by the school', 'Zqo Abla']);
  board = await kitchen.board(tok.esi, { station: 'all' });
  var dt = board.cooking.find(function (t) { return t.label === 'Zqo Abla'; });
  assert.deepEqual([dt.fulfillment, dt.customerPhone, dt.deliveryAddress, dt.tableName], ['delivery', '0200000101', 'Zqo Street 4, by the school', 'Delivery']);
  // Paying the delivery keeps who and where on the sale.
  var sale = await pos.createOrder(tok.ama, { tabId: del.id, fulfillment: 'delivery', customerName: 'Zqo Abla', customerPhone: '0200000101', deliveryAddress: 'Zqo Street 4, by the school',
    items: [{ menuItemId: fish, qty: 1 }], payments: [{ method: 'mobile_money' }] });
  assert.deepEqual([sale.fulfillment, sale.customerName, sale.deliveryAddress, sale.paymentMethod], ['delivery', 'Zqo Abla', 'Zqo Street 4, by the school', 'mobile_money']);
  for (var t of [dine, pick]) await pos.removeTab(tok.ama, t.id);
});

test('a note on each dish goes to the kitchen; a dish not on the menu is priced at the till', async function () {
  var tab = await pos.saveTab(tok.ama, { fulfillment: 'dine_in', tableId: t1, items: [
    { menuItemId: fish, qty: 1, note: 'Zqo no pepper' }, { menuItemId: fish, qty: 1 }, { custom: { name: 'Zqo extra plantain', price: 15, category: 'Zqo Grill' }, qty: 2, note: 'Zqo well done' }
  ] });
  assert.equal(tab.total, 230);
  assert.deepEqual(tab.lines.map(function (l) { return [l.name, l.qty, l.note, l.custom]; }),
    [['Zqo grilled fish', 1, 'Zqo no pepper', false], ['Zqo grilled fish', 1, '', false], ['Zqo extra plantain', 2, 'Zqo well done', true]]);
  var b = await kitchen.board(tok.esi, { station: grill });
  var ticket = b.cooking.find(function (t) { return t.tableName === 'Zqo T1' && t.status !== 'cancelled'; });
  assert.deepEqual(ticket.items.map(function (i) { return [i.name, i.qty, i.note]; }),
    [['Zqo grilled fish', 1, 'Zqo no pepper'], ['Zqo grilled fish', 1, ''], ['Zqo extra plantain', 2, 'Zqo well done']]);
  // A new round where the plain fish gets a note: the plain one is
  // cancelled and the noted one goes; nothing else is sent again.
  var round = await pos.saveTab(tok.ama, { id: tab.id, fulfillment: 'dine_in', tableId: t1, items: [
    { menuItemId: fish, qty: 1, note: 'Zqo no pepper' }, { menuItemId: fish, qty: 1, note: 'Zqo extra lemon' }, { custom: { name: 'Zqo extra plantain', price: 15, category: 'Zqo Grill' }, qty: 2, note: 'Zqo well done' }
  ] });
  assert.ok(round.kitchenTicket);
  b = await kitchen.board(tok.esi, { station: 'all' });
  var mine = b.cooking.filter(function (t) { return t.tableName === 'Zqo T1' && t.status !== 'cancelled'; });
  assert.deepEqual(mine[1].items.map(function (i) { return [i.name, i.note]; }), [['Zqo grilled fish', 'Zqo extra lemon']]);
  assert.ok(mine[0].items.some(function (i) { return i.note === '' && i.status === 'cancelled'; }), 'the plain fish is cancelled');
  // A waiter may not add a dish that is not on the menu (unless a manager lets them).
  await assert.rejects(pos.saveTab(tok.yaw, { fulfillment: 'dine_in', tableId: t2, items: [{ custom: { name: 'Zqo soup', price: 30 }, qty: 1 }] }), /not on the menu/);
  await assert.rejects(pos.createOrder(tok.ama, { items: [{ custom: { name: '', price: 30 }, qty: 1 }], payments: [{ method: 'cash' }] }), /Give the dish/);
  // Paid: the notes and the custom dish are on the sale and its receipt.
  var sale = await pos.createOrder(tok.ama, { tabId: tab.id, fulfillment: 'dine_in', tableId: t1, items: round.lines.map(function (l) {
    return l.custom ? { custom: { name: l.name, price: l.unitPrice, category: 'Zqo Grill' }, qty: l.qty, note: l.note } : { menuItemId: l.menuItemId, qty: l.qty, note: l.note };
  }), payments: [{ method: 'cash', tendered: 250 }] });
  assert.equal(sale.total, 230);
  assert.equal(sale.change, 20);
  var r = await pos.receiptForSession(tok.ama, sale.id);
  assert.deepEqual(r.items.map(function (i) { return [i.name, i.note, i.custom]; }),
    [['Zqo grilled fish', 'Zqo no pepper', false], ['Zqo grilled fish', 'Zqo extra lemon', false], ['Zqo extra plantain', 'Zqo well done', true]]);
  // A dish not on the menu never shows in "mostly bought".
  assert.ok(!(await pos.mostlyBought(tok.ama)).some(function (m) { return /plantain/.test(m.name); }));
});

test('split bills, foreign money at the manager\'s rate, Alipay and WeChat Pay; the drawer counts them right', async function () {
  var before = (await pos.getOpenDrawerSession(tok.ama)).expected;
  // The payments must add up to the bill.
  await assert.rejects(pos.createOrder(tok.ama, { items: [{ menuItemId: fish, qty: 2 }], payments: [{ method: 'cash', amount: 120 }, { method: 'mobile_money', amount: 50 }] }), /30.00 is still to pay/);
  await assert.rejects(pos.createOrder(tok.ama, { items: [{ menuItemId: fish, qty: 2 }], payments: [{ method: 'cash', amount: 150 }, { method: 'mobile_money', amount: 100 }] }), /more than the bill/);
  var split = await pos.createOrder(tok.ama, { items: [{ menuItemId: fish, qty: 2 }], payments: [{ method: 'cash', amount: 120, tendered: 150 }, { method: 'mobile_money', amount: 80 }] });
  assert.equal(split.paymentMethod, 'split');
  assert.deepEqual(split.payments.map(function (p) { return [p.method, p.amount, p.tendered, p.changeGiven]; }), [['cash', 120, 150, 30], ['mobile_money', 80, null, 0]]);
  assert.equal(split.change, 30);
  // US dollars: off until a manager sets a rate and turns them on.
  await assert.rejects(pos.createOrder(tok.ama, { items: [{ menuItemId: rice, qty: 1 }], payments: [{ method: 'cash', currency: 'USD' }] }), /does not take US dollars/);
  await assert.rejects(settingsAs('kojo', { currencies: { USD: { on: true, rate: 0 } } }), /Set the rate for US dollars/);
  // Alipay and WeChat Pay are charged in RMB: not until the manager sets its rate.
  await assert.rejects(pos.createOrder(tok.ama, { items: [{ menuItemId: beer, qty: 1 }], payments: [{ method: 'alipay' }] }), /sets the RMB rate/);
  var saved = await settingsAs('kojo', { currencies: { USD: { on: true, rate: 15 }, CNY: { on: true, rate: 2 } } });
  assert.deepEqual(saved.settings.currencies, { USD: { on: true, rate: 15 }, CNY: { on: true, rate: 2 } });
  assert.equal(saved.settings.ratesSetBy, 'Kojo Zqo');
  // 550 in dollars: $40 handed over is 600 cedis; 50 cedis change.
  var big = await pos.createOrder(tok.ama, { items: [{ menuItemId: fish, qty: 5 }, { menuItemId: rice, qty: 1 }], payments: [{ method: 'cash', currency: 'USD', tendered: 40 }] });
  assert.deepEqual(big.payments.map(function (p) { return [p.method, p.currency, p.amount, p.foreignAmount, p.rate, p.tendered, p.changeGiven]; }), [['cash', 'USD', 550, 36.67, 15, 40, 50]]);
  assert.equal(big.change, 50);
  await assert.rejects(pos.createOrder(tok.ama, { items: [{ menuItemId: fish, qty: 5 }], payments: [{ method: 'cash', currency: 'USD', tendered: 30 }] }), /less than the total/);
  // Alipay in yuan; VIP and IOU only in cedis.
  var ali = await pos.createOrder(tok.ama, { items: [{ menuItemId: beer, qty: 3 }], payments: [{ method: 'alipay', currency: 'CNY' }] });
  assert.deepEqual([ali.paymentMethod, ali.payments[0].foreignAmount, ali.payments[0].amount], ['alipay', 30, 60]);
  var wechat = await pos.createOrder(tok.ama, { items: [{ menuItemId: beer, qty: 1 }], payments: [{ method: 'wechat' }] });
  assert.deepEqual([wechat.paymentMethod, wechat.payments[0].currency, wechat.payments[0].foreignAmount], ['wechat', 'CNY', 10]);
  // Each way of paying in its own money: Alipay and WeChat in RMB only,
  // Mobile Money in cedis only, cash in cedis or dollars, VIP in cedis.
  var one = function (pay) { return pos.createOrder(tok.ama, { items: [{ menuItemId: beer, qty: 1 }], payments: [pay] }); };
  await assert.rejects(one({ method: 'alipay', currency: 'GHS' }), /Alipay is paid in RMB only/);
  await assert.rejects(one({ method: 'wechat', currency: 'USD' }), /WeChat Pay is paid in RMB only/);
  await assert.rejects(one({ method: 'mobile_money', currency: 'USD' }), /Mobile Money is paid in cedis only/);
  await assert.rejects(one({ method: 'mobile_money', currency: 'CNY' }), /Mobile Money is paid in cedis only/);
  await assert.rejects(one({ method: 'cash', currency: 'CNY' }), /Cash is taken in cedis or US dollars/);
  await assert.rejects(one({ method: 'vip', currency: 'USD' }), /VIP is in cedis/);
  await assert.rejects(one({ method: 'other' }), /Payment method/);
  // The drawer: 120 cedis kept from the split, minus the 50 cedis change for
  // the dollars (the $40 are counted apart); Mobile Money and Alipay are not cash.
  var d = await pos.getOpenDrawerSession(tok.ama);
  assert.equal(Math.round((d.expected - before) * 100) / 100, 70);
  assert.deepEqual(d.foreignCash, [{ currency: 'USD', amount: 40, cedis: 550 }]);
  // The shift and the reports count a split bill in each way it was paid.
  var shift = await pos.shiftSummary(tok.ama);
  var by = {};
  shift.byMethod.forEach(function (m) { by[m.method] = m.total; });
  assert.ok(by.cash >= 670 && by.mobile_money >= 80 && by.alipay === 60 && by.wechat === 20);
  // An older till that sends paymentMethod still sells, and the part is kept.
  var old = await pos.createOrder(tok.ama, { items: [{ menuItemId: beer, qty: 1 }], paymentMethod: 'cash', cashTendered: 50 });
  assert.deepEqual([old.paymentMethod, old.cashTendered, old.change, old.payments.length], ['cash', 50, 30, 1]);
  // Refunding the split: cash, or the ways it was paid.
  assert.deepEqual((await money.saleForRefund(tok.ama, split.id)).methods, ['cash', 'mobile_money']);
  assert.deepEqual((await money.saleForRefund(tok.ama, ali.id)).methods, ['alipay', 'cash']);
});

test('VIP and IOU only for customers with those accounts; an IOU limit holds', async function () {
  var c = await pos.createGuestForSession(tok.ama, { name: 'Zqo Adwoa', phone: '0200000201' });
  assert.deepEqual([c.vip, c.iouAllowed], [false, false]);
  await assert.rejects(pos.createOrder(tok.ama, { guestId: c.id, items: [{ menuItemId: beer, qty: 1 }], payments: [{ method: 'vip' }] }), /has no VIP account/);
  await assert.rejects(pos.createOrder(tok.ama, { guestId: c.id, items: [{ menuItemId: beer, qty: 1 }], payments: [{ method: 'iou' }] }), /has no IOU account/);
  await money.vipTopUp(tok.ama, { guestId: c.id, amount: 50, method: 'mobile_money' });
  // The manager opens an IOU account with a limit, in the settings.
  await assert.rejects(access.settingsCustomers(tok.ama, {}, IP), /type a manager's PIN/);
  var list = await access.settingsCustomers(tok.ama, { managerPin: PINS.kojo, q: 'adwoa' }, IP);
  assert.deepEqual(list.map(function (x) { return [x.name, x.vip, x.vipBalance, x.iouAllowed]; }), [['Zqo Adwoa', true, 50, false]]);
  await settingsAs('kojo', {}, { customers: [{ id: c.id, iouAllowed: true, iouLimit: 100 }] });
  var found = (await pos.guestsForSession(tok.ama, 'adwoa'))[0];
  assert.deepEqual([found.vip, found.vipBalance, found.iouAllowed, found.iouLimit, found.iouOwed], [true, 50, true, 100, 0]);
  // VIP pays part of a split bill; the rest in cash.
  var part = await pos.createOrder(tok.ama, { guestId: c.id, items: [{ menuItemId: fish, qty: 1 }], payments: [{ method: 'vip', amount: 40 }, { method: 'cash', amount: 60 }] });
  assert.equal(part.vipBalance, 10);
  // An IOU is for the whole bill, within the limit.
  await assert.rejects(pos.createOrder(tok.ama, { guestId: c.id, items: [{ menuItemId: fish, qty: 1 }], payments: [{ method: 'iou', amount: 50 }, { method: 'cash', amount: 50 }] }), /cannot be split/);
  await pos.createOrder(tok.ama, { guestId: c.id, items: [{ menuItemId: rice, qty: 1 }, { menuItemId: beer, qty: 1 }], payments: [{ method: 'iou' }] });
  await assert.rejects(pos.createOrder(tok.ama, { guestId: c.id, items: [{ menuItemId: fish, qty: 1 }], payments: [{ method: 'iou' }] }), /already owes 70.00; their IOU limit is 100.00/);
  assert.equal((await pos.guestsForSession(tok.ama, 'adwoa'))[0].iouOwed, 70);
});

test('the floor map is set in the settings: tables placed, shaped, renamed and taken away', async function () {
  var open = await access.openSettings(tok.kojo, null, IP);
  var first = open.tables.find(function (t) { return t.name === 'Zqo T1'; });
  await settingsAs('kojo', {}, { tables: [
    { id: first.id, name: 'Zqo Window 1', mapX: 12.5, mapY: 20, shape: 'round', seats: 2, area: 'Zqo Inside' },
    { name: 'Zqo Terrace 1', mapX: 80, mapY: 70, shape: 'long', seats: 8, area: 'Zqo Terrace' },
    { id: t2, remove: true }
  ] });
  var tables = await pos.tablesForSession(tok.ama);
  assert.deepEqual(tables.map(function (t) { return [t.name, t.mapX, t.mapY, t.shape, t.seats, t.area]; }),
    [['Zqo Terrace 1', 80, 70, 'long', 8, 'Zqo Terrace'], ['Zqo Window 1', 12.5, 20, 'round', 2, 'Zqo Inside']]);
  await assert.rejects(settingsAs('kojo', {}, { tables: [{ name: 'Zqo Window 1' }] }), /already a table called/);
  await assert.rejects(settingsAs('ama', {}, { tables: [{ name: 'Zqo X' }] }), /type a manager's PIN/);
});

test('where the food stands, as a tag on the till; a ticket printed when it is done', async function () {
  var tab = await pos.saveTab(tok.ama, { fulfillment: 'dine_in', tableId: t1, items: [{ menuItemId: fish, qty: 1, note: 'Zqo no salt' }, { menuItemId: beer, qty: 2 }] });
  var mine = function (list) { return list.find(function (t) { return t.id === tab.id; }); };
  assert.equal(mine(await pos.listTabs(tok.ama)).kitchen.state, 'cooking');
  var b = await kitchen.board(tok.esi, { station: 'all' });
  var ticket = b.cooking.find(function (t) { return t.label === 'Zqo Window 1'; });
  assert.equal(b.printReady, false);
  await kitchen.finishTicket(tok.esi, ticket.id, 'all');
  var ready = mine(await pos.listTabs(tok.ama)).kitchen;
  assert.deepEqual([ready.state, ready.ready], ['ready', 1]);
  // The ticket for the runner: the whole order, who and where.
  await settingsAs('kojo', { kitchen: { warnAfter: 10, lateAfter: 20, printReady: true } });
  assert.equal((await kitchen.board(tok.esi, { station: 'all' })).printReady, true);
  var printed = await kitchen.printTicket(tok.esi, ticket.id);
  assert.deepEqual([printed.number, printed.tableName, printed.fulfillment, printed.sentBy], [ticket.number, 'Zqo Window 1', 'dine_in', 'Ama Zqo']);
  assert.deepEqual(printed.items.map(function (i) { return [i.name, i.qty, i.note]; }), [['Zqo grilled fish', 1, 'Zqo no salt'], ['Zqo lager', 2, '']]);
  assert.ok(printed.printedAt);
  await kitchen.serveTicket(tok.ama, ticket.id, 'till');
  assert.equal(mine(await pos.listTabs(tok.ama)).kitchen.state, 'served');
  // Paid: the sale carries the tag too.
  var sale = await pos.createOrder(tok.ama, { tabId: tab.id, fulfillment: 'dine_in', tableId: t1, items: [{ menuItemId: fish, qty: 1, note: 'Zqo no salt' }, { menuItemId: beer, qty: 2 }], payments: [{ method: 'cash' }] });
  var recent = (await pos.shiftSummary(tok.ama)).recent.find(function (o) { return o.id === sale.id; });
  assert.equal(recent.kitchen.state, 'served');
});

test('the activity report: everything on the till and the kitchen screen, for a manager', async function () {
  await assert.rejects(access.activityReport(tok.ama, {}, IP), /type a manager's PIN/);
  var all = await access.activityReport(tok.ama, { managerPin: PINS.kojo }, IP);
  var actions = all.rows.map(function (r) { return r.action; });
  ['till.signin', 'kds.signin', 'till.drawer_open', 'till.kitchen', 'till.sale', 'till.vip', 'till.removed', 'till.customer', 'kds.ready', 'kds.printed', 'kds.served', 'settings.saved']
    .forEach(function (a) { assert.ok(actions.indexOf(a) >= 0, a); });
  assert.ok(all.totals.sales >= 9 && all.totals.sold > 0);
  assert.ok(all.staff.some(function (s) { return s.name === 'Esi Zqo'; }));
  var splits = all.rows.filter(function (r) { return r.action === 'till.sale' && r.details.method === 'split'; }).map(function (r) { return r.summary; });
  assert.ok(splits.some(function (x) { return /by cash 120.00 \+ Mobile Money 80.00/.test(x); }), 'a split bill says each way it was paid');
  assert.ok(splits.some(function (x) { return /by VIP 40.00 \+ cash 60.00 · Zqo Adwoa/.test(x); }));
  // Filters: the kitchen screen only; one person; words; a page at a time.
  var kds = await access.activityReport(tok.ama, { managerPin: PINS.kojo, app: 'kds' }, IP);
  assert.ok(kds.rows.length > 0 && kds.rows.every(function (r) { return r.app === 'kds'; }));
  var esi = await access.activityReport(tok.kojo, { employeeId: people.esi }, IP);
  assert.ok(esi.rows.every(function (r) { return r.who === 'Esi Zqo'; }));
  var words = await access.activityReport(tok.kojo, { q: 'Zqo Abla' }, IP);
  assert.ok(words.rows.length >= 1 && words.rows.every(function (r) { return /Zqo Abla/.test(r.summary); }));
  var page = await access.activityReport(tok.kojo, { limit: 3 }, IP);
  assert.equal(page.rows.length, 3);
  assert.equal(page.more, true);
  var next = await access.activityReport(tok.kojo, { limit: 3, before: page.rows[2].id }, IP);
  assert.ok(next.rows[0].id < page.rows[2].id);
});

test('the sales report: every sale and refund, the day\'s totals, by way of paying, order type, cashier and hour', async function () {
  // A refund today: one lager of a two-lager sale, in cash.
  var sale = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqo Walk-in', customerPhone: '0200000992', items: [{ menuItemId: beer, qty: 2 }], payments: [{ method: 'cash' }] });
  var line = (await pool.query('SELECT id FROM restaurant_order_items WHERE order_id = $1', [sale.id])).rows[0];
  await money.refundSale(tok.ama, sale.id, { items: [{ id: line.id, qty: 1 }], reason: 'Zqo warm lager', method: 'cash', managerPin: PINS.kojo }, IP);

  await assert.rejects(access.salesReport(tok.ama, {}, IP), /type a manager's PIN/);
  await assert.rejects(access.salesReport(tok.kojo, { from: '2026-01-01', to: '2026-06-30' }, IP), /at most three months/);
  var r = await access.salesReport(tok.kojo, {}, IP);
  var orders = (await pool.query("SELECT count(*)::int AS n, sum(total) AS gross FROM restaurant_orders WHERE company_id = $1 AND status = 'completed'", [company.id])).rows[0];
  assert.equal(r.totals.sales, orders.n);
  assert.equal(r.totals.gross, Math.round(Number(orders.gross) * 100) / 100);
  assert.equal(r.totals.refunds, 1);
  assert.equal(r.totals.refunded, 20);
  assert.equal(r.totals.net, Math.round((r.totals.gross - 20) * 100) / 100);
  assert.ok(r.totals.dishes > 0 && r.totals.average > 0);
  // Each part of a split under its own way of paying; refunds against theirs.
  var by = {};
  r.byMethod.forEach(function (m) { by[m.method] = m; });
  ['cash', 'mobile_money', 'alipay', 'vip'].forEach(function (m) { assert.ok(by[m] && by[m].amount > 0, m); });
  assert.ok(!by.split, 'a split bill is counted by its parts');
  assert.equal(by.cash.refunded, 20);
  assert.equal(by.cash.net, Math.round((by.cash.amount - 20) * 100) / 100);
  var sum = r.byMethod.reduce(function (s, m) { return s + m.amount; }, 0);
  assert.equal(Math.round(sum * 100) / 100, r.totals.gross);
  assert.ok(r.byFulfillment.some(function (f) { return f.fulfillment === 'delivery'; }) && r.byFulfillment.some(function (f) { return f.fulfillment === 'pickup'; }));
  assert.equal(r.byCashier[0].name, 'Ama Zqo');
  assert.equal(r.byHour.reduce(function (s, h) { return s + h.sales; }, 0), r.totals.sales);
  assert.ok(r.topItems[0].qty >= r.topItems[r.topItems.length - 1].qty);
  assert.ok(r.foreign.some(function (f) { return f.currency === 'USD'; }) && r.foreign.some(function (f) { return f.currency === 'CNY'; }));
  // The transactions: the refund as its own line, a sale with its dishes and parts.
  var refund = r.rows.find(function (x) { return x.kind === 'refund'; });
  assert.equal(refund.total, -20);
  assert.equal(refund.orderNo, sale.orderNo);
  assert.equal(refund.approvedBy, 'Kojo Zqo');
  assert.deepEqual(refund.items.map(function (i) { return [i.name, i.qty]; }), [['Zqo lager', 1]]);
  var split = r.rows.find(function (x) { return x.kind === 'sale' && x.method === 'split' && x.payments.some(function (p) { return p.method === 'mobile_money'; }); });
  assert.ok(split.items.length > 0 && split.payments.length === 2);
  var del = r.rows.find(function (x) { return x.fulfillment === 'delivery'; });
  assert.ok(del.deliveryAddress && del.customer === 'Zqo Abla');
  // Filters.
  var ali = await access.salesReport(tok.kojo, { method: 'alipay' }, IP);
  assert.ok(ali.rows.length >= 1 && ali.rows.every(function (x) { return x.payments.some(function (p) { return p.method === 'alipay'; }); }));
  var refunds = await access.salesReport(tok.kojo, { kind: 'refunds' }, IP);
  assert.deepEqual(refunds.rows.map(function (x) { return x.kind; }), ['refund']);
  var pickup = await access.salesReport(tok.kojo, { fulfillment: 'pickup', kind: 'sales' }, IP);
  assert.ok(pickup.rows.length >= 1 && pickup.rows.every(function (x) { return x.fulfillment === 'pickup'; }));
  var words = await access.salesReport(tok.kojo, { q: 'Zqo Abla' }, IP);
  assert.ok(words.rows.length >= 1 && words.rows.every(function (x) { return x.customer === 'Zqo Abla'; }));
  var nobody = await access.salesReport(tok.kojo, { cashierId: people.yaw }, IP);
  assert.equal(nobody.totals.sales, 0);
  var page = await access.salesReport(tok.kojo, { limit: 3 }, IP);
  assert.equal(page.rows.length, 3);
  assert.equal(page.more, true);
  var next = await access.salesReport(tok.kojo, { limit: 3, offset: 3 }, IP);
  assert.notEqual(next.rows[0].id, page.rows[2].id);
});
