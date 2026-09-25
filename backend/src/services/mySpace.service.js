var { pool } = require('../db/pool');
var { rowToAttendance } = require('./attendance.service');
var { rowToLeaveRequest } = require('./leave.service');

// My space: everything about the signed-in person, for themselves only —
// nothing here depends on a permission beyond being signed in, and every
// query is keyed on their own employee or user id.
//
// Today's clock and shift, the last 14 days and this month's attendance,
// leave balances with what is waiting for a decision, their leave
// requests, the tasks assigned to them, their expense claims and purchase
// requests, their latest payslips from approved or paid runs (drafts stay
// with payroll until approved), announcements they haven't read or still
// need to confirm, how many approvals wait for them, and their account's
// sign-in safety.

function iso(d) { return d.toISOString().slice(0, 10); }

async function overview(ctx) {
  var emp = ctx.employee.id;
  var today = iso(new Date());
  var monthStart = today.slice(0, 8) + '01';
  var year = new Date().getFullYear();
  var since14 = iso(new Date(Date.now() - 13 * 86400000));

  var profile = (await pool.query(
    "SELECT e.*, d.name AS department_name, c.name AS company_name, m.first_name || ' ' || m.last_name AS manager_name, " +
    '  s.name AS shift_name, s.start_time AS tpl_start, s.end_time AS tpl_end ' +
    'FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id ' +
    'LEFT JOIN employees m ON m.id = e.manager_id LEFT JOIN shifts s ON s.id = e.shift_id WHERE e.id = $1', [emp])).rows[0];
  var start = profile.tpl_start || profile.shift_start || null;
  var end = profile.tpl_end || profile.shift_end || null;

  var todayRow = (await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND date = $2', [emp, today])).rows[0];
  var recent = (await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND date >= $2 ORDER BY date', [emp, since14])).rows;
  var month = (await pool.query(
    "SELECT count(*) FILTER (WHERE status IN ('present', 'late', 'half_day'))::int AS days, count(*) FILTER (WHERE status = 'late')::int AS late, " +
    "  count(*) FILTER (WHERE status = 'absent')::int AS absent, count(*) FILTER (WHERE auto_clocked_out)::int AS auto_out, " +
    '  COALESCE(sum(EXTRACT(EPOCH FROM ((COALESCE(clock_out_date, date) + clock_out) - (date + clock_in))) / 3600) FILTER (WHERE clock_in IS NOT NULL AND clock_out IS NOT NULL), 0)::float AS hours ' +
    'FROM attendance WHERE employee_id = $1 AND date >= $2', [emp, monthStart])).rows[0];

  var balances = (await pool.query(
    'SELECT lb.entitled, lb.used, lt.id AS leave_type_id, lt.name, lt.paid, ' +
    "  COALESCE((SELECT sum(days) FROM leave_requests r WHERE r.employee_id = $1 AND r.leave_type_id = lt.id AND r.status = 'pending' AND extract(year from r.start_date) = $2), 0)::int AS pending " +
    'FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id WHERE lb.employee_id = $1 AND lb.year = $2 AND lt.active ORDER BY lt.name', [emp, year])).rows;
  var leave = (await pool.query(
    'SELECT lr.*, lt.name AS type_name FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.employee_id = $1 ORDER BY lr.start_date DESC LIMIT 20', [emp])).rows;

  var tasks = (await pool.query(
    'SELECT t.id, t.title, t.priority, t.due_date, t.status, p.name AS project_name FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id ' +
    "LEFT JOIN projects p ON p.id = t.project_id WHERE ta.employee_id = $1 AND t.status NOT IN ('done', 'completed', 'cancelled') " +
    'ORDER BY t.due_date NULLS LAST, t.created_at LIMIT 30', [emp])).rows;
  var doneMonth = (await pool.query(
    "SELECT count(*)::int AS n FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id WHERE ta.employee_id = $1 AND t.status IN ('done', 'completed') AND t.completed_at >= $2", [emp, monthStart])).rows[0].n;

  var claims = (await pool.query(
    'SELECT id, category, amount, date, status, decision_note, paid_at, receipt_key FROM expenses WHERE requester_id = $1 ORDER BY created_at DESC LIMIT 10', [emp])).rows;
  var purchases = (await pool.query(
    "SELECT id, item, quantity, estimated_price, status, created_at FROM procurement_requests WHERE requester_id = $1 AND created_at >= now() - interval '90 days' ORDER BY created_at DESC LIMIT 10", [emp])).rows;
  var payslips = (await pool.query(
    "SELECT p.days_worked, p.gross_pay, p.net_pay, p.ssnit_employee, p.paye_tax, pr.run_no, pr.period_start, pr.period_end, pr.pay_date, pr.status " +
    "FROM payslips p JOIN pay_runs pr ON pr.id = p.pay_run_id WHERE p.employee_id = $1 AND pr.status IN ('approved', 'paid') ORDER BY pr.period_end DESC LIMIT 6", [emp])).rows;

  var announcements = [];
  try {
    var list = await require('./announcements.service').list(ctx);
    announcements = list.filter(function (a) { return !a.read || (a.requiresAck && !a.acknowledged); }).slice(0, 5)
      .map(function (a) { return { id: a.id, title: a.title, publishedAt: a.publishedAt, requiresAck: a.requiresAck, read: a.read, acknowledged: a.acknowledged }; });
  } catch (e) { announcements = []; }

  var approvals = 0;
  if (ctx.can('approval.act')) {
    try { approvals = (await require('./approvals.service').queue(ctx, {})).length; } catch (e) { approvals = 0; }
  }
  var account = (await pool.query(
    'SELECT email, last_login_at, created_at, totp_enabled_at, sms_two_step_at, email_two_step_at, ' +
    '  EXISTS (SELECT 1 FROM mcp_oauth_tokens t WHERE t.user_id = users.id AND t.revoked_at IS NULL AND t.expires_at > now()) AS claude ' +
    'FROM users WHERE id = $1', [ctx.user.id])).rows[0];
  var unread = (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND NOT read', [emp])).rows[0].n;

  return {
    today: today,
    profile: {
      id: profile.id, code: profile.code, name: profile.first_name + ' ' + profile.last_name, firstName: profile.first_name,
      title: profile.position_title || '', department: profile.department_name || '', company: profile.company_name || '',
      manager: profile.manager_name || null, hireDate: profile.hire_date || null, email: profile.email || '', phone: profile.phone || '',
      employmentType: profile.employment_type || '', photo: profile.photo_key ? (profile.photo_updated_at ? new Date(profile.photo_updated_at).getTime() : 1) : null
    },
    shift: { name: profile.shift_name || profile.shift || null, start: start ? String(start).slice(0, 5) : null, end: end ? String(end).slice(0, 5) : null },
    todayAttendance: todayRow ? rowToAttendance(todayRow) : null,
    recent: recent.map(rowToAttendance),
    month: { days: month.days, late: month.late, absent: month.absent, autoOut: month.auto_out, hours: Math.round(month.hours * 10) / 10 },
    balances: balances.map(function (b) {
      return { leaveTypeId: b.leave_type_id, name: b.name, paid: b.paid, entitled: Number(b.entitled), used: Number(b.used), pending: b.pending, left: Number(b.entitled) - Number(b.used) };
    }),
    leave: leave.map(function (r) { return Object.assign(rowToLeaveRequest(r), { typeName: r.type_name }); }),
    tasks: tasks.map(function (t) { return { id: t.id, title: t.title, priority: t.priority, dueDate: t.due_date, status: t.status, project: t.project_name || null }; }),
    tasksDoneThisMonth: doneMonth,
    claims: claims.map(function (c) {
      return { id: c.id, category: c.category, amount: Number(c.amount), date: c.date, status: c.status, note: c.decision_note || '', paidAt: c.paid_at, hasReceipt: !!c.receipt_key };
    }),
    purchases: purchases.map(function (p) { return { id: p.id, item: p.item, quantity: Number(p.quantity), estimatedPrice: Number(p.estimated_price), status: p.status, createdAt: p.created_at }; }),
    payslips: payslips.map(function (p) {
      return {
        runNo: p.run_no, periodStart: p.period_start, periodEnd: p.period_end, payDate: p.pay_date, status: p.status, daysWorked: Number(p.days_worked),
        gross: Number(p.gross_pay), net: Number(p.net_pay), ssnit: Number(p.ssnit_employee), paye: Number(p.paye_tax)
      };
    }),
    announcements: announcements,
    approvalsWaiting: approvals,
    unreadNotifications: unread,
    account: {
      email: account.email, lastLoginAt: account.last_login_at, since: account.created_at, roles: ctx.roleNames,
      twoStep: { app: !!account.totp_enabled_at, sms: !!account.sms_two_step_at, email: !!account.email_two_step_at }, claudeConnected: !!account.claude
    }
  };
}

module.exports = { overview: overview };
