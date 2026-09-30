var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V, businessDays } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { nextDocNumber } = require('../utils/documents');
var { computePaye } = require('../utils/payroll');
var { restWeekdays } = require('../utils/workWeek');

// Payroll: employees are paid a daily rate (employees.daily_rate) on one of
// three cycles (employees.pay_cycle — 'monthly', paid on the 5th per Company
// Settings, 'biweekly', or 'daily' for staff paid out per day worked). A pay
// run computes each employee's days worked
// from Attendance (present/late = 1 worked day; absent/leave/off don't
// count) over the chosen period, then gross/SSNIT/PAYE/net — see
// computePaye() in utils/payroll.js for the important caveat on the tax
// figures.
//
// Or (migration 0108) a monthly basic salary and allowance
// (employees.basic_salary / allowance): the run pays them cut by the days
// paid for — present or late, plus approved paid
// leave — out of the month's working days (not their rest days, Sundays
// unless their work week says otherwise, or the company's public holidays). SSNIT is on basic only; the allowance is not taxed.

function todayISO() { return new Date().toISOString().slice(0, 10); }

async function getPayrollSettings(db) {
  var res = await db.query('SELECT payroll FROM settings WHERE id = 1');
  return res.rows[0].payroll;
}

function periodScaleFor(periodStart, periodEnd) {
  var days = Math.round((new Date(periodEnd + 'T00:00') - new Date(periodStart + 'T00:00')) / 86400000) + 1;
  return days / 30;
}

function rowToPayRun(r, extra) {
  return Object.assign({
    id: r.id, runNo: r.run_no, cycle: r.cycle, periodStart: r.period_start, periodEnd: r.period_end,
    payDate: r.pay_date, status: r.status, createdBy: r.created_by, createdAt: r.created_at,
    approvedBy: r.approved_by, approvedAt: r.approved_at, companyId: r.company_id || null
  }, extra || {});
}

function rowToPayslip(r, extra) {
  return Object.assign({
    id: r.id, payRunId: r.pay_run_id, employeeId: r.employee_id, daysWorked: Number(r.days_worked),
    dailyRate: Number(r.daily_rate), grossPay: Number(r.gross_pay), ssnitEmployee: Number(r.ssnit_employee),
    ssnitEmployer: Number(r.ssnit_employer), taxableIncome: Number(r.taxable_income), payeTax: Number(r.paye_tax),
    payeByCompany: !!r.paye_by_company, netPay: Number(r.net_pay),
    payBasis: r.pay_basis || 'daily', basicPay: Number(r.basic_pay), allowancePay: Number(r.allowance_pay),
    monthlyBasic: r.monthly_basic == null ? null : Number(r.monthly_basic), monthlyAllowance: r.monthly_allowance == null ? null : Number(r.monthly_allowance),
    workingDays: r.working_days == null ? null : r.working_days, amountsEdited: !!r.amounts_edited
  }, extra || {});
}

// companyPaysPaye: the employee's company pays their PAYE (companies.
// pays_staff_paye), so it isn't taken off their take-home pay; it is still
// worked out the same way and still owed to GRA, as a cost to the company.
// pay: { basic, allowance } for the period. SSNIT (staff and employer) is
// on basic only; PAYE on basic less staff SSNIT (the allowance is not
// taxed), with its bands scaled to the period.
async function computeSlipFields(db, pay, periodScale, companyPaysPaye) {
  var payroll = await getPayrollSettings(db);
  var basic = Math.round(pay.basic * 100) / 100, allowance = Math.round((pay.allowance || 0) * 100) / 100;
  var grossPay = Math.round((basic + allowance) * 100) / 100;
  var ssnitEmployee = Math.round(basic * (payroll.ssnitEmployeeRate / 100) * 100) / 100;
  var ssnitEmployer = Math.round(basic * (payroll.ssnitEmployerRate / 100) * 100) / 100;
  var taxableIncome = Math.max(0, Math.round((basic - ssnitEmployee) * 100) / 100);
  var payeTax = computePaye(taxableIncome, payroll.payeBands, periodScale);
  var netPay = Math.round((grossPay - ssnitEmployee - (companyPaysPaye ? 0 : payeTax)) * 100) / 100;
  return { basicPay: basic, allowancePay: allowance, grossPay: grossPay, ssnitEmployee: ssnitEmployee, ssnitEmployer: ssnitEmployer, taxableIncome: taxableIncome, payeTax: payeTax, payeByCompany: !!companyPaysPaye, netPay: netPay };
}

