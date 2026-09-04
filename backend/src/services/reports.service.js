var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var quotationsService = require('./quotations.service');

function todayISO() { return new Date().toISOString().slice(0, 10); }

async function baseCurrency() {
  var res = await pool.query('SELECT currency FROM settings WHERE id = 1');
  return res.rows[0].currency || 'GHS';
}

// A row-per-currency SQL result -> [{ currency, amount }], for reports that
// sum money across many documents that can each be in a different currency
// (see documents.js's resolveCurrency()) — never blended into one number.
function byCurrencyArr(rows, amountKey) {
  return rows.map(function (r) { return { currency: r.currency, amount: Number(r[amountKey]) }; });
}

// kernel.js: handlers['reports.summary']
async function summary(ctx) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');

  var invTotals = await pool.query("SELECT currency, sum(grand_total) AS invoiced, sum(grand_total) FILTER (WHERE status = 'paid') AS paid FROM invoices GROUP BY currency");
  var byCat = await pool.query("SELECT category, sum(amount) AS amount FROM expenses WHERE status != 'rejected' GROUP BY category ORDER BY amount DESC");
  var byCustomer = await pool.query(
    'SELECT c.name, o.currency, sum(o.total) AS amount FROM sales_orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.name, o.currency ORDER BY amount DESC'
  );
  var quotationsSent = await pool.query("SELECT count(*)::int AS n FROM quotations WHERE status != 'draft'");
  var quotationsAccepted = await pool.query("SELECT count(*)::int AS n FROM quotations WHERE status = 'accepted'");
  var ordersCount = await pool.query('SELECT count(*)::int AS n FROM sales_orders');
  var approvedExpenses = await pool.query("SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE status IN ('approved','paid')");

  var invoicedByCurrency = invTotals.rows.map(function (r) { return { currency: r.currency, amount: Number(r.invoiced) }; });
  var paidByCurrency = invTotals.rows.map(function (r) { return { currency: r.currency, amount: Number(r.paid || 0) }; });
  var outstandingByCurrency = invTotals.rows.map(function (r) { return { currency: r.currency, amount: Number(r.invoiced) - Number(r.paid || 0) }; });

  return {
    invoicedByCurrency: invoicedByCurrency, paidByCurrency: paidByCurrency, outstandingByCurrency: outstandingByCurrency,
    quotationsSent: quotationsSent.rows[0].n, quotationsAccepted: quotationsAccepted.rows[0].n, ordersCount: ordersCount.rows[0].n,
    expenseByCategory: byCat.rows.map(function (r) { return { category: r.category, amount: Number(r.amount) }; }),
    salesByCustomer: byCustomer.rows.map(function (r) { return { customer: r.name, currency: r.currency, amount: Number(r.amount) }; }),
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
    'SELECT c.name, o.currency, sum(o.total) AS total FROM sales_orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.name, o.currency ORDER BY total DESC LIMIT 5'
  );
  var leadsRes = await pool.query(
    "SELECT c.*, m.first_name, m.last_name FROM customers c LEFT JOIN employees m ON m.id = c.account_manager_id WHERE c.category IN ('lead','prospect')"
  );
  var recentQuotesRes = await pool.query(
    'SELECT q.quote_no, q.grand_total, q.currency, q.status, c.name AS customer_name FROM quotations q JOIN customers c ON c.id = q.customer_id ORDER BY q.created_at DESC LIMIT 5'
  );

  return {
    pipeline: pipeline, totalCustomers: totalCustomers.rows[0].n,
    funnel: { sent: f.sent, accepted: f.accepted, rejected: f.rejected, conversionRate: f.sent ? Math.round((f.accepted / f.sent) * 100) : 0 },
    topCustomers: topCustomersRes.rows.map(function (r) { return { name: r.name, currency: r.currency, total: Number(r.total) }; }),
    leads: leadsRes.rows.map(function (r) { return { name: r.name, contactPerson: r.contact_person, email: r.email, phone: r.phone, category: r.category, managerName: r.first_name ? r.first_name + ' ' + r.last_name : '—' }; }),
    recentQuotes: recentQuotesRes.rows.map(function (r) { return { quoteNo: r.quote_no, customerName: r.customer_name, currency: r.currency, total: Number(r.grand_total), status: r.status }; })
  };
}

