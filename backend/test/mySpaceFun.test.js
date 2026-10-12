// My space's livelier facts: the on-time streak and best run, this week's
// hours, what is coming up (next leave, public holiday, birthday, work
// anniversary) and the team. On a throwaway employee of its own.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var mySpace = require('../src/services/mySpace.service');
var { buildContext } = require('../src/services/context.service');

var me, empId, deptId, companyId, holidayId;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function yearsAgo(n, plusDays) { var d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); d.setUTCDate(d.getUTCDate() + plusDays); return d.toISOString().slice(0, 10); }

test.before(async function () {
  var alice = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'alice.kamau@bplghana.com'")).rows[0].id);
  deptId = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [alice.employee.id])).rows[0].department_id;
  companyId = (await pool.query('SELECT company_id FROM departments WHERE id = $1', [deptId])).rows[0].company_id;
  empId = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, date_of_birth, status) VALUES ('ZQF-1','Zq','Funny','zqf.1@example.com',$1,'Tester','permanent',$2,$3,'active') RETURNING id",
    [deptId, yearsAgo(3, 5), yearsAgo(30, 10)])).rows[0].id;
  me = Object.assign(Object.create(Object.getPrototypeOf(alice)), alice, { employee: Object.assign({}, alice.employee, { id: empId }) });
  // Newest first: on time, on time, on time, late, on time — a run of 3 now.
  var plan = [[-2, 'present'], [-4, 'present'], [-6, 'present'], [-8, 'late'], [-10, 'present']];
  for (var i = 0; i < plan.length; i++) {
    await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status) VALUES ($1, $2, '08:00', '16:30', $3)", [empId, day(plan[i][0]), plan[i][1]]);
  }
  var type = (await pool.query('SELECT id FROM leave_types LIMIT 1')).rows[0].id;
  await pool.query("INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, status) VALUES ($1,$2,$3,$4,3,'approved')", [empId, type, day(4), day(6)]);
  holidayId = (await pool.query("INSERT INTO holidays (company_id, date, name) VALUES ($1, $2, 'Zqf Founders Day') RETURNING id", [companyId, day(6)])).rows[0].id;
});
test.after(async function () {
  await pool.query('DELETE FROM attendance WHERE employee_id = $1', [empId]);
  await pool.query('DELETE FROM leave_requests WHERE employee_id = $1', [empId]);
  await pool.query('DELETE FROM holidays WHERE id = $1', [holidayId]);
  await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
  await pool.end();
});

test('the streak counts clock-ins in a row on time; the week adds up its hours', async function () {
  var f = (await mySpace.overview(me)).fun;
  assert.equal(f.streak, 3);
  assert.equal(f.bestStreak, 3);
  assert.equal(f.week.length, 7);
  var monday = f.week[0].date;
  assert.equal(new Date(monday + 'T00:00:00Z').getUTCDay(), 1, 'the week starts on Monday');
  var inWeek = [-2, -4, -6, -8, -10].map(day).filter(function (d) { return d >= monday && d <= day(0); }).length;
  assert.equal(f.weekHours, inWeek * 8.5);
  assert.ok(f.week.every(function (d) { return d.future === (d.date > day(0)); }));
});

test('coming up: next leave, the public holiday, birthday and work anniversary; and the team', async function () {
  var f = (await mySpace.overview(me)).fun;
  assert.deepEqual([f.nextLeave.daysTo, f.nextLeave.days, f.nextLeave.onNow], [4, 3, false]);
  assert.deepEqual([f.nextHoliday.name, f.nextHoliday.daysTo], ['Zqf Founders Day', 6]);
  assert.equal(f.birthday.daysTo, 10);
  assert.deepEqual([f.anniversary.daysTo, f.anniversary.years], [5, 3]);
  assert.ok(f.team.size >= 1, 'others in the department');
  assert.ok(f.team.people.every(function (p) { return p.id !== empId; }), 'not themselves');
});

test('a yearly date on 29 February falls on 28 February in other years', function () {
  assert.deepEqual(mySpace._nextYearly('2000-02-29', '2027-01-10'), { date: '2027-02-28', daysTo: 49, years: 27 });
  assert.deepEqual(mySpace._nextYearly('2000-02-29', '2028-01-10'), { date: '2028-02-29', daysTo: 50, years: 28 });
  assert.equal(mySpace._nextYearly('2010-03-05', '2026-03-05').daysTo, 0);
});
