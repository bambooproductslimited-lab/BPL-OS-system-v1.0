// The restaurant report: sales and items by kitchen group month by month,
// shifts and hours, the month's items ranked by how many sold, and the
// kitchen bonus on the best sellers by gross sales. Categories are grouped
// by guess until the restaurant sets them; shifts and the bonus rule are
// per restaurant. Test data uses the ZQR company code.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var report = require('../src/services/restaurantReport.service');
var { buildContext } = require('../src/services/context.service');

var kelvin, company, cashier, menu = {};

async function cleanup() {
  var co = (await pool.query("SELECT id FROM companies WHERE code = 'ZQR'")).rows[0];
  if (!co) return;
  await pool.query('DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = $1)', [co.id]);
  await pool.query('DELETE FROM restaurant_orders WHERE company_id = $1', [co.id]);
  await pool.query('DELETE FROM restaurant_menu_items WHERE company_id = $1', [co.id]);
  await pool.query('DELETE FROM restaurant_report_settings WHERE company_id = $1', [co.id]);
  await pool.query("DELETE FROM employees WHERE code = 'ZQR-CASH'");
  await pool.query('DELETE FROM departments WHERE company_id = $1', [co.id]);
  await pool.query('DELETE FROM companies WHERE id = $1', [co.id]);
}

var seq = 0;
// one order at a UTC time with lines [menuKey, qty, price, gross?]
async function sale(at, lines, status) {
  seq += 1;
  var total = lines.reduce(function (s, l) { return s + l[1] * l[2]; }, 0);
  var o = (await pool.query(
    "INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, payment_method, status, created_at) VALUES ($1, $2, $3, $4, $4, 'cash', $5, $6) RETURNING id",
    [company.id, 'ZQR-' + seq, cashier, total, status || 'completed', at])).rows[0];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var m = menu[l[0]];
    await pool.query('INSERT INTO restaurant_order_items (order_id, menu_item_id, name, qty, unit_price, line_total, gross) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [o.id, m ? m.id : null, m ? m.name : l[0], l[1], l[2], l[1] * l[2], l[3] === undefined ? null : l[3]]);
  }
}

test.before(async function () {
  await cleanup();
  kelvin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQR', 'Zqr Star Grill') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQRK', 'Zqr Kitchen', $1) RETURNING id", [company.id])).rows[0];
  cashier = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type) VALUES ('ZQR-CASH', 'Zqr', 'Till', 'zqr.till@example.com', $1, current_date, 'active', 'permanent') RETURNING id",
    [dept.id])).rows[0].id;
  var items = [
    ['beer', 'Zqr Club beer', '啤酒类 Beer'], ['kebab', 'Zqr kebab', '烧烤类 BBQ'], ['ribs', 'Zqr ribs', '中式 Chinese Ktn'],
    ['fish', 'Zqr pickled fish', '中式 Chinese Ktn'], ['duck', 'Zqr roast duck', '广东 Chinese Ktn'], ['tomyum', 'Zqr tom yum', '泰式 Thai Ktn'],
    ['fries', 'Zqr fries', 'Zqr Snacks']
  ];
  for (var i = 0; i < items.length; i++) {
    menu[items[i][0]] = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, $2, $3, 10, true) RETURNING id, name", [company.id, items[i][1], items[i][2]])).rows[0];
  }
  // July 2026
  await sale('2026-07-10T20:15:00Z', [['beer', 10, 20], ['kebab', 5, 20]]);
  await sale('2026-07-11T13:00:00Z', [['ribs', 2, 300]]);
  // August 2026
  await sale('2026-08-02T07:30:00Z', [['fries', 3, 50]]);                            // breakfast
  await sale('2026-08-03T12:10:00Z', [['ribs', 4, 300, 1300], ['fish', 1, 500]]);    // lunch; ribs had a discount-free gross of 1300
  await sale('2026-08-04T19:45:00Z', [['tomyum', 2, 340], ['beer', 6, 20]]);         // dinner
  await sale('2026-08-05T01:20:00Z', [['duck', 1, 400], ['kebab', 20, 20]]);         // night cap, past midnight
  await sale('2026-08-06T23:05:00Z', [['beer', 12, 20], ['Old till button', 1, 30]]); // night cap; a line not on the menu
  await sale('2026-08-07T20:00:00Z', [['ribs', 9, 300]], 'voided');                  // voided: never counted
});
test.after(async function () { await cleanup(); await pool.end(); });

test('groups sales and items by kitchen, month by month, guessing each category from its name', async function () {
  var r = await report.report(kelvin, company.id, { month: '2026-08' });
  assert.equal(r.month, '2026-08');
  assert.equal(r.months.length, 12);
  assert.equal(r.months[11], '2026-08');
  assert.equal(r.months[0], '2025-09');
  var g = function (name) { return r.groups.find(function (x) { return x.group === name; }); };
  assert.equal(g('Bar').byMonth['2026-07'].net, 200);
  assert.equal(g('Bar').byMonth['2026-08'].qty, 18);
  assert.equal(g('BBQ').byMonth['2026-08'].net, 400);
  assert.equal(g('Chinese').byMonth['2026-08'].net, 1200 + 500 + 400);   // both Chinese kitchens
  assert.equal(g('Chinese').byMonth['2026-07'].net, 600);
  assert.equal(g('Thai').byMonth['2026-08'].net, 680);
  assert.equal(g('Other').byMonth['2026-08'].net, 150);                  // "Zqr Snacks" matches nothing
  assert.equal(g(r.notOnMenu).byMonth['2026-08'].net, 30);
  assert.equal(r.groups[0].group, 'Chinese');                             // biggest in the month first
  assert.equal(r.totals['2026-08'].orders, 5);                            // the voided order is left out
  assert.equal(r.totals['2026-08'].net, 150 + 1700 + 800 + 800 + 270);
  assert.equal(r.totals['2026-08'].lines, r.totals['2026-08'].net);
  var cat = r.categories.find(function (c) { return c.category === '啤酒类 Beer'; });
  assert.equal(cat.group, 'Bar');
  assert.equal(cat.set, false);
});

