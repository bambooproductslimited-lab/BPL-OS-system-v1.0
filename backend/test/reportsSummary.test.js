// Reports summary: one company over a period. Voided invoices aren't
// sales; part-payments count as collected on the day they came in; owed
// is what is still to pay now; expenses count once approved; payroll is
// approved runs by pay date, cost being gross plus the employer's SSNIT.
// Uses February 2023 so nothing else in the tests lands in the period.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var invoices = require('../src/services/invoices.service');
var payroll = require('../src/services/payroll.service');
var reports = require('../src/services/reports.service');
var { buildContext } = require('../src/services/context.service');

var boss, cust, run, exp;
var P = { company: 'BPL', from: '2023-02-01', to: '2023-02-28' };
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = await customers.create(boss, { name: 'Zqr Report Client', category: 'active' });
});
test.after(async function () {
  await pool.query('DELETE FROM payments WHERE customer_id = $1', [cust.id]);
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = $1)", [cust.id]);
  await pool.query('DELETE FROM invoices WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
  if (exp) await pool.query('DELETE FROM expenses WHERE id = $1', [exp]);
  if (run) { await pool.query('DELETE FROM payslips WHERE pay_run_id = $1', [run]); await pool.query('DELETE FROM pay_runs WHERE id = $1', [run]); }
  await pool.end();
});

test('a period summary for one company', async function () {
  var before = await reports.summary(boss, P);
  var ghs = function (list, key) { var r = list.find(function (x) { return x.currency === 'GHS'; }); return r ? r[key || 'amount'] : 0; };

  var a = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqr panels', qty: 10, unitPrice: 100 }], dueDate: '2023-03-10' });
  var v = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqr wrong', qty: 1, unitPrice: 999 }] });
  await pool.query("UPDATE invoices SET issued_at = '2023-02-10' WHERE id = ANY($1)", [[a.id, v.id]]);
  await invoices.voidInvoice(boss, v.id);
  await invoices.recordPayment(boss, a.id, { amount: 300, method: 'cash', date: '2023-02-20' });
  await invoices.recordPayment(boss, a.id, { amount: 200, method: 'cash', date: '2023-03-05' });
  var emp = (await pool.query("SELECT e.id, e.department_id FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0];
  exp = (await pool.query("INSERT INTO expenses (requester_id, department_id, category, amount, date, description, status) VALUES ($1,$2,'Zqr Fuel',150,'2023-02-12','Zqr test','approved') RETURNING id", [emp.id, emp.department_id])).rows[0].id;
  var r = await payroll.create(boss, { cycle: 'monthly', periodStart: '2023-02-01', periodEnd: '2023-02-28', payDate: '2023-02-28' });
  run = r.id;

  var mid = await reports.summary(boss, P);
  assert.equal(ghs(mid.invoiced) - ghs(before.invoiced), 1000);
  assert.equal(ghs(mid.collected) - ghs(before.collected), 300);
  assert.equal(mid.expenses.total - before.expenses.total, 150);
  assert.equal(mid.payroll.runs, before.payroll.runs, 'a draft run is not counted');
  await payroll.approve(boss, run);
  var after = await reports.summary(boss, P);
  assert.equal(after.payroll.runs - before.payroll.runs, 1);
  assert.ok(after.payroll.cost >= after.payroll.gross);
  assert.equal(after.months.length, 12);
  assert.equal(after.months[11].month, '2023-02');
  assert.ok(after.topCustomers.some(function (c) { return c.name === 'Zqr Report Client' && c.amount === 1000; }));
  // owed is now, whatever the period: 1000 - 300 - 200
  var now = await reports.summary(boss, {});
  assert.ok(ghs(now.owed) >= 500);
  await assert.rejects(reports.summary(boss, { from: '2023-03-01', to: '2023-02-01' }), /before its start/);
});