// A monthly amount for the days paid: monthly x paid days / the month's
// working days, never more than the period's share of the month.
function salaryShare(monthly, paidDays, workingDays, monthWorkingDays) {
  if (!monthly || !monthWorkingDays) return 0;
  return Math.round(Number(monthly) * Math.min(Number(paidDays), workingDays) / monthWorkingDays * 100) / 100;
}
function iso(d) { return d.toISOString().slice(0, 10); }
// Second shifts worked (migration 0112): staff on two shifts a day are paid
// each shift as a day, so these are days on top of the period's working days.
async function secondShiftsWorked(db, employeeId, from, to) {
  var r = await db.query(
    "SELECT count(*)::int AS n FROM attendance WHERE employee_id = $1 AND shift_no = 2 AND status IN ('present','late') AND date BETWEEN $2 AND $3",
    [employeeId, from, to]);
  return r.rows[0].n;
}
async function holidaySet(db, companyId, from, to) {
  if (!companyId) return new Set();
  var r = await db.query("SELECT to_char(date, 'YYYY-MM-DD') AS d FROM holidays WHERE company_id = $1 AND date BETWEEN $2 AND $3", [companyId, from, to]);
  return new Set(r.rows.map(function (x) { return x.d; }));
}
// Days paid for, for a salaried employee: present or late, plus approved
// paid leave on working days not already counted as present or late.
async function paidDaysFor(db, employeeId, from, to, holidays, restDays) {
  var att = await db.query(
    "SELECT to_char(date, 'YYYY-MM-DD') AS d, status FROM attendance WHERE employee_id = $1 AND date BETWEEN $2 AND $3", [employeeId, from, to]);
  var marked = {}, days = 0;
  att.rows.forEach(function (a) {
    if (a.status === 'present' || a.status === 'late') { marked[a.d] = true; days += 1; }
  });
  var leave = await db.query(
    "SELECT to_char(greatest(lr.start_date, $2::date), 'YYYY-MM-DD') AS s, to_char(least(lr.end_date, $3::date), 'YYYY-MM-DD') AS e " +
    "FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id " +
    "WHERE lr.employee_id = $1 AND lr.status = 'approved' AND lt.paid AND lr.start_date <= $3 AND lr.end_date >= $2", [employeeId, from, to]);
  var counted = {};
  leave.rows.forEach(function (l) {
    for (var d = new Date(l.s + 'T00:00:00Z'); iso(d) <= l.e; d = new Date(d.getTime() + 86400000)) {
      var k = iso(d);
      if (restDays.indexOf(d.getUTCDay()) >= 0 || holidays.has(k) || marked[k] || counted[k]) continue;
      counted[k] = true; days += 1;
    }
  });
  return days;
}
function monthOf(periodEnd) {
  var e = new Date(String(periodEnd).slice(0, 10) + 'T00:00:00Z');
  return { start: iso(new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), 1))), end: iso(new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 0))) };
}

// payroll.payslipHistory — one employee's payslips across every run,
// newest pay date first, optionally narrowed to a period. Used by the
// Payroll screen's employee filter so admins can see one person's pay
// history instead of hunting through each run.
async function payslipHistory(ctx, employeeId, from, to) {
  if (!ctx.can('payroll.read')) fail('forbidden', 'Your role does not allow this action (payroll.read).');
  if (!employeeId) fail('invalid', 'employeeId is required.');
  var empRes = await pool.query('SELECT id, code, first_name, last_name FROM employees WHERE id = $1', [employeeId]);
  var employee = empRes.rows[0];
  if (!employee) fail('notfound', 'Employee not found.');

  var where = ['p.employee_id = $1'];
  var params = [employeeId];
  if (from) { params.push(V.date(from, 'From date')); where.push('pr.period_end >= $' + params.length); }
  if (to) { params.push(V.date(to, 'To date')); where.push('pr.period_start <= $' + params.length); }

  var res = await pool.query(
    'SELECT p.*, pr.run_no, pr.cycle, pr.period_start, pr.period_end, pr.pay_date, pr.status AS run_status ' +
    'FROM payslips p JOIN pay_runs pr ON pr.id = p.pay_run_id ' +
    'WHERE ' + where.join(' AND ') + ' ORDER BY pr.pay_date DESC',
    params
  );
  var payslips = res.rows.map(function (r) {
    return rowToPayslip(r, {
      runNo: r.run_no, cycle: r.cycle, periodStart: r.period_start, periodEnd: r.period_end,
      payDate: r.pay_date, runStatus: r.run_status
    });
  });
  return { employeeId: employee.id, employeeCode: employee.code, employeeName: employee.first_name + ' ' + employee.last_name, payslips: payslips };
}

