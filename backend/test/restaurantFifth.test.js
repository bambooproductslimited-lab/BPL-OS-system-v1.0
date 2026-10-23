// The fifth five from the Square list (migrations 0178–0180): paying at the
// table (the bill or a share, with a tip, through Paystack), tips shared out
// (to whoever served, by sale, by hours) and paid, recipes and food cost
// (cost of goods sold, margins, menu engineering), guests' feedback from
// their receipt, and the ready-for-pickup board. Fake Zqj data only;
// nothing goes out: Paystack is stubbed.
var test = require('node:test');
var assert = require('node:assert/strict');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var paystack = require('../src/services/restaurantPaystack.service');
var tableOrders = require('../src/services/restaurantTableOrders.service');
var tablePay = require('../src/services/restaurantTablePay.service');
var tips = require('../src/services/restaurantTips.service');
var costs = require('../src/services/restaurantCosts.service');
var feedback = require('../src/services/restaurantFeedback.service');
var board = require('../src/services/restaurantBoard.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7631', kojo: '7632', yaw: '7633', kofi: '7634' };
var IP = '10.9.7.1';
var QR = 'zqj-table-qr-0001';
var company, dept, people = {}, tok = {}, rice, juice, regular, large, t1;
var realKey = config.paystack.secretKey;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQJ'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_feedback WHERE company_id = ANY($1)', 'DELETE FROM restaurant_tip_payouts WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_recipes WHERE company_id = ANY($1)', 'DELETE FROM restaurant_stock_moves WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_paystack_payments WHERE company_id = ANY($1)', 'DELETE FROM restaurant_table_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_displays WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_payments WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_ingredients WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_tables WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_guests WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM restaurant_displays WHERE company_id IS NULL AND ip LIKE '10.9.7.%'");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQJ-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQJ-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, role) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqj', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
  await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [company.id, people[key], role]);
}
async function settings(s) { await access.saveSettings(tok.kojo, { settings: s }, IP); }
function cash(total) { return [{ method: 'cash', currency: 'GHS', tendered: total }]; }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }
function chargeOf(tab) {
  return { tabId: tab.id, fulfillment: tab.fulfillment, tableId: tab.tableId || undefined, waiterId: tab.waiterId || undefined, items: tab.lines.map(function (l) { return { menuItemId: l.menuItemId, variationId: l.variationId || undefined, qty: l.qty }; }) };
}
function manager(p) { return Object.assign({ managerPin: PINS.kojo }, p); }

// Paystack, as its API answers (no request leaves the machine).
var paystackState = {};
function stubPaystack() {
  config.paystack.secretKey = 'zqj-fake-paystack-key-for-tests';
  paystack.setFetchForTests(async function (url, opts) {
    var body = opts.body ? JSON.parse(opts.body) : null;
    var data;
    if (/\/transaction\/initialize$/.test(url)) {
      paystackState[body.reference] = { status: 'ongoing', amount: body.amount, sent: body };
      data = { authorization_url: 'https://checkout.paystack.com/zqj' + body.reference.slice(-6).toLowerCase(), reference: body.reference };
    } else {
      var ref = decodeURIComponent(url.split('/').pop());
      var st = paystackState[ref] || { status: 'ongoing', amount: 0 };
      data = { reference: ref, status: st.status, amount: st.amount, channel: st.channel || '', fees: st.status === 'success' ? 100 : null,
        authorization: st.status === 'success' ? { card_type: 'visa ', last4: '4081' } : {} };
    }
    return { ok: true, status: 200, json: async function () { return { status: true, message: 'ok', data: data }; } };
  });
}
async function paid(ref, extra) {
  Object.assign(paystackState[ref], { status: 'success' }, extra || {});
  await pool.query('UPDATE restaurant_paystack_payments SET checked_at = NULL WHERE reference = $1', [ref]);
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQJ', 'Zqj Grill') RETURNING *")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQJF', 'Zqj Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQJ-1', 'Ama', 'cashier');
  await person('kojo', 'ZQJ-2', 'Kojo', 'manager');
  await person('yaw', 'ZQJ-3', 'Yaw', 'waiter');
  await person('kofi', 'ZQJ-4', 'Kofi', 'kitchen');
  rice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqj jollof', 'Zqj Mains', 50, true) RETURNING id", [company.id])).rows[0].id;
  juice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqj sobolo', 'Zqj Drinks', 20, true) RETURNING id", [company.id])).rows[0].id;
  regular = (await pool.query("INSERT INTO restaurant_menu_item_variations (menu_item_id, name, price, sort_order) VALUES ($1, 'Regular', 20, 0) RETURNING id", [juice])).rows[0].id;
  large = (await pool.query("INSERT INTO restaurant_menu_item_variations (menu_item_id, name, price, sort_order) VALUES ($1, 'Large', 30, 1) RETURNING id", [juice])).rows[0].id;
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name, seats, area, qr_token) VALUES ($1, 'Zqj T1', 4, 'Zqj Patio', $2) RETURNING id", [company.id, QR])).rows[0].id;
  await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zqj Kitchen', '{}', true)", [company.id]);
  for (var k of ['ama', 'kojo']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
});
test.after(async function () {
  paystack.setFetchForTests(null);
  config.paystack.secretKey = realKey;
  await cleanup(); await pool.end();
});

