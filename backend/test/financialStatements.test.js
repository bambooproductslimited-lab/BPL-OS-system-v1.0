// Financial statements: purchases received count as a cost; the cash flow
// counts expense claims only once paid out (approved ones are "still to
// pay"); a company filter narrows each statement; tax set on a whole
// document is counted and reconciles. Uses March 2023 to stay clear of
// other tests' data.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var invoices = require('../src/services/invoices.service');
var reports = require('../src/services/reports.service');
var { buildContext } = require('../src/services/context.service');

var boss, cust, exps = [], proc;
var P = { from: '2023-03-01', to: '2023-03-31' };
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = await customers.create(boss, { name: 'Zqf Statements Client', category: 'active' });
});
test.after(async function () {
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = $1)", [cust.id]);
  await pool.query('DELETE FROM invoices WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
  for (var i = 0; i < exps.length; i++) await pool.query('DELETE FROM expenses WHERE id = $1', [exps[i]]);
  if (proc) await pool.query('DELETE FROM procurement_requests WHERE id = $1', [proc]);
  await pool.end();
});

test('purchases, cash timing, company filter and whole-document tax', async function () {
  var before = await reports.profitAndLoss(boss, P);
  var cfBefore = await reports.cashFlow(boss, P);
  var taxBefore = await reports.taxSummary(boss, Object.assign({ company: 'BPL' }, P));

  var emp = (await pool.query("SELECT e.id, e.department_id FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0];
  proc = (await pool.query("INSERT INTO procurement_requests (requester_id, department_id, item, quantity, estimated_price, status, actual_cost, received_at) VALUES ($1,$2,'Zqf nails',10,500,'received',450,'2023-03-09') RETURNING id", [emp.id, emp.department_id])).rows[0].id;
  exps.push((await pool.query("INSERT INTO expenses (requester_id, department_id, category, amount, date, description, status) VALUES ($1,$2,'Zqf Fuel',100,'2023-03-05','Zqf approved','approved') RETURNING id", [emp.id, emp.department_id])).rows[0].id);
  exps.push((await pool.query("INSERT INTO expenses (requester_id, department_id, category, amount, date, description, status, paid_at) VALUES ($1,$2,'Zqf Fuel',70,'2023-02-25','Zqf paid in March','paid','2023-03-02') RETURNING id", [emp.id, emp.department_id])).rows[0].id);
  var inv = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqf panel', qty: 1, unitPrice: 1000 }], taxRate: 15 });
  await pool.query("UPDATE invoices SET issued_at = '2023-03-15' WHERE id = $1", [inv.id]);

  var after = await reports.profitAndLoss(boss, P);
  assert.equal(Math.round((after.purchases.procurement - before.purchases.procurement) * 100) / 100, 450);
  assert.equal(Math.round((after.totalExpenses - before.totalExpenses) * 100) / 100, 100, 'the claim dated February is not a March cost');

  var cf = await reports.cashFlow(boss, P);
  assert.equal(Math.round((cf.expensesOut - cfBefore.expensesOut) * 100) / 100, 70, 'only the claim paid out in March went out in March');
  assert.ok(cf.stillToPay.expenses >= 100);
  assert.equal(Math.round((cf.purchasesOut - cfBefore.purchasesOut) * 100) / 100, 450);

  var tax = await reports.taxSummary(boss, Object.assign({ company: 'BPL' }, P));
  assert.equal(Math.round((tax.totalTaxOnWholeDocuments - taxBefore.totalTaxOnWholeDocuments) * 100) / 100, 150);
  assert.ok(Math.abs(tax.reconciliationDiff - taxBefore.reconciliationDiff) < 0.01, 'whole-document tax reconciles');
  assert.ok(tax.byRate.some(function (r) { return r.rate === 15 && r.onWholeDocument; }));

  var list = await reports.statementCompanies(boss);
  assert.equal(list[0].code, 'ALL');
  var other = list.find(function (c) { return c.code !== 'ALL' && c.code !== 'BPL'; });
  if (other) {
    var theirs = await reports.profitAndLoss(boss, Object.assign({ company: other.code }, P));
    assert.equal(theirs.company.code, other.code);
    assert.ok(theirs.purchases.procurement <= after.purchases.procurement - 450 + 0.01, 'a Bamboo Products purchase is not another company\'s');
  }
  await assert.rejects(reports.profitAndLoss(boss, { company: 'NOPE' }), /no company/);
});
