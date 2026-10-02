/*
 * One yearly leave total (leavePool.service.js): the days agreed with the
 * employee (or the company default) less that year's company holidays;
 * annual, compassionate and sick leave all from it; more than is left is
 * allowed and owed; HR settles what is owed. Uses Alice in 2031–2032 with
 * holidays named "ZLP", removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var leave = require('../src/services/leave.service');
var lp = require('../src/services/leavePool.service');
var approvals = require('../src/services/approvals.service');

var alice, kelvin, companyId, annual, sick, maternity, unpaid, savedTotal, savedDefault;
var HOLIDAYS_2031 = ['2031-01-01', '2031-01-07', '2031-02-14', '2031-03-06', '2031-04-18', '2031-04-21', '2031-05-01', '2031-05-25',
  '2031-07-01', '2031-08-04', '2031-09-21', '2031-12-25', '2031-12-26']; // 13

async function cleanup() {
  if (!alice) return;
  await pool.query("DELETE FROM approvals WHERE subject_type = 'leave_request' AND subject_id IN (SELECT id FROM leave_requests WHERE employee_id = $1 AND start_date >= '2031-01-01')", [alice.employee.id]);
  await pool.query("DELETE FROM leave_requests WHERE employee_id = $1 AND start_date >= '2031-01-01'", [alice.employee.id]);
  await pool.query('DELETE FROM leave_owed_settlements WHERE employee_id = $1', [alice.employee.id]);
  await pool.query("DELETE FROM holidays WHERE name LIKE 'ZLP%'");
}
test.before(async function () {
  alice = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'alice.kamau@bplghana.com'")).rows[0].id);
  kelvin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await cleanup();
  companyId = (await pool.query('SELECT company_id FROM departments WHERE id = $1', [alice.employee.department_id])).rows[0].company_id;
  savedTotal = (await pool.query('SELECT leave_days_total FROM employees WHERE id = $1', [alice.employee.id])).rows[0].leave_days_total;
  savedDefault = (await pool.query('SELECT leave_days_default FROM companies WHERE id = $1', [companyId])).rows[0].leave_days_default;
  await pool.query('UPDATE employees SET leave_days_total = 14 WHERE id = $1', [alice.employee.id]);
  for (var d of HOLIDAYS_2031) await pool.query("INSERT INTO holidays (company_id, date, name) VALUES ($1, $2, 'ZLP holiday') ON CONFLICT DO NOTHING", [companyId, d]);
  var types = (await pool.query('SELECT * FROM leave_types WHERE active')).rows;
  annual = types.find(function (t) { return /annual/i.test(t.name); });
  sick = types.find(function (t) { return /sick/i.test(t.name); });
  maternity = types.find(function (t) { return /matern/i.test(t.name); });
  unpaid = types.find(function (t) { return !t.paid; });
});
test.after(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET leave_days_total = $2 WHERE id = $1', [alice.employee.id, savedTotal]);
  await pool.query('UPDATE companies SET leave_days_default = $2 WHERE id = $1', [companyId, savedDefault]);
  await pool.end();
});

test('the holidays come out of the total: 14 with 13 holidays leaves 1; each year counts its own', async function () {
  assert.equal(annual.in_pool, true);
  assert.equal(sick.in_pool, true);
  assert.equal(maternity.in_pool, false, 'maternity/paternity stays outside');
  assert.equal(unpaid.in_pool, false, 'unpaid stays outside');
  var p = await lp.poolFor(alice.employee.id, 2031);
  assert.deepEqual([p.total, p.totalFrom, p.holidays, p.available, p.used, p.left, p.owed], [14, 'employee', 13, 1, 0, 1, 0]);
  var next = await lp.poolFor(alice.employee.id, 2032);
  assert.deepEqual([next.holidays, next.available], [0, 14], '2032 has no holidays entered: the full total');
});

test('more than is left is allowed, said before and after, and owed once approved', async function () {
  // Mon 3 – Wed 5 March 2031: 3 working days.
  var pv = await lp.previewRequest(alice, { leaveTypeId: annual.id, startDate: '2031-03-03', endDate: '2031-03-05' });
  assert.deepEqual([pv.days, pv.inPool, pv.wouldOwe], [3, true, 2]);
  var r = await leave.requestLeave(alice, { leaveTypeId: annual.id, startDate: '2031-03-03', endDate: '2031-03-05', reason: 'ZLP family' });
  assert.equal(r.status, 'pending', 'not refused');
  assert.equal(r.wouldOwe, 2);

  // The approver sees it.
  var ap = (await pool.query("SELECT id FROM approvals WHERE subject_type = 'leave_request' AND subject_id = $1", [r.id])).rows[0];
  var q = await approvals.queue(kelvin, {});
  var item = q.find(function (a) { return a.subjectId === r.id; });
  assert.ok(ap && item, 'in the queue');
  assert.equal(item.facts.pool.wouldOwe, 2);
  assert.equal(item.facts.pool.left, 1);

  await leave.decide(kelvin, r.id, 'approved', '');
  var p = await lp.poolFor(alice.employee.id, 2031);
  assert.deepEqual([p.used, p.left, p.owed, p.owedOutstanding], [3, 0, 2, 2]);
});

test('sick leave is from the same total; a holiday inside leave is not charged; a holiday added later changes the balance', async function () {
  // Thu 6 March is a holiday: Thu 6 – Fri 7 is 1 working day.
  var pv = await lp.previewRequest(alice, { leaveTypeId: sick.id, startDate: '2031-03-06', endDate: '2031-03-07' });
  assert.deepEqual([pv.days, pv.wouldOwe], [1, 3]);
  // A holiday added during the year: one more day owed, at once.
  await pool.query("INSERT INTO holidays (company_id, date, name) VALUES ($1, '2031-10-10', 'ZLP extra')", [companyId]);
  var p = await lp.poolFor(alice.employee.id, 2031);
  assert.deepEqual([p.holidays, p.available, p.owed], [14, 0, 3]);
  await pool.query("DELETE FROM holidays WHERE name = 'ZLP extra'");
});

test('HR sees who owes and settles it; outside the pool the old rules stay', async function () {
  var list = await lp.owedList(kelvin, 2031);
  var me = list.people.find(function (x) { return x.employeeId === alice.employee.id; });
  assert.equal(me.owedOutstanding, 2);
  await assert.rejects(lp.settle(kelvin, { employeeId: alice.employee.id, year: 2031, how: 'pay', days: 3 }), /Only 2 day/);
  await assert.rejects(lp.settle(kelvin, { employeeId: alice.employee.id, year: 2031, how: 'other' }), /Say how/);
  var after = await lp.settle(kelvin, { employeeId: alice.employee.id, year: 2031, how: 'pay', note: 'October payroll' });
  assert.deepEqual([after.owed, after.settled, after.owedOutstanding], [2, 2, 0]);
  await assert.rejects(lp.settle(kelvin, { employeeId: alice.employee.id, year: 2031, how: 'waived' }), /Nothing is owed/);
  var list2 = await lp.owedList(kelvin, 2031);
  var me2 = list2.people.find(function (x) { return x.employeeId === alice.employee.id; });
  assert.equal(me2.settlements[0].how, 'pay');
  await assert.rejects(lp.owedList(alice, 2031), /employee\.write/);

  // Unpaid leave: no limit, nothing owed.
  var pv = await lp.previewRequest(alice, { leaveTypeId: unpaid.id, startDate: '2031-06-02', endDate: '2031-06-06' });
  assert.deepEqual([pv.inPool, pv.wouldOwe], [false, 0]);
});

test('no own total: the company default; neither: no pool, the per-type allowances as before', async function () {
  await pool.query('UPDATE employees SET leave_days_total = NULL WHERE id = $1', [alice.employee.id]);
  await lp.setCompanyDefault(kelvin, companyId, 20);
  var p = await lp.poolFor(alice.employee.id, 2031);
  assert.deepEqual([p.total, p.totalFrom, p.available], [20, 'company', 7]);
  var defaults = await lp.companyDefaults(kelvin, 2031);
  assert.equal(defaults.find(function (c) { return c.companyId === companyId; }).holidays, 13);
  await lp.setCompanyDefault(kelvin, companyId, null);
  var none = await lp.poolFor(alice.employee.id, 2031);
  assert.equal(none.inEffect, false);
  await assert.rejects(lp.setCompanyDefault(kelvin, companyId, -1), /whole number/);
  await assert.rejects(lp.setCompanyDefault(alice, companyId, 10), /employee\.write/);
  await pool.query('UPDATE employees SET leave_days_total = 14 WHERE id = $1', [alice.employee.id]);
});