// kernel.js: handlers['finance.dashboard']
async function financeDashboard(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var t = todayISO();
  var periodType = (params && params.periodType === 'years') ? 'years' : 'months';
  var periodCount = Math.max(1, Math.min(12, Number(params && params.periodCount) || 6));
  var base = await baseCurrency();

  var overdueRes = await pool.query(
    "SELECT i.invoice_no, i.grand_total, i.currency, i.due_date, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id " +
    "WHERE i.status != 'paid' AND i.due_date < $1 ORDER BY i.due_date",
    [t]
  );
  var overdue = overdueRes.rows.map(function (r) {
    return { invoiceNo: r.invoice_no, customerName: r.customer_name, currency: r.currency, amount: Number(r.grand_total), daysOverdue: Math.round((new Date(t) - new Date(r.due_date)) / 86400000) };
  }).sort(function (a, b) { return b.daysOverdue - a.daysOverdue; });

  var unpaidRes = await pool.query("SELECT currency, sum(grand_total) AS s, count(*)::int AS n FROM invoices WHERE status != 'paid' GROUP BY currency");
  var paidThisMonthRes = await pool.query("SELECT currency, sum(grand_total) AS s FROM invoices WHERE status = 'paid' AND paid_at IS NOT NULL AND to_char(paid_at,'YYYY-MM') = $1 GROUP BY currency", [t.slice(0, 7)]);

  var pendingExpensesRes = await pool.query(
    "SELECT e.category, e.amount, e.date, emp.first_name, emp.last_name, d.name AS dept_name FROM expenses e " +
    "JOIN employees emp ON emp.id = e.requester_id JOIN departments d ON d.id = e.department_id WHERE e.status = 'pending'"
  );
  var approvedExpensesThisMonthRes = await pool.query(
    "SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE status IN ('approved','paid') AND to_char(date,'YYYY-MM') = $1", [t.slice(0, 7)]
  );

  // A trend line is inherently one number per month — mixing currencies on
  // it would be meaningless, and true FX conversion is out of scope (see
  // documents.js's resolveCurrency() doc comment). Restricted to the
  // company's base currency; baseCurrency is returned below so the frontend
  // can label the chart accordingly.
  var months = [];
  if (periodType === 'years') {
    for (var y = periodCount - 1; y >= 0; y--) {
      var yr = new Date().getFullYear() - y;
      var revRes = await pool.query("SELECT coalesce(sum(grand_total),0) AS s FROM invoices WHERE status = 'paid' AND currency = $1 AND to_char(paid_at,'YYYY') = $2", [base, String(yr)]);
      var expRes = await pool.query("SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE status IN ('approved','paid') AND to_char(date::date,'YYYY') = $1", [String(yr)]);
      months.push({ month: String(yr), revenue: Number(revRes.rows[0].s), expense: Number(expRes.rows[0].s) });
    }
  } else {
    for (var m = periodCount - 1; m >= 0; m--) {
      var dt = new Date(); dt.setMonth(dt.getMonth() - m);
      var key = dt.toISOString().slice(0, 7);
      var label = dt.toLocaleDateString('en-GB', { month: 'short', year: periodCount > 12 ? '2-digit' : undefined });
      var revRes2 = await pool.query("SELECT coalesce(sum(grand_total),0) AS s FROM invoices WHERE status = 'paid' AND currency = $1 AND to_char(paid_at,'YYYY-MM') = $2", [base, key]);
      var expRes2 = await pool.query("SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE status IN ('approved','paid') AND to_char(date::date,'YYYY-MM') = $1", [key]);
      months.push({ month: label, revenue: Number(revRes2.rows[0].s), expense: Number(expRes2.rows[0].s) });
    }
  }

  var recentPaymentsRes = await pool.query(
    'SELECT pm.*, c.name AS customer_name, i.invoice_no FROM payments pm JOIN customers c ON c.id = pm.customer_id JOIN invoices i ON i.id = pm.invoice_id ORDER BY pm.date DESC LIMIT 6'
  );

  var cashCollectedByCurrency = byCurrencyArr(paidThisMonthRes.rows, 's');
  var outstandingByCurrency = byCurrencyArr(unpaidRes.rows, 's');
  var unpaidCount = unpaidRes.rows.reduce(function (s, r) { return s + r.n; }, 0);
  // Net position nets cash collected against expenses (GHS-only, no
  // per-currency data) into one number — restricted to the base currency
  // for the same reason the monthly trend above is, above's comment.
  var paidThisMonthBase = (paidThisMonthRes.rows.find(function (r) { return r.currency === base; }) || { s: 0 }).s;
  var approvedExpensesThisMonth = Number(approvedExpensesThisMonthRes.rows[0].s);

  return {
    baseCurrency: base,
    cashCollectedThisMonthByCurrency: cashCollectedByCurrency,
    outstandingByCurrency: outstandingByCurrency, unpaidCount: unpaidCount,
    overdueInvoices: overdue, overdueTotalByCurrency: byCurrencyArr(
      Object.values(overdue.reduce(function (acc, i) { acc[i.currency] = acc[i.currency] || { currency: i.currency, s: 0 }; acc[i.currency].s += i.amount; return acc; }, {})), 's'
    ),
    pendingExpenses: pendingExpensesRes.rows.map(function (r) { return { category: r.category, amount: Number(r.amount), requesterName: r.first_name + ' ' + r.last_name, departmentName: r.dept_name, date: r.date }; }),
    pendingExpensesTotal: pendingExpensesRes.rows.reduce(function (s, r) { return s + Number(r.amount); }, 0),
    approvedExpensesThisMonth: approvedExpensesThisMonth,
    netPositionThisMonth: Number(paidThisMonthBase) - approvedExpensesThisMonth,
    monthlyTrend: months,
    recentPayments: recentPaymentsRes.rows.map(function (r) { return { customerName: r.customer_name, invoiceNo: r.invoice_no, amount: Number(r.amount), currency: r.currency, date: r.date, method: r.method }; })
  };
}