test('paying at the table: a share and the rest, with a tip, through Paystack; the till closes the bill with them', async function () {
  stubPaystack();
  var tab = await pos.saveTab(tok.ama, { tableId: t1, fulfillment: 'dine_in', waiterId: people.yaw, items: [{ menuItemId: rice, qty: 2 }, { menuItemId: juice, variationId: regular, qty: 1 }] });
  var info = await tablePay.info(QR);
  assert.deepEqual([info.on, info.open, info.total, info.left, info.table.name], [false, true, 120, 120, 'Zqj T1']);
  await assert.rejects(tablePay.start(QR, { amount: 60 }, IP), /not on here/);
  await settings({ tablePay: { on: true }, tips: { on: true, percents: [10], pool: { method: 'direct', roles: ['waiter'] } } });
  info = await tablePay.info(QR);
  assert.equal(info.on, true);
  assert.deepEqual(info.tips, [10]);
  assert.deepEqual(info.items.map(function (i) { return [i.name, i.qty]; }), [['Zqj jollof', 2], ['Zqj sobolo — Regular', 1]]);
  await assert.rejects(tablePay.start(QR, { amount: 200 }, IP), /more than is left/);
  await assert.rejects(tablePay.start(QR, { amount: 0.2 }, IP), /at least/);
  await assert.rejects(tablePay.start(QR, { amount: 60, tip: 500 }, IP), /at most/);
  // A share of it, with a tip; back only to our own sites.
  var a = await tablePay.start(QR, { amount: 60, tip: 6, name: 'Esi Zqj', back: 'https://evil.example.com/q/x' }, IP);
  assert.match(a.url, /^https:\/\/checkout\.paystack\.com\//);
  assert.equal(paystackState[a.reference].sent.amount, 6600);
  assert.ok(!/evil/.test(paystackState[a.reference].sent.callback_url));
  var st = await tablePay.status(QR, a.reference);
  assert.deepEqual([st.payment.status, st.bill.left], ['pending', 120]);
  await paid(a.reference, { channel: 'mobile_money' });
  st = await tablePay.status(QR, a.reference);
  assert.deepEqual([st.payment.status, st.payment.amount, st.payment.tip, st.bill.paid, st.bill.left], ['success', 60, 6, 60, 60]);
  assert.equal(st.bill.payments[0].payer, 'Esi', 'first names only');
  await assert.rejects(tablePay.status(QR, 'BOS-NOT-THIS-ONE'), /not this table/);
  // The rest, by another guest's card.
  var b = await tablePay.start(QR, { amount: 60 }, IP);
  await paid(b.reference, { channel: 'card' });
  await tablePay.status(QR, b.reference);
  await assert.rejects(tablePay.start(QR, { amount: 5 }, IP), /paid already/);
  // On the till: in the inbox and on the open order, with the bill's QR link.
  var inbox = await tableOrders.inbox(tok.ama);
  assert.deepEqual(inbox.paidAtTable.map(function (x) { return [x.tableName, x.amount, x.tip, x.payments]; }), [['Zqj T1', 120, 6, 2]]);
  var t = (await pos.listTabs(tok.ama)).find(function (x) { return x.id === tab.id; });
  assert.deepEqual(t.paidAtTable.map(function (p) { return [p.amount, p.tip, p.payer]; }), [[66, 6, 'Esi Zqj'], [60, 0, '']]);
  var link = await tablePay.link(tok.ama, tab.id);
  assert.match(link.url, /\/q\/zqj-table-qr-0001\?pay=1$/);
  assert.equal(link.on, true);
  // Closed with what was paid; the tip goes with them.
  var sale = await pos.createOrder(tok.ama, Object.assign(chargeOf(t), { tip: 6, payments: t.paidAtTable.map(function (p) { return { paystackRef: p.ref }; }) }));
  assert.deepEqual([sale.total, sale.tip, sale.channel], [120, 6, 'till']);
  assert.equal((await tablePay.info(QR)).open, false);
  assert.equal((await tableOrders.inbox(tok.ama)).paidAtTable.length, 0);
  await assert.rejects(pos.createOrder(tok.ama, Object.assign(chargeOf(t), { payments: [{ paystackRef: a.reference }] })), /paid|open order/);
});

test('tips shared out: to whoever served, by sale, by hours; payouts', async function () {
  await assert.rejects(settings({ tips: { on: true, percents: [10], pool: { method: 'sale', roles: [] } } }), /who shares them/);
  await assert.rejects(settings({ tips: { on: true, percents: [10], pool: { method: 'bogus', roles: ['waiter'] } } }), /shared how/);
  await settings({ tips: { on: true, percents: [10], pool: { method: 'direct', roles: ['waiter', 'cashier'] } } });
  var day = daysAgo(3);
  async function tipped(tip, waiterId, hhmm) {
    var s = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', waiterId: waiterId || undefined, items: [{ menuItemId: rice, qty: 1 }], tip: tip, payments: cash(50 + tip) });
    await pool.query('UPDATE restaurant_orders SET created_at = $2 WHERE id = $1', [s.id, day + 'T' + hhmm + ':00Z']);
  }
  await tipped(12, people.yaw, '12:00');
  await tipped(9, null, '15:00');
  await tipped(5, null, '20:00');
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status, source, note) VALUES ($1, $4, '10:00', '16:00', 'present', 'manual', ''), " +
    "($2, $4, '11:00', '14:00', 'present', 'manual', ''), ($3, $4, '09:00', '17:00', 'present', 'manual', '')", [people.yaw, people.ama, people.kofi, day]);
  await assert.rejects(tips.tab(tok.ama, { managerPin: PINS.ama, from: day, to: day }, IP), /manager/i);
  function split(r) { var o = {}; r.people.forEach(function (x) { if (x.tips) o[x.name] = x.tips; }); return o; }
  var r = await tips.tab(tok.kojo, manager({ from: day, to: day }), IP);
  assert.deepEqual([r.method, r.total, r.orders], ['direct', 26, 3]);
  assert.deepEqual(split(r), { 'Yaw Zqj': 12, 'Ama Zqj': 14 });
  // By sale: shared by whoever was clocked in; nobody at 8pm, so to whoever served.
  r = await tips.tab(tok.kojo, manager({ from: day, to: day, method: 'sale' }), IP);
  assert.deepEqual(split(r), { 'Yaw Zqj': 15, 'Ama Zqj': 11 });
  assert.equal(r.fallback, 5);
  // By hours: the day's tips by hours worked (6 and 3), to the cent.
  r = await tips.tab(tok.kojo, manager({ from: day, to: day, method: 'hours' }), IP);
  assert.deepEqual(split(r), { 'Yaw Zqj': 17.34, 'Ama Zqj': 8.66 });
  assert.equal(r.people.find(function (x) { return x.name === 'Yaw Zqj'; }).hours, 6);
  assert.ok(!r.people.some(function (x) { return x.name === 'Kofi Zqj'; }), 'the kitchen does not share unless picked');
  await settings({ tips: { on: true, percents: [10], pool: { method: 'hours', roles: ['waiter', 'cashier', 'kitchen'] } } });
  r = await tips.tab(tok.kojo, manager({ from: day, to: day }), IP);
  assert.deepEqual(split(r), { 'Yaw Zqj': 9.18, 'Ama Zqj': 4.58, 'Kofi Zqj': 12.24 });
  assert.equal(Object.values(split(r)).reduce(function (a, x) { return a + x; }, 0).toFixed(2), '26.00');
  // Paid out: what is still owed.
  await assert.rejects(tips.tab(tok.kojo, manager({ action: 'payout', employeeId: people.kofi, amount: 0, from: day, to: day }), IP), /0.01/);
  r = await tips.tab(tok.kojo, manager({ action: 'payout', employeeId: people.kofi, amount: 10, method: 'mobile_money', through: day, from: day, to: day }), IP);
  var kofi = r.people.find(function (x) { return x.name === 'Kofi Zqj'; });
  assert.deepEqual([kofi.paid, kofi.owed], [10, 2.24]);
  assert.equal(r.payouts.length, 1);
  assert.equal(r.payouts[0].by, 'Kojo Zqj');
  r = await tips.tab(tok.kojo, manager({ action: 'remove', id: r.payouts[0].id, from: day, to: day }), IP);
  assert.equal(r.payouts.length, 0);
  assert.deepEqual(tips.share(10, { a: 1, b: 1, c: 1 }), { a: 3.34, b: 3.33, c: 3.33 });
});

