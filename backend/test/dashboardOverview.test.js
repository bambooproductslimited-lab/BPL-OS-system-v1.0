// The OS overview (GET /api/dashboard): every company together by default,
// or one company's people, money and stock; always only what this person
// may see.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var dashboard = require('../src/services/dashboard.service');
var { buildContext } = require('../src/services/context.service');

var ctx, sbr, empId;

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  empId = ctx.employee.id;
  sbr = (await pool.query("SELECT id, code FROM companies WHERE code = 'SBR'")).rows[0];
  await pool.query(
    "INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, status) VALUES ($1, 'D3V-R-1', $2, 150, 150, 'completed')",
    [sbr.id, empId]
  );
});
test.after(async function () {
  await pool.query("DELETE FROM restaurant_orders WHERE order_no LIKE 'D3V-%'");
  await pool.end();
});

test('all companies by default, then one company at a time', async function () {
  var all = await dashboard.load(ctx);
  assert.equal(all.company.code, 'ALL');
  var total = (await pool.query("SELECT count(*)::int AS n FROM employees WHERE status != 'terminated'")).rows[0].n;
  assert.equal(all.headcount, total);
  assert.equal(all.companies[0].code, 'BPL');
  assert.deepEqual(all.companies.slice(1, 3).map(function (c) { return c.code; }), ['SBR', 'BGN']);
  assert.ok(Array.isArray(all.lateList) && Array.isArray(all.onLeaveList) && Array.isArray(all.notClockedInList));

  var one = await dashboard.load(ctx, 'sbr');
  assert.equal(one.company.code, 'SBR');
  assert.equal(one.company.kind, 'restaurant');
  var sbrPeople = (await pool.query(
    "SELECT count(*)::int AS n FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.status != 'terminated' AND d.company_id = $1", [sbr.id]
  )).rows[0].n;
  assert.equal(one.headcount, sbrPeople);
  assert.ok(one.departments.every(function (d) { return d.companyCode === 'SBR'; }));
  assert.equal(one.lowStockCount, null, 'Bamboo Products stock is not a restaurant figure');
  assert.equal(one.restaurants.length, 1);
  assert.ok(one.restaurants[0].salesToday >= 150);
  assert.ok(one.restaurants[0].ordersToday >= 1);
});

test('only what the person may see', async function () {
  var limited = Object.assign({}, ctx, { can: function () { return false; } });
  var d = await dashboard.load(limited);
  assert.equal(d.headcount, 1, 'only themselves');
  assert.equal(d.outstandingInvoices, null);
  assert.equal(d.restaurants, null);
  assert.equal(d.pendingExpenses, null);
});
