var { pool } = require('../db/pool');
var { visibleEmployee } = require('../middleware/rbac');
var approvalsService = require('./approvals.service');

function todayISO() { return new Date().toISOString().slice(0, 10); }

// kernel.js: handlers['dashboard.load']
async function load(ctx) {
  var t = todayISO();

  var empRes = await pool.query("SELECT id, department_id, manager_id FROM employees WHERE status != 'terminated'");
  var visible = [];
  for (var i = 0; i < empRes.rows.length; i++) {
    if (await visibleEmployee(ctx, empRes.rows[i])) visible.push(empRes.rows[i]);
  }
  var visibleIds = {}; visible.forEach(function (e) { visibleIds[e.id] = true; });

  var attRes = await pool.query('SELECT employee_id, status FROM attendance WHERE date = $1', [t]);
  var inToday = attRes.rows.filter(function (a) { return visibleIds[a.employee_id]; });

  var pendingLeaveRes = await pool.query("SELECT employee_id FROM leave_requests WHERE status = 'pending'");
  var pendingLeave = pendingLeaveRes.rows.filter(function (l) { return visibleIds[l.employee_id]; });

  var onLeaveRes = await pool.query(
    "SELECT employee_id FROM leave_requests WHERE status = 'approved' AND start_date <= $1 AND end_date >= $1",
    [t]
  );
  var onLeaveToday = onLeaveRes.rows.filter(function (l) { return visibleIds[l.employee_id]; }).length;

  var approvalQueue = ctx.can('approval.act') ? await approvalsService.queue(ctx) : [];

  var deptRes = await pool.query('SELECT id, name, code FROM departments');
  var departments = [];
  for (i = 0; i < deptRes.rows.length; i++) {
    var d = deptRes.rows[i];
    var people = visible.filter(function (e) { return e.department_id === d.id; });
    if (!people.length) continue;
    var peopleIds = {}; people.forEach(function (e) { peopleIds[e.id] = true; });
    var present = inToday.filter(function (a) { return peopleIds[a.employee_id] && a.status !== 'absent'; }).length;
    departments.push({ name: d.name, code: d.code, headcount: people.length, present: present, rate: Math.round((present / people.length) * 100) });
  }

  var recentAudit = [];
  if (ctx.can('audit.read')) {
    var auditRes = await pool.query('SELECT * FROM audit_logs ORDER BY at DESC LIMIT 6');
    recentAudit = auditRes.rows.map(function (l) { return { id: l.id, at: l.at, actorName: l.actor_name, action: l.action, summary: l.summary }; });
  }

  var myTasksRes = await pool.query(
    "SELECT count(*)::int AS n FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id " +
    "WHERE ta.employee_id = $1 AND t.status NOT IN ('completed','cancelled')",
    [ctx.employee.id]
  );

  var announcementRes = await pool.query(
    "SELECT title FROM announcements WHERE audience_scope = 'all' OR department_id = $1 ORDER BY published_at DESC LIMIT 1",
    [ctx.employee.department_id]
  );

  var lowStockCount = null;
  if (ctx.can('inventory.read')) {
    var r = await pool.query('SELECT count(*)::int AS n FROM products WHERE current_stock <= reorder_level');
    lowStockCount = r.rows[0].n;
  }
  var pendingProcurement = null;
  if (ctx.can('procurement.read.all')) {
    var r2 = await pool.query("SELECT count(*)::int AS n FROM procurement_requests WHERE status = 'pending'");
    pendingProcurement = r2.rows[0].n;
  }
  var assetsDueService = null;
  if (ctx.can('asset.read')) {
    var r3 = await pool.query('SELECT count(*)::int AS n FROM assets WHERE next_service_date IS NOT NULL AND next_service_date <= $1', [new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)]);
    assetsDueService = r3.rows[0].n;
  }
  var outstandingInvoices = null;
  if (ctx.can('invoice.read')) {
    // Grouped by currency rather than blended into one number — a company
    // invoicing in more than one currency can't meaningfully sum GHS and
    // USD amounts together (see documents.js's resolveCurrency()).
    var r4 = await pool.query("SELECT currency, sum(grand_total) AS s FROM invoices WHERE status != 'paid' GROUP BY currency ORDER BY s DESC");
    outstandingInvoices = r4.rows.map(function (r) { return { currency: r.currency, amount: Number(r.s) }; });
  }
  var pendingExpenses = null;
  if (ctx.can('expense.read.all')) {
    var r5 = await pool.query("SELECT count(*)::int AS n FROM expenses WHERE status = 'pending'");
    pendingExpenses = r5.rows[0].n;
  }

  return {
    headcount: visible.length,
    presentToday: inToday.filter(function (a) { return a.status !== 'absent'; }).length,
    lateToday: inToday.filter(function (a) { return a.status === 'late'; }).length,
    notClockedIn: Math.max(0, visible.length - inToday.length),
    onLeaveToday: onLeaveToday,
    pendingLeave: pendingLeave.length,
    approvalQueue: approvalQueue.length,
    departments: departments,
    recentAudit: recentAudit,
    myOpenTasks: myTasksRes.rows[0].n,
    latestAnnouncement: announcementRes.rows[0] ? announcementRes.rows[0].title : null,
    lowStockCount: lowStockCount,
    pendingProcurement: pendingProcurement,
    assetsDueService: assetsDueService,
    outstandingInvoices: outstandingInvoices,
    pendingExpenses: pendingExpenses
  };
}

module.exports = { load: load };
