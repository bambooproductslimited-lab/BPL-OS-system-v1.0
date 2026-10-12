// The attendance roster and report on a public holiday: no clock-in on one
// of your company's holidays reads as holiday (not absent), someone who
// comes in that day is present as usual, and another company's staff are
// not on that company's holiday. Holiday beats leave and the rest day.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var attendance = require('../src/services/attendance.service');
var { buildContext } = require('../src/services/context.service');

var ctx, home, came, elsewhere, bpl, holidayId, leaveTypeId;
var HOLIDAY = '2031-04-16';   // a Wednesday, far from any seeded data
var AFTER = '2031-04-17';

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query("SELECT d.id, d.company_id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0];
  bpl = dept.company_id;
  var other = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code <> 'BPL' LIMIT 1")).rows[0];
  async function emp(code, deptId) {
    return (await pool.query(
      "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status, shift_start) " +
      "VALUES ($1, 'H0L', $1, $2, $3, 'Tester', 'permanent', '2020-01-01', 'active', '08:00') RETURNING id", [code, code.toLowerCase() + '@example.com', deptId])).rows[0].id;
  }
  home = await emp('H0L-1', dept.id);
  came = await emp('H0L-2', dept.id);
  elsewhere = await emp('H0L-3', other.id);
  holidayId = (await pool.query("INSERT INTO holidays (company_id, date, name) VALUES ($1, $2, 'H0L Founders Day') RETURNING id", [bpl, HOLIDAY])).rows[0].id;
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1, $2, '07:55', 'present', 'manual')", [came, HOLIDAY]);
  // leave over the holiday: still the holiday that day
  leaveTypeId = (await pool.query('SELECT id FROM leave_types LIMIT 1')).rows[0].id;
  await pool.query("INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES ($1, $2, $3, $4, 1, 'H0L', 'approved')", [home, leaveTypeId, HOLIDAY, AFTER]);
});
test.after(async function () {
  var ids = [home, came, elsewhere];
  await pool.query('DELETE FROM attendance WHERE employee_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM leave_requests WHERE employee_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [ids]);
  await pool.query('DELETE FROM holidays WHERE id = $1', [holidayId]);
  await pool.end();
});

test('a public holiday with no clock-in reads as holiday, with its name, in the roster and the report', async function () {
  var day = await attendance.list(ctx, { date: HOLIDAY });
  var row = function (id) { return day.rows.find(function (r) { return r.employeeId === id; }); };
  assert.deepEqual([row(home).status, row(home).holiday], ['holiday', 'H0L Founders Day'], 'holiday beats leave');
  assert.equal(row(came).status, 'present', 'someone who came in that day is present');
  assert.equal(row(elsewhere).status, 'absent', 'another company\'s staff are not on this company\'s holiday');

  var rep = await attendance.report(ctx, HOLIDAY, AFTER, {});
  var at = function (id, date) { return rep.rows.find(function (r) { return r.employeeId === id && r.date === date; }); };
  assert.deepEqual([at(home, HOLIDAY).status, at(home, HOLIDAY).holiday], ['holiday', 'H0L Founders Day']);
  assert.equal(at(home, AFTER).status, 'leave', 'the day after is leave again');
  assert.deepEqual([at(came, HOLIDAY).status, at(elsewhere, HOLIDAY).status, at(elsewhere, AFTER).holiday], ['present', 'absent', null]);
});

test('the highlights do not count a holiday as a missed day', async function () {
  var h = await attendance.highlights(ctx, { date: HOLIDAY });
  var t = h.trend.find(function (x) { return x.date === HOLIDAY; });
  var bplStaff = (await pool.query("SELECT count(*)::int AS n FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.company_id = $1 AND e.status <> 'terminated'", [bpl])).rows[0].n;
  assert.ok(t.expected <= h.scopeSize - bplStaff + 1, 'Bamboo Products staff off for the holiday are not expected (' + t.expected + ' of ' + h.scopeSize + ')');
  assert.ok(t.came >= 1);
});
