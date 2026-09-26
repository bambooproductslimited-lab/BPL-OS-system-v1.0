// The restaurant till: cash received and change on a cash sale, open
// tables kept to add to and pay later (paid once, never counted as a sale
// until then), the cashier's shift so far, and reprinting a receipt. Test
// data uses the ZQT company code.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var pinAuth = require('../src/lib/pinAuth');

var PIN = '7351';
var company, other, cashier, waiter, table, fish, beer, token, otherToken;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code IN ('ZQT', 'ZQU')")).rows.map(function (r) { return r.id; });
  if (!cos.length) return;
  await pool.query('DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))', [cos]);
  await pool.query('DELETE FROM restaurant_orders WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))', [cos]);
  await pool.query('DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM restaurant_tables WHERE company_id = ANY($1)', [cos]);
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQT-%'");
  await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
}
async function person(code, first, dept, pin) {
  return (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqt', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pin ? pinAuth.hashPin(pin) : null])).rows[0].id;
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [[pinAuth.hashPin(PIN), pinAuth.hashPin('7352')]]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQT', 'Zqt Grill') RETURNING *")).rows[0];
  other = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQU', 'Zqu Cafe') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTF', 'Zqt Floor', $1) RETURNING id", [company.id])).rows[0].id;
  var dept2 = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQUF', 'Zqu Floor', $1) RETURNING id", [other.id])).rows[0].id;
  cashier = await person('ZQT-1', 'Akua', dept, PIN);
  waiter = await person('ZQT-2', 'Kojo', dept);
  await person('ZQT-3', 'Efua', dept2, '7352');
  table = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqt Table 4') RETURNING id", [company.id])).rows[0].id;
  fish = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqt grilled fish', 'Zqt Kitchen', 120, true) RETURNING id", [company.id])).rows[0].id;
  beer = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqt lager', 'Zqt Bar', 20, true) RETURNING id", [company.id])).rows[0].id;
  token = (await pos.login(PIN, '10.9.9.1')).token;
  otherToken = (await pos.login('7352', '10.9.9.2')).token;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('a cash sale keeps what was handed over and gives the change; too little is refused', async function () {
  await pos.openDrawerSession(token, 200);
  await assert.rejects(pos.createOrder(token, { items: [{ menuItemId: fish, qty: 1 }], paymentMethod: 'cash', cashTendered: 100 }), /less than the total/);
  var o = await pos.createOrder(token, { items: [{ menuItemId: fish, qty: 1 }, { menuItemId: beer, qty: 2 }], paymentMethod: 'cash', cashTendered: 200 });
  assert.equal(o.total, 160);
  assert.equal(o.cashTendered, 200);
  assert.equal(o.change, 40);
  var card = await pos.createOrder(token, { items: [{ menuItemId: beer, qty: 1 }], paymentMethod: 'card', cashTendered: 500 });
  assert.equal(card.cashTendered, null);            // only cash has change
  var r = await pos.receiptForSession(token, o.id);
  assert.equal(r.change, 40);
  assert.equal(r.items.length, 2);
  assert.equal(r.cashierName, 'Akua Zqt');
  await assert.rejects(pos.receiptForSession(otherToken, o.id), /not found/);
});

test('an open table is saved, added to, shown at today\'s prices, and paid once', async function () {
  await assert.rejects(pos.saveTab(token, { items: [{ menuItemId: beer, qty: 1 }] }), /Pick a table/);
  var tab = await pos.saveTab(token, { tableId: table, waiterId: waiter, items: [{ menuItemId: beer, qty: 3 }] });
  assert.equal(tab.tableName, 'Zqt Table 4');
  assert.equal(tab.waiterName, 'Kojo Zqt');
  assert.equal(tab.total, 60);
  await assert.rejects(pos.saveTab(token, { tableId: table, items: [{ menuItemId: fish, qty: 1 }] }), /already has an open order/);
  tab = await pos.saveTab(token, { id: tab.id, tableId: table, waiterId: waiter, items: [{ menuItemId: beer, qty: 3 }, { menuItemId: fish, qty: 1 }] });
  assert.equal(tab.total, 180);
  await pool.query('UPDATE restaurant_menu_items SET price = 25 WHERE id = $1', [beer]);
  assert.equal((await pos.listTabs(token))[0].total, 195);
  assert.equal((await pos.listTabs(otherToken)).length, 0);          // another restaurant never sees it
  var shift = await pos.shiftSummary(token);
  assert.equal(shift.openTabs, 1);
  var before = shift.sales;

  var paid = await pos.createOrder(token, { tabId: tab.id, tableId: table, waiterId: waiter, items: tab.lines.map(function (l) { return { menuItemId: l.menuItemId, qty: l.qty }; }), paymentMethod: 'mobile_money' });
  assert.equal(paid.total, 195);
  assert.equal((await pos.listTabs(token)).length, 0);
  await assert.rejects(pos.createOrder(token, { tabId: tab.id, items: [{ menuItemId: beer, qty: 1 }], paymentMethod: 'cash' }), /already been paid/);
  assert.equal((await pos.shiftSummary(token)).sales, before + 195);

  var gone = await pos.saveTab(token, { label: 'Zqt bar tab', items: [{ menuItemId: beer, qty: 1 }] });
  await assert.rejects(pos.removeTab(otherToken, gone.id), /already been paid or removed/);
  await pos.removeTab(token, gone.id);
  assert.equal((await pos.listTabs(token)).length, 0);
});

test('the shift counts this cashier\'s sales since the drawer opened, by method, with the latest first', async function () {
  var s = await pos.shiftSummary(token);
  assert.equal(s.orders, 3);
  assert.equal(s.sales, 160 + 20 + 195);
  assert.deepEqual(s.byMethod.map(function (m) { return m.method; }), ['mobile_money', 'cash', 'card']);
  assert.equal(s.recent[0].total, 195);
  assert.equal(s.recent[0].tableName, 'Zqt Table 4');
  assert.equal(s.recent.length, 3);
  assert.equal(s.lastClosed, null);
  await pos.closeDrawerSession(token, { actualCash: 360 });
  var after = await pos.shiftSummary(token);
  assert.equal(after.orders, 0);                    // no drawer open, nothing counted
  assert.equal(after.lastClosed.counted, 360);
  assert.equal(after.lastClosed.cashierName, 'Akua Zqt');
});
