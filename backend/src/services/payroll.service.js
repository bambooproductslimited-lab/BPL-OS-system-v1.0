var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { nextDocNumber } = require('../utils/documents');
var { computePaye } = require('../utils/payroll');

// Payroll: employees are paid a daily rate (employees.daily_rate) on one of
// three cycles (employees.pay_cycle — 'monthly', paid on the 5th per Company
// Settings, 'biweekly', or 'daily' for staff paid out per day worked). A pay
// run computes each employee's days worked
// from Attendance (present/late = 1 worked day; absent/leave/off don't
// count) over the chosen period, then gross/SSNIT/PAYE/net — see
// computePaye() in utils/payroll.js for the important caveat on the tax
// figures.

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
    approvedBy: r.approved_by, approvedAt: r.approved_at
  }, extra || {});
}

function rowToPayslip(r, extra) {
  return Object.assign({
    id: r.id, payRunId: r.pay_run_id, employeeId: r.employee_id, daysWorked: Number(r.days_worked),
    dailyRate: Number(r.daily_rate), grossPay: Number(r.gross_pay), ssnitEmployee: Number(r.ssnit_employee),
    ssnitEmployer: Number(r.ssnit_employer), taxableIncome: Number(r.taxable_income), payeTax: Number(r.paye_tax),
    netPay: Number(r.net_pay)
  }, extra || {});
}

