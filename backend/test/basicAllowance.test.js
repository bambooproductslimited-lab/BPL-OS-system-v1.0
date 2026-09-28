// Basic salary and allowance (migration 0108): a salaried employee is paid
// their monthly basic and allowance cut by the days paid for (present or
// late, plus approved paid leave) out of the
// month's working days (not Sundays or the company's public holidays),
// never more than the month. SSNIT is on basic only; the allowance is not
// taxed. Both can be typed on a draft payslip for that run alone.
// Own company (ZQB); its staff are active only while its run is made.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var payroll = require('../src/services/payroll.service');
var employees = require('../src/services/employees.service');
var { computePaye } = require('../src/utils/payroll');
var { buildContext } = require('../src/services/context.service');

var boss, co, part, full, daily;
async function cleanup() {
  await pool.query("DELETE FROM payslips WHERE pay_run_id IN (SELECT id FROM pay_runs WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQB'))");
  await pool.query("DELETE FROM pay_runs WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQB')");
  await pool.query("DELETE FROM leave_requests WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQB-%')");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQB-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQB-%'");
  await pool.query("DELETE FROM departments WHERE code = 'ZQBF'");
  await pool.query("DELETE FROM holidays WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZQB')");
  await pool.query("DELETE FROM companies WHERE code = 'ZQB'");
}
async function emp(code, dept, extra) {
  return (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, pay_cycle, daily_rate, basic_salary, allowance) " +
    "VALUES ($1, 'Zq', $1, lower($1) || '@example.com', $2, '2015-01-01', 'inactive', 'permanent', 'monthly', $3, $4, $5) RETURNING id",
    [code, dept, extra.rate || 0, extra.basic == null ? null : extra.basic, extra.allowance == null ? null : extra.allowance])).rows[0].id;
}
async function mark(id, dates, status) {
  for (var d of dates) await pool.query('INSERT INTO attendance (employee_id, date, status) VALUES ($1, $2, $3)', [id, d, status]);
}
function marchWorkingDays(except) {
  var out = [];
  for (var d = 1; d <= 31; d++) {
    var iso = '2017-03-' + String(d).padStart(2, '0');
    if (new Date(iso + 'T00:00:00Z').getUTCDay() === 0 || iso === '2017-03-06' || (except || []).indexOf(iso) >= 0) continue;
    out.push(iso);
  }
  return out;
}
async function makeRun(start, end) {
  var ids = [part, full, daily];
  await pool.query("UPDATE employees SET status = 'active' WHERE id = ANY($1::uuid[])", [ids]);
  try { return await payroll.create(boss, { cycle: 'monthly', periodStart: start, periodEnd: end, payDate: end, companyId: co }); }
  finally { await pool.query("UPDATE employees SET status = 'inactive' WHERE id = ANY($1::uuid[])", [ids]); }
}
var r2 = function (n) { return Math.round(n * 100) / 100; };

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await cleanup();
  co = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQB', 'Zqb Joinery') RETURNING id")).rows[0].id;
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQBF', 'Zqb Floor', $1) RETURNING id", [co])).rows[0].id;
  await pool.query("INSERT INTO holidays (company_id, date, name) VALUES ($1, '2017-03-06', 'Zq Independence Day')", [co]);
  part = await emp('ZQB-1', dept, { basic: 2600, allowance: 520 });
  full = await emp('ZQB-2', dept, { basic: 2600, allowance: 520 });
  daily = await emp('ZQB-3', dept, { rate: 100 });
  // March 2017: 31 days, 4 Sundays, 1 public holiday = 26 working days.
  // part: 20 present, 1 late, 2 days paid leave, 1 day unpaid leave, the rest absent = 23 days paid for.
  var wd = marchWorkingDays();
  assert.equal(wd.length, 26);
  await mark(part, wd.slice(0, 20), 'present');
  await mark(part, [wd[20]], 'late');
  var paidType = (await pool.query('SELECT id FROM leave_types WHERE paid LIMIT 1')).rows[0].id;
  var unpaidType = (await pool.query('SELECT id FROM leave_types WHERE NOT paid LIMIT 1')).rows[0].id;
  await pool.query("INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, status) VALUES ($1,$2,$3,$4,2,'approved')", [part, paidType, wd[21], wd[22]]);
  await pool.query("INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, status) VALUES ($1,$2,$3,$3,1,'approved')", [part, unpaidType, wd[23]]);
  // full: every working day, plus a Sunday.
  await mark(full, wd, 'present');
  await mark(full, ['2017-03-12'], 'present');
  await mark(daily, wd.slice(0, 10), 'present');
});
test.after(async function () { await cleanup(); await pool.end(); });