test('recipes and food cost: a sale draws the ingredients down and keeps its cost; margins and menu engineering', async function () {
  async function ingredient(name, cost) {
    return (await pool.query("INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, unit_cost) VALUES ($1, $2, 'kg', 10, $3) RETURNING id", [company.id, name, cost])).rows[0].id;
  }
  var grain = await ingredient('Zqj rice grains', 12), chicken = await ingredient('Zqj chicken', 40), hibiscus = await ingredient('Zqj hibiscus', 30);
  await assert.rejects(costs.tab(tok.ama, { managerPin: PINS.ama }, IP), /manager/i);
  var l = await costs.tab(tok.kojo, manager({ action: 'list' }), IP);
  assert.equal(l.ingredients.length, 3);
  assert.equal(l.dishes.find(function (d) { return d.id === rice; }).cost, null);
  await assert.rejects(costs.tab(tok.kojo, manager({ action: 'recipe', menuItemId: rice, lines: [{ ingredientId: grain, qty: 0 }] }), IP), /how much/);
  await assert.rejects(costs.tab(tok.kojo, manager({ action: 'recipe', menuItemId: rice, lines: [{ ingredientId: '00000000-0000-0000-0000-000000000000', qty: 1 }] }), IP), /this restaurant/);
  l = await costs.tab(tok.kojo, manager({ action: 'recipe', menuItemId: rice, lines: [{ ingredientId: grain, qty: 0.25 }, { ingredientId: chicken, qty: 0.3 }] }), IP);
  var dish = l.dishes.find(function (d) { return d.id === rice; });
  assert.deepEqual([dish.cost, dish.source, dish.foodCost, dish.profit, dish.recipe.length], [15, 'recipe', 30, 35, 2]);
  // A size's own recipe; the dish itself costed by hand.
  await costs.tab(tok.kojo, manager({ action: 'recipe', menuItemId: juice, variationId: large, lines: [{ ingredientId: hibiscus, qty: 0.1 }] }), IP);
  l = await costs.tab(tok.kojo, manager({ action: 'cost', menuItemId: juice, unitCost: 1.5 }), IP);
  var drink = l.dishes.find(function (d) { return d.id === juice; });
  assert.deepEqual([drink.cost, drink.source], [1.5, 'manual']);
  assert.deepEqual(drink.sizes.map(function (z) { return [z.name, z.cost, z.source, z.foodCost]; }), [['Regular', 1.5, 'dish_manual', 7.5], ['Large', 3, 'recipe', 10]]);
  var s = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 2 }, { menuItemId: juice, variationId: regular, qty: 1 }, { menuItemId: juice, variationId: large, qty: 1 }], payments: cash(150) });
  var lines = (await pool.query('SELECT name, unit_cost FROM restaurant_order_items WHERE order_id = $1 ORDER BY sort_order', [s.id])).rows;
  assert.deepEqual(lines.map(function (x) { return Number(x.unit_cost); }), [15, 1.5, 3]);
  var stock = async function () { return (await pool.query('SELECT name, stock_qty FROM restaurant_ingredients WHERE company_id = $1 ORDER BY name', [company.id])).rows.map(function (x) { return Number(x.stock_qty); }); };
  assert.deepEqual(await stock(), [9.4, 9.9, 9.5]);
  // The report, on its own day.
  var day = daysAgo(5);
  await pool.query('UPDATE restaurant_orders SET created_at = $2 WHERE id = $1', [s.id, day + 'T13:00:00Z']);
  await pool.query('UPDATE restaurant_stock_moves SET created_at = $2 WHERE order_id = $1', [s.id, day + 'T13:00:00Z']);
  var r = await costs.tab(tok.kojo, manager({ action: 'report', from: day, to: day }), IP);
  assert.deepEqual([r.totals.revenue, r.totals.cost, r.totals.profit, r.totals.foodCost], [150, 34.5, 115.5, 23]);
  var jollof = r.dishes.find(function (d) { return d.name === 'Zqj jollof'; });
  assert.deepEqual([jollof.qty, jollof.cost, jollof.profit, jollof.foodCost, jollof.class], [2, 30, 70, 30, 'star']);
  assert.equal(r.dishes.find(function (d) { return d.id === juice; }).class, 'plowhorse');
  assert.deepEqual(r.categories.map(function (c) { return [c.category, c.foodCost]; }), [['Zqj Mains', 30], ['Zqj Drinks', 9]]);
  assert.deepEqual(r.ingredients.map(function (x) { return [x.name, x.qty, x.cost]; }), [['Zqj chicken', 0.6, 24], ['Zqj rice grains', 0.5, 6], ['Zqj hibiscus', 0.1, 3]]);
  // Voided: the ingredients go back.
  await pos.voidOrder({ can: function () { return true; } }, s.id);
  assert.deepEqual(await stock(), [10, 10, 10]);
  // A recipe taken off: back to no cost.
  l = await costs.tab(tok.kojo, manager({ action: 'recipe', menuItemId: rice, lines: [] }), IP);
  assert.equal(l.dishes.find(function (d) { return d.id === rice; }).cost, null);
});

