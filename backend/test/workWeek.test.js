// Work week per employee (migration 0109): a Monday-to-Friday person's
// Saturdays aren't working days for a salaried pay run, show as off (not
// absent) in attendance, and aren't counted in a day range.
// Own company (ZQW); its staff are active only while its run is made.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var payroll = require('../src/services/payroll.service');
var attendance = require('../src/services/attendance.service');
var employees = require('../src/services/employees.service');
var { businessDays } = require('../src/utils/validate');
var { restWeekdays } = require('../src/utils/workWeek');
var { buildContext } = require('../src/services/context.service');

var boss, co, dept, fri, sat;
async function cleanup() {
  await pool.query("DELETE FROM payslips WHERE pay_run_id IN (SELECT id FROM pay_runs WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQW'))");
  await pool.query("DELETE FROM pay_runs WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQW')");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQW-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQW-%'");
  await pool.query("DELETE FROM departments WHERE code = 'ZQWF'");
  await pool.query("DELETE FROM holidays WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQW')");
  await pool.query("DELETE FROM companies WHERE code = 'ZQW'");
}
async function emp(code, workDays) {
  return (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, pay_cycle, basic_salary, allowance, work_days) " +
    "VALUES ($1, 'Zq', $1, lower($1) || '@example.com', $2, '2015-01-01', 'inactive', 'permanent', 'monthly', 2200, 440, $3) RETURNING id",
    [code, dept, workDays])).rows[0].id;
}
function weekdaysOfMarch(skip) {
  var out = [];
  for (var d = 1; d <= 31; d++) {
    var iso = '2017-03-' + String(d).padStart(2, '0');
    var dow = new Date(iso + 'T00:00:00Z').getUTCDay();
    if (skip.indexOf(dow) >= 0 || iso === '2017-03-06') continue;
    out.push(iso);
  }
  return out;
}

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await cleanup();
  co = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQW', 'Zqw Office') RETURNING id")).rows[0].id;
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQWF', 'Zqw Admin', $1) RETURNING id", [co])).rows[0].id;
  await pool.query("INSERT INTO holidays (company_id, date, name) VALUES ($1, '2017-03-06', 'Zq holiday')", [co]);
  fri = await emp('ZQW-1', 'mon_fri');
  sat = await emp('ZQW-2', null);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('work weeks: rest weekdays and day counts', function () {
  assert.deepEqual(restWeekdays('mon_fri'), [0, 6]);
  assert.deepEqual(restWeekdays('mon_sat'), [0]);
  assert.deepEqual(restWeekdays(null), [0]);
  assert.deepEqual(restWeekdays('all'), []);
  // Fri 3 – Mon 13 March 2017: 11 days, 2 Sundays, 2 Saturdays.
  assert.equal(businessDays('2017-03-03', '2017-03-13'), 9);
  assert.equal(businessDays('2017-03-03', '2017-03-13', null, [0, 6]), 7);
  assert.equal(businessDays('2017-03-03', '2017-03-13', null, []), 11);
});

test('a Monday-to-Friday salaried person: full month on every weekday, Saturdays off in attendance', async function () {
  var weekdays = weekdaysOfMarch([0, 6]);   // 23 weekdays less the holiday = 22
  assert.equal(weekdays.length, 22);
  for (var d of weekdays) await pool.query("INSERT INTO attendance (employee_id, date, status) VALUES ($1, $2, 'present')", [fri, d]);
  for (var d2 of weekdays) await pool.query("INSERT INTO attendance (employee_id, date, status) VALUES ($1, $2, 'present')", [sat, d2]);

  await pool.query("UPDATE employees SET status = 'active' WHERE id = ANY($1::uuid[])", [[fri, sat]]);
  var run;
  try { run = await payroll.create(boss, { cycle: 'monthly', periodStart: '2017-03-01', periodEnd: '2017-03-31', payDate: '2017-03-31', companyId: co }); }
  finally { await pool.query("UPDATE employees SET status = 'inactive' WHERE id = ANY($1::uuid[])", [[fri, sat]]); }

  var f = run.payslips.find(function (s) { return s.employeeId === fri; });
  assert.equal(f.workingDays, 22);
  assert.equal(f.basicPay, 2200, 'every weekday worked is the full month');
  assert.equal(f.allowancePay, 440);
  var s = run.payslips.find(function (x) { return x.employeeId === sat; });
  assert.equal(s.workingDays, 26);          // Monday to Saturday: the 4 Saturdays count
  assert.equal(s.basicPay, Math.round(2200 * 22 / 26 * 100) / 100);

  // Attendance: a Saturday is off for the Monday-to-Friday person, absent for the other.
  await pool.query("UPDATE employees SET status = 'active' WHERE id = ANY($1::uuid[])", [[fri, sat]]);
  try {
    var rep = await attendance.report(boss, '2017-03-04', '2017-03-04', { companyId: co });
    assert.equal(rep.rows.find(function (r) { return r.employeeId === fri; }).status, 'off');
    assert.equal(rep.rows.find(function (r) { return r.employeeId === sat; }).status, 'absent');
  } finally { await pool.query("UPDATE employees SET status = 'inactive' WHERE id = ANY($1::uuid[])", [[fri, sat]]); }
});

test('the work week is on the employee record and checked', async function () {
  await employees.update(boss, sat, { workDays: 'all' });
  assert.equal((await pool.query('SELECT work_days FROM employees WHERE id = $1', [sat])).rows[0].work_days, 'all');
  await assert.rejects(employees.update(boss, sat, { workDays: 'tue_thu' }), /Work week/);
  await employees.update(boss, sat, { workDays: '' });
  assert.equal((await pool.query('SELECT work_days FROM employees WHERE id = $1', [sat])).rows[0].work_days, null);
});