// payroll.listRuns — params.companyId narrows to runs relevant to that one
// company: a run created specifically FOR that company (see create()'s
// companyId option), plus every "All companies" run (company_id null),
// since those still contain that company's payslips even though they
// weren't scoped to just it. Only a run scoped to a DIFFERENT company gets
// excluded — an "All companies" run is never hidden by this filter.
async function list(ctx, params) {
  if (!ctx.can('payroll.read')) fail('forbidden', 'Your role does not allow this action (payroll.read).');
  // With each run: its totals (what staff take home, what the company
  // pays in all — gross plus the employer's SSNIT — and the SSNIT and PAYE
  // owed to the authorities), who approved it, and how many payslips have
  // no days worked.
  var res = await pool.query(
    'SELECT pr.*, e.first_name, e.last_name, a.first_name AS a_first, a.last_name AS a_last, c.name AS company_name, t.* ' +
    'FROM pay_runs pr JOIN employees e ON e.id = pr.created_by LEFT JOIN employees a ON a.id = pr.approved_by LEFT JOIN companies c ON c.id = pr.company_id ' +
    'LEFT JOIN LATERAL (SELECT count(*)::int AS employee_count, coalesce(sum(net_pay),0) AS total_net, coalesce(sum(gross_pay),0) AS total_gross, ' +
    '  coalesce(sum(ssnit_employee),0) AS total_ssnit_ee, coalesce(sum(ssnit_employer),0) AS total_ssnit_er, coalesce(sum(paye_tax),0) AS total_paye, ' +
    '  coalesce(sum(paye_tax) FILTER (WHERE paye_by_company),0) AS total_paye_co, ' +
    '  count(*) FILTER (WHERE days_worked = 0)::int AS zero_days FROM payslips p WHERE p.pay_run_id = pr.id) t ON true ' +
    'ORDER BY pr.period_end DESC, pr.created_at DESC'
  );
  return res.rows
    .filter(function (r) { return !(params && params.companyId) || !r.company_id || r.company_id === params.companyId; })
    .map(function (r) {
      return rowToPayRun(r, {
        createdByName: r.first_name + ' ' + r.last_name, approvedByName: r.a_first ? r.a_first + ' ' + r.a_last : null,
        companyName: r.company_name || 'All companies',
        employeeCount: r.employee_count, totalNet: Number(r.total_net), totals: totalsOf(r), zeroDays: r.zero_days
      });
    });
}

function totalsOf(r) {
  var gross = Number(r.total_gross), er = Number(r.total_ssnit_er), co = Number(r.total_paye_co);
  return {
    gross: gross, net: Number(r.total_net), ssnitEmployee: Number(r.total_ssnit_ee), ssnitEmployer: er,
    paye: Number(r.total_paye), payeByCompany: co, cost: Math.round((gross + er + co) * 100) / 100
  };
}

// Days in a pay period, both ends counted.
function periodDays(start, end) {
  return Math.round((new Date(String(end).slice(0, 10) + 'T00:00:00Z') - new Date(String(start).slice(0, 10) + 'T00:00:00Z')) / 86400000) + 1;
}

