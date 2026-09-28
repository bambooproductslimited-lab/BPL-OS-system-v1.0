// Company pays PAYE (migration 0106): a company can pay its staff's PAYE
// itself. Their payslips still work out PAYE and owe it to GRA, but it is
// not taken off take-home pay; it counts as a cost to the company instead.
// Switching it changes draft runs at once and never an approved or paid one.
// Own company (ZQY) whose staff are active only while its run is made, so
// the other payroll tests' all-company runs never pick them up.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var payroll = require('../src/services/payroll.service');
var reports = require('../src/services/reports.service');
var { buildContext } = require('../src/services/context.service');

var boss, viewer, co, empIds = [];
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}
async function cleanup() {
  await pool.query("DELETE FROM payslips WHERE pay_run_id IN (SELECT id FROM pay_runs WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQY'))");
  await pool.query("DELETE FROM pay_runs WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQY')");
  await pool.query("DELETE FROM payslips WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQY-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQY-%'");
  await pool.query("DELETE FROM departments WHERE code = 'ZQYF'");
  await pool.query("DELETE FROM customers WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQY')");
  await pool.query("DELETE FROM companies WHERE code = 'ZQY'");
}
async function makeRun(start, end) {
  await pool.query("UPDATE employees SET status = 'active' WHERE id = ANY($1::uuid[])", [empIds]);
  try { return await payroll.create(boss, { cycle: 'monthly', periodStart: start, periodEnd: end, payDate: end, companyId: co }); }
  finally { await pool.query("UPDATE employees SET status = 'inactive' WHERE id = ANY($1::uuid[])", [empIds]); }
}
async function withDays(run, days) {
  var r = run;
  for (var s of run.payslips) r = await payroll.editSlip(boss, run.id, s.employeeId, days);
  return r;
}

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  viewer = limited(boss, ['payroll.manage']);
  await cleanup();
  co = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQY', 'Zqy Weavers') RETURNING id")).rows[0].id;
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQYF', 'Zqy Floor', $1) RETURNING id", [co])).rows[0].id;
  // A customer makes it a trading company, so it has a Reports page.
  await pool.query("INSERT INTO customers (name, company_id) VALUES ('Zqy Buyer', $1)", [co]);
  for (var i = 1; i <= 2; i++) {
    empIds.push((await pool.query(
      "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, pay_cycle, daily_rate) " +
      "VALUES ($1, 'Zq Ama', 'Weaver' || $2, $3, $4, '2020-01-01', 'inactive', 'permanent', 'monthly', 150) RETURNING id",
      ['ZQY-' + i, String(i), 'zqy' + i + '@example.com', dept])).rows[0].id);
  }
});
test.after(async function () { await cleanup(); await pool.end(); });

test('staff pay their own PAYE by default; with the company paying, take-home keeps it and the cost carries it', async function () {
  var policy = await payroll.payePolicy(viewer);
  assert.equal(policy.find(function (c) { return c.id === co; }).paysStaffPaye, false);

  // Staff pay: net = gross - SSNIT - PAYE.
  var own = await withDays(await makeRun('2019-01-01', '2019-01-31'), 22);
  var s = own.payslips[0];
  assert.ok(s.payeTax > 0, 'there is PAYE to pay');
  assert.equal(s.payeByCompany, false);
  assert.equal(s.netPay, Math.round((s.grossPay - s.ssnitEmployee - s.payeTax) * 100) / 100);
  assert.equal(own.totals.cost, Math.round((own.totals.gross + own.totals.ssnitEmployer) * 100) / 100);
  await payroll.approve(boss, own.id);

  // A draft made before the switch.
  var draft = await withDays(await makeRun('2019-02-01', '2019-02-28'), 20);
  assert.equal(draft.payslips[0].payeByCompany, false);

  await assert.rejects(payroll.setPayePolicy(viewer, co, true), /payroll.manage/);
  await assert.rejects(payroll.setPayePolicy(boss, co, 'yes'), /PAYE/);
  var set = await payroll.setPayePolicy(boss, co, true);
  assert.equal(set.companies.find(function (c) { return c.id === co; }).paysStaffPaye, true);
  assert.equal(set.draftPayslipsUpdated, 2);

  // The draft now has the company paying; the approved run is untouched.
  var d2 = await payroll.get(boss, draft.id);
  d2.payslips.forEach(function (p) {
    assert.equal(p.payeByCompany, true);
    assert.equal(p.netPay, Math.round((p.grossPay - p.ssnitEmployee) * 100) / 100);
  });
  var o2 = await payroll.get(boss, own.id);
  assert.equal(o2.payslips[0].payeByCompany, false);
  assert.equal(o2.totals.net, own.totals.net);

  // A new run: PAYE still worked out and owed to GRA, not taken from pay, part of the cost.
  var paid = await withDays(await makeRun('2019-03-01', '2019-03-31'), 22);
  var p = paid.payslips[0];
  assert.equal(p.payeByCompany, true);
  assert.equal(p.payeTax, s.payeTax);
  assert.equal(p.netPay, Math.round((p.grossPay - p.ssnitEmployee) * 100) / 100);
  assert.equal(paid.totals.payeByCompany, paid.totals.paye);
  assert.equal(paid.totals.cost, Math.round((paid.totals.gross + paid.totals.ssnitEmployer + paid.totals.paye) * 100) / 100);
  var listed = (await payroll.list(boss, { companyId: co })).find(function (r) { return r.id === paid.id; });
  assert.equal(listed.totals.cost, paid.totals.cost);
  assert.equal(listed.totals.payeByCompany, paid.totals.paye);

  // Editing days keeps the company paying.
  var edited = await payroll.editSlip(boss, paid.id, p.employeeId, 10);
  var e = edited.payslips.find(function (x) { return x.employeeId === p.employeeId; });
  assert.equal(e.netPay, Math.round((e.grossPay - e.ssnitEmployee) * 100) / 100);

  // Switching back: drafts go back to staff paying.
  await payroll.setPayePolicy(boss, co, false);
  var back = await payroll.get(boss, paid.id);
  back.payslips.forEach(function (x) { assert.equal(x.payeByCompany, false); assert.equal(x.netPay, Math.round((x.grossPay - x.ssnitEmployee - x.payeTax) * 100) / 100); });
});

test('reports count PAYE the company pays as payroll cost', async function () {
  await payroll.setPayePolicy(boss, co, true);
  var run = await withDays(await makeRun('2019-04-01', '2019-04-30'), 22);
  await payroll.approve(boss, run.id);
  var r = await reports.summary(boss, { company: 'ZQY', from: '2019-04-01', to: '2019-04-30' });
  assert.equal(r.payroll.payeByCompany, run.totals.paye);
  assert.equal(r.payroll.cost, run.totals.cost);
});
