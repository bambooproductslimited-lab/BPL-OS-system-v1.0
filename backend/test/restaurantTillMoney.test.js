// The till's money (restaurantTillMoney.service.js, migration 0153): the
// till takes cash, Mobile Money, VIP (from a guest's balance) and IOU (owed
// by a named guest, paid later); a refund gives back some or all of a
// sale's dishes with a manager's PIN; the drawer counts cash refunds, IOUs
// paid and VIP top-ups in cash. Test data uses the ZQM company code.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var money = require('../src/services/restaurantTillMoney.service');
var pinAuth = require('../src/lib/pinAuth');
var { buildContext } = require('../src/services/context.service');

var PIN = '7471', MANAGER_PIN = '7472', OTHER_PIN = '7473', IP = '10.9.7.1';
var company, cashier, manager, guest, guest2, fish, beer, token, token2, admin;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQM'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    await pool.query('DELETE FROM restaurant_vip_entries WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_iou_advances WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_refunds WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM restaurant_orders WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_guests WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', [cos]);
  }
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zqm-%@example.com')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqm-%@example.com'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQM-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(code, first, dept, pin) {
  return (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqm', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pin ? pinAuth.hashPin(pin) : null])).rows[0].id;
}
async function withRole(employeeId, email, roleKey) {
  var u = (await pool.query("INSERT INTO users (employee_id, email, password_hash) VALUES ($1, $2, 'x') RETURNING id", [employeeId, email])).rows[0].id;
  await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [u, roleKey]);
}
async function dish(name, price) {
  return (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, $2, 'Zqm', $3, true) RETURNING id", [company.id, name, price])).rows[0].id;
}
async function drawer(t) { return pos.getOpenDrawerSession(t || token); }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [[PIN, MANAGER_PIN, OTHER_PIN].map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQM', 'Zqm Grill House') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQMF', 'Zqm Floor', $1) RETURNING id", [company.id])).rows[0].id;
  cashier = await person('ZQM-1', 'Ama', dept, PIN);
  manager = await person('ZQM-2', 'Kojo', dept, MANAGER_PIN);
  var other = await person('ZQM-3', 'Yaw', dept, OTHER_PIN);
  await withRole(manager, 'zqm-kojo@example.com', 'department_manager');
  await withRole(other, 'zqm-yaw@example.com', 'employee');
  fish = await dish('Zqm grilled fish', 100);
  beer = await dish('Zqm lager', 20);
  guest = (await pos.createGuestForSession((await pos.login(PIN, IP)).token, { name: 'Zqm Abena', phone: '0200000001' }));
  guest2 = (await pos.createGuestForSession((await pos.login(PIN, IP)).token, { name: 'Zqm Kwesi', phone: '0200000002' }));
  token = (await pos.login(PIN, IP)).token;
  token2 = (await pos.login(OTHER_PIN, IP)).token;
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await pos.openDrawerSession(token, 100);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('VIP: money put down is spent on sales, never more than is there', async function () {
  await assert.rejects(pos.createOrder(token, { items: [{ menuItemId: fish, qty: 1 }], paymentMethod: 'vip' }), /pick the customer/);
  // Only a customer with a VIP account (money put down once) pays by VIP.
  await assert.rejects(pos.createOrder(token, { items: [{ menuItemId: fish, qty: 1 }], paymentMethod: 'vip', guestId: guest.id }), /has no VIP account/);
  await assert.rejects(money.vipTopUp(token, { guestId: guest.id, amount: 0, method: 'cash' }), /greater than zero/);
  await assert.rejects(money.vipTopUp(token, { guestId: guest.id, amount: 50, method: 'card' }), /Paid with/);
  await assert.rejects(money.vipTopUp(token2, { guestId: guest.id, amount: 50, method: 'cash' }), /open your cash drawer first/i);
  var t1 = await money.vipTopUp(token, { guestId: guest.id, amount: 150, method: 'cash', note: 'Zqm first' });
  assert.equal(t1.balance, 150);
  // Every way of paying needs the cashier on duty's open drawer.
  await assert.rejects(money.vipTopUp(token2, { guestId: guest.id, amount: 100, method: 'mobile_money' }), /open your cash drawer first/i);
  var t2 = await money.vipTopUp(token, { guestId: guest.id, amount: 100, method: 'mobile_money' });
  assert.equal(t2.balance, 250, 'Mobile Money needs no drawer');

  var sale = await pos.createOrder(token, { items: [{ menuItemId: fish, qty: 2 }], paymentMethod: 'vip', guestId: guest.id });
  assert.equal(sale.paymentMethod, 'vip');
  assert.equal(sale.vipBalance, 50);
  await assert.rejects(pos.createOrder(token, { items: [{ menuItemId: fish, qty: 1 }], paymentMethod: 'vip', guestId: guest.id }), /has 50.00 on their VIP balance/);
  var g = await money.vipGuest(token, guest.id);
  assert.equal(g.balance, 50);
  assert.deepEqual(g.entries.map(function (e) { return [e.kind, e.amount, e.method]; }), [['sale', -200, null], ['topup', 100, 'mobile_money'], ['topup', 150, 'cash']]);
  var list = await money.vipGuests(token);
  assert.deepEqual(list.map(function (x) { return [x.name, x.balance, x.toppedUp]; }), [['Zqm Abena', 50, 250]]);
  assert.equal((await money.vipGuests(token, 'kwesi'))[0].balance, 0, 'a search finds any guest, to top up a new one');
  // The cash top-up is in this drawer; the Mobile Money one is not.
  var d = await drawer();
  assert.equal(d.vipTopUpsCash, 150);
  assert.equal(d.expected, 250);
  // Voided by a manager in the OS: the money goes back.
  await pos.voidOrder(admin, sale.id);
  assert.equal((await money.vipGuest(token, guest.id)).balance, 250);
});

