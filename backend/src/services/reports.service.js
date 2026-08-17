var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var quotationsService = require('./quotations.service');

function todayISO() { return new Date().toISOString().slice(0, 10); }

// kernel.js: handlers['reports.summary']
async function summary(ctx) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');

  var invTotals = await pool.query("SELECT coalesce(sum(grand_total),0) AS invoiced, coalesce(sum(grand_total) FILTER (WHERE status = 'paid'),0) AS paid FROM invoices");
  var byCat = await pool.query("SELECT category, sum(amount) AS amount FROM expenses WHERE status != 'rejected' GROUP BY category ORDER BY amount DESC");
  var byCustomer = await pool.query(
    'SELECT c.name, sum(o.total) AS amount FROM sales_orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.name ORDER BY amount DESC'
  );
  var quotationsSent = await pool.query("SELECT count(*)::int AS n FROM quotations WHERE status != 'draft'");
  var quotationsAccepted = await pool.query("SELECT count(*)::int AS n FROM quotations WHERE status = 'accepted'");
  var ordersCount = await pool.query('SELECT count(*)::int AS n FROM sales_orders');
  var approvedExpenses = await pool.query("SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE status IN ('approved','paid')");

  return {
    totalInvoiced: Number(invTotals.rows[0].invoiced), totalPaid: Number(invTotals.rows[0].paid),
    outstanding: Number(invTotals.rows[0].invoiced) - Number(invTotals.rows[0].paid),
    quotationsSent: quotationsSent.rows[0].n, quotationsAccepted: quotationsAccepted.rows[0].n, ordersCount: ordersCount.rows[0].n,
    expenseByCategory: byCat.rows.map(function (r) { return { category: r.category, amount: Number(r.amount) }; }),
    salesByCustomer: byCustomer.rows.map(function (r) { return { customer: r.name, amount: Number(r.amount) }; }),
    totalExpensesApproved: Number(approvedExpenses.rows[0].s)
  };
}

// kernel.js: handlers['marketing.dashboard']
async function marketingDashboard(ctx) {
  if (!ctx.can('customer.read')) fail('forbidden', 'Your role does not allow this action (customer.read).');
  var cats = ['lead', 'prospect', 'active', 'vip', 'inactive'];
  var pipelineRes = await pool.query('SELECT category, count(*)::int AS n FROM customers GROUP BY category');
  var pipelineByCat = {}; pipelineRes.rows.forEach(function (r) { pipelineByCat[r.category] = r.n; });
  var pipeline = cats.map(function (c) { return { category: c, count: pipelineByCat[c] || 0 }; });

  var totalCustomers = await pool.query('SELECT count(*)::int AS n FROM customers');
  var funnelRes = await pool.query(
    "SELECT count(*) FILTER (WHERE status != 'draft')::int AS sent, count(*) FILTER (WHERE status = 'accepted')::int AS accepted, " +
    "count(*) FILTER (WHERE status IN ('rejected','expired'))::int AS rejected FROM quotations"
  );
  var f = funnelRes.rows[0];

  var topCustomersRes = await pool.query(
    'SELECT c.name, sum(o.total) AS total FROM sales_orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.name ORDER BY total DESC LIMIT 5'
  );
  var leadsRes = await pool.query(
    "SELECT c.*, m.first_name, m.last_name FROM customers c LEFT JOIN employees m ON m.id = c.account_manager_id WHERE c.category IN ('lead','prospect')"
  );
  var recentQuotesRes = await pool.query(
    'SELECT q.quote_no, q.grand_total, q.status, c.name AS customer_name FROM quotations q JOIN customers c ON c.id = q.customer_id ORDER BY q.created_at DESC LIMIT 5'
  );

  return {
    pipeline: pipeline, totalCustomers: totalCustomers.rows[0].n,
    funnel: { sent: f.sent, accepted: f.accepted, rejected: f.rejected, conversionRate: f.sent ? Math.round((f.accepted / f.sent) * 100) : 0 },
    topCustomers: topCustomersRes.rows.map(function (r) { return { name: r.name, total: Number(r.total) }; }),
    leads: leadsRes.rows.map(function (r) { return { name: r.name, contactPerson: r.contact_person, email: r.email, phone: r.phone, category: r.category, managerName: r.first_name ? r.first_name + ' ' + r.last_name : '—' }; }),
    recentQuotes: recentQuotesRes.rows.map(function (r) { return { quoteNo: r.quote_no, customerName: r.customer_name, total: Number(r.grand_total), status: r.status }; })
  };
}