// kernel.js: handlers['commercial.dashboard']
async function commercialDashboard(ctx) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var t = todayISO();
  var base = await baseCurrency();
  await quotationsService.list(ctx).catch(function () {}); // triggers autoExpireQuotations as a side effect, same as kernel

  var qCountsRes = await pool.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('sent','viewed'))::int AS awaiting, " +
    "count(*) FILTER (WHERE status = 'accepted')::int AS accepted, count(*) FILTER (WHERE status = 'rejected')::int AS rejected, " +
    "count(*) FILTER (WHERE status = 'expired')::int AS expired, count(*) FILTER (WHERE status != 'draft')::int AS sent " +
    'FROM quotations'
  );
  var q = qCountsRes.rows[0];
  var qValueRes = await pool.query('SELECT currency, sum(grand_total) AS s FROM quotations GROUP BY currency');

  var invCountsRes = await pool.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE balance_due > 0 AND due_date < $1)::int AS overdue_count FROM invoices",
    [t]
  );
  var inv = invCountsRes.rows[0];
  var invValueRes = await pool.query(
    "SELECT currency, sum(grand_total) AS invoiced, sum(amount_paid) AS paid, sum(balance_due) AS outstanding, " +
    "sum(balance_due) FILTER (WHERE balance_due > 0 AND due_date < $1) AS overdue_amount, " +
    "sum(grand_total) FILTER (WHERE to_char(issued_at,'YYYY-MM') = $2) AS revenue_month, " +
    "sum(grand_total) FILTER (WHERE to_char(issued_at,'YYYY') = $3) AS revenue_year " +
    'FROM invoices GROUP BY currency',
    [t, t.slice(0, 7), t.slice(0, 4)]
  );

  // Trend line, one number per month — restricted to the base currency for
  // the same reason financeDashboard's monthlyTrend above is.
  var months = [];
  for (var m = 5; m >= 0; m--) {
    var dt = new Date(); dt.setMonth(dt.getMonth() - m);
    var key = dt.toISOString().slice(0, 7);
    var invoicedRes = await pool.query("SELECT coalesce(sum(grand_total),0) AS s FROM invoices WHERE currency = $1 AND to_char(issued_at,'YYYY-MM') = $2", [base, key]);
    var paidRes = await pool.query("SELECT coalesce(sum(amount),0) AS s FROM payments WHERE currency = $1 AND to_char(date::date,'YYYY-MM') = $2", [base, key]);
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

  function invRow(r) { return { invoiceNo: r.invoice_no, customerName: r.customer_name, currency: r.currency, balanceDue: Number(r.balance_due), dueDate: r.due_date }; }
  function recentInvoiceRow(r) { return { invoiceNo: r.invoice_no, customerName: r.customer_name, currency: r.currency, grandTotal: Number(r.grand_total), status: r.status }; }
  function quoteRow(r) { return { quoteNo: r.quote_no, customerName: r.customer_name, currency: r.currency, grandTotal: Number(r.grand_total), status: r.status }; }

  return {
    baseCurrency: base,
    totalQuotations: q.total, awaitingResponse: q.awaiting, acceptedQuotations: q.accepted, rejectedQuotations: q.rejected, expiredQuotations: q.expired,
    totalQuotationValueByCurrency: byCurrencyArr(qValueRes.rows, 's'), conversionRate: q.sent ? Math.round((q.accepted / q.sent) * 100) : 0,
    totalInvoices: inv.total,
    totalInvoicedByCurrency: byCurrencyArr(invValueRes.rows, 'invoiced'),
    totalPaidByCurrency: byCurrencyArr(invValueRes.rows, 'paid'),
    outstandingByCurrency: byCurrencyArr(invValueRes.rows, 'outstanding'),
    overdueCount: inv.overdue_count, overdueAmountByCurrency: byCurrencyArr(invValueRes.rows.filter(function (r) { return r.overdue_amount != null; }), 'overdue_amount'),
    revenueThisMonthByCurrency: byCurrencyArr(invValueRes.rows.filter(function (r) { return r.revenue_month != null; }), 'revenue_month'),
    revenueThisYearByCurrency: byCurrencyArr(invValueRes.rows.filter(function (r) { return r.revenue_year != null; }), 'revenue_year'),
    monthly: months, upcomingDue: upcomingRes.rows.map(invRow), overdueInvoices: overdueListRes.rows.map(invRow),
    recentQuotes: recentQuotesRes.rows.map(quoteRow), recentInvoices: recentInvoicesRes.rows.map(recentInvoiceRow),
    recentPayments: recentPaymentsRes.rows.map(function (r) { return { invoiceNo: r.invoice_no, customerName: r.customer_name, amount: Number(r.amount), currency: r.currency, date: r.date, method: r.method }; })
  };
}