test('IOU: needs the guest, stays owed until paid, and the cash goes in the drawer', async function () {
  await assert.rejects(pos.createOrder(token, { items: [{ menuItemId: beer, qty: 3 }], paymentMethod: 'iou' }), /needs the customer who owes it/);
  // Only a customer a manager gave an IOU account may owe.
  await assert.rejects(pos.createOrder(token, { items: [{ menuItemId: beer, qty: 3 }], paymentMethod: 'iou', guestId: guest2.id }), /has no IOU account/);
  await pool.query('UPDATE restaurant_guests SET iou_allowed = true WHERE id = ANY($1)', [[guest.id, guest2.id]]);
  var iou = await pos.createOrder(token, { items: [{ menuItemId: beer, qty: 3 }], paymentMethod: 'iou', guestId: guest2.id });
  var iou2 = await pos.createOrder(token, { items: [{ menuItemId: fish, qty: 1 }], paymentMethod: 'iou', guestId: guest2.id });
  var list = await money.iouList(token);
  assert.deepEqual(list.open.map(function (x) { return [x.orderNo, x.owed, x.guestName, x.guestPhone, x.dishes]; }),
    [[iou.orderNo, 60, 'Zqm Kwesi', '0200000002', '3× Zqm lager'], [iou2.orderNo, 100, 'Zqm Kwesi', '0200000002', '1× Zqm grilled fish']]);
  assert.equal(list.owed, 160);
  var shift = await pos.shiftSummary(token);
  assert.equal(shift.iousOpen, 2);
  assert.equal(shift.iousOwed, 160);
  var before = (await drawer()).expected;

  await assert.rejects(money.payIou(token, iou.id, { method: 'iou' }), /Paid with/);
  await assert.rejects(money.payIou(token2, iou.id, { method: 'cash' }), /open your cash drawer first/i);
  var paid = await money.payIou(token, iou.id, { method: 'cash' });
  assert.equal(paid.paidAmount, 60);
  assert.equal(paid.paidBy, 'Ama Zqm');
  await assert.rejects(money.payIou(token, iou.id, { method: 'cash' }), /already been paid/);
  await assert.rejects(money.payIou(token2, iou2.id, { method: 'mobile_money' }), /open your cash drawer first/i);
  await money.payIou(token, iou2.id, { method: 'mobile_money' });
  var after = await money.iouList(token);
  assert.equal(after.open.length, 0);
  assert.deepEqual(after.paidToday.map(function (x) { return [x.orderNo, x.paidMethod]; }).sort(), [[iou.orderNo, 'cash'], [iou2.orderNo, 'mobile_money']].sort());
  var d = await drawer();
  assert.equal(d.iouPaidCash, 60);
  assert.equal(d.expected, before + 60, 'IOU sales are not cash until paid');
  await assert.rejects(money.payIou(token, (await pos.createOrder(token, { items: [{ menuItemId: beer, qty: 1 }], paymentMethod: 'cash' })).id, { method: 'cash' }), /IOU not found/);
});

