// The HR leave overview: every active employee's balance per active leave
// type for a year (a stored row, or a preview from their own figure or the
// type's default), their agreed total against what is split, and the
// year's public holidays. HR only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var leave = require('../src/services/leave.service');
var { buildContext } = require('../src/services/context.service');

var YEAR = 2033;
var ctx, empId, paidType, otherType, holidayId, companyId;

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query("SELECT d.id, d.company_id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0];
  companyId = dept.company_id;
  empId = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status, leave_days_total) " +
    "VALUES ('LOV-1', 'Lov', 'Tester', 'lov.tester@example.com', $1, 'Tester', 'permanent', '2020-01-01', 'active', 30) RETURNING id", [dept.id]
  )).rows[0].id;
  var types = (await pool.query('SELECT id, days_per_year FROM leave_types WHERE active AND paid ORDER BY name LIMIT 2')).rows;
  paidType = types[0]; otherType = types[1];
  await pool.query('INSERT INTO employee_leave_entitlements (employee_id, leave_type_id, days_per_year) VALUES ($1, $2, 7)', [empId, paidType.id]);
  await pool.query('INSERT INTO leave_balances (employee_id, leave_type_id, year, entitled, used) VALUES ($1, $2, $3, 7, 2)', [empId, paidType.id, YEAR]);
  holidayId = (await pool.query("INSERT INTO holidays (company_id, date, name) VALUES ($1, '2033-03-06', 'Lov Day') RETURNING id", [companyId])).rows[0].id;
});
test.after(async function () {
  await pool.query('DELETE FROM holidays WHERE id = $1', [holidayId]);
  await pool.query('DELETE FROM leave_balances WHERE employee_id = $1', [empId]);
  await pool.query('DELETE FROM employee_leave_entitlements WHERE employee_id = $1', [empId]);
  await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
  await pool.end();
});

test('everyone\'s balances for a year, with previews and holidays', async function () {
  var ov = await leave.overview(ctx, YEAR);
  assert.equal(ov.year, YEAR);
  assert.ok(ov.types.length >= 2);
  var e = ov.employees.find(function (x) { return x.id === empId; });
  assert.equal(e.name, 'Lov Tester');
  assert.equal(e.companyCode, 'BPL');
  assert.equal(e.granted, true);
  assert.equal(e.customCount, 1);
  assert.equal(e.leaveDaysTotal, 30);
  var own = e.balances.find(function (b) { return b.leaveTypeId === paidType.id; });
  assert.deepEqual([own.entitled, own.used, own.hasRow, own.custom], [7, 2, true, true]);
  var preview = e.balances.find(function (b) { return b.leaveTypeId === otherType.id; });
  assert.deepEqual([preview.entitled, preview.used, preview.hasRow, preview.custom], [otherType.days_per_year, 0, false, false]);
  var expectedAllocated = ov.types.reduce(function (n, t) { return n + (t.id === paidType.id ? 7 : t.daysPerYear); }, 0);
  assert.equal(e.allocated, expectedAllocated);
  assert.ok(ov.holidays.some(function (h) { return h.id === holidayId && h.date === '2033-03-06' && h.companyId === companyId; }));
});

test('only HR can see it', async function () {
  var limited = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
    can: function (p) { return p !== 'employee.write' && ctx.can(p); }
  });
  await assert.rejects(function () { return leave.overview(limited, YEAR); }, /employee\.write/);
});
