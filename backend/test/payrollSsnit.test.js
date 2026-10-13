// SSNIT on the salary for SSNIT (migration 0145): staff 5.5%, employer 13%
// of the person's salary for SSNIT (else their basic salary) each month,
// whatever days they worked; a run shorter than a month charges its share
// of the month; nothing earned, no SSNIT. A daily-rate person with no
// salary for SSNIT pays it on what they earned. Own company (ZQS), 2016.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var payroll = require('../src/services/payroll.service');
var employees = require('../src/services/employees.service');
var { buildContext } = require('../src/services/context.service');

var boss, co, half, typed, dailyTyped, daily, away;
var r2 = function (n) { return Math.round(n * 100) / 100; };
async function cleanup() {
  await pool.query("DELETE FROM payslips WHERE pay_run_id IN (SELECT id FROM pay_runs WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQS'))");
  await pool.query("DELETE FROM pay_runs WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQS')");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQS-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQS-%'");
  await pool.query("DELETE FROM departments WHERE code = 'ZQSF'");
  await pool.query("DELETE FROM companies WHERE code = 'ZQS'");
}
async function emp(code, dept, x) {
  return (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, pay_cycle, daily_rate, basic_salary, ssnit_salary) " +
    "VALUES ($1, 'Zq', $1, lower($1) || '@example.com', $2, '2015-01-01', 'inactive', 'permanent', 'monthly', $3, $4, $5) RETURNING id",
    [code, dept, x.rate || 0, x.basic == null ? null : x.basic, x.ssnit == null ? null : x.ssnit])).rows[0].id;
}
async function work(id, from, n) {
  await pool.query("INSERT INTO attendance (employee_id, date, status) SELECT $1, d::date, 'present' FROM generate_series($2::date, $2::date + ($3::int - 1), interval '1 day') d WHERE extract(dow FROM d) <> 0", [id, from, n]);
}
async function makeRun(start, end) {
  var ids = [half, typed, dailyTyped, daily, away];
  await pool.query("UPDATE employees SET status = 'active' WHERE id = ANY($1::uuid[])", [ids]);
  try { return await payroll.create(boss, { cycle: 'monthly', periodStart: start, periodEnd: end, payDate: end, companyId: co }); }
  finally { await pool.query("UPDATE employees SET status = 'inactive' WHERE id = ANY($1::uuid[])", [ids]); }
}

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await cleanup();
  co = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQS', 'Zqs Joinery') RETURNING id")).rows[0].id;
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQSF', 'Zqs Floor', $1) RETURNING id", [co])).rows[0].id;
  half = await emp('ZQS-1', dept, { basic: 3000 });                   // works half of June
  typed = await emp('ZQS-2', dept, { basic: 3000, ssnit: 2000 });     // a different salary for SSNIT
  dailyTyped = await emp('ZQS-3', dept, { rate: 100, ssnit: 1500 });  // daily rate, salary for SSNIT typed
  daily = await emp('ZQS-4', dept, { rate: 100 });                    // daily rate, nothing typed
  away = await emp('ZQS-5', dept, { basic: 3000 });                   // never came
  await work(half, '2016-06-01', 15);
  await work(typed, '2016-06-01', 30);
  await work(dailyTyped, '2016-06-01', 5);
  await work(daily, '2016-06-01', 5);
  await work(typed, '2016-07-01', 15);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('SSNIT is on the salary for SSNIT, whatever days were worked; nothing earned, none', async function () {
  var run = await makeRun('2016-06-01', '2016-06-30');
  var slip = function (id) { return run.payslips.find(function (s) { return s.employeeId === id; }); };

  var h = slip(half);
  assert.ok(h.basicPay < 3000, 'pay is cut by the days paid');
  assert.deepEqual([h.ssnitSalary, h.ssnitEmployee, h.ssnitEmployer], [3000, 165, 390], 'SSNIT on the full basic salary');
  assert.equal(h.taxableIncome, r2(h.basicPay - 165));

  var t = slip(typed);
  assert.deepEqual([t.ssnitSalary, t.ssnitEmployee, t.ssnitEmployer], [2000, 110, 260], 'on the salary for SSNIT typed');

  var dt = slip(dailyTyped);
  assert.equal(dt.basicPay, 100 * dt.daysWorked);
  assert.deepEqual([dt.ssnitSalary, dt.ssnitEmployee], [1500, 82.5], 'a daily-rate person with a salary for SSNIT: not on what they earned');

  var d = slip(daily);
  assert.deepEqual([d.ssnitSalary, d.ssnitEmployee], [null, r2(d.basicPay * 0.055)], 'no salary for SSNIT: on what they earned');
  assert.ok(d.basicPay > 0);

  var a = slip(away);
  assert.deepEqual([a.daysWorked, a.ssnitEmployee, a.ssnitEmployer, a.netPay], [0, 0, 0, 0], 'nothing earned, no SSNIT');

  // Days changed on the draft: nothing earned, no SSNIT; days back, the month's SSNIT.
  var z = (await payroll.editSlip(boss, run.id, half, 0)).payslips.find(function (s) { return s.employeeId === half; });
  assert.deepEqual([z.ssnitEmployee, z.ssnitEmployer], [0, 0]);
  var back = (await payroll.editSlip(boss, run.id, away, 10)).payslips.find(function (s) { return s.employeeId === away; });
  assert.deepEqual([back.ssnitEmployee, back.ssnitEmployer], [165, 390]);
});

test('a run over half a month charges half a month of SSNIT', async function () {
  var run = await makeRun('2016-07-01', '2016-07-15');
  var t = run.payslips.find(function (s) { return s.employeeId === typed; });
  var share = r2(2000 * 15 / 31);
  assert.equal(t.ssnitEmployee, r2(share * 0.055));
  assert.equal(t.ssnitEmployer, r2(share * 0.13));
});

test('the salary for SSNIT on the employee record needs payroll.manage', async function () {
  var hr = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (x) { return x !== 'payroll.manage' && boss.can(x); } });
  await assert.rejects(employees.update(hr, daily, { ssnitSalary: 1000 }), /payroll.manage/);
  await assert.rejects(employees.update(boss, daily, { ssnitSalary: -1 }), /zero or more/);
  await employees.update(boss, daily, { ssnitSalary: '1200.456' });
  assert.equal(Number((await pool.query('SELECT ssnit_salary FROM employees WHERE id = $1', [daily])).rows[0].ssnit_salary), 1200.46);
  await employees.update(boss, daily, { ssnitSalary: '' });
  assert.equal((await pool.query('SELECT ssnit_salary FROM employees WHERE id = $1', [daily])).rows[0].ssnit_salary, null);
});