test('refunds: some or all of the dishes, a reason, and a manager\'s PIN', async function () {
  var sale = await pos.createOrder(token, { items: [{ menuItemId: fish, qty: 2 }, { menuItemId: beer, qty: 4 }], paymentMethod: 'cash' });
  var items = (await money.saleForRefund(token, sale.id)).items;
  var fishLine = items.find(function (i) { return i.name === 'Zqm grilled fish'; });
  var beerLine = items.find(function (i) { return i.name === 'Zqm lager'; });
  var start = (await drawer()).expected;
  var ask = { items: [{ id: beerLine.id, qty: 1 }], reason: 'Zqm warm beer', method: 'cash', managerPin: MANAGER_PIN };

  await assert.rejects(money.refundSale(token, sale.id, Object.assign({}, ask, { reason: '' }), IP), /Say why/);
  await assert.rejects(money.refundSale(token, sale.id, Object.assign({}, ask, { managerPin: '9998' }), IP), /Incorrect manager PIN/);
  await assert.rejects(money.refundSale(token, sale.id, Object.assign({}, ask, { managerPin: OTHER_PIN }), IP), /Yaw Zqm cannot approve refunds/);
  await assert.rejects(money.refundSale(token, sale.id, Object.assign({}, ask, { managerPin: PIN }), IP), /cannot approve refunds/, 'a cashier with no manager account cannot approve their own');
  await assert.rejects(money.refundSale(token, sale.id, Object.assign({}, ask, { items: [{ id: beerLine.id, qty: 5 }] }), IP), /Only 4 × Zqm lager is left/);
  await assert.rejects(money.refundSale(token, sale.id, Object.assign({}, ask, { method: 'vip' }), IP), /cannot be refunded that way/);
  await assert.rejects(money.refundSale(token2, sale.id, ask, IP), /open your cash drawer first/i);

  var r1 = await money.refundSale(token, sale.id, ask, IP);
  assert.deepEqual([r1.refund.amount, r1.refund.method, r1.refund.approvedByName, r1.refund.cashierName], [20, 'cash', 'Kojo Zqm', 'Ama Zqm']);
  assert.deepEqual(r1.refund.items, [{ name: 'Zqm lager', qty: 1, amount: 20 }]);
  assert.equal(r1.sale.refunded, 20);
  assert.equal(r1.sale.items.find(function (i) { return i.id === beerLine.id; }).refundedQty, 1);
  // The rest of the beer and one fish, back on Mobile Money.
  var r2 = await money.refundSale(token, sale.id, { items: [{ id: beerLine.id, qty: 3 }, { id: fishLine.id, qty: 1 }], reason: 'Zqm too slow', method: 'mobile_money', managerPin: MANAGER_PIN }, IP);
  assert.equal(r2.refund.amount, 160);
  await assert.rejects(money.refundSale(token, sale.id, Object.assign({}, ask), IP), /already been refunded/);

  var d = await drawer();
  assert.equal(d.cashRefunds, 20);
  assert.equal(d.expected, start - 20, 'only the cash refund leaves the drawer');
  var receipt = await pos.receiptForSession(token, sale.id);
  assert.equal(receipt.refunded, 180);
  assert.equal(receipt.refunds.length, 2);
  var detail = await pos.getOrder(admin, sale.id);
  assert.deepEqual(detail.refunds.map(function (r) { return [r.amount, r.method, r.reason]; }), [[20, 'cash', 'Zqm warm beer'], [160, 'mobile_money', 'Zqm too slow']]);
  var shift = await pos.shiftSummary(token);
  assert.equal(shift.refunds.total, 180);
  assert.equal(shift.refunds.count, 2);
  // Found by its number to refund.
  assert.equal((await money.salesToRefund(token, sale.orderNo))[0].refunded, 180);
});

