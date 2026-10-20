// Who may do what on the till and the kitchen screen, and the till's other
// settings (restaurantTillAccess.service.js, migration 0155): a role per
// person (or the restaurant's default), checked on the server for every
// call; settings opened and saved by a manager — the person signed in, a
// manager's PIN, or anyone whose OS account may manage restaurants. Test
// data uses the ZQS company code.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var kitchen = require('../src/services/restaurantKitchen.service');
var money = require('../src/services/restaurantTillMoney.service');
var access = require('../src/services/restaurantTillAccess.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7481', yaw: '7482', esi: '7483', kofi: '7484', kojo: '7485', boss: '7486' };
var IP = '10.9.6.1';
var company, people = {}, fish, beer, table, tok = {};

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQS'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    await pool.query('DELETE FROM restaurant_refunds WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM restaurant_orders WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_tables WHERE company_id = ANY($1)', [cos]);
    await pool.query("DELETE FROM audit_logs WHERE action = 'restaurant.till.settings' AND entity_id = ANY($1::text[])", [cos]);
  }
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zqs-%@example.com')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqs-%@example.com'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQS-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqs', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
async function dish(name, cat, price) {
  return (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, $2, $3, $4, true) RETURNING id', [company.id, name, cat, price])).rows[0].id;
}
function login(key, app) { return pos.login(PINS[key], IP, app); }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQS', 'Zqs Chop Bar') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQSF', 'Zqs Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQS-1', 'Ama', dept);
  await person('yaw', 'ZQS-2', 'Yaw', dept);
  await person('esi', 'ZQS-3', 'Esi', dept);
  await person('kofi', 'ZQS-4', 'Kofi', dept);
  await person('kojo', 'ZQS-5', 'Kojo', dept);
  await person('boss', 'ZQS-6', 'Abena', dept);
  // The boss has an OS account that may manage restaurants.
  var u = (await pool.query("INSERT INTO users (employee_id, email, password_hash) VALUES ($1, 'zqs-boss@example.com', 'x') RETURNING id", [people.boss])).rows[0].id;
  await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'department_manager'", [u]);
  fish = await dish('Zqs grilled fish', 'Zqs Grill', 100);
  beer = await dish('Zqs lager', 'Zqs Bar', 20);
  table = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqs T1') RETURNING id", [company.id])).rows[0].id;
  tok.ama = (await login('ama', 'till')).token;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('with nothing set, everyone is a cashier: sells, keeps tables, runs a drawer, but cannot approve refunds or open the settings', async function () {
  var p = await access.profile(tok.ama);
  assert.equal(p.role, 'cashier');
  assert.deepEqual([p.can.till, p.can.charge, p.can.keepOpen, p.can.refund, p.can.kds, p.can.approveRefunds], [true, true, true, true, true, false]);
  assert.deepEqual(p.settings.paymentMethods, ['cash', 'mobile_money', 'vip', 'iou', 'other']);
  assert.deepEqual(p.settings.kitchen, { warnAfter: 10, lateAfter: 20 });
  assert.equal(p.settings.receipt.footer, 'Thank you!');
  await assert.rejects(access.openSettings(tok.ama, null, IP), /A manager opens the till settings/);
  await assert.rejects(access.openSettings(tok.ama, '0000', IP), /Incorrect manager PIN/);
  await assert.rejects(access.openSettings(tok.ama, PINS.yaw, IP), /Yaw Zqs is not a manager of this restaurant/);
});

test('a manager sets roles, ways of paying, receipts, signing out, waiters and kitchen times', async function () {
  // Nobody has the manager role yet: the boss's OS account opens it.
  var open = await access.openSettings(tok.ama, PINS.boss, IP);
  assert.equal(open.managerName, 'Abena Zqs');
  assert.deepEqual(open.staff.map(function (s) { return [s.name, s.role, s.hasPin]; }).slice(0, 2), [['Abena Zqs', null, true], ['Ama Zqs', null, true]]);
  await assert.rejects(access.saveSettings(tok.ama, { managerPin: PINS.boss, settings: { paymentMethods: [] } }, IP), /at least one way of paying/);
  await assert.rejects(access.saveSettings(tok.ama, { managerPin: PINS.boss, settings: { kitchen: { warnAfter: 15, lateAfter: 15 } } }, IP), /more minutes than amber/);
  var saved = await access.saveSettings(tok.ama, {
    managerPin: PINS.boss,
    settings: {
      paymentMethods: ['cash', 'mobile_money', 'iou'], receipt: { footer: 'Zqs: see you soon', extra: 'Zqs Road, Accra', showLogo: false },
      idleMinutes: 15, requireWaiter: true, kitchen: { warnAfter: 8, lateAfter: 15 },
      roles: { cashier: { refund: false } }
    },
    staff: [{ employeeId: people.kojo, role: 'manager' }, { employeeId: people.yaw, role: 'waiter' }, { employeeId: people.esi, role: 'kitchen' }, { employeeId: people.kofi, role: 'none' }]
  }, IP);
  assert.deepEqual(saved.settings.paymentMethods, ['cash', 'mobile_money', 'iou']);
  assert.equal(saved.settings.roles.cashier.refund, false);
  assert.equal(saved.settings.roles.cashier.charge, true, 'what was not sent stays as it was');
  assert.deepEqual(saved.staff.filter(function (s) { return s.role; }).map(function (s) { return [s.name, s.role]; }).sort(),
    [['Esi Zqs', 'kitchen'], ['Kofi Zqs', 'none'], ['Kojo Zqs', 'manager'], ['Yaw Zqs', 'waiter']]);
  var log = (await pool.query("SELECT actor_name, summary FROM audit_logs WHERE action = 'restaurant.till.settings' AND entity_id = $1", [company.id])).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_name, 'Abena Zqs');
  assert.match(log[0].summary, /paymentMethods.*4 people's roles/);

  // A manager signed in opens them with no PIN, and cannot demote themselves.
  tok.kojo = (await login('kojo', 'till')).token;
  assert.equal((await access.openSettings(tok.kojo, null, IP)).managerName, 'Kojo Zqs');
  await assert.rejects(access.saveSettings(tok.kojo, { staff: [{ employeeId: people.kojo, role: 'cashier' }] }, IP), /your own manager role/);
});

