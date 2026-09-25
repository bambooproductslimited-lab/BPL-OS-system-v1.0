// Payroll runs: overlapping runs on the same cycle are refused (they would
// pay the same people twice), a draft can be deleted but an approved run
// can't, edited days can't exceed the period, and each run carries its
// totals — cost is gross plus the employer's SSNIT — and who approved it.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var payroll = require('../src/services/payroll.service');
var { buildContext } = require('../src/services/context.service');

var boss, made = [];
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
});
test.after(async function () {
  for (var i = 0; i < made.length; i++) {
    await pool.query('DELETE FROM payslips WHERE pay_run_id = $1', [made[i]]);
    await pool.query('DELETE FROM pay_runs WHERE id = $1', [made[i]]);
  }
  await pool.end();
});

test('overlap refused, drafts deletable, days capped, totals and approver', async function () {
  var run = await payroll.create(boss, { cycle: 'monthly', periodStart: '2024-03-01', periodEnd: '2024-03-31', payDate: '2024-04-05' });
  made.push(run.id);
  assert.equal(run.periodDays, 31);
  assert.ok(run.payslips.length > 0);
  var t = run.totals;
  assert.equal(t.cost, Math.round((t.gross + t.ssnitEmployer) * 100) / 100);
  assert.equal(t.net, Math.round(run.payslips.reduce(function (a, s) { return a + s.netPay; }, 0) * 100) / 100);

  await assert.rejects(payroll.create(boss, { cycle: 'monthly', periodStart: '2024-03-15', periodEnd: '2024-04-14' }), /already pays/);
  var company = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0];
  await assert.rejects(payroll.create(boss, { cycle: 'monthly', periodStart: '2024-03-10', periodEnd: '2024-03-20', companyId: company.id }), /already pays/);

  var slip = run.payslips[0];
  await assert.rejects(payroll.editSlip(boss, run.id, slip.employeeId, 32), /only has 31 days/);
  var edited = await payroll.editSlip(boss, run.id, slip.employeeId, 20);
  assert.equal(edited.payslips.find(function (s) { return s.employeeId === slip.employeeId; }).daysWorked, 20);

  assert.equal(await payroll.remove(boss, run.id), true);
  made = [];
  var again = await payroll.create(boss, { cycle: 'monthly', periodStart: '2024-03-01', periodEnd: '2024-03-31' });
  made.push(again.id);
  await payroll.approve(boss, again.id);
  await assert.rejects(payroll.remove(boss, again.id), /Only a draft/);
  var row = (await payroll.list(boss, {})).find(function (r) { return r.id === again.id; });
  assert.ok(row.approvedByName);
  assert.equal(row.totals.cost, Math.round((row.totals.gross + row.totals.ssnitEmployer) * 100) / 100);
  assert.equal(typeof row.zeroDays, 'number');
});