// payroll.getRun — payslips are joined out to their employee's department
// and company (the Companies tier added in migration 0032) so the Payroll
// screen can filter one run's payslips by company/department client-side,
// same as it already does with the employee filter; a pay run itself still
// spans every eligible employee on its cycle regardless of company —
// filtering only narrows what's shown, never what a run contains.
async function get(ctx, id) {
  if (!ctx.can('payroll.read')) fail('forbidden', 'Your role does not allow this action (payroll.read).');
  var runRes = await pool.query(
    'SELECT pr.*, c.name AS company_name, cb.first_name AS c_first, cb.last_name AS c_last, ab.first_name AS a_first, ab.last_name AS a_last ' +
    'FROM pay_runs pr LEFT JOIN companies c ON c.id = pr.company_id LEFT JOIN employees cb ON cb.id = pr.created_by LEFT JOIN employees ab ON ab.id = pr.approved_by WHERE pr.id = $1',
    [id]
  );
  var run = runRes.rows[0];
  if (!run) fail('notfound', 'Pay run not found.');
  var slipsRes = await pool.query(
    'SELECT p.*, e.code, e.first_name, e.last_name, e.position_title, e.ssnit_number, e.tin, d.id AS department_id, d.name AS department_name, c.id AS company_id, c.name AS company_name ' +
    'FROM payslips p JOIN employees e ON e.id = p.employee_id ' +
    'JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id ' +
    'WHERE p.pay_run_id = $1 ORDER BY e.first_name',
    [id]
  );
  var slips = slipsRes.rows.map(function (r) {
    return rowToPayslip(r, {
      employeeCode: r.code, employeeName: r.first_name + ' ' + r.last_name, positionTitle: r.position_title,
      ssnitNumber: r.ssnit_number || null, tin: r.tin || null,
      departmentId: r.department_id, departmentName: r.department_name, companyId: r.company_id, companyName: r.company_name
    });
  });
  var sum = function (k) { return Math.round(slips.reduce(function (a, x) { return a + x[k]; }, 0) * 100) / 100; };
  var totals = { gross: sum('grossPay'), net: sum('netPay'), ssnitEmployee: sum('ssnitEmployee'), ssnitEmployer: sum('ssnitEmployer'), paye: sum('payeTax') };
  totals.payeByCompany = Math.round(slips.reduce(function (a, x) { return a + (x.payeByCompany ? x.payeTax : 0); }, 0) * 100) / 100;
  totals.cost = Math.round((totals.gross + totals.ssnitEmployer + totals.payeByCompany) * 100) / 100;
  return Object.assign(rowToPayRun(run), {
    companyName: run.company_name || 'All companies', payslips: slips, totals: totals, periodDays: periodDays(run.period_start, run.period_end),
    createdByName: run.c_first ? run.c_first + ' ' + run.c_last : null, approvedByName: run.a_first ? run.a_first + ' ' + run.a_last : null
  });
}