test('each role is held to what it may do, on the server', async function () {
  // No access: neither screen.
  await assert.rejects(login('kofi', 'till'), /does not use the till/);
  await assert.rejects(login('kofi', 'kds'), /does not use the kitchen screen/);
  // The kitchen: the kitchen screen only.
  await assert.rejects(login('esi', 'till'), /does not use the till/);
  tok.esi = (await login('esi', 'kds')).token;
  await kitchen.createStation(await require('../src/services/context.service').buildContext((await pool.query("SELECT id FROM users WHERE email = 'zqs-boss@example.com'")).rows[0].id),
    { companyId: company.id, name: 'Zqs Kitchen', everythingElse: true });
  var b = await kitchen.board(tok.esi, { station: 'all' });
  assert.deepEqual(b.timing, { warnAfter: 8, lateAfter: 15 });
  await assert.rejects(pos.menuForSession(tok.esi), /does not use the till/);

  // A waiter keeps tables open (with their name, as the settings ask) and cannot charge.
  tok.yaw = (await login('yaw', 'till')).token;
  await assert.rejects(pos.saveTab(tok.yaw, { tableId: table, items: [{ menuItemId: beer, qty: 2 }] }), /Pick the waiter for this table/);
  var tab = await pos.saveTab(tok.yaw, { tableId: table, waiterId: people.yaw, items: [{ menuItemId: beer, qty: 2 }] });
  await assert.rejects(pos.createOrder(tok.yaw, { tabId: tab.id, tableId: table, waiterId: people.yaw, items: [{ menuItemId: beer, qty: 2 }], paymentMethod: 'cash' }), /cannot take payments/);
  await assert.rejects(pos.openDrawerSession(tok.yaw, 100), /cannot take payments/);
  await assert.rejects(pos.removeTab(tok.yaw, tab.id), /cannot remove an open table/);
  await assert.rejects(pos.toggleFavorite(tok.yaw, beer), /cannot change the favourites/);
  await assert.rejects(money.payIou(tok.yaw, tab.id, { method: 'cash' }), /cannot take IOU payments/);
  var waiterProfile = await access.profile(tok.yaw);
  assert.deepEqual([waiterProfile.role, waiterProfile.can.charge, waiterProfile.can.keepOpen], ['waiter', false, true]);

  // The cashier charges the table, only the ways of paying the till offers.
  await pos.openDrawerSession(tok.ama, 100);
  await assert.rejects(pos.createOrder(tok.ama, { tabId: tab.id, tableId: table, waiterId: people.yaw, items: [{ menuItemId: beer, qty: 2 }], paymentMethod: 'other' }), /turned off in the till settings/);
  var sale = await pos.createOrder(tok.ama, { tabId: tab.id, tableId: table, waiterId: people.yaw, items: [{ menuItemId: beer, qty: 2 }], paymentMethod: 'cash' });
  // Refunds are off for cashiers here; the manager refunds, and approves with their own PIN.
  await assert.rejects(money.salesToRefund(tok.ama), /cannot refund sales/);
  var line = (await money.saleForRefund(tok.kojo, sale.id)).items[0];
  await assert.rejects(money.refundSale(tok.kojo, sale.id, { items: [{ id: line.id, qty: 1 }], reason: 'Zqs warm', method: 'mobile_money', managerPin: PINS.yaw }, IP), /Yaw Zqs cannot approve refunds/);
  var r = await money.refundSale(tok.kojo, sale.id, { items: [{ id: line.id, qty: 1 }], reason: 'Zqs warm', method: 'mobile_money', managerPin: PINS.kojo }, IP);
  assert.equal(r.refund.approvedByName, 'Kojo Zqs');

  // A role changed takes effect on the next call, with no signing in again.
  await access.saveSettings(tok.kojo, { staff: [{ employeeId: people.yaw, role: 'cashier' }] }, IP);
  assert.equal((await access.profile(tok.yaw)).can.charge, true);
  // Back to the default role.
  await access.saveSettings(tok.kojo, { staff: [{ employeeId: people.yaw, role: null }] }, IP);
  assert.equal((await access.profile(tok.yaw)).role, 'cashier');
});
