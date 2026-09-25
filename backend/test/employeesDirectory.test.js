// The employee directory list: each person's photo version, who is on
// approved leave today (and until when), and — for HR only — whether they
// can sign in.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var employees = require('../src/services/employees.service');
var { buildContext } = require('../src/services/context.service');

var ctx, empId;

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0];
  empId = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status, photo_key, photo_updated_at) " +
    "VALUES ('DIR-1', 'Dirq', 'Tester', 'dirq.tester@example.com', $1, 'Tester', 'permanent', CURRENT_DATE - 3, 'active', 'db:00000000-0000-0000-0000-000000000000', '2031-01-02T03:04:05Z') RETURNING id", [dept.id]
  )).rows[0].id;
  var leaveTypeId = (await pool.query('SELECT id FROM leave_types LIMIT 1')).rows[0].id;
  await pool.query(
    "INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES ($1, $2, CURRENT_DATE - 1, CURRENT_DATE + 2, 4, 'DIR', 'approved')",
    [empId, leaveTypeId]
  );
});
test.after(async function () {
  await pool.query('DELETE FROM leave_requests WHERE employee_id = $1', [empId]);
  await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
  await pool.end();
});

test('the list carries the photo version, leave today and, for HR, sign-in', async function () {
  var list = await employees.list(ctx, { q: 'dirq' });
  assert.equal(list.length, 1);
  var e = list[0];
  assert.equal(e.photo, new Date('2031-01-02T03:04:05Z').getTime());
  var until = (await pool.query("SELECT to_char(CURRENT_DATE + 2, 'YYYY-MM-DD') AS d")).rows[0].d;
  assert.equal(e.onLeaveUntil, until);
  assert.equal(e.login, null); // no account

  var mine = (await employees.list(ctx, { q: 'kelvin' })).find(function (x) { return x.email === 'kelvin.duho@bplghana.com'; });
  assert.equal(mine.onLeaveUntil, null);
  assert.equal(mine.login.status, 'active');
});

test('people without employee.write do not see sign-in details', async function () {
  var limited = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
    can: function (p) { return p !== 'employee.write' && ctx.can(p); }
  });
  var list = await employees.list(limited, { q: 'dirq' });
  assert.equal(list.length, 1);
  assert.equal('login' in list[0], false);
  assert.ok(list[0].onLeaveUntil);
});