test('guests\' feedback from the receipt: unhappy ones wait for a manager; happy ones are shown the review page', async function () {
  var guest = (await pool.query("INSERT INTO restaurant_guests (company_id, name, phone, source) VALUES ($1, 'Efua Zqj', '0200000931', 'till') RETURNING id", [company.id])).rows[0].id;
  var s = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', waiterId: people.yaw, guestId: guest, items: [{ menuItemId: rice, qty: 1 }, { menuItemId: juice, variationId: regular, qty: 1 }], payments: cash(70) });
  var token = (await pool.query('SELECT receipt_token FROM restaurant_orders WHERE id = $1', [s.id])).rows[0].receipt_token;
  var ask = await feedback.ask(token);
  assert.deepEqual([ask.on, ask.open, ask.given], [true, true, null]);
  assert.deepEqual(ask.dishes, ['Zqj jollof', 'Zqj sobolo — Regular']);
  await assert.rejects(feedback.ask('not-a-real-receipt-token-at-all'), /not right/);
  await assert.rejects(feedback.give(token, { rating: 0 }, IP), /1 to 5/);
  var g = await feedback.give(token, { rating: 2, tags: ['speed', 'bogus'], dishes: [{ name: 'Zqj jollof', liked: false }, { name: 'Not on it', liked: true }], comment: '  Waited   long  ', contactOk: true }, IP);
  assert.deepEqual([g.given.rating, g.given.tags, g.given.dishes, g.given.comment, g.reviewUrl], [2, ['speed'], [{ name: 'Zqj jollof', liked: false }], 'Waited long', null]);
  var logged = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'feedback.unhappy'", [company.id])).rows;
  assert.equal(logged.length, 1);
  await assert.rejects(settings({ feedback: { on: true, reviewUrl: 'http://example.com/review' } }), /https/);
  await settings({ feedback: { on: true, reviewUrl: 'https://example.com/zqj-review' } });
  // The manager: the summary, then followed up with a message to the guest.
  await assert.rejects(feedback.tab(tok.ama, { managerPin: PINS.ama }, IP), /manager/i);
  var r = await feedback.tab(tok.kojo, manager({}), IP);
  assert.deepEqual([r.summary.count, r.summary.average, r.summary.unhappy, r.summary.open, r.summary.score], [1, 2, 1, 1, -100]);
  assert.deepEqual(r.tags.find(function (t) { return t.tag === 'speed'; }), { tag: 'speed', happy: 0, unhappy: 1, count: 1 });
  assert.deepEqual(r.dishes, [{ name: 'Zqj jollof', liked: 0, disliked: 1 }]);
  assert.deepEqual(r.people, [{ name: 'Yaw', count: 1, average: 2 }]);
  var item = r.items[0];
  assert.deepEqual([item.status, item.guest, item.phone, item.servedBy], ['new', 'Efua Zqj', '+233200000931', 'Yaw']);
  assert.equal(await feedback.waiting(company.id), 1);
  r = await feedback.tab(tok.kojo, manager({ action: 'seen', id: item.id }), IP);
  assert.equal(r.items[0].status, 'seen');
  r = await feedback.tab(tok.kojo, manager({ action: 'resolve', id: item.id, reply: 'Called her, a free dessert next time', message: 'Sorry, Efua. Your next dessert is on us.' }), IP);
  assert.match(r.whatsapp, /^https:\/\/wa\.me\/233200000931\?text=Sorry/);
  assert.deepEqual([r.items[0].status, r.items[0].reply, r.items[0].resolvedBy], ['resolved', 'Called her, a free dessert next time', 'Kojo Zqj']);
  assert.equal(await feedback.waiting(company.id), 0);
  // Changed to happy: still one per sale, and the review page.
  g = await feedback.give(token, { rating: 5, tags: ['food'] }, IP);
  assert.equal(g.reviewUrl, 'https://example.com/zqj-review');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM restaurant_feedback WHERE order_id = $1', [s.id])).rows[0].n, 1);
  assert.equal((await feedback.ask(token)).given.rating, 5);
  // Closed after 14 days, and when the restaurant turns it off.
  await pool.query("UPDATE restaurant_orders SET created_at = now() - interval '20 days' WHERE id = $1", [s.id]);
  await assert.rejects(feedback.give(token, { rating: 4 }, IP), /closed/);
  await settings({ feedback: { on: false, reviewUrl: '' } });
  assert.equal((await feedback.ask(token)).on, false);
  await settings({ feedback: { on: true, reviewUrl: '' } });
});