// ── Financial Reports ────────────────────────────────────────────────────
// Built entirely from existing transactional tables (invoices, payments,
// expenses, payslips, products, assets) — there's no general ledger, so
// "approved"/"paid" expense and pay-run statuses are treated as the
// recognized-expense moment throughout, matching the convention the rest
// of this file already uses (see financeDashboard above).

function requireReportManage(ctx) {
  if (!ctx.can('report.manage')) fail('forbidden', 'Your role does not allow this action (report.manage).');
}

function defaultPeriod(params) {
  var to = (params && params.to) || todayISO();
  var from = (params && params.from) || (to.slice(0, 8) + '01'); // month-to-date by default
  return { from: from, to: to };
}

// kernel.js: handlers['reports.profitAndLoss']
// Nets revenue against expenses/payroll into one number per line, which is
// only meaningful within a single currency — expenses/payroll have no
// per-currency data at all, and true FX conversion is out of scope (see
// documents.js's resolveCurrency()). So this, like every report below it,
// is restricted to invoices in the company's base currency (baseCurrency in
// the response); a non-base-currency invoice still shows correctly on its
// own document view and in the Invoices list, just not folded into these
// blended statements.
async function profitAndLoss(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var period = defaultPeriod(params);
  var base = await baseCurrency();

  var revRes = await pool.query(
    "SELECT coalesce(sum(grand_total),0) AS s FROM invoices WHERE status != 'void' AND currency = $1 AND issued_at BETWEEN $2 AND $3",
    [base, period.from, period.to]
  );
  var expByCatRes = await pool.query(
    "SELECT category, sum(amount) AS amount FROM expenses WHERE status IN ('approved','paid') AND date BETWEEN $1 AND $2 GROUP BY category ORDER BY amount DESC",
    [period.from, period.to]
  );
  var payrollRes = await pool.query(
    "SELECT coalesce(sum(ps.gross_pay + ps.ssnit_employer),0) AS s FROM payslips ps JOIN pay_runs pr ON pr.id = ps.pay_run_id " +
    "WHERE pr.status IN ('approved','paid') AND pr.pay_date BETWEEN $1 AND $2",
    [period.from, period.to]
  );

  var revenue = Number(revRes.rows[0].s);
  var expenseByCategory = expByCatRes.rows.map(function (r) { return { category: r.category, amount: Number(r.amount) }; });
  var totalExpenses = expenseByCategory.reduce(function (s, r) { return s + r.amount; }, 0);
  var payrollCost = Number(payrollRes.rows[0].s);

  return {
    from: period.from, to: period.to, baseCurrency: base,
    revenue: revenue, expenseByCategory: expenseByCategory, totalExpenses: totalExpenses,
    payrollCost: payrollCost, totalCosts: totalExpenses + payrollCost,
    netProfit: revenue - totalExpenses - payrollCost
  };
}