// kernel.js: handlers['finance.dashboard']
async function financeDashboard(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var t = todayISO();
  var periodType = (params && params.periodType === 'years') ? 'years' : 'months';
  var periodCount = Math.max(1, Math.min(12, Number(params && params.periodCount) || 6));

  var overdueRes = await pool.query(
    "SELECT i.invoice_no, i.grand_total, i.due_date, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id " +
    "WHERE i.status != 'paid' AND i.due_date < $1 ORDER BY i.due_date",
    [t]
  );
  var overdue = overdueRes.rows.map(function (r) {
    return { invoiceNo: r.invoice_no, customerName: r.customer_name, amount: Number(r.grand_total), daysOverdue: Math.round((new Date(t) - new Date(r.due_date)) / 86400000) };
  }).sort(function (a, b) { return b.daysOverdue - a.daysOverdue; });

  var unpaidRes = await pool.query("SELECT coalesce(sum(grand_total),0) AS s, count(*)::int AS n FROM invoices WHERE status != 'paid'");
  var paidThisMonthRes = await pool.query("SELECT coalesce(sum(grand_total),0) AS s FROM invoices WHERE status = 'paid' AND paid_at IS NOT NULL AND to_char(paid_at,'YYYY-MM') = $1", [t.slice(0, 7)]);

  var pendingExpensesRes = await pool.query(
    "SELECT e.category, e.amount, e.date, emp.first_name, emp.last_name, d.name AS dept_name FROM expenses e " +
    "JOIN employees emp ON emp.id = e.requester_id JOIN departments d ON d.id = e.department_id WHERE e.status = 'pending'"
  );
  var approvedExpensesThisMonthRes = await pool.query(
    "SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE status IN ('approved','paid') AND to_char(date,'YYYY-MM') = $1", [t.slice(0, 7)]
  );

  var months = [];
  if (periodType === 'years') {
    for (var y = periodCount - 1; y >= 0; y--) {
      var yr = new Date().getFullYear() - y;
      var revRes = await pool.query("SELECT coalesce(sum(grand_total),0) AS s FROM invoices WHERE status = 'paid' AND to_char(paid_at,'YYYY') = $1", [String(yr)]);
      var expRes = await pool.query("SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE status IN ('approved','paid') AND to_char(date::date,'YYYY') = $1", [String(yr)]);
      months.push({ month: String(yr), revenue: Number(revRes.rows[0].s), expense: Number(expRes.rows[0].s) });
    }
  } else {
    for (var m = periodCount - 1; m >= 0; m--) {
      var dt = new Date(); dt.setMonth(dt.getMonth() - m);
      var key = dt.toISOString().slice(0, 7);
      var label = dt.toLocaleDateString('en-GB', { month: 'short', year: periodCount > 12 ? '2-digit' : undefined });
      var revRes2 = await pool.query("SELECT coalesce(sum(grand_total),0) AS s FROM invoices WHERE status = 'paid' AND to_char(paid_at,'YYYY-MM') = $1", [key]);
      var expRes2 = await pool.query("SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE status IN ('approved','paid') AND to_char(date::date,'YYYY-MM') = $1", [key]);
      months.push({ month: label, revenue: Number(revRes2.rows[0].s), expense: Number(expRes2.rows[0].s) });
    }
  }

  var recentPaymentsRes = await pool.query(
    'SELECT pm.*, c.name AS customer_name, i.invoice_no FROM payments pm JOIN customers c ON c.id = pm.customer_id JOIN invoices i ON i.id = pm.invoice_id ORDER BY pm.date DESC LIMIT 6'
  );

  var paidThisMonth = Number(paidThisMonthRes.rows[0].s);
  var approvedExpensesThisMonth = Number(approvedExpensesThisMonthRes.rows[0].s);

  return {
    cashCollectedThisMonth: paidThisMonth,
    outstandingTotal: Number(unpaidRes.rows[0].s), unpaidCount: unpaidRes.rows[0].n,
    overdueInvoices: overdue, overdueTotal: overdue.reduce(function (s, i) { return s + i.amount; }, 0),
    pendingExpenses: pendingExpensesRes.rows.map(function (r) { return { category: r.category, amount: Number(r.amount), requesterName: r.first_name + ' ' + r.last_name, departmentName: r.dept_name, date: r.date }; }),
    pendingExpensesTotal: pendingExpensesRes.rows.reduce(function (s, r) { return s + Number(r.amount); }, 0),
    approvedExpensesThisMonth: approvedExpensesThisMonth,
    netPositionThisMonth: paidThisMonth - approvedExpensesThisMonth,
    monthlyTrend: months,
    recentPayments: recentPaymentsRes.rows.map(function (r) { return { customerName: r.customer_name, invoiceNo: r.invoice_no, amount: Number(r.amount), date: r.date, method: r.method }; })
  };
}