test('the ready-for-pickup board: paired from the till; the counter\'s orders preparing and ready, first names only', async function () {
  var hi = await board.hello(null, '10.9.7.20', 'zqj-tv');
  assert.equal(hi.kind, 'board');
  var v = await board.view(hi.key);
  assert.equal(v.paired, false);
  assert.match(v.code, /^\d{6}$/);
  await assert.rejects(board.pair(tok.ama, { code: '000000' }), /No board shows/);
  var l = await board.pair(tok.ama, { code: v.code, name: 'Zqj TV' });
  assert.deepEqual(l.boards.map(function (b) { return b.name; }), ['Zqj TV']);
  await pool.query("UPDATE restaurant_kitchen_tickets SET status = 'served' WHERE company_id = $1", [company.id]);
  // A pickup order and a table's: only the pickup one shows.
  var pick = await pos.saveTab(tok.ama, { fulfillment: 'pickup', customerName: 'Efua Zqj', customerPhone: '0200000932', items: [{ menuItemId: rice, qty: 1 }] });
  await pos.saveTab(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: juice, variationId: regular, qty: 1 }] });
  await pool.query("INSERT INTO restaurant_kitchen_tickets (company_id, number, label, status) VALUES ($1, 4242, 'K-0042 · Kwesi Zqj', 'cooking')", [company.id]);
  v = await board.view(hi.key);
  assert.deepEqual([v.paired, v.restaurant.name], [true, 'Zqj Grill']);
  assert.deepEqual(v.preparing.map(function (x) { return x.name; }).sort(), ['Efua', 'Kwesi']);
  assert.equal(v.preparing.find(function (x) { return x.name === 'Kwesi'; }).ref, 'K-0042');
  assert.match(v.preparing.find(function (x) { return x.name === 'Efua'; }).ref, /^#\d+$/);
  assert.equal(v.ready.length, 0);
  assert.ok(!JSON.stringify(v).includes('0200000932'), 'no phone numbers on the board');
  // Ready, then handed over.
  await pool.query("UPDATE restaurant_kitchen_tickets SET status = 'ready', ready_at = now() WHERE tab_id = $1", [pick.id]);
  v = await board.view(hi.key);
  assert.deepEqual(v.ready.map(function (x) { return x.name; }), ['Efua']);
  assert.deepEqual(v.preparing.map(function (x) { return x.name; }), ['Kwesi']);
  await pool.query("UPDATE restaurant_kitchen_tickets SET ready_at = now() - interval '40 minutes' WHERE tab_id = $1", [pick.id]);
  assert.equal((await board.view(hi.key)).ready.length, 0, 'gone half an hour after it was ready');
  await pool.query("UPDATE restaurant_kitchen_tickets SET status = 'served' WHERE label LIKE 'K-0042%' AND company_id = $1", [company.id]);
  assert.equal((await board.view(hi.key)).preparing.length, 0);
  // Off the till: it shows a new code.
  await board.unpair(tok.ama, l.boards[0].id);
  await assert.rejects(board.view(hi.key), /taken off/);
});