// payroll.createRun — one payslip per active employee on the chosen cycle,
// days worked pulled automatically from Attendance for the period.
// p.companyId is optional — when set, the run is scoped to just that
// company's employees (and remembers the scoping on pay_runs.company_id
// for the run list/detail to show later); left unset, this behaves exactly
// as before — every active employee on the cycle, across every company.
async function create(ctx, p) {
  if (!ctx.can('payroll.manage')) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  var cycle = V.oneOf(p.cycle, ['monthly', 'biweekly', 'daily'], 'Cycle');
  var periodStart = V.date(p.periodStart, 'Period start');
  var periodEnd = V.date(p.periodEnd, 'Period end');
  var payDate = V.date(p.payDate || todayISO(), 'Pay date');
  if (periodEnd < periodStart) fail('invalid', 'Period end must be on or after period start.');

  var companyId = null, companyName = null;
  if (p.companyId) {
    var companyRes = await pool.query('SELECT id, name FROM companies WHERE id = $1', [p.companyId]);
    if (!companyRes.rows[0]) fail('invalid', 'Company is not a valid option.');
    companyId = companyRes.rows[0].id;
    companyName = companyRes.rows[0].name;
  }

  // Two runs on the same cycle over overlapping days would pay the same
  // people twice: refused when either run covers every company, or both
  // cover this one.
  var clash = await pool.query(
    'SELECT run_no, period_start, period_end FROM pay_runs WHERE cycle = $1 AND period_start <= $3 AND period_end >= $2 ' +
    'AND ($4::uuid IS NULL OR company_id IS NULL OR company_id = $4) LIMIT 1',
    [cycle, periodStart, periodEnd, companyId]);
  if (clash.rows[0]) {
    var c0 = clash.rows[0];
    fail('conflict', c0.run_no + ' already pays the ' + cycle + ' staff for ' + String(c0.period_start).slice(0, 10) + ' to ' + String(c0.period_end).slice(0, 10) + '. Pick days it doesn\'t cover, or delete it if it is still a draft.');
  }

  var employeesRes = companyId
    ? await pool.query(
        "SELECT e.id, e.daily_rate, e.basic_salary, e.allowance, e.work_days, c.id AS company_id, c.pays_staff_paye FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id " +
        "WHERE e.status = 'active' AND e.pay_cycle = $1 AND d.company_id = $2",
        [cycle, companyId]
      )
    : await pool.query(
        "SELECT e.id, e.daily_rate, e.basic_salary, e.allowance, e.work_days, c.id AS company_id, coalesce(c.pays_staff_paye, false) AS pays_staff_paye FROM employees e " +
        "LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id " +
        "WHERE e.status = 'active' AND e.pay_cycle = $1", [cycle]);
  if (!employeesRes.rows.length) {
    fail('invalid', 'No active employees are on the ' + cycle + ' pay cycle' + (companyName ? ' at ' + companyName : '') + '.');
  }

  var periodScale = periodScaleFor(periodStart, periodEnd);

  var newId = await withTransaction(async function (client) {
    var runNo = await nextDocNumber(client, 'payrun');
    var runRes = await client.query(
      "INSERT INTO pay_runs (run_no, cycle, period_start, period_end, pay_date, status, created_by, company_id) VALUES ($1,$2,$3,$4,$5,'draft',$6,$7) RETURNING *",
      [runNo, cycle, periodStart, periodEnd, payDate, ctx.employee.id, companyId]
    );
    var run = runRes.rows[0];

    for (var i = 0; i < employeesRes.rows.length; i++) {
      var emp = employeesRes.rows[i];
      var attRes = await client.query(
        "SELECT count(*) FILTER (WHERE status IN ('present','late')) AS worked_days " +
        'FROM attendance WHERE employee_id = $1 AND date BETWEEN $2 AND $3',
        [emp.id, periodStart, periodEnd]
      );
      var daysWorked = Number(attRes.rows[0].worked_days);
      var dailyRate = Number(emp.daily_rate);
      var salaried = emp.basic_salary != null;
      var basis = { basis: 'daily', monthlyBasic: null, monthlyAllowance: null, workingDays: null, monthWorkingDays: null };
      var pay = { basic: dailyRate * daysWorked, allowance: 0 };
      if (salaried) {
        var month = monthOf(periodEnd);
        var hol = await holidaySet(client, emp.company_id, month.start < periodStart ? month.start : periodStart, month.end > periodEnd ? month.end : periodEnd);
        var rest = restWeekdays(emp.work_days);
        var workingDays = businessDays(periodStart, periodEnd, hol, rest);
        var monthWorkingDays = businessDays(month.start, month.end, hol, rest);
        daysWorked = await paidDaysFor(client, emp.id, periodStart, periodEnd, hol, rest);
        // A second shift is another day's pay, over and above the working days.
        workingDays += await secondShiftsWorked(client, emp.id, periodStart, periodEnd);
        basis = { basis: 'salary', monthlyBasic: Number(emp.basic_salary), monthlyAllowance: Number(emp.allowance || 0), workingDays: workingDays, monthWorkingDays: monthWorkingDays };
        pay = {
          basic: salaryShare(basis.monthlyBasic, daysWorked, workingDays, monthWorkingDays),
          allowance: salaryShare(basis.monthlyAllowance, daysWorked, workingDays, monthWorkingDays)
        };
      }
      var slip = await computeSlipFields(client, pay, periodScale, emp.pays_staff_paye);

      await client.query(
        'INSERT INTO payslips (pay_run_id, employee_id, days_worked, daily_rate, gross_pay, ssnit_employee, ssnit_employer, taxable_income, paye_tax, net_pay, paye_by_company, ' +
        'pay_basis, basic_pay, allowance_pay, monthly_basic, monthly_allowance, working_days, month_working_days) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
        [run.id, emp.id, daysWorked, salaried ? 0 : dailyRate, slip.grossPay, slip.ssnitEmployee, slip.ssnitEmployer, slip.taxableIncome, slip.payeTax, slip.netPay, slip.payeByCompany,
          basis.basis, slip.basicPay, slip.allowancePay, basis.monthlyBasic, basis.monthlyAllowance, basis.workingDays, basis.monthWorkingDays]
      );
    }

    await audit(client, ctx, 'payroll.create', 'pay_run', run.id,
      'Created ' + cycle + ' pay run ' + run.run_no + ' for ' + periodStart + ' to ' + periodEnd +
      (companyName ? ' — ' + companyName : '') + ' (' + employeesRes.rows.length + ' employees).');
    return run.id;
  });

  return get(ctx, newId);
}