// kernel.js: handlers['reports.cashFlow'] — see profitAndLoss's comment above; restricted to baseCurrency for the same reason.
async function cashFlow(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var period = defaultPeriod(params);
  var base = await baseCurrency();

  var cashInRes = await pool.query('SELECT coalesce(sum(amount),0) AS s FROM payments WHERE currency = $1 AND date BETWEEN $2 AND $3', [base, period.from, period.to]);
  var expensesOutRes = await pool.query(
    "SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE status IN ('approved','paid') AND date BETWEEN $1 AND $2",
    [period.from, period.to]
  );
  var payrollOutRes = await pool.query(
    "SELECT coalesce(sum(ps.gross_pay + ps.ssnit_employer),0) AS s FROM payslips ps JOIN pay_runs pr ON pr.id = ps.pay_run_id " +
    "WHERE pr.status IN ('approved','paid') AND pr.pay_date BETWEEN $1 AND $2",
    [period.from, period.to]
  );
  var byMethodRes = await pool.query(
    'SELECT method, sum(amount) AS s FROM payments WHERE currency = $1 AND date BETWEEN $2 AND $3 GROUP BY method ORDER BY s DESC',
    [base, period.from, period.to]
  );

  var cashIn = Number(cashInRes.rows[0].s);
  var expensesOut = Number(expensesOutRes.rows[0].s);
  var payrollOut = Number(payrollOutRes.rows[0].s);
  var cashOut = expensesOut + payrollOut;

  return {
    from: period.from, to: period.to, baseCurrency: base,
    cashIn: cashIn, cashInByMethod: byMethodRes.rows.map(function (r) { return { method: r.method, amount: Number(r.s) }; }),
    expensesOut: expensesOut, payrollOut: payrollOut, cashOut: cashOut,
    netCashFlow: cashIn - cashOut
  };
}