async function computeSlipFields(db, dailyRate, daysWorked, periodScale) {
  var payroll = await getPayrollSettings(db);
  var grossPay = Math.round(dailyRate * daysWorked * 100) / 100;
  var ssnitEmployee = Math.round(grossPay * (payroll.ssnitEmployeeRate / 100) * 100) / 100;
  var ssnitEmployer = Math.round(grossPay * (payroll.ssnitEmployerRate / 100) * 100) / 100;
  var taxableIncome = Math.max(0, grossPay - ssnitEmployee);
  var payeTax = computePaye(taxableIncome, payroll.payeBands, periodScale);
  var netPay = Math.round((grossPay - ssnitEmployee - payeTax) * 100) / 100;
  return { grossPay: grossPay, ssnitEmployee: ssnitEmployee, ssnitEmployer: ssnitEmployer, taxableIncome: taxableIncome, payeTax: payeTax, netPay: netPay };
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

// payroll.listRuns
async function list(ctx) {
  if (!ctx.can('payroll.read')) fail('forbidden', 'Your role does not allow this action (payroll.read).');
  var res = await pool.query(
    'SELECT pr.*, e.first_name, e.last_name, ' +
    '(SELECT count(*)::int FROM payslips p WHERE p.pay_run_id = pr.id) AS employee_count, ' +
    '(SELECT coalesce(sum(net_pay),0) FROM payslips p WHERE p.pay_run_id = pr.id) AS total_net ' +
    'FROM pay_runs pr JOIN employees e ON e.id = pr.created_by ORDER BY pr.created_at DESC'
  );
  return res.rows.map(function (r) {
    return rowToPayRun(r, { createdByName: r.first_name + ' ' + r.last_name, employeeCount: r.employee_count, totalNet: Number(r.total_net) });
  });
}

// payroll.getRun — payslips are joined out to their employee's department
// and company (the Companies tier added in migration 0032) so the Payroll
// screen can filter one run's payslips by company/department client-side,
// same as it already does with the employee filter; a pay run itself still
// spans every eligible employee on its cycle regardless of company —
// filtering only narrows what's shown, never what a run contains.
async function get(ctx, id) {
  if (!ctx.can('payroll.read')) fail('forbidden', 'Your role does not allow this action (payroll.read).');
  var runRes = await pool.query('SELECT * FROM pay_runs WHERE id = $1', [id]);
  var run = runRes.rows[0];
  if (!run) fail('notfound', 'Pay run not found.');
  var slipsRes = await pool.query(
    'SELECT p.*, e.code, e.first_name, e.last_name, e.position_title, d.id AS department_id, d.name AS department_name, c.id AS company_id, c.name AS company_name ' +
    'FROM payslips p JOIN employees e ON e.id = p.employee_id ' +
    'JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id ' +
    'WHERE p.pay_run_id = $1 ORDER BY e.first_name',
    [id]
  );
  var slips = slipsRes.rows.map(function (r) {
    return rowToPayslip(r, {
      employeeCode: r.code, employeeName: r.first_name + ' ' + r.last_name, positionTitle: r.position_title,
      departmentId: r.department_id, departmentName: r.department_name, companyId: r.company_id, companyName: r.company_name
    });
  });
  return Object.assign(rowToPayRun(run), { payslips: slips });
}

// payroll.createRun — one payslip per active employee on the chosen cycle,
// days worked pulled automatically from Attendance for the period.
async function create(ctx, p) {
  if (!ctx.can('payroll.manage')) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  var cycle = V.oneOf(p.cycle, ['monthly', 'biweekly', 'daily'], 'Cycle');
  var periodStart = V.date(p.periodStart, 'Period start');
  var periodEnd = V.date(p.periodEnd, 'Period end');
  var payDate = V.date(p.payDate || todayISO(), 'Pay date');
  if (periodEnd < periodStart) fail('invalid', 'Period end must be on or after period start.');

  var employeesRes = await pool.query("SELECT id, daily_rate FROM employees WHERE status = 'active' AND pay_cycle = $1", [cycle]);
  if (!employeesRes.rows.length) fail('invalid', 'No active employees are on the ' + cycle + ' pay cycle.');

  var periodScale = periodScaleFor(periodStart, periodEnd);

  var newId = await withTransaction(async function (client) {
    var runNo = await nextDocNumber(client, 'payrun');
    var runRes = await client.query(
      "INSERT INTO pay_runs (run_no, cycle, period_start, period_end, pay_date, status, created_by) VALUES ($1,$2,$3,$4,$5,'draft',$6) RETURNING *",
      [runNo, cycle, periodStart, periodEnd, payDate, ctx.employee.id]
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
      var slip = await computeSlipFields(client, dailyRate, daysWorked, periodScale);

      await client.query(
        'INSERT INTO payslips (pay_run_id, employee_id, days_worked, daily_rate, gross_pay, ssnit_employee, ssnit_employer, taxable_income, paye_tax, net_pay) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [run.id, emp.id, daysWorked, dailyRate, slip.grossPay, slip.ssnitEmployee, slip.ssnitEmployer, slip.taxableIncome, slip.payeTax, slip.netPay]
      );
    }

    await audit(client, ctx, 'payroll.create', 'pay_run', run.id,
      'Created ' + cycle + ' pay run ' + run.run_no + ' for ' + periodStart + ' to ' + periodEnd + ' (' + employeesRes.rows.length + ' employees).');
    return run.id;
  });

  return get(ctx, newId);
}

// payroll.editSlip — while still a draft, HR/Finance can correct the
// auto-computed days worked (e.g. unpaid leave not reflected in
// Attendance yet); everything downstream recalculates from that.
async function editSlip(ctx, payRunId, employeeId, daysWorked) {
  if (!ctx.can('payroll.manage')) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  var runRes = await pool.query('SELECT * FROM pay_runs WHERE id = $1', [payRunId]);
  var run = runRes.rows[0];
  if (!run) fail('notfound', 'Pay run not found.');
  if (run.status !== 'draft') fail('invalid', 'Only a draft pay run can be edited.');

  var slipRes = await pool.query('SELECT * FROM payslips WHERE pay_run_id = $1 AND employee_id = $2', [payRunId, employeeId]);
  var slip = slipRes.rows[0];
  if (!slip) fail('notfound', 'Payslip not found.');

  var days = Number(daysWorked);
  if (!(days >= 0)) fail('invalid', 'Days worked must be a non-negative number.');

  var periodScale = periodScaleFor(run.period_start, run.period_end);
  var computed = await computeSlipFields(pool, Number(slip.daily_rate), days, periodScale);

  await pool.query(
    'UPDATE payslips SET days_worked = $1, gross_pay = $2, ssnit_employee = $3, ssnit_employer = $4, taxable_income = $5, paye_tax = $6, net_pay = $7 WHERE id = $8',
    [days, computed.grossPay, computed.ssnitEmployee, computed.ssnitEmployer, computed.taxableIncome, computed.payeTax, computed.netPay, slip.id]
  );
  await audit(pool, ctx, 'payroll.editSlip', 'pay_run', payRunId, 'Adjusted days worked in ' + run.run_no + '.');
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

module.exports = { list: list, get: get, create: create, editSlip: editSlip, approve: approve, markPaid: markPaid, payslipHistory: payslipHistory };
