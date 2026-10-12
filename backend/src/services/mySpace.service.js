var { pool } = require('../db/pool');
var { rowToAttendance } = require('./attendance.service');
var { rowToLeaveRequest } = require('./leave.service');

// My space: everything about the signed-in person, for themselves only —
// nothing here depends on a permission beyond being signed in, and every
// query is keyed on their own employee or user id.
//
// Today's clock and shift, the last 14 days and this month's attendance,
// leave balances with what is waiting for a decision, their leave
// requests, the work orders they are on or manage, their expense claims and purchase
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

  var todayRow = (await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND date = $2 ORDER BY shift_no DESC LIMIT 1', [emp, today])).rows[0]; // the latest of the day's shifts
  var recent = (await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND date >= $2 ORDER BY date', [emp, since14])).rows;
  var month = (await pool.query(
    "SELECT count(*) FILTER (WHERE status IN ('present', 'late', 'half_day'))::int AS days, count(*) FILTER (WHERE status = 'late')::int AS late, " +
    "  count(*) FILTER (WHERE status = 'absent')::int AS absent, count(*) FILTER (WHERE auto_clocked_out)::int AS auto_out, " +
    '  COALESCE(sum(EXTRACT(EPOCH FROM ((COALESCE(clock_out_date, date) + clock_out) - (date + clock_in))) / 3600) FILTER (WHERE clock_in IS NOT NULL AND clock_out IS NOT NULL), 0)::float AS hours ' +
    'FROM attendance WHERE employee_id = $1 AND date >= $2', [emp, monthStart])).rows[0];

  var balances = (await pool.query(
    'SELECT lb.entitled, lb.used, lt.id AS leave_type_id, lt.name, lt.paid, lt.in_pool, ' +
    "  COALESCE((SELECT sum(days) FROM leave_requests r WHERE r.employee_id = $1 AND r.leave_type_id = lt.id AND r.status = 'pending' AND extract(year from r.start_date) = $2), 0)::int AS pending " +
    'FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id WHERE lb.employee_id = $1 AND lb.year = $2 AND lt.active ORDER BY lt.name', [emp, year])).rows;
  var leave = (await pool.query(
    'SELECT lr.*, lt.name AS type_name FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.employee_id = $1 ORDER BY lr.start_date DESC LIMIT 20', [emp])).rows;

  var tasks = (await pool.query(
    'SELECT t.id, t.wo_no, t.title, t.priority, t.due_date, t.status, t.project_manager_id, p.name AS project_name FROM tasks t ' +
    'LEFT JOIN projects p ON p.id = t.project_id WHERE (t.project_manager_id = $1 OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.employee_id = $1)) ' +
    "AND t.status NOT IN ('done', 'completed', 'cancelled') " +
    'ORDER BY t.due_date NULLS LAST, t.created_at LIMIT 30', [emp])).rows;
  var doneMonth = (await pool.query(
    "SELECT count(*)::int AS n FROM tasks t WHERE (t.project_manager_id = $1 OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.employee_id = $1)) " +
    "AND t.status IN ('done', 'completed') AND t.completed_at >= $2", [emp, monthStart])).rows[0].n;

  var claims = (await pool.query(
    'SELECT id, category, amount, date, status, decision_note, paid_at, receipt_key FROM expenses WHERE requester_id = $1 ORDER BY created_at DESC LIMIT 10', [emp])).rows;
  var purchases = (await pool.query(
    "SELECT id, item, quantity, estimated_price, status, created_at FROM procurement_requests WHERE requester_id = $1 AND created_at >= now() - interval '90 days' ORDER BY created_at DESC LIMIT 10", [emp])).rows;
  var payslips = (await pool.query(
    "SELECT p.days_worked, p.gross_pay, p.net_pay, p.ssnit_employee, p.paye_tax, p.paye_by_company, p.basic_pay, p.allowance_pay, p.pay_basis, pr.run_no, pr.period_start, pr.period_end, pr.pay_date, pr.status " +
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
  var fun = await funFacts(emp, profile, today);

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
      return { leaveTypeId: b.leave_type_id, name: b.name, paid: b.paid, inPool: b.in_pool, entitled: Number(b.entitled), used: Number(b.used), pending: b.pending, left: Number(b.entitled) - Number(b.used) };
    }),
    // The yearly total (leavePool.service.js): when it is in effect, the
    // types marked inPool are counted here, not in their own balances.
    leavePool: await require('./leavePool.service').poolFor(emp, year),
    leave: leave.map(function (r) { return Object.assign(rowToLeaveRequest(r), { typeName: r.type_name }); }),
    tasks: tasks.map(function (t) { return { id: t.id, number: 'WO-' + String(t.wo_no).padStart(4, '0'), title: t.title, priority: t.priority, dueDate: t.due_date, status: t.status, project: t.project_name || null, managing: t.project_manager_id === emp }; }),
    tasksDoneThisMonth: doneMonth,
    claims: claims.map(function (c) {
      return { id: c.id, category: c.category, amount: Number(c.amount), date: c.date, status: c.status, note: c.decision_note || '', paidAt: c.paid_at, hasReceipt: !!c.receipt_key };
    }),
    purchases: purchases.map(function (p) { return { id: p.id, item: p.item, quantity: Number(p.quantity), estimatedPrice: Number(p.estimated_price), status: p.status, createdAt: p.created_at }; }),
    payslips: payslips.map(function (p) {
      return {
        runNo: p.run_no, periodStart: p.period_start, periodEnd: p.period_end, payDate: p.pay_date, status: p.status, daysWorked: Number(p.days_worked),
        gross: Number(p.gross_pay), net: Number(p.net_pay), ssnit: Number(p.ssnit_employee), paye: Number(p.paye_tax), payeByCompany: !!p.paye_by_company, basic: Number(p.basic_pay), allowance: Number(p.allowance_pay), salaried: p.pay_basis === 'salary'
      };
    }),
    announcements: announcements,
    approvalsWaiting: approvals,
    unreadNotifications: unread,
    account: {
      email: account.email, lastLoginAt: account.last_login_at, since: account.created_at, roles: ctx.roleNames,
      twoStep: { app: !!account.totp_enabled_at, sms: !!account.sms_two_step_at, email: !!account.email_two_step_at }, claudeConnected: !!account.claude
    },
    fun: fun
  };
}

