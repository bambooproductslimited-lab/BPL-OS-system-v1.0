// The finance dashboard and the quotations & invoicing overview, one
// company at a time: an invoice or expense counts only for its own
// company, a restaurant's finance view comes from its till and its own
// expenses, and the AI assistant's overview still counts every company.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var reports = require('../src/services/reports.service');
var { buildContext } = require('../src/services/context.service');

var ctx, empId, poki, sbr, pokiCustomer, pokiInvoice, bplCustomer, bplInvoice, sbrExpense;

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  empId = (await pool.query('SELECT employee_id FROM users WHERE id = $1', [ctx.user.id])).rows[0].employee_id;
  poki = (await pool.query("SELECT id, code FROM companies WHERE code = 'PKI'")).rows[0];
  sbr = (await pool.query("SELECT id, code FROM companies WHERE code = 'SBR'")).rows[0];
  var sbrDept = (await pool.query('SELECT id FROM departments WHERE company_id = $1 LIMIT 1', [sbr.id])).rows[0];

  pokiCustomer = (await pool.query("INSERT INTO customers (name, category, company_id) VALUES ('F7N Poki Tenant', 'active', $1) RETURNING id", [poki.id])).rows[0].id;
  bplCustomer = (await pool.query("INSERT INTO customers (name, category) VALUES ('F7N Bamboo Buyer', 'active') RETURNING id")).rows[0].id;
  // Overdue by 45 days: one for Poki (on the invoice), one for Bamboo Products (no company).
  pokiInvoice = (await pool.query(
    "INSERT INTO invoices (invoice_no, customer_id, company_id, grand_total, balance_due, status, currency, issued_at, due_date) " +
    "VALUES ('F7N-P-1', $1, $2, 700, 700, 'unpaid', 'GHS', current_date - 60, current_date - 45) RETURNING id", [pokiCustomer, poki.id]
  )).rows[0].id;
  bplInvoice = (await pool.query(
    "INSERT INTO invoices (invoice_no, customer_id, grand_total, balance_due, status, currency, issued_at, due_date) " +
    "VALUES ('F7N-B-1', $1, 1300, 1300, 'unpaid', 'GHS', current_date - 60, current_date - 45) RETURNING id", [bplCustomer]
  )).rows[0].id;

  if (sbrDept) {
    sbrExpense = (await pool.query(
      "INSERT INTO expenses (requester_id, department_id, category, amount, date, status) VALUES ($1, $2, 'F7N gas refill', 250, current_date, 'approved') RETURNING id",
      [empId, sbrDept.id]
    )).rows[0].id;
  }
  await pool.query(
    "INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, status, payment_method) VALUES " +
    "($1, 'F7N-R-1', $2, 400, 400, 'completed', 'mobile_money'), ($1, 'F7N-R-2', $2, 90, 90, 'voided', 'cash')", [sbr.id, empId]
  );
});
test.after(async function () {
  await pool.query("DELETE FROM restaurant_orders WHERE order_no LIKE 'F7N-%'");
  if (sbrExpense) await pool.query('DELETE FROM expenses WHERE id = $1', [sbrExpense]);
  await pool.query('DELETE FROM invoices WHERE id = ANY($1::uuid[])', [[pokiInvoice, bplInvoice]]);
  await pool.query('DELETE FROM customers WHERE id = ANY($1::uuid[])', [[pokiCustomer, bplCustomer]]);
  await pool.end();
});

test('an overdue invoice counts only for its own company', async function () {
  var bpl = await reports.financeDashboard(ctx, {});
  var pki = await reports.financeDashboard(ctx, { company: 'pki' });
  assert.equal(bpl.company.code, 'BPL');
  assert.equal(bpl.kind, 'trade');
  assert.ok(bpl.overdueInvoices.some(function (i) { return i.invoiceNo === 'F7N-B-1' && i.daysOverdue === 45 && i.amount === 1300; }));
  assert.ok(!bpl.overdueInvoices.some(function (i) { return i.invoiceNo === 'F7N-P-1'; }));
  assert.ok(pki.overdueInvoices.some(function (i) { return i.invoiceNo === 'F7N-P-1'; }));
  assert.ok(!pki.overdueInvoices.some(function (i) { return i.invoiceNo === 'F7N-B-1'; }));
  assert.ok(pki.aging.d31to60 >= 700);
  assert.ok(pki.topDebtors.some(function (d) { return d.name === 'F7N Poki Tenant' && d.owed === 700; }));
  assert.equal(bpl.monthlyTrend.length, 6);
});

test('a restaurant gets its till sales, own expenses and voided orders', async function () {
  var d = await reports.financeDashboard(ctx, { company: sbr.code, periodType: 'years', periodCount: 3 });
  assert.equal(d.kind, 'restaurant');
  assert.ok(d.salesThisMonth >= 400);
  assert.ok(d.voidedThisMonth >= 1);
  assert.ok(d.byMethod.some(function (m) { return m.method === 'mobile_money'; }));
  assert.equal(d.daily.length, 14);
  assert.equal(d.monthlyTrend.length, 3);
  assert.ok(d.drawers && typeof d.drawers.closed === 'number');
  if (sbrExpense) {
    assert.ok(d.expenseByCategoryThisMonth.some(function (c) { return c.category === 'F7N gas refill'; }));
    var bpl = await reports.financeDashboard(ctx, {});
    assert.ok(!bpl.expenseByCategoryThisMonth.some(function (c) { return c.category === 'F7N gas refill'; }));
  }
});

test('the quotations & invoicing overview is per company, restaurants excluded', async function () {
  var list = await reports.commercialCompanies(ctx);
  assert.equal(list[0].code, 'BPL');
  assert.ok(!list.some(function (c) { return c.kind === 'restaurant'; }));
  var pki = await reports.commercialDashboard(ctx, 'PKI');
  assert.ok(pki.overdueInvoices.some(function (i) { return i.invoiceNo === 'F7N-P-1' && i.days === -45; }));
  var bpl = await reports.commercialDashboard(ctx);
  assert.ok(!bpl.overdueInvoices.some(function (i) { return i.invoiceNo === 'F7N-P-1'; }));
  await assert.rejects(reports.commercialDashboard(ctx, sbr.code), /no dashboard/);
  var all = await reports.commercialDashboard(ctx, null, { allCompanies: true });
  assert.ok(all.overdueInvoices.some(function (i) { return i.invoiceNo === 'F7N-P-1'; }));
  assert.ok(all.overdueInvoices.some(function (i) { return i.invoiceNo === 'F7N-B-1'; }));
});

test('both need report.read, and restaurants restaurant.read', async function () {
  var nobody = Object.assign({}, ctx, { can: function () { return false; } });
  await assert.rejects(reports.financeDashboard(nobody, {}), /report\.read/);
  await assert.rejects(reports.commercialDashboard(nobody), /report\.read/);
  var noRestaurant = Object.assign({}, ctx, { can: function (p) { return p === 'report.read'; } });
  await assert.rejects(reports.financeDashboard(noRestaurant, { company: sbr.code }), /no dashboard/);
  assert.ok(!(await reports.financeCompanies(noRestaurant)).some(function (c) { return c.kind === 'restaurant'; }));
});
