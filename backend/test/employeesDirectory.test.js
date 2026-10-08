// The employee directory list: each person's photo version, who is on
// approved leave today (and until when), who has the OS open right now,
// — for HR only — whether they can sign in, and — for whoever may see
// everyone's attendance — today's clock-in.
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
  await pool.query('DELETE FROM attendance WHERE employee_id = $1', [empId]);
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

test('who has the OS open right now, and today\'s clock-in for those who may see attendance', async function () {
  var find = async function (c) { return (await employees.list(c, { q: 'dirq' }))[0]; };
  assert.equal((await find(ctx)).online, false);
  assert.equal((await find(ctx)).today, null, 'not clocked in');
  await pool.query("UPDATE employees SET last_seen_at = now() - interval '30 seconds' WHERE id = $1", [empId]);
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1, $2, '07:52', 'present', 'manual')", [empId, new Date().toISOString().slice(0, 10)]);
  var e = await find(ctx);
  assert.equal(e.online, true);
  assert.deepEqual(e.today, { status: 'present', clockIn: '07:52', clockOut: null });
  await pool.query("UPDATE employees SET last_seen_at = now() - interval '10 minutes' WHERE id = $1", [empId]);
  assert.equal((await find(ctx)).online, false, 'seen ten minutes ago is not online');
  var noAttendance = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
    can: function (p) { return p !== 'attendance.read.all' && ctx.can(p); }
  });
  assert.equal('today' in (await find(noAttendance)), false, 'no attendance permission, no clock-in shown');
});

test('a date of birth: colleagues see the birthday, only HR and the person see the year', async function () {
  await employees.update(ctx, empId, { dateOfBirth: '1990-03-14' });
  var hr = (await employees.list(ctx, { q: 'dirq' }))[0];
  assert.deepEqual([hr.birthday, hr.dateOfBirth], ['03-14', '1990-03-14']);
  var colleague = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
    can: function (p) { return p !== 'employee.write' && ctx.can(p); }
  });
  var seen = (await employees.list(colleague, { q: 'dirq' }))[0];
  assert.equal(seen.birthday, '03-14');
  assert.equal('dateOfBirth' in seen, false, 'no year for a colleague');
  var self = Object.assign(Object.create(Object.getPrototypeOf(colleague)), colleague, { employee: Object.assign({}, ctx.employee, { id: empId }) });
  assert.equal((await employees.list(self, { q: 'dirq' }))[0].dateOfBirth, '1990-03-14', 'the person sees their own');

  // Checked: a real date, between 14 and 100 years ago; empty clears it.
  await assert.rejects(employees.update(ctx, empId, { dateOfBirth: '1990-02-30' }), /valid date/);
  await assert.rejects(employees.update(ctx, empId, { dateOfBirth: new Date(Date.now() + 86400000).toISOString().slice(0, 10) }), /check the year/);
  await assert.rejects(employees.update(ctx, empId, { dateOfBirth: '1890-01-01' }), /check the year/);
  await employees.update(ctx, empId, { dateOfBirth: '' });
  var cleared = (await employees.list(ctx, { q: 'dirq' }))[0];
  assert.deepEqual([cleared.birthday, cleared.dateOfBirth], [null, null]);
});
