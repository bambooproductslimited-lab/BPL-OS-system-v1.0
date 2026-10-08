// The attendance screen's highlights (attendance.service.js highlights()):
// the 14-day trend, on-time streaks (leave neither counts nor breaks a run;
// today, someone not in yet keeps yesterday's run), the day's early birds
// against their own shift start, the days of the week, perfect attendance
// and punctuality. Test data: its own company (ZAH) and "Zah" people, on
// days far from any other test's, all removed afterwards.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var attendance = require('../src/services/attendance.service');
var { buildContext } = require('../src/services/context.service');

var ctx, co, dept, emp = {};
var D = '2031-06-30';   // a Monday
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function today() { return new Date().toISOString().slice(0, 10); }

async function cleanup() {
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZAH-%')");
  await pool.query("DELETE FROM leave_requests WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZAH-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZAH-%'");
  await pool.query("DELETE FROM departments WHERE code = 'ZAH-D'");
  await pool.query("DELETE FROM companies WHERE code = 'ZAH'");
}
async function person(code, first, shift) {
  return (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status, shift_start) " +
    "VALUES ($1, $2, 'Zah', $3, $4, 'Tester', 'permanent', '2020-01-01', 'active', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, shift])).rows[0].id;
}
async function day(id, date, status, clockIn) {
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1, $2, $3, $4, 'manual')", [id, date, clockIn || (status === 'late' ? '08:40' : '07:58'), status]);
}

test.before(async function () {
  await cleanup();
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  co = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZAH', 'Zah Works') RETURNING id")).rows[0].id;
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZAH-D', 'Zah Floor', $1) RETURNING id", [co])).rows[0].id;
  emp.ama = await person('ZAH-1', 'Ama', '08:00');
  emp.kofi = await person('ZAH-2', 'Kofi', '08:00');
  emp.esi = await person('ZAH-3', 'Esi', '08:00');
  emp.yaw = await person('ZAH-4', 'Yaw', null);
  // Ama: on time for 30 days but late 10 days before; in at 07:30 on the day.
  for (var i = 1; i < 30; i++) await day(emp.ama, addDays(D, -i), i === 10 ? 'late' : 'present');
  await day(emp.ama, D, 'present', '07:30');
  // Kofi: on time every one of the 30 days; 07:50 on the day.
  for (i = 1; i < 30; i++) await day(emp.kofi, addDays(D, -i), 'present');
  await day(emp.kofi, D, 'present', '07:50');
  // Esi: on time for the last five days but one, which was approved leave.
  for (i of [4, 3, 1]) await day(emp.esi, addDays(D, -i), 'present');
  await day(emp.esi, D, 'present', '07:59');
  var lt = (await pool.query('SELECT id FROM leave_types LIMIT 1')).rows[0].id;
  await pool.query("INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES ($1, $2, $3, $3, 1, 'Zah', 'approved')", [emp.esi, lt, addDays(D, -2)]);
  // Yaw: no shift; came in once, late, on the day.
  await day(emp.yaw, D, 'late', '09:15');
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the trend, streaks, early birds, weekdays, perfect attendance and punctuality', async function () {
  var h = await attendance.highlights(ctx, { date: D, departmentId: dept });
  assert.deepEqual([h.date, h.from, h.days, h.partial, h.scopeSize], [D, addDays(D, -29), 30, false, 4]);

  // The last 14 days: on the day all four came, one late; two days before,
  // Esi was on leave (not expected) and Yaw missed it.
  assert.equal(h.trend.length, 14);
  assert.deepEqual(h.trend[13], { date: D, came: 4, late: 1, expected: 4, rate: 100 });
  assert.deepEqual(h.trend[11], { date: addDays(D, -2), came: 2, late: 0, expected: 3, rate: 67 });

  // On-time runs: Kofi all 30 days, Ama 10 (since her late day), Esi 4
  // (her leave day neither counts nor breaks it); Yaw none.
  assert.deepEqual(h.streaks.map(function (s) { return [s.name, s.days, s.wholeWindow]; }), [['Kofi Zah', 30, true], ['Ama Zah', 10, false], ['Esi Zah', 4, false]]);
  assert.equal(h.onStreak, 2);
  assert.equal(h.streaks[0].department, 'Zah Floor');

  // Early birds against their own 08:00 start; Yaw has no shift, so is not ranked.
  assert.deepEqual(h.earlyBirds.map(function (b) { return [b.name, b.clockIn, b.early]; }), [['Ama Zah', '07:30', 30], ['Kofi Zah', '07:50', 10], ['Esi Zah', '07:59', 1]]);

  // Monday first; every day counted once.
  assert.deepEqual(h.weekdays.map(function (w) { return w.weekday; }), [1, 2, 3, 4, 5, 6, 0]);
  var expected = h.weekdays.reduce(function (a, w) { return a + w.expected; }, 0);
  var cameAll = h.weekdays.reduce(function (a, w) { return a + w.came; }, 0);
  assert.equal(cameAll, 30 + 30 + 4 + 1);
  assert.equal(expected, 30 + 30 + 29 + 30, 'Esi\'s leave day is not expected');
  assert.ok(h.weekdays.every(function (w) { return w.rate === null || (w.rate >= 0 && w.rate <= 100); }));

  // Only Kofi: 10+ days, none late or missed.
  assert.deepEqual([h.perfect.count, h.perfect.people.map(function (p) { return p.name; })], [1, ['Kofi Zah']]);
  assert.deepEqual(h.punctuality, { onTime: 29 + 30 + 4, late: 2, rate: 97 });
});

test('today: someone not in yet keeps yesterday\'s run, and today is not counted as missed', async function () {
  var t = today();
  for (var i = 1; i <= 3; i++) await day(emp.yaw, addDays(t, -i), 'present');
  var h = await attendance.highlights(ctx, { departmentId: dept });
  assert.equal(h.date, t);
  assert.equal(h.partial, true);
  var yaw = h.streaks.find(function (s) { return s.name === 'Yaw Zah'; });
  assert.equal(yaw && yaw.days, 3);
  assert.deepEqual([h.trend[13].came, h.trend[13].expected], [0, 0], 'nobody in yet, nobody missed yet');
  assert.deepEqual(h.earlyBirds, []);
});

test('nobody in scope: empty highlights; a bad date is refused', async function () {
  var none = await attendance.highlights(ctx, { date: D, departmentId: '00000000-0000-0000-0000-000000000000' });
  assert.deepEqual([none.trend, none.streaks, none.earlyBirds, none.perfect.count], [[], [], [], 0]);
  await assert.rejects(attendance.highlights(ctx, { date: '2031-13-45' }), /Date/);
});