// kernel.js: handlers['reports.balanceSheet'] — see profitAndLoss's comment above; restricted to baseCurrency for the same reason.
async function balanceSheet(ctx) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var base = await baseCurrency();
  var manualRes = await pool.query('SELECT balance_sheet FROM settings WHERE id = 1');
  var manual = manualRes.rows[0].balance_sheet || {};

  var arRes = await pool.query("SELECT coalesce(sum(balance_due),0) AS s FROM invoices WHERE status != 'void' AND currency = $1 AND balance_due > 0", [base]);
  var invRes = await pool.query('SELECT coalesce(sum(cost_price * current_stock),0) AS s FROM products');
  var assetsRes = await pool.query('SELECT coalesce(sum(purchase_price),0) AS s FROM assets');
  var revRes = await pool.query("SELECT coalesce(sum(grand_total),0) AS s FROM invoices WHERE status != 'void' AND currency = $1", [base]);
  var expRes = await pool.query("SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE status IN ('approved','paid')");
  var payrollRes = await pool.query("SELECT coalesce(sum(ps.gross_pay + ps.ssnit_employer),0) AS s FROM payslips ps JOIN pay_runs pr ON pr.id = ps.pay_run_id WHERE pr.status IN ('approved','paid')");

  var cashAndBank = Number(manual.cashAndBank || 0);
  var accountsReceivable = Number(arRes.rows[0].s);
  var inventoryValue = Number(invRes.rows[0].s);
  var fixedAssets = Number(assetsRes.rows[0].s);
  var totalAssets = cashAndBank + accountsReceivable + inventoryValue + fixedAssets;

  var accountsPayable = Number(manual.accountsPayable || 0);
  var loansPayable = Number(manual.loansPayable || 0);
  var otherLiabilities = Number(manual.otherLiabilities || 0);
  var totalLiabilities = accountsPayable + loansPayable + otherLiabilities;

  // Retained earnings = all-time net profit, the same recognition rules as
  // profitAndLoss() above but with no date bound (since inception).
  var retainedEarnings = Number(revRes.rows[0].s) - Number(expRes.rows[0].s) - Number(payrollRes.rows[0].s);
  var ownersEquity = Number(manual.ownersEquity || 0);
  var totalEquity = ownersEquity + retainedEarnings;

  return {
    asOf: todayISO(), baseCurrency: base,
    assets: { cashAndBank: cashAndBank, accountsReceivable: accountsReceivable, inventoryValue: inventoryValue, fixedAssets: fixedAssets, total: totalAssets },
    liabilities: { accountsPayable: accountsPayable, loansPayable: loansPayable, otherLiabilities: otherLiabilities, total: totalLiabilities },
    equity: { ownersEquity: ownersEquity, retainedEarnings: retainedEarnings, total: totalEquity },
    // Zero when the manual inputs (cash & bank, above all) are accurate; a
    // nonzero balanceCheck is a live prompt to correct them, since cash is
    // this system's usual "plug" figure absent a real cash book.
    balanceCheck: totalAssets - (totalLiabilities + totalEquity),
    manualInputs: { cashAndBank: cashAndBank, accountsPayable: accountsPayable, loansPayable: loansPayable, otherLiabilities: otherLiabilities, ownersEquity: ownersEquity, notes: manual.notes || '' }
  };
}

// kernel.js: handlers['reports.balanceSheetInputs.get']
async function getBalanceSheetInputs(ctx) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var res = await pool.query('SELECT balance_sheet FROM settings WHERE id = 1');
  return res.rows[0].balance_sheet || {};
}

// kernel.js: handlers['reports.balanceSheetInputs.save']
async function saveBalanceSheetInputs(ctx, p) {
  requireReportManage(ctx);
  var res = await pool.query('SELECT balance_sheet FROM settings WHERE id = 1');
  var current = res.rows[0].balance_sheet || {};
  ['cashAndBank', 'accountsPayable', 'loansPayable', 'otherLiabilities', 'ownersEquity'].forEach(function (f) {
    if (p[f] !== undefined) current[f] = Number(p[f]) || 0;
  });
  if (p.notes !== undefined) current.notes = String(p.notes).slice(0, 2000);
  await pool.query('UPDATE settings SET balance_sheet = $1, updated_at = now() WHERE id = 1', [JSON.stringify(current)]);
  await audit(pool, ctx, 'report.balanceSheetInputs', 'settings', 'balance_sheet', 'Updated balance sheet manual inputs.');
  return current;
}