// payroll.editSlip — while still a draft, HR/Finance can correct the
// auto-computed days worked (e.g. unpaid leave not reflected in
// Attendance yet); everything downstream recalculates from that.
async function editSlip(ctx, payRunId, employeeId, daysWorked, amounts) {
  if (!ctx.can('payroll.manage')) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  var runRes = await pool.query('SELECT * FROM pay_runs WHERE id = $1', [payRunId]);
  var run = runRes.rows[0];
  if (!run) fail('notfound', 'Pay run not found.');
  if (run.status !== 'draft') fail('invalid', 'Only a draft pay run can be edited.');

  var slipRes = await pool.query('SELECT * FROM payslips WHERE pay_run_id = $1 AND employee_id = $2', [payRunId, employeeId]);
  var slip = slipRes.rows[0];
  if (!slip) fail('notfound', 'Payslip not found.');

  var days = daysWorked === undefined || daysWorked === null || daysWorked === '' ? Number(slip.days_worked) : Number(daysWorked);
  if (!(days >= 0)) fail('invalid', 'Days worked must be a non-negative number.');
  var calendarDays = periodDays(run.period_start, run.period_end);
  var extraShifts = await secondShiftsWorked(pool, employeeId, run.period_start, run.period_end);
  var maxDays = calendarDays + extraShifts;
  if (days > maxDays) fail('invalid', extraShifts ? 'This pay period only has ' + calendarDays + ' days and ' + extraShifts + ' second shifts.' : 'This pay period only has ' + maxDays + ' days.');

  // Salaried: basic and allowance typed for this run, or else worked out
  // again from the monthly amounts for the days. Daily: days x rate.
  amounts = amounts || {};
  var typed = function (v) { return v !== undefined && v !== null && v !== ''; };
  var pay, edited = !!slip.amounts_edited;
  if (slip.pay_basis === 'salary') {
    if (typed(amounts.basicPay) || typed(amounts.allowancePay)) {
      var b = typed(amounts.basicPay) ? Number(amounts.basicPay) : Number(slip.basic_pay);
      var a = typed(amounts.allowancePay) ? Number(amounts.allowancePay) : Number(slip.allowance_pay);
      if (!(b >= 0) || !(a >= 0)) fail('invalid', 'Basic and allowance must be amounts of zero or more.');
      pay = { basic: b, allowance: a };
      edited = true;
    } else {
      pay = {
        basic: salaryShare(slip.monthly_basic, days, slip.working_days, slip.month_working_days),
        allowance: salaryShare(slip.monthly_allowance, days, slip.working_days, slip.month_working_days)
      };
      edited = false;
    }
  } else {
    if (typed(amounts.basicPay) || typed(amounts.allowancePay)) fail('invalid', 'This person is paid a daily rate. Give them a basic salary on their employee record to pay basic and allowance.');
    pay = { basic: Number(slip.daily_rate) * days, allowance: 0 };
  }

  var periodScale = periodScaleFor(run.period_start, run.period_end);
  var computed = await computeSlipFields(pool, pay, periodScale, slip.paye_by_company);

  await pool.query(
    'UPDATE payslips SET days_worked = $1, gross_pay = $2, ssnit_employee = $3, ssnit_employer = $4, taxable_income = $5, paye_tax = $6, net_pay = $7, ' +
    'basic_pay = $8, allowance_pay = $9, amounts_edited = $10 WHERE id = $11',
    [days, computed.grossPay, computed.ssnitEmployee, computed.ssnitEmployer, computed.taxableIncome, computed.payeTax, computed.netPay,
      computed.basicPay, computed.allowancePay, edited, slip.id]
  );
  await audit(pool, ctx, 'payroll.editSlip', 'pay_run', payRunId, (edited ? 'Changed basic/allowance' : 'Adjusted days worked') + ' in ' + run.run_no + '.');
  return get(ctx, payRunId);
}