// kernel.js: handlers['commercial.dashboard']
async function commercialDashboard(ctx) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var t = todayISO();
  await quotationsService.list(ctx).catch(function () {}); // triggers autoExpireQuotations as a side effect, same as kernel

  var qCounts = await pool.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('sent','viewed'))::int AS awaiting, " +
    "count(*) FILTER (WHERE status = 'accepted')::int AS accepted, count(*) FILTER (WHERE status = 'rejected')::int AS rejected, " +
    "count(*) FILTER (WHERE status = 'expired')::int AS expired, count(*) FILTER (WHERE status != 'draft')::int AS sent, " +
    "coalesce(sum(grand_total),0) AS total_value FROM quotations"
  );
  var q = qCounts.rows[0];

  var invCounts = await pool.query(
    "SELECT count(*)::int AS total, coalesce(sum(grand_total),0) AS total_invoiced, coalesce(sum(amount_paid),0) AS total_paid, " +
    "coalesce(sum(balance_due),0) AS outstanding, count(*) FILTER (WHERE balance_due > 0 AND due_date < $1)::int AS overdue_count, " +
    "coalesce(sum(balance_due) FILTER (WHERE balance_due > 0 AND due_date < $1),0) AS overdue_amount, " +
    "coalesce(sum(grand_total) FILTER (WHERE to_char(issued_at,'YYYY-MM') = $2),0) AS revenue_month, " +
    "coalesce(sum(grand_total) FILTER (WHERE to_char(issued_at,'YYYY') = $3),0) AS revenue_year " +
    'FROM invoices',
    [t, t.slice(0, 7), t.slice(0, 4)]
  );
  var inv = invCounts.rows[0];

  var months = [];
  for (var m = 5; m >= 0; m--) {
    var dt = new Date(); dt.setMonth(dt.getMonth() - m);
    var key = dt.toISOString().slice(0, 7);
    var invoicedRes = await pool.query("SELECT coalesce(sum(grand_total),0) AS s FROM invoices WHERE to_char(issued_at,'YYYY-MM') = $1", [key]);
    var paidRes = await pool.query("SELECT coalesce(sum(amount),0) AS s FROM payments WHERE to_char(date::date,'YYYY-MM') = $1", [key]);
    months.push({ month: dt.toLocaleDateString('en-GB', { month: 'short' }), invoiced: Number(invoicedRes.rows[0].s), paid: Number(paidRes.rows[0].s) });
  }

  var upcomingRes = await pool.query(
    "SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.balance_due > 0 AND i.due_date >= $1 ORDER BY i.due_date LIMIT 5",
    [t]
  );
  var overdueListRes = await pool.query(
    "SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.balance_due > 0 AND i.due_date < $1 ORDER BY i.due_date",
    [t]
  );
  var recentQuotesRes = await pool.query('SELECT q.*, c.name AS customer_name FROM quotations q JOIN customers c ON c.id = q.customer_id ORDER BY q.created_at DESC LIMIT 5');
  var recentInvoicesRes = await pool.query('SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.issued_at DESC LIMIT 5');
  var recentPaymentsRes = await pool.query(
    'SELECT pm.*, c.name AS customer_name, i.invoice_no FROM payments pm JOIN customers c ON c.id = pm.customer_id JOIN invoices i ON i.id = pm.invoice_id ORDER BY pm.date DESC LIMIT 5'
  );

  function invRow(r) { return { invoiceNo: r.invoice_no, customerName: r.customer_name, balanceDue: Number(r.balance_due), dueDate: r.due_date }; }
  function quoteRow(r) { return { quoteNo: r.quote_no, customerName: r.customer_name, grandTotal: Number(r.grand_total), status: r.status }; }

  return {
    totalQuotations: q.total, awaitingResponse: q.awaiting, acceptedQuotations: q.accepted, rejectedQuotations: q.rejected, expiredQuotations: q.expired,
    totalQuotationValue: Number(q.total_value), conversionRate: q.sent ? Math.round((q.accepted / q.sent) * 100) : 0,
    totalInvoices: inv.total, totalInvoicedAmount: Number(inv.total_invoiced), totalPaid: Number(inv.total_paid), outstandingBalance: Number(inv.outstanding),
    overdueCount: inv.overdue_count, overdueAmount: Number(inv.overdue_amount),
    revenueThisMonth: Number(inv.revenue_month), revenueThisYear: Number(inv.revenue_year),
    monthly: months, upcomingDue: upcomingRes.rows.map(invRow), overdueInvoices: overdueListRes.rows.map(invRow),
    recentQuotes: recentQuotesRes.rows.map(quoteRow), recentInvoices: recentInvoicesRes.rows.map(invRow),
    recentPayments: recentPaymentsRes.rows.map(function (r) { return { invoiceNo: r.invoice_no, customerName: r.customer_name, amount: Number(r.amount), date: r.date, method: r.method }; })
  };
}

module.exports = { summary: summary, marketingDashboard: marketingDashboard, financeDashboard: financeDashboard, commercialDashboard: commercialDashboard };