// kernel.js: handlers['reports.arAging'] — a receivables LISTING, not a
// blended statement, so unlike profitAndLoss/cashFlow/balanceSheet above,
// every currency's invoices are included; the bucket totals and grand total
// are grouped per currency instead of restricted to one.
async function arAging(ctx) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var t = todayISO();
  var res = await pool.query(
    "SELECT i.invoice_no, i.balance_due, i.currency, i.due_date, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id " +
    "WHERE i.status != 'void' AND i.balance_due > 0 ORDER BY i.due_date NULLS LAST"
  );
  var bucketKeys = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'];
  var buckets = {}; bucketKeys.forEach(function (k) { buckets[k] = {}; });
  var totals = {};
  var rows = res.rows.map(function (r) {
    var daysOverdue = r.due_date ? Math.floor((new Date(t) - new Date(r.due_date)) / 86400000) : -1;
    var bucket = daysOverdue <= 0 ? 'current' : daysOverdue <= 30 ? 'd1_30' : daysOverdue <= 60 ? 'd31_60' : daysOverdue <= 90 ? 'd61_90' : 'd90_plus';
    buckets[bucket][r.currency] = (buckets[bucket][r.currency] || 0) + Number(r.balance_due);
    totals[r.currency] = (totals[r.currency] || 0) + Number(r.balance_due);
    return { invoiceNo: r.invoice_no, customerName: r.customer_name, currency: r.currency, balanceDue: Number(r.balance_due), dueDate: r.due_date, daysOverdue: Math.max(0, daysOverdue), bucket: bucket };
  });
  var toArr = function (obj) { return Object.keys(obj).map(function (c) { return { currency: c, amount: obj[c] }; }); };
  var bucketsArr = {}; bucketKeys.forEach(function (k) { bucketsArr[k] = toArr(buckets[k]); });
  return { asOf: t, invoices: rows, buckets: bucketsArr, totalByCurrency: toArr(totals) };
}

// kernel.js: handlers['reports.expenseDetail']
async function expenseDetail(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var period = defaultPeriod(params);
  var res = await pool.query(
    "SELECT e.category, e.amount, e.date, e.description, e.status, emp.first_name, emp.last_name, d.name AS dept_name " +
    "FROM expenses e JOIN employees emp ON emp.id = e.requester_id JOIN departments d ON d.id = e.department_id " +
    "WHERE e.status IN ('approved','paid') AND e.date BETWEEN $1 AND $2 ORDER BY e.date DESC",
    [period.from, period.to]
  );
  var byCategory = {}, byDept = {};
  var rows = res.rows.map(function (r) {
    byCategory[r.category] = (byCategory[r.category] || 0) + Number(r.amount);
    byDept[r.dept_name] = (byDept[r.dept_name] || 0) + Number(r.amount);
    return { category: r.category, amount: Number(r.amount), date: r.date, description: r.description, requesterName: r.first_name + ' ' + r.last_name, departmentName: r.dept_name };
  });
  return {
    from: period.from, to: period.to, items: rows,
    total: rows.reduce(function (s, r) { return s + r.amount; }, 0),
    byCategory: Object.keys(byCategory).map(function (k) { return { category: k, amount: byCategory[k] }; }).sort(function (a, b) { return b.amount - a.amount; }),
    byDepartment: Object.keys(byDept).map(function (k) { return { department: k, amount: byDept[k] }; }).sort(function (a, b) { return b.amount - a.amount; })
  };
}