test('refunds of VIP and IOU sales go back to the balance and off what is owed', async function () {
  await money.vipTopUp(token, { guestId: guest2.id, amount: 100, method: 'mobile_money' });
  var vip = await pos.createOrder(token, { items: [{ menuItemId: beer, qty: 5 }], paymentMethod: 'vip', guestId: guest2.id });
  assert.equal(vip.vipBalance, 0);
  var r = await money.refundSale(token, vip.id, { items: [{ id: (await money.saleForRefund(token, vip.id)).items[0].id, qty: 2 }], reason: 'Zqm spilt', managerPin: MANAGER_PIN }, IP);
  assert.equal(r.refund.method, 'vip');
  assert.equal((await money.vipGuest(token, guest2.id)).balance, 40);

  var iou = await pos.createOrder(token, { items: [{ menuItemId: beer, qty: 2 }], paymentMethod: 'iou', guestId: guest.id });
  assert.deepEqual((await money.saleForRefund(token, iou.id)).methods, ['iou']);
  var line = (await money.saleForRefund(token, iou.id)).items[0];
  await money.refundSale(token, iou.id, { items: [{ id: line.id, qty: 1 }], reason: 'Zqm one too many', managerPin: MANAGER_PIN }, IP);
  assert.equal((await money.iouList(token)).open.find(function (x) { return x.id === iou.id; }).owed, 20);
  await money.refundSale(token, iou.id, { items: [{ id: line.id, qty: 1 }], reason: 'Zqm none at all', managerPin: MANAGER_PIN }, IP);
  assert.equal((await money.iouList(token)).open.some(function (x) { return x.id === iou.id; }), false, 'refunded to nothing: nothing owed');

  var voided = await pos.createOrder(token, { items: [{ menuItemId: beer, qty: 1 }], paymentMethod: 'cash' });
  await pos.voidOrder(admin, voided.id);
  await assert.rejects(money.refundSale(token, voided.id, { items: [{ id: (await money.saleForRefund(token, voided.id)).items[0].id, qty: 1 }], reason: 'Zqm void', managerPin: MANAGER_PIN }, IP), /voided/);
});

test('Other is no longer taken; a sale paid that way before keeps its name, out of the drawer, refunded in cash or Mobile Money', async function () {
  await assert.rejects(pos.createOrder(token, { items: [{ menuItemId: beer, qty: 2 }], paymentMethod: 'other' }), /Payment method/);
  var start = (await drawer()).expected;
  var o = await pos.createOrder(token, { items: [{ menuItemId: beer, qty: 2 }], paymentMethod: 'mobile_money' });
  // As one paid "Other" before it was taken off.
  await pool.query("UPDATE restaurant_orders SET payment_method = 'other' WHERE id = $1", [o.id]);
  await pool.query("UPDATE restaurant_order_payments SET method = 'other' WHERE order_id = $1", [o.id]);
  assert.equal((await money.saleForRefund(token, o.id)).paymentMethod, 'other');
  assert.equal((await drawer()).expected, start);
  assert.deepEqual((await money.saleForRefund(token, o.id)).methods, ['cash', 'mobile_money']);
});

test('sales figures are net of refunds', async function () {
  var list = await pos.listOrders(admin, company.id, {});
  var gross = list.orders.filter(function (o) { return o.status === 'completed'; }).reduce(function (s, o) { return s + o.total - o.refunded; }, 0);
  assert.equal(list.revenueTotal, Math.round(gross * 100) / 100);
  assert.ok(list.orders.some(function (o) { return o.refunded > 0; }));
});

