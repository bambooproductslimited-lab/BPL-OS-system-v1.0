// Public holidays in a pay run (migration 0144): the company's holidays on
// an employee's working days are days paid — for daily-rate and salaried
// staff — unless they worked that day (paid already). Not for someone paid
// for no other day in the period, not before they were hired, and not on
// a rest day. Own company (ZQH), May 2016; staff active only for the run.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var payroll = require('../src/services/payroll.service');
var { buildContext } = require('../src/services/context.service');

var boss, co, worker, absent, newcomer, salaried;
async function cleanup() {
  await pool.query("DELETE FROM payslips WHERE pay_run_id IN (SELECT id FROM pay_runs WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQH'))");
  await pool.query("DELETE FROM pay_runs WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQH')");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQH-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQH-%'");
  await pool.query("DELETE FROM departments WHERE code = 'ZQHF'");
  await pool.query("DELETE FROM holidays WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQH')");
  await pool.query("DELETE FROM companies WHERE code = 'ZQH'");
}
async function emp(code, dept, hired, extra) {
  return (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, pay_cycle, daily_rate, basic_salary) " +
    "VALUES ($1, 'Zq', $1, lower($1) || '@example.com', $2, $3, 'inactive', 'permanent', 'monthly', $4, $5) RETURNING id",
    [code, dept, hired, extra.rate || 0, extra.basic == null ? null : extra.basic])).rows[0].id;
}
async function mark(id, dates) {
  for (var d of dates) await pool.query("INSERT INTO attendance (employee_id, date, status) VALUES ($1, $2, 'present')", [id, d]);
}
var HOLIDAYS = ['2016-05-01', '2016-05-02', '2016-05-25'];   // a Sunday, a Monday, a Wednesday
function mayWorkingDays() {
  var out = [];
  for (var d = 1; d <= 31; d++) {
    var iso = '2016-05-' + String(d).padStart(2, '0');
    if (new Date(iso + 'T00:00:00Z').getUTCDay() !== 0) out.push(iso);
  }
  return out;
}

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await cleanup();
  co = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQH', 'Zqh Workshop') RETURNING id")).rows[0].id;
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQHF', 'Zqh Floor', $1) RETURNING id", [co])).rows[0].id;
  for (var h of HOLIDAYS) await pool.query("INSERT INTO holidays (company_id, date, name) VALUES ($1, $2, 'Zq holiday')", [co, h]);
  worker = await emp('ZQH-1', dept, '2015-01-01', { rate: 100 });
  absent = await emp('ZQH-2', dept, '2015-01-01', { rate: 100 });
  newcomer = await emp('ZQH-3', dept, '2016-05-10', { rate: 100 });
  salaried = await emp('ZQH-4', dept, '2015-01-01', { basic: 2600 });
  await mark(worker, ['2016-05-03', '2016-05-04', '2016-05-05', '2016-05-06', '2016-05-25']);   // and works the Wednesday holiday
  await mark(newcomer, ['2016-05-11', '2016-05-12']);
  await mark(salaried, mayWorkingDays().filter(function (d) { return HOLIDAYS.indexOf(d) < 0; }));
});
test.after(async function () { await cleanup(); await pool.end(); });

test('public holidays are paid days: daily-rate and salaried, worked or not, from the hire date', async function () {
  var ids = [worker, absent, newcomer, salaried];
  await pool.query("UPDATE employees SET status = 'active' WHERE id = ANY($1::uuid[])", [ids]);
  var run;
  try { run = await payroll.create(boss, { cycle: 'monthly', periodStart: '2016-05-01', periodEnd: '2016-05-31', payDate: '2016-05-31', companyId: co }); }
  finally { await pool.query("UPDATE employees SET status = 'inactive' WHERE id = ANY($1::uuid[])", [ids]); }
  var slip = function (id) { return run.payslips.find(function (s) { return s.employeeId === id; }); };

  var w = slip(worker);
  assert.equal(w.daysWorked, 6, '5 days worked (one on the Wednesday holiday) and the Monday holiday');
  assert.equal(w.holidaysPaid, 1, 'the Sunday holiday is a rest day; the Wednesday one was worked');
  assert.equal(w.basicPay, 600);

  var a = slip(absent);
  assert.deepEqual([a.daysWorked, a.holidaysPaid, a.basicPay], [0, 0, 0], 'no holiday pay for someone who never came');

  var n = slip(newcomer);
  assert.deepEqual([n.daysWorked, n.holidaysPaid], [3, 1], 'only the holiday after they were hired');

  var s = slip(salaried);
  assert.equal(s.payBasis, 'salary');
  assert.equal(s.workingDays, 26, 'May 2016: 31 days, 5 Sundays; the holidays are working days');
  assert.equal(s.holidaysPaid, 2);
  assert.equal(s.daysWorked, 26);
  assert.equal(s.basicPay, 2600, 'every other day worked: the full month');
});
