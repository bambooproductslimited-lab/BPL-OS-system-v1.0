// Employees' SSNIT number and TIN (migration 0107): only payroll.manage sees
// or sets them, they are tidied (upper case, no spaces) and checked, two
// people can't share one, and pay runs carry them for filing.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var employees = require('../src/services/employees.service');
var payroll = require('../src/services/payroll.service');
var { buildContext } = require('../src/services/context.service');

var boss, hr, dept, ids = [], runIds = [];
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  hr = limited(boss, ['payroll.manage']);
  dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0].id;
});
test.after(async function () {
  for (var r of runIds) { await pool.query('DELETE FROM payslips WHERE pay_run_id = $1', [r]); await pool.query('DELETE FROM pay_runs WHERE id = $1', [r]); }
  await pool.query('DELETE FROM leave_balances WHERE employee_id = ANY($1::uuid[])', [ids]).catch(function () {});
  await pool.query('DELETE FROM audit_log WHERE entity_id = ANY($1::text[])', [ids]).catch(function () {});
  await pool.query('DELETE FROM employees WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

test('SSNIT number and TIN: payroll.manage only, tidied, checked and unique', async function () {
  var a = await employees.create(boss, { firstName: 'Zqs', lastName: 'One', email: 'zqs.one@example.com', departmentId: dept, positionTitle: 'Zq weaver', hireDate: '2024-01-02', employmentType: 'permanent', ssnitNumber: ' c018306020094 ', tin: 'gha-123456789-0' });
  ids.push(a.id);
  var full = (await employees.list(boss, { q: 'zqs.one' })).find(function (e) { return e.id === a.id; });
  assert.equal(full.ssnitNumber, 'C018306020094');
  assert.equal(full.tin, 'GHA-123456789-0');
  var hidden = (await employees.list(hr, { q: 'zqs.one' })).find(function (e) { return e.id === a.id; });
  assert.equal(hidden.ssnitNumber, undefined, 'without payroll.manage the numbers are not sent');
  assert.equal(hidden.tin, undefined);
  await assert.rejects(employees.update(hr, a.id, { tin: 'P0001234567' }), /payroll.manage/);

  var b = await employees.create(boss, { firstName: 'Zqs', lastName: 'Two', email: 'zqs.two@example.com', departmentId: dept, positionTitle: 'Zq weaver', hireDate: '2024-01-02', employmentType: 'permanent' });
  ids.push(b.id);
  await assert.rejects(employees.update(boss, b.id, { ssnitNumber: 'C018306020094' }), /already on Zqs One/);
  await assert.rejects(employees.update(boss, b.id, { tin: 'gha-123456789-0' }), /already on Zqs One/);
  await assert.rejects(employees.update(boss, b.id, { tin: 'P000/123' }), /letters, numbers and dashes/);
  await employees.update(boss, b.id, { ssnitNumber: 'E041209120012', tin: 'P0001234567' });
  // Cleared with an empty value.
  await employees.update(boss, a.id, { tin: '' });
  var after = (await employees.list(boss, { q: 'zqs' }));
  assert.equal(after.find(function (e) { return e.id === a.id; }).tin, null);
  assert.equal(after.find(function (e) { return e.id === b.id; }).ssnitNumber, 'E041209120012');
});

test('a pay run shows each payslip\'s SSNIT number and TIN', async function () {
  await pool.query("UPDATE employees SET pay_cycle = 'biweekly', daily_rate = 100 WHERE id = ANY($1::uuid[])", [ids]);
  var co = (await pool.query("SELECT c.id FROM companies c JOIN departments d ON d.company_id = c.id WHERE d.id = $1", [dept])).rows[0].id;
  var run = await payroll.create(boss, { cycle: 'biweekly', periodStart: '2018-06-04', periodEnd: '2018-06-17', payDate: '2018-06-20', companyId: co });
  runIds.push(run.id);
  var slip = run.payslips.find(function (s) { return s.employeeId === ids[1]; });
  assert.equal(slip.ssnitNumber, 'E041209120012');
  assert.equal(slip.tin, 'P0001234567');
});