test('pay in and out for an account: VIP money put down or given back (a manager\'s PIN); cash lent on an IOU account; IOUs paid back together', async function () {
  var d0 = await drawer();
  var start = d0.expected, seen = new Set(d0.movements.map(function (m) { return m.account + m.id; }));
  // In, for a VIP account: money put down in cash.
  var b0 = (await money.vipGuest(token, guest2.id)).balance;
  await money.vipTopUp(token, { guestId: guest2.id, amount: 80, method: 'cash' });
  // Out, for a VIP account: given back in cash, with a manager's PIN, never more than is there.
  await assert.rejects(money.vipCashOut(token, { guestId: guest2.id, amount: 30 }, IP), /PIN/);
  await assert.rejects(money.vipCashOut(token, { guestId: guest2.id, amount: 30, managerPin: OTHER_PIN }, IP), /cannot approve refunds/);
  await assert.rejects(money.vipCashOut(token, { guestId: guest2.id, amount: b0 + 81, managerPin: MANAGER_PIN }, IP), /on their VIP balance: no more can be given back/);
  await assert.rejects(money.vipCashOut(token2, { guestId: guest2.id, amount: 30, managerPin: MANAGER_PIN }, IP), /open your cash drawer first/i);
  var out = await money.vipCashOut(token, { guestId: guest2.id, amount: 30, managerPin: MANAGER_PIN, note: 'Zqm moving away' }, IP);
  assert.deepEqual([out.balance, out.approvedBy], [b0 + 50, 'Kojo Zqm']);
  var last = (await money.vipGuest(token, guest2.id)).entries[0];
  assert.deepEqual([last.kind, last.amount, last.method, last.note], ['cashout', -30, 'cash', 'Zqm moving away']);

  // Out, for an IOU account: cash lent, owed like a sale, within the account's limit.
  await assert.rejects(money.iouAdvance(token, { guestId: guest.id, amount: 0 }), /greater than zero/);
  await pool.query('UPDATE restaurant_guests SET iou_allowed = false WHERE id = $1', [guest.id]);
  await assert.rejects(money.iouAdvance(token, { guestId: guest.id, amount: 20 }), /has no IOU account/);
  var owed0 = await money.owedBy(pool, guest.id);
  await pool.query('UPDATE restaurant_guests SET iou_allowed = true, iou_limit = $2 WHERE id = $1', [guest.id, owed0 + 100]);
  await assert.rejects(money.iouAdvance(token2, { guestId: guest.id, amount: 20 }), /open your cash drawer first/i);
  var lent = await money.iouAdvance(token, { guestId: guest.id, amount: 40, note: 'Zqm taxi home' });
  assert.match(lent.advance.orderNo, /^A-\d{4}$/);
  assert.deepEqual([lent.advance.kind, lent.advance.owed, lent.advance.note, lent.owed], ['advance', 40, 'Zqm taxi home', owed0 + 40]);
  await assert.rejects(money.iouAdvance(token, { guestId: guest.id, amount: 61 }), /their IOU limit is/);
  // What was lent counts against the limit for sales on IOU too.
  await assert.rejects(pos.createOrder(token, { items: [{ menuItemId: fish, qty: 1 }], paymentMethod: 'iou', guestId: guest.id }), /their IOU limit is/);
  var sale = await pos.createOrder(token, { items: [{ menuItemId: beer, qty: 1 }], paymentMethod: 'iou', guestId: guest.id });
  var open = (await money.iouList(token, 'Zqm Abena')).open;
  assert.ok(open.some(function (x) { return x.id === lent.advance.id && x.kind === 'advance'; }) && open.some(function (x) { return x.id === sale.id && x.kind === 'sale'; }));
  assert.equal((await pos.guestsForSession(token, 'Zqm Abena'))[0].iouOwed, owed0 + 60);

  // In, for an IOU account: what they owe paid back together, all or none.
  await assert.rejects(money.payIous(token, { ids: [] }), /Pick what is being paid back/);
  await assert.rejects(money.payIous(token, { ids: [lent.advance.id, '00000000-0000-0000-0000-000000000001'] }), /IOU not found/);
  assert.ok((await money.iouList(token, 'Zqm Abena')).open.some(function (x) { return x.id === lent.advance.id; }), 'none paid');
  var paid = await money.payIous(token, { ids: [lent.advance.id, sale.id], method: 'cash' });
  assert.equal(paid.total, 60);
  await assert.rejects(money.payIou(token, lent.advance.id, { method: 'cash' }), /already been paid/);
  assert.ok((await money.iouList(token)).paidToday.some(function (x) { return x.id === lent.advance.id && x.paidMethod === 'cash'; }));

  // The drawer: + VIP put down + IOUs paid back, − VIP given back − cash lent; each with its customer.
  var d = await drawer();
  assert.equal(d.expected, Math.round((start + 80 - 30 - 40 + 60) * 100) / 100);
  assert.deepEqual([d.vipCashOutsCash, d.iouLentCash], [30, 40]);
  var moves = d.movements.filter(function (m) { return m.account && !seen.has(m.account + m.id); })
    .map(function (m) { return [m.direction, m.account, m.amount, m.customer]; }).sort();
  assert.deepEqual(moves, [['in', 'iou', 20, 'Zqm Abena'], ['in', 'iou', 40, 'Zqm Abena'], ['in', 'vip', 80, 'Zqm Kwesi'], ['out', 'iou', 40, 'Zqm Abena'], ['out', 'vip', 30, 'Zqm Kwesi']]);
  // The till settings' IOUs and VIP report.
  var r = await require('../src/services/restaurantTillAccounts.service').report(company.id, {});
  assert.ok(r.ious.some(function (x) { return x.kind === 'advance' && x.paid && x.orderNo === lent.advance.orderNo; }));
  assert.deepEqual([r.totals.vipCashedOut, r.totals.iouLent, r.totals.iouLentCount], [30, 40, 1]);
  assert.ok(r.vip.some(function (x) { return x.kind === 'cashout' && x.amount === -30; }));
  var log = (await pool.query("SELECT action FROM restaurant_activity WHERE company_id = $1 AND action IN ('till.vip_cashout', 'till.iou_advance') ORDER BY at", [company.id])).rows.map(function (x) { return x.action; });
  assert.deepEqual(log, ['till.vip_cashout', 'till.iou_advance']);
});
