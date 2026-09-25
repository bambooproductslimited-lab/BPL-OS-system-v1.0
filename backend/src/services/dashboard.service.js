var { pool } = require('../db/pool');
var { visibleEmployee } = require('../middleware/rbac');
var approvalsService = require('./approvals.service');
var marketingChannels = require('./marketingChannels');

function todayISO() { return new Date().toISOString().slice(0, 10); }
function isoPlus(t, days) { return new Date(new Date(t + 'T00:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10); }
function dayStr(d) { return d ? (d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function hhmm(t) { return t ? String(t).slice(0, 5) : null; }

// kernel.js: handlers['dashboard.load'] -> GET /api/dashboard?company=
//
// Everything is what this person may see: the people count only those
// visibleEmployee() allows, and each money or stock figure only appears
// with its own permission. company narrows it to one company — its people
// (by department), their leave, attendance, purchase requests and assets
// (by who holds them), its invoices and expense claims (same rules as the
// finance dashboard), its stock — or leaves it at every company together
// (ALL, the default, which is what this screen always showed and what the
// AI assistant's overview reads).
async function load(ctx, companyCode) {
  var t = todayISO();
  var companiesRes = await pool.query("SELECT id, code, name FROM companies WHERE status = 'active' ORDER BY name");
  var deptRes = await pool.query('SELECT d.id, d.name, d.code, d.company_id FROM departments d');
  var deptById = {}; deptRes.rows.forEach(function (d) { deptById[d.id] = d; });
  var bpl = companiesRes.rows.filter(function (c) { return c.code === 'BPL'; })[0];
  function companyOfDept(deptId) { var d = deptById[deptId]; return d ? d.company_id : (bpl && bpl.id); }

  var empRes = await pool.query(
    "SELECT id, first_name, last_name, department_id, manager_id, position_title, shift_start FROM employees WHERE status != 'terminated'"
  );
  var visibleAll = [];
  for (var i = 0; i < empRes.rows.length; i++) {
    if (await visibleEmployee(ctx, empRes.rows[i])) visibleAll.push(empRes.rows[i]);
  }

  // The companies this person can see people in, for the switcher.
  var seenCompany = {};
  visibleAll.forEach(function (e) { seenCompany[companyOfDept(e.department_id)] = true; });
  var restaurantIds = {};
  marketingChannels.trackedCompanies(companiesRes.rows).forEach(function (tc) {
    if (tc.channels === marketingChannels.RESTAURANT_CHANNELS) restaurantIds[tc.id] = true;
  });
  (await pool.query('SELECT DISTINCT company_id FROM restaurant_menu_items UNION SELECT DISTINCT company_id FROM restaurant_orders')).rows
    .forEach(function (r) { restaurantIds[r.company_id] = true; });
  // Also the restaurants for those who may see them, and any company with
  // its own customers (Poki) for those who may see invoices.
  var withCustomers = {};
  if (ctx.can('invoice.read')) {
    (await pool.query('SELECT DISTINCT company_id FROM customers WHERE company_id IS NOT NULL')).rows.forEach(function (r) { withCustomers[r.company_id] = true; });
  }
  var listed = companiesRes.rows.filter(function (c) {
    return seenCompany[c.id] || (restaurantIds[c.id] && ctx.can('restaurant.read')) || withCustomers[c.id];
  })
    .map(function (c) { return { id: c.id, code: c.code, name: c.name, kind: restaurantIds[c.id] ? 'restaurant' : 'trade' }; });
  var order = marketingChannels.trackedCompanies(listed).map(function (x) { return x.id; });
  listed.sort(function (x, y) { var a = order.indexOf(x.id), b = order.indexOf(y.id); return (a < 0 ? 99 : a) - (b < 0 ? 99 : b) || x.name.localeCompare(y.name); });

  var code = String(companyCode || 'ALL').trim().toUpperCase();
  var co = code === 'ALL' ? null : listed.filter(function (c) { return c.code.toUpperCase() === code; })[0] || null;
  function inScope(companyId) { return !co || companyId === co.id; }

  var visible = visibleAll.filter(function (e) { return inScope(companyOfDept(e.department_id)); });
  var visibleById = {}; visible.forEach(function (e) { visibleById[e.id] = e; });
  function nameOf(e) { return e.first_name + ' ' + e.last_name; }
  function deptName(e) { return deptById[e.department_id] ? deptById[e.department_id].name : ''; }

  var attRes = await pool.query('SELECT employee_id, status, clock_in FROM attendance WHERE date = $1', [t]);
  var inToday = attRes.rows.filter(function (a) { return visibleById[a.employee_id]; });
  var clocked = {}; inToday.forEach(function (a) { clocked[a.employee_id] = a; });

  var pendingLeaveRes = await pool.query("SELECT employee_id FROM leave_requests WHERE status = 'pending'");
  var pendingLeave = pendingLeaveRes.rows.filter(function (l) { return visibleById[l.employee_id]; });

  var leaveRes = await pool.query(
    "SELECT lr.employee_id, lr.start_date, lr.end_date, lt.name AS type FROM leave_requests lr LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id " +
    "WHERE lr.status = 'approved' AND lr.end_date >= $1 AND lr.start_date <= $2 ORDER BY lr.start_date",
    [t, isoPlus(t, 7)]
  );
  var onLeave = [], upcomingLeave = [], onLeaveIds = {};
  leaveRes.rows.forEach(function (l) {
    var e = visibleById[l.employee_id];
    if (!e) return;
    var row = { name: nameOf(e), department: deptName(e), type: l.type || '', from: dayStr(l.start_date), until: dayStr(l.end_date) };
    if (row.from <= t) { onLeave.push(row); onLeaveIds[e.id] = true; } else upcomingLeave.push(row);
  });

  var late = inToday.filter(function (a) { return a.status === 'late'; }).map(function (a) {
    var e = visibleById[a.employee_id];
    return { name: nameOf(e), department: deptName(e), clockIn: hhmm(a.clock_in), shiftStart: hhmm(e.shift_start) };
  }).sort(function (x, y) { return String(y.clockIn).localeCompare(String(x.clockIn)); });
  var notIn = visible.filter(function (e) { return !clocked[e.id] && !onLeaveIds[e.id]; }).map(function (e) {
    return { name: nameOf(e), department: deptName(e), shiftStart: hhmm(e.shift_start) };
  }).sort(function (x, y) { return String(x.shiftStart || '99').localeCompare(String(y.shiftStart || '99')) || x.name.localeCompare(y.name); });

  var approvalQueue = ctx.can('approval.act') ? await approvalsService.queue(ctx) : [];

  var departments = [];
  deptRes.rows.forEach(function (d) {
    var people = visible.filter(function (e) { return e.department_id === d.id; });
    if (!people.length) return;
    var present = people.filter(function (e) { return clocked[e.id] && clocked[e.id].status !== 'absent'; }).length;
    var lateN = people.filter(function (e) { return clocked[e.id] && clocked[e.id].status === 'late'; }).length;
    var away = people.filter(function (e) { return onLeaveIds[e.id]; }).length;
    var company = companiesRes.rows.filter(function (c) { return c.id === d.company_id; })[0];
    departments.push({
      name: d.name, code: d.code, company: company ? company.name : '', companyCode: company ? company.code : '',
      headcount: people.length, present: present, late: lateN, onLeave: away, rate: Math.round((present / people.length) * 100)
    });
  });

  var recentAudit = [];
  if (ctx.can('audit.read')) {
    // Changes people made, not sign-ins and sign-outs (which would fill the list).
    var auditRes = await pool.query("SELECT * FROM audit_logs WHERE action NOT IN ('auth.login', 'auth.logout') ORDER BY at DESC LIMIT 6");
    recentAudit = auditRes.rows.map(function (l) { return { id: l.id, at: l.at, actorName: l.actor_name, action: l.action, summary: l.summary }; });
  }

  // The person's own work: not per company.
  var myTasksRes = await pool.query(
    "SELECT count(*)::int AS n, count(*) FILTER (WHERE t.due_date < $2)::int AS overdue, count(*) FILTER (WHERE t.due_date = $2)::int AS due_today " +
    "FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id WHERE ta.employee_id = $1 AND t.status NOT IN ('completed','cancelled')",
    [ctx.employee.id, t]
  );
  var announcementRes = await pool.query(
    "SELECT title, published_at FROM announcements WHERE (audience_scope = 'all' OR department_id = $1 " +
    "OR (audience_scope = 'company' AND company_id = (SELECT company_id FROM departments WHERE id = $1))) " +
    'AND (expires_on IS NULL OR expires_on >= CURRENT_DATE) ORDER BY published_at DESC LIMIT 1',
    [ctx.employee.department_id]
  );

  var scopeId = co ? co.id : null;
  var isBpl = !co || co.code === 'BPL';

  // Bamboo Products' finished-goods stock.
  var lowStockCount = null;
  if (ctx.can('inventory.read') && isBpl) {
    lowStockCount = (await pool.query('SELECT count(*)::int AS n FROM products WHERE active AND current_stock <= reorder_level')).rows[0].n;
  }
  var pendingProcurement = null;
  if (ctx.can('procurement.read.all')) {
    var pr = await pool.query(
      "SELECT count(*)::int AS n FROM procurement_requests p LEFT JOIN departments d ON d.id = p.department_id WHERE p.status = 'pending' AND " +
      '($1::uuid IS NULL OR d.company_id = $1 OR (p.department_id IS NULL AND $2))', [scopeId, isBpl]
    );
    pendingProcurement = pr.rows[0].n;
  }
  var assetsDueService = null;
  if (ctx.can('asset.read')) {
    var ar = await pool.query(
      'SELECT count(*)::int AS n FROM assets a LEFT JOIN employees e ON e.id = a.assigned_employee_id LEFT JOIN departments d ON d.id = e.department_id ' +
      "WHERE a.status <> 'retired' AND a.next_service_date IS NOT NULL AND a.next_service_date <= $1 " +
      'AND ($2::uuid IS NULL OR coalesce(a.company_id, d.company_id) = $2 OR (coalesce(a.company_id, d.company_id) IS NULL AND $3))',
      [isoPlus(t, 7), scopeId, isBpl]
    );
    assetsDueService = ar.rows[0].n;
  }
  // Same company rules as the finance dashboard: the invoice's company,
  // else its customer's, else Bamboo Products'.
  var outstandingInvoices = null, overdueInvoices = null;
  if (ctx.can('invoice.read')) {
    var ir = await pool.query(
      "SELECT i.currency, sum(i.balance_due) AS s, count(*) FILTER (WHERE i.due_date < $3)::int AS overdue FROM invoices i JOIN customers c ON c.id = i.customer_id " +
      "WHERE i.status NOT IN ('paid','void') AND i.balance_due > 0 AND ($1::uuid IS NULL OR coalesce(i.company_id, c.company_id) = $1 OR (coalesce(i.company_id, c.company_id) IS NULL AND $2)) " +
      'GROUP BY i.currency ORDER BY s DESC', [scopeId, isBpl, t]
    );
    outstandingInvoices = ir.rows.map(function (r) { return { currency: r.currency, amount: Number(r.s) }; });
    overdueInvoices = ir.rows.reduce(function (s, r) { return s + r.overdue; }, 0);
  }
  var pendingExpenses = null;
  if (ctx.can('expense.read.all')) {
    var er = await pool.query(
      "SELECT count(*)::int AS n FROM expenses e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'pending' AND " +
      '($1::uuid IS NULL OR d.company_id = $1 OR (e.department_id IS NULL AND $2))', [scopeId, isBpl]
    );
    pendingExpenses = er.rows[0].n;
  }

  // The restaurants in scope: today's till against the same day last week,
  // and their kitchen stock.
  var restaurants = null;
  if (ctx.can('restaurant.read')) {
    var rs = listed.filter(function (c) { return c.kind === 'restaurant' && inScope(c.id); });
    restaurants = [];
    for (var k = 0; k < rs.length; k++) {
      var r = rs[k];
      var sales = await pool.query(
        "SELECT coalesce(sum(total) FILTER (WHERE created_at::date = $2), 0) AS today, count(*) FILTER (WHERE created_at::date = $2)::int AS orders, " +
        "coalesce(sum(total) FILTER (WHERE created_at::date = $2::date - 7), 0) AS last_week FROM restaurant_orders WHERE company_id = $1 AND status = 'completed'",
        [r.id, t]
      );
      var stock = await pool.query(
        'SELECT (SELECT count(*) FROM restaurant_ingredients WHERE company_id = $1 AND active AND stock_qty <= reorder_level)::int + ' +
        '(SELECT count(*) FROM restaurant_supplies WHERE company_id = $1 AND active AND stock_qty <= reorder_level)::int AS low, ' +
        '(SELECT count(*) FROM restaurant_ingredients WHERE company_id = $1 AND active AND expiry_date IS NOT NULL AND expiry_date <= $2::date + 3)::int AS expiring',
        [r.id, t]
      );
      restaurants.push({
        code: r.code, name: r.name,
        salesToday: Number(sales.rows[0].today), ordersToday: sales.rows[0].orders, salesSameDayLastWeek: Number(sales.rows[0].last_week),
        lowStock: stock.rows[0].low, expiringSoon: stock.rows[0].expiring
      });
    }
  }

  var currency = ((await pool.query('SELECT currency FROM settings WHERE id = 1')).rows[0] || {}).currency || 'GHS';

  return {
    today: t, currency: currency,
    company: co ? { code: co.code, name: co.name, kind: co.kind } : { code: 'ALL', name: '', kind: 'all' },
    companies: listed.map(function (c) { return { code: c.code, name: c.name, kind: c.kind }; }),
    headcount: visible.length,
    presentToday: inToday.filter(function (a) { return a.status !== 'absent'; }).length,
    lateToday: late.length,
    notClockedIn: notIn.length,
    onLeaveToday: onLeave.length,
    pendingLeave: pendingLeave.length,
    approvalQueue: approvalQueue.length,
    departments: departments,
    lateList: late.slice(0, 12),
    notClockedInList: notIn.slice(0, 12),
    onLeaveList: onLeave,
    upcomingLeave: upcomingLeave.slice(0, 10),
    recentAudit: recentAudit,
    myOpenTasks: myTasksRes.rows[0].n, myOverdueTasks: myTasksRes.rows[0].overdue, myTasksDueToday: myTasksRes.rows[0].due_today,
    latestAnnouncement: announcementRes.rows[0] ? announcementRes.rows[0].title : null,
    latestAnnouncementAt: announcementRes.rows[0] ? announcementRes.rows[0].published_at : null,
    lowStockCount: lowStockCount,
    pendingProcurement: pendingProcurement,
    assetsDueService: assetsDueService,
    outstandingInvoices: outstandingInvoices,
    overdueInvoices: overdueInvoices,
    pendingExpenses: pendingExpenses,
    restaurants: restaurants
  };
}

module.exports = { load: load };