test('basic and allowance are cut by days paid for; SSNIT on basic; the allowance untaxed', async function () {
  var run = await makeRun('2017-03-01', '2017-03-31');
  var bands = (await pool.query('SELECT payroll FROM settings WHERE id = 1')).rows[0].payroll.payeBands;
  var p = run.payslips.find(function (s) { return s.employeeId === part; });
  assert.equal(p.payBasis, 'salary');
  assert.equal(p.daysWorked, 23);
  assert.equal(p.workingDays, 26);
  assert.equal(p.basicPay, 2300);          // 2600 x 23 / 26
  assert.equal(p.allowancePay, 460);       // 520 x 23 / 26
  assert.equal(p.grossPay, 2760);
  assert.equal(p.ssnitEmployee, 126.5);    // 5.5% of basic only
  assert.equal(p.ssnitEmployer, 299);      // 13% of basic only
  assert.equal(p.taxableIncome, 2173.5);   // basic - staff SSNIT; allowance not taxed
  assert.equal(p.payeTax, computePaye(2173.5, bands, 31 / 30));
  assert.equal(p.netPay, r2(2760 - 126.5 - p.payeTax));

  var f = run.payslips.find(function (s) { return s.employeeId === full; });
  assert.equal(f.basicPay, 2600, 'never more than the month');
  assert.equal(f.allowancePay, 520);

  var d = run.payslips.find(function (s) { return s.employeeId === daily; });
  assert.equal(d.payBasis, 'daily');
  assert.equal(d.basicPay, 1000);
  assert.equal(d.allowancePay, 0);
  assert.equal(d.ssnitEmployee, 55);

  // Typed for this run: SSNIT and PAYE follow the amounts.
  var edited = await payroll.editSlip(boss, run.id, part, undefined, { basicPay: 3000, allowancePay: 0 });
  var e = edited.payslips.find(function (s) { return s.employeeId === part; });
  assert.equal(e.amountsEdited, true);
  assert.equal(e.grossPay, 3000);
  assert.equal(e.ssnitEmployee, 165);
  await assert.rejects(payroll.editSlip(boss, run.id, part, undefined, { basicPay: -1 }), /zero or more/);
  await assert.rejects(payroll.editSlip(boss, run.id, daily, undefined, { allowancePay: 50 }), /daily rate/);
  // Changing days works it out again from the monthly amounts.
  var back = await payroll.editSlip(boss, run.id, part, 13);
  var b = back.payslips.find(function (s) { return s.employeeId === part; });
  assert.equal(b.amountsEdited, false);
  assert.equal(b.basicPay, 1300);
  assert.equal(b.allowancePay, 260);
});

test('a run over half the month pays at most that half', async function () {
  var run = await makeRun('2017-04-03', '2017-04-16');
  // April 2017: 30 days, 5 Sundays = 25 working days; 3–16 Apr has 12. No attendance: nothing paid.
  var p = run.payslips.find(function (s) { return s.employeeId === full; });
  assert.equal(p.workingDays, 12);
  assert.equal(p.basicPay, 0);
  await pool.query("INSERT INTO attendance (employee_id, date, status) SELECT $1, d::date, 'present' FROM generate_series('2017-04-03'::date, '2017-04-16'::date, interval '1 day') d", [full]);
  var again = await payroll.editSlip(boss, run.id, full, 14);
  assert.equal(again.payslips.find(function (s) { return s.employeeId === full; }).basicPay, r2(2600 * 12 / 25));
});

test('employee record: basic and allowance need payroll.manage, an allowance needs a basic', async function () {
  var hr = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (x) { return x !== 'payroll.manage' && boss.can(x); } });
  await assert.rejects(employees.update(hr, daily, { basicSalary: 1000 }), /payroll.manage/);
  await assert.rejects(employees.update(boss, daily, { allowance: 200 }), /basic salary too/);
  await assert.rejects(employees.update(boss, daily, { basicSalary: -5 }), /zero or more/);
  await employees.update(boss, daily, { basicSalary: '1500.456', allowance: 300 });
  var row = (await pool.query('SELECT basic_salary, allowance FROM employees WHERE id = $1', [daily])).rows[0];
  assert.deepEqual([Number(row.basic_salary), Number(row.allowance)], [1500.46, 300]);
  await employees.update(boss, daily, { basicSalary: '', allowance: '' });
  row = (await pool.query('SELECT basic_salary, allowance FROM employees WHERE id = $1', [daily])).rows[0];
  assert.deepEqual([row.basic_salary, row.allowance], [null, null]);
});