// kernel.js: handlers['reports.taxSummary']
// Tax is recorded per line item as a plain percentage (document_line_items.
// tax_rate) — there's no link back to which named tax (VAT/NHIL/GETFund/
// WHT) was intended, since the line-item editor is a free-form % field,
// not a picker tied to commercial.taxRates. This groups by the exact rate
// found in the data and labels it with whichever configured tax(es) share
// that same percentage — ambiguous when two taxes have the same rate
// (e.g. NHIL and GETFund both default to 2.5%), which is disclosed via the
// label rather than guessed at. Also cross-checks the sum of line-item tax
// against each invoice's own recorded tax_total, since a document-level
// tax rate (a separate, currently-unused code path in invoices.service.js)
// would show up as a gap here rather than being silently missed.
async function taxSummary(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var period = defaultPeriod(params);
  var base = await baseCurrency();

  var settingsRes = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var taxRates = (settingsRes.rows[0].commercial && settingsRes.rows[0].commercial.taxRates) || [];
  var nameByRate = {};
  taxRates.forEach(function (t) {
    var key = Number(t.rate).toFixed(3);
    nameByRate[key] = nameByRate[key] ? nameByRate[key] + ' / ' + t.name : t.name;
  });

  var linesRes = await pool.query(
    "SELECT li.tax_rate, li.qty, li.unit_price, li.discount, li.discount_type, i.id AS invoice_id " +
    "FROM document_line_items li JOIN invoices i ON i.id = li.document_id " +
    "WHERE li.document_type = 'invoice' AND i.status != 'void' AND i.currency = $1 AND i.issued_at BETWEEN $2 AND $3",
    [base, period.from, period.to]
  );

  var byRate = {};
  var totalTaxFromLineItems = 0;
  linesRes.rows.forEach(function (r) {
    var line = Number(r.qty) * Number(r.unit_price);
    var lineDiscount = r.discount_type === 'percent' ? (line * Number(r.discount)) / 100 : Number(r.discount);
    var afterDiscount = Math.max(0, line - lineDiscount);
    var rate = Number(r.tax_rate);
    var tax = (afterDiscount * rate) / 100;
    var key = rate.toFixed(3);
    if (!byRate[key]) byRate[key] = { rate: rate, taxableBase: 0, taxCollected: 0, invoiceIds: {} };
    byRate[key].taxableBase += afterDiscount;
    byRate[key].taxCollected += tax;
    byRate[key].invoiceIds[r.invoice_id] = true;
    totalTaxFromLineItems += tax;
  });

  var recordedRes = await pool.query(
    "SELECT coalesce(sum(tax_total),0) AS s FROM invoices WHERE status != 'void' AND currency = $1 AND issued_at BETWEEN $2 AND $3",
    [base, period.from, period.to]
  );
  var recordedTaxTotal = Number(recordedRes.rows[0].s);

  var byRateArr = Object.keys(byRate)
    .sort(function (a, b) { return Number(b) - Number(a); })
    .map(function (key) {
      var r = byRate[key];
      return {
        rate: r.rate, label: nameByRate[key] || (r.rate === 0 ? 'Zero-rated / no tax' : 'Custom (' + r.rate + '%)'),
        taxableBase: Math.round(r.taxableBase * 100) / 100, taxCollected: Math.round(r.taxCollected * 100) / 100,
        invoiceCount: Object.keys(r.invoiceIds).length
      };
    });

  return {
    from: period.from, to: period.to, baseCurrency: base, byRate: byRateArr,
    totalTaxFromLineItems: Math.round(totalTaxFromLineItems * 100) / 100,
    recordedTaxTotal: recordedTaxTotal,
    reconciliationDiff: Math.round((recordedTaxTotal - totalTaxFromLineItems) * 100) / 100
  };
}

module.exports = {
  summary: summary, marketingDashboard: marketingDashboard, financeDashboard: financeDashboard, commercialDashboard: commercialDashboard,
  profitAndLoss: profitAndLoss, cashFlow: cashFlow, balanceSheet: balanceSheet, arAging: arAging, expenseDetail: expenseDetail,
  getBalanceSheetInputs: getBalanceSheetInputs, saveBalanceSheetInputs: saveBalanceSheetInputs, taxSummary: taxSummary
};