// The livelier bits of My space, all about the person themselves: how many
// of their clock-ins in a row were on time (and their best run in the last
// four months), this week's hours day by day against last week's, what is
// coming up for them (their next approved leave, the company's next public
// holiday, their birthday and work anniversary) and their team (names and
// photos, as Messages shows them to everyone).
function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
// The next yearly date of a YYYY-MM-DD, from today (29 February falls on
// 28 February in other years).
function nextYearly(isoDate, today) {
  if (!isoDate) return null;
  var y = Number(today.slice(0, 4)), md = String(isoDate).slice(5, 10);
  function at(year) { var v = year + '-' + md; return md === '02-29' && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? year + '-02-28' : v; }
  var next = at(y) >= today ? at(y) : at(y + 1);
  return { date: next, daysTo: dayDiff(today, next), years: Number(next.slice(0, 4)) - Number(String(isoDate).slice(0, 4)) };
}
async function funFacts(emp, profile, today) {
  var monday = (function () { var d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); })();
  var lastMonday = iso(new Date(Date.parse(monday + 'T00:00:00Z') - 7 * 86400000));
  var q = await Promise.all([
    pool.query("SELECT to_char(date, 'YYYY-MM-DD') AS date, bool_or(status = 'late') AS late, bool_or(status = 'absent') AS absent, bool_or(status IN ('present', 'half_day')) AS present " +
      'FROM attendance WHERE employee_id = $1 AND date >= CURRENT_DATE - 120 GROUP BY date ORDER BY date DESC', [emp]),
    pool.query("SELECT to_char(date, 'YYYY-MM-DD') AS date, CASE WHEN bool_or(status = 'late') THEN 'late' WHEN bool_or(status = 'absent') THEN 'absent' ELSE max(status) END AS status, " +
      '  COALESCE(sum(EXTRACT(EPOCH FROM ((COALESCE(clock_out_date, date) + clock_out) - (date + clock_in))) / 3600) FILTER (WHERE clock_in IS NOT NULL AND clock_out IS NOT NULL), 0)::float AS hours, ' +
      '  bool_or(clock_in IS NOT NULL AND clock_out IS NULL) AS open ' +
      'FROM attendance WHERE employee_id = $1 AND date >= $2 GROUP BY date', [emp, lastMonday]),
    profile.department_id ? pool.query("SELECT to_char(h.date, 'YYYY-MM-DD') AS date, h.name FROM holidays h JOIN departments d ON d.company_id = h.company_id WHERE d.id = $1 AND h.date >= CURRENT_DATE ORDER BY h.date LIMIT 1", [profile.department_id]) : { rows: [] },
    pool.query("SELECT to_char(lr.start_date, 'YYYY-MM-DD') AS start_date, to_char(lr.end_date, 'YYYY-MM-DD') AS end_date, lr.days, lt.name FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id " +
      "WHERE lr.employee_id = $1 AND lr.status = 'approved' AND lr.end_date >= CURRENT_DATE ORDER BY lr.start_date LIMIT 1", [emp]),
    profile.department_id ? pool.query("SELECT id, first_name, last_name, position_title, photo_key, photo_updated_at, count(*) OVER ()::int AS total FROM employees " +
      "WHERE department_id = $1 AND status = 'active' AND id <> $2 ORDER BY (photo_key IS NULL), first_name, last_name LIMIT 8", [profile.department_id, emp]) : { rows: [] }
  ]);
  // Streaks over the days they clocked in (days off do not break a run;
  // a late or absent day does).
  var days = q[0].rows, current = 0, best = 0, run = 0, counting = true;
  days.forEach(function (d) {
    var good = d.present && !d.late && !d.absent;
    if (good) { run++; if (counting) current++; } else { run = 0; counting = false; }
    if (run > best) best = run;
  });
  var byDate = {}; q[1].rows.forEach(function (r) { byDate[r.date] = r; });
  var week = [], weekHours = 0, lastWeekHours = 0;
  for (var i = 0; i < 7; i++) {
    var d = iso(new Date(Date.parse(monday + 'T00:00:00Z') + i * 86400000));
    var r = byDate[d];
    week.push({ date: d, hours: r ? Math.round(r.hours * 10) / 10 : 0, status: r ? r.status : null, open: !!(r && r.open), future: d > today });
    weekHours += r ? r.hours : 0;
  }
  // Last week, whole and up to the same weekday as today, so a week in
  // progress is compared with the same days of the one before.
  var sameDayLastWeek = iso(new Date(Date.parse(today + 'T00:00:00Z') - 7 * 86400000)), lastWeekSoFar = 0;
  q[1].rows.forEach(function (r2) { if (r2.date < monday) { lastWeekHours += r2.hours; if (r2.date <= sameDayLastWeek) lastWeekSoFar += r2.hours; } });
  var leave = q[3].rows[0];
  var hire = profile.hire_date ? String(profile.hire_date instanceof Date ? iso(profile.hire_date) : profile.hire_date).slice(0, 10) : null;
  var born = profile.date_of_birth ? String(profile.date_of_birth instanceof Date ? iso(profile.date_of_birth) : profile.date_of_birth).slice(0, 10) : null;
  var anniversary = hire ? nextYearly(hire, today) : null;
  if (anniversary && anniversary.years < 1) anniversary = null;
  var birthday = born ? nextYearly(born, today) : null;
  var team = q[4].rows;
  return {
    streak: current, bestStreak: best,
    week: week, weekHours: Math.round(weekHours * 10) / 10, lastWeekHours: Math.round(lastWeekHours * 10) / 10, lastWeekSoFar: Math.round(lastWeekSoFar * 10) / 10,
    nextLeave: leave ? { startDate: leave.start_date, endDate: leave.end_date, days: Number(leave.days), type: leave.name, daysTo: Math.max(0, dayDiff(today, leave.start_date)), onNow: leave.start_date <= today } : null,
    nextHoliday: q[2].rows[0] ? { date: q[2].rows[0].date, name: q[2].rows[0].name, daysTo: dayDiff(today, q[2].rows[0].date) } : null,
    birthday: birthday ? { date: birthday.date, daysTo: birthday.daysTo } : null,
    anniversary: anniversary,
    team: { size: team.length ? team[0].total : 0, people: team.map(function (t) {
      return { id: t.id, name: t.first_name + ' ' + t.last_name, title: t.position_title || '', photo: t.photo_key ? (t.photo_updated_at ? new Date(t.photo_updated_at).getTime() : 1) : null };
    }) }
  };
}

module.exports = { overview: overview, nextYearly: nextYearly, _nextYearly: nextYearly };
