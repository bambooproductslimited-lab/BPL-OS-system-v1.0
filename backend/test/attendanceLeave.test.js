// The attendance roster and report: a day on approved leave with no
// clock-in reads as leave (not absence), and a late arrival says by how
// many minutes after the person's shift start.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var attendance = require('../src/services/attendance.service');
var { buildContext } = require('../src/services/context.service');

var ctx, empId, leaveTypeId;
var LEAVE_DAY = '2031-03-12';   // a Wednesday, far from any seeded data
var LATE_DAY = '2031-03-13';

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0];
  empId = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status, shift_start) " +
    "VALUES ('L8V-1', 'L8V', 'Tester', 'l8v.tester@example.com', $1, 'Tester', 'permanent', '2020-01-01', 'active', '08:00') RETURNING id", [dept.id]
  )).rows[0].id;
  leaveTypeId = (await pool.query('SELECT id FROM leave_types LIMIT 1')).rows[0].id;
  await pool.query(
    "INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES ($1, $2, $3, $3, 1, 'L8V', 'approved')",
    [empId, leaveTypeId, LEAVE_DAY]
  );
  await pool.query(
    "INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1, $2, '08:25', 'late', 'manual')", [empId, LATE_DAY]
  );
});
test.after(async function () {
  await pool.query('DELETE FROM attendance WHERE employee_id = $1', [empId]);
  await pool.query('DELETE FROM leave_requests WHERE employee_id = $1', [empId]);
  await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
  await pool.end();
});

test('a day on approved leave reads as leave, in the roster and the report', async function () {
  var day = await attendance.list(ctx, { date: LEAVE_DAY });
  var row = day.rows.find(function (r) { return r.employeeId === empId; });
  assert.equal(row.status, 'leave');
  assert.equal(row.companyCode, 'BPL');
  var rep = await attendance.report(ctx, LEAVE_DAY, LATE_DAY, {});
  var mine = rep.rows.filter(function (r) { return r.employeeId === empId; });
  assert.equal(mine.find(function (r) { return r.date === LEAVE_DAY; }).status, 'leave');
  assert.equal(mine.find(function (r) { return r.date === LATE_DAY; }).status, 'late');
});

test('a late arrival says how many minutes after the shift start', async function () {
  var day = await attendance.list(ctx, { date: LATE_DAY });
  var row = day.rows.find(function (r) { return r.employeeId === empId; });
  assert.equal(row.shiftStart, '08:00');
  assert.equal(row.minutesLate, 25);
});