test('shifts run from their start to the next one, the last past midnight', async function () {
  var r = await report.report(kelvin, company.id, { month: '2026-08' });
  var s = function (name) { return r.shifts.find(function (x) { return x.name === name; }); };
  assert.deepEqual(s('Night cap').hours.map(function (h) { return h.hour; }), [22, 23, 0, 1, 2, 3, 4, 5]);
  assert.equal(s('Breakfast').byMonth['2026-08'].net, 150);
  assert.equal(s('Lunch').byMonth['2026-08'].net, 1700);
  assert.equal(s('Lunch').byMonth['2026-07'].net, 600);
  assert.equal(s('Dinner').byMonth['2026-08'].net, 800);
  assert.equal(s('Night cap').byMonth['2026-08'].net, 1070);
  assert.equal(s('Night cap').hours.find(function (h) { return h.hour === 1; }).net, 800);
  assert.equal(s('Night cap').hours.find(function (h) { return h.hour === 23; }).orders, 1);
});

test('ranks the month\'s items by how many sold, and pays the bonus on the best sellers by gross', async function () {
  var r = await report.report(kelvin, company.id, { month: '2026-08' });
  assert.equal(r.items[0].name, 'Zqr kebab');
  assert.equal(r.items[0].qty, 20);
  var ribs = r.items.find(function (i) { return i.name === 'Zqr ribs'; });
  assert.equal(ribs.gross, 1300);                                         // Square's gross when there is one
  assert.equal(ribs.net, 1200);
  // default rule: Chinese and Thai kitchens, top 10, 10%
  assert.deepEqual(r.bonus.rule, { groups: ['Chinese', 'Thai'], top: 10, rate: 10 });
  assert.deepEqual(r.bonus.rows.map(function (x) { return x.name; }), ['Zqr ribs', 'Zqr tom yum', 'Zqr pickled fish', 'Zqr roast duck']);
  assert.equal(r.bonus.rows[0].bonus, 130);
  assert.equal(r.bonus.rows[0].kitchen, '中式 Chinese Ktn');
  var chinese = r.bonus.kitchens.find(function (k) { return k.kitchen === '中式 Chinese Ktn'; });
  assert.equal(chinese.bonus, 180);
  assert.equal(chinese.items, 2);
  assert.equal(r.bonus.total, 130 + 68 + 50 + 40);
});

test('the restaurant sets groups, shifts and the bonus rule, and the report follows them', async function () {
  await assert.rejects(report.saveSettings(kelvin, company.id, { shifts: [{ name: 'A', start: 6 }, { name: 'B', start: 6 }] }), /same hour/);
  await assert.rejects(report.saveSettings(kelvin, company.id, { shifts: [{ name: 'A', start: 25 }] }), /0 to 23/);
  await assert.rejects(report.saveSettings(kelvin, company.id, { bonus: { top: 0 } }), /1 to 100/);
  await report.saveSettings(kelvin, company.id, {
    groups: { 'Zqr Snacks': 'BBQ' },
    shifts: [{ name: 'Night', start: 18 }, { name: 'Day', start: 6 }],
    bonus: { groups: ['Thai'], top: 1, rate: 5 }
  });
  var r = await report.report(kelvin, company.id, { month: '2026-08' });
  assert.equal(r.groups.find(function (x) { return x.group === 'BBQ'; }).byMonth['2026-08'].net, 550);
  assert.ok(!r.groups.find(function (x) { return x.group === 'Other'; }));
  assert.deepEqual(r.shifts.map(function (x) { return x.name; }), ['Day', 'Night']);
  assert.equal(r.shifts[0].byMonth['2026-08'].net, 150 + 1700);
  assert.equal(r.shifts[1].byMonth['2026-08'].net, 800 + 1070);
  assert.equal(r.bonus.rows[0].name, 'Zqr tom yum');
  assert.equal(r.bonus.rows[0].bonus, 34);
  assert.equal(r.bonus.total, 34);
  assert.equal(r.categories.find(function (c) { return c.category === 'Zqr Snacks'; }).set, true);
  assert.ok((await pool.query("SELECT 1 FROM audit_logs WHERE action = 'restaurant.report.settings' AND entity_id = $1", [company.id])).rows[0]);
});

test('with no month asked for it shows the latest month with sales; it needs restaurant.read, settings restaurant.manage', async function () {
  var r = await report.report(kelvin, company.id, {});
  assert.equal(r.month, '2026-08');
  assert.equal(r.first, '2026-07');
  var nobody = { can: function () { return false; } };
  await assert.rejects(report.report(nobody, company.id, {}), /restaurant\.read/);
  var reader = { can: function (p) { return p === 'restaurant.read'; } };
  await assert.rejects(report.saveSettings(reader, company.id, {}), /restaurant\.manage/);
  assert.equal(report.guessGroup('Thai Drinks'), 'Thai');
  assert.equal(report.guessGroup('早餐 Breakfast'), 'Breakfast');
  assert.equal(report.guessGroup('冰沙系列 Smoothie'), 'Bar');
  assert.equal(report.guessGroup('小凉亭特色菜 SB Special'), 'Chinese');
});