// payroll.approveRun
async function approve(ctx, id) {
  if (!ctx.can('payroll.manage')) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  var res = await pool.query('SELECT * FROM pay_runs WHERE id = $1', [id]);
  var run = res.rows[0];
  if (!run) fail('notfound', 'Pay run not found.');
  if (run.status !== 'draft') fail('invalid', 'Only a draft pay run can be approved.');
  await pool.query("UPDATE pay_runs SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2", [ctx.employee.id, id]);
  await audit(pool, ctx, 'payroll.approve', 'pay_run', id, 'Approved pay run ' + run.run_no + '.');
  return get(ctx, id);
}

// payroll.markPaid
async function markPaid(ctx, id) {
  if (!ctx.can('payroll.manage')) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  var res = await pool.query('SELECT * FROM pay_runs WHERE id = $1', [id]);
  var run = res.rows[0];
  if (!run) fail('notfound', 'Pay run not found.');
  if (run.status !== 'approved') fail('invalid', 'Only an approved pay run can be marked paid.');
  await pool.query("UPDATE pay_runs SET status = 'paid' WHERE id = $1", [id]);
  await audit(pool, ctx, 'payroll.paid', 'pay_run', id, 'Marked pay run ' + run.run_no + ' as paid.');
  return get(ctx, id);
}

// payroll.deleteRun — a draft made by mistake (wrong dates, wrong cycle)
// can be thrown away; approved and paid runs are the record and stay.
async function remove(ctx, id) {
  if (!ctx.can('payroll.manage')) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  var run = (await pool.query('SELECT * FROM pay_runs WHERE id = $1', [id])).rows[0];
  if (!run) fail('notfound', 'Pay run not found.');
  if (run.status !== 'draft') fail('invalid', 'Only a draft pay run can be deleted.');
  await withTransaction(async function (client) {
    await client.query('DELETE FROM payslips WHERE pay_run_id = $1', [id]);
    await client.query('DELETE FROM pay_runs WHERE id = $1', [id]);
    await audit(client, ctx, 'payroll.delete', 'pay_run', id, 'Deleted draft pay run ' + run.run_no + '.');
  });
  return true;
}

// Who pays PAYE, company by company. Turning it on or off changes the
// payslips of draft runs straight away; approved and paid runs keep what
// they were paid.
async function payePolicy(ctx) {
  if (!ctx.can('payroll.read')) fail('forbidden', 'Your role does not allow this action (payroll.read).');
  var r = await pool.query(
    "SELECT c.id, c.code, c.name, c.pays_staff_paye, (SELECT count(*)::int FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.company_id = c.id AND e.status = 'active') AS staff " +
    'FROM companies c ORDER BY c.name');
  return r.rows.map(function (c) { return { id: c.id, code: c.code, name: c.name, paysStaffPaye: c.pays_staff_paye, staff: c.staff }; });
}

async function setPayePolicy(ctx, companyId, pays) {
  if (!ctx.can('payroll.manage')) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  if (typeof pays !== 'boolean') fail('invalid', 'Say whether the company pays its staff\'s PAYE.');
  var drafts = 0, name = null;
  await withTransaction(async function (client) {
    var c = (await client.query('UPDATE companies SET pays_staff_paye = $2 WHERE id = $1 RETURNING name', [companyId, pays])).rows[0];
    if (!c) fail('notfound', 'Company not found.');
    name = c.name;
    var upd = await client.query(
      'UPDATE payslips p SET paye_by_company = $2, net_pay = round(p.gross_pay - p.ssnit_employee - CASE WHEN $2 THEN 0 ELSE p.paye_tax END, 2) ' +
      "FROM pay_runs pr, employees e, departments d WHERE pr.id = p.pay_run_id AND pr.status = 'draft' AND e.id = p.employee_id AND d.id = e.department_id AND d.company_id = $1 AND p.paye_by_company <> $2",
      [companyId, pays]);
    drafts = upd.rowCount;
    await audit(client, ctx, 'payroll.payePolicy', 'company', companyId,
      (pays ? name + ' now pays its staff\'s PAYE' : name + '\'s staff now pay their own PAYE') + (drafts ? ' (' + drafts + ' draft payslip(s) updated).' : '.'));
  });
  return { companies: await payePolicy(ctx), draftPayslipsUpdated: drafts };
}

module.exports = {
  payePolicy: payePolicy, setPayePolicy: setPayePolicy,
  list: list, get: get, create: create, editSlip: editSlip, approve: approve, markPaid: markPaid, remove: remove, payslipHistory: payslipHistory };
