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

// kernel.js: handlers['reports.summary'] — the Reports page: one trade
// company (Bamboo Products when left out) over a chosen period.
//   - sales: invoiced (voided invoices left out), collected (payments by
//     the day the money came in, part-payments included), owed now and
//     overdue now, each per currency — never blended;
//   - spending: approved and paid expense claims by category, claims still
//     waiting, and payroll (approved and paid runs by pay date, for that
//     company's staff): take-home, PAYE and SSNIT, and the cost in all;
//   - quotations sent, accepted and turned down in the period, orders, and
//     the clients invoiced most;
//   - twelve months ending with the period, in the base currency, for the
//     trend chart.
function monthStart(iso) { return iso.slice(0, 7) + '-01'; }
function addMonths(iso, n) { var d = new Date(iso.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
function monthEnd(iso) { var d = new Date(addMonths(iso, 1) + 'T00:00:00Z'); d.setUTCDate(0); return d.toISOString().slice(0, 10); }
async function summary(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  params = params || {};
  var co = await resolveDashboardCompany(ctx, params.company, true);
  var t = todayISO();
  var from = /^\d{4}-\d{2}-\d{2}$/.test(params.from || '') ? params.from : monthStart(t);
  var to = /^\d{4}-\d{2}-\d{2}$/.test(params.to || '') ? params.to : t;
  if (to < from) fail('invalid', 'The end of the period is before its start.');
  var base = await baseCurrency();
  var inv = docScope(co, 'i', 'c'), q = docScope(co, 'q', 'c'), exp = expenseScope(co);
  var payScope = co.id === null ? '$1::uuid IS NULL' : 'd.company_id = $1';
  var P = [co.id, from, to];

  var invoiced = await pool.query("SELECT i.currency, sum(i.grand_total) AS amount, count(*)::int AS n FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status <> 'void' AND i.issued_at BETWEEN $2 AND $3 AND " + inv + ' GROUP BY i.currency ORDER BY i.currency', P);
  var collected = await pool.query('SELECT p.currency, sum(p.amount) AS amount, count(*)::int AS n FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id WHERE p.date BETWEEN $2 AND $3 AND ' + inv + ' GROUP BY p.currency ORDER BY p.currency', P);
  var owed = await pool.query("SELECT i.currency, sum(i.balance_due) AS amount, sum(i.balance_due) FILTER (WHERE i.due_date < $2) AS overdue, count(*)::int AS n FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('unpaid','partially_paid') AND " + inv + ' GROUP BY i.currency ORDER BY i.currency', [co.id, t]);
  var byCat = await pool.query("SELECT e.category, sum(e.amount) AS amount, count(*)::int AS n FROM expenses e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status IN ('approved','paid') AND e.date BETWEEN $2 AND $3 AND " + exp + ' GROUP BY e.category ORDER BY amount DESC', P);
  var pendingExp = await pool.query("SELECT coalesce(sum(e.amount),0) AS amount, count(*)::int AS n FROM expenses e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'pending' AND " + exp, [co.id]);
  var payroll = await pool.query(
    'SELECT coalesce(sum(s.net_pay),0) AS net, coalesce(sum(s.gross_pay),0) AS gross, coalesce(sum(s.ssnit_employee),0) AS ssnit_ee, coalesce(sum(s.ssnit_employer),0) AS ssnit_er, coalesce(sum(s.paye_tax),0) AS paye, count(DISTINCT pr.id)::int AS runs ' +
    "FROM payslips s JOIN pay_runs pr ON pr.id = s.pay_run_id JOIN employees e ON e.id = s.employee_id JOIN departments d ON d.id = e.department_id WHERE pr.status IN ('approved','paid') AND pr.pay_date BETWEEN $2 AND $3 AND " + payScope, P);
  var quotes = await pool.query(
    "SELECT count(*) FILTER (WHERE q.sent_at::date BETWEEN $2 AND $3)::int AS sent, count(*) FILTER (WHERE q.status = 'accepted' AND q.answered_at::date BETWEEN $2 AND $3)::int AS accepted, " +
    "count(*) FILTER (WHERE q.status = 'rejected' AND q.answered_at::date BETWEEN $2 AND $3)::int AS rejected, count(*) FILTER (WHERE q.sent_at IS NOT NULL AND q.status IN ('sent','viewed','expired') AND q.valid_until BETWEEN $2 AND $3 AND q.valid_until < CURRENT_DATE)::int AS expired " +
    'FROM quotations q JOIN customers c ON c.id = q.customer_id WHERE ' + q, P);
  var orders = await pool.query('SELECT count(*)::int AS n FROM sales_orders o JOIN customers c ON c.id = o.customer_id WHERE o.created_at::date BETWEEN $2 AND $3 AND ' + (co.id === null ? '$1::uuid IS NULL' : co.code === 'BPL' ? '(c.company_id IS NULL OR c.company_id = $1)' : 'c.company_id = $1'), P);
  var byCustomer = await pool.query("SELECT c.id, c.name, i.currency, sum(i.grand_total) AS amount, count(*)::int AS n FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status <> 'void' AND i.issued_at BETWEEN $2 AND $3 AND " + inv + ' GROUP BY c.id, c.name, i.currency ORDER BY amount DESC LIMIT 10', P);

  // twelve months ending with the period's last month, base currency
  var first = addMonths(to, -11);
  var S = [co.id, monthStart(first), monthEnd(to), base];
  var mInv = await pool.query("SELECT to_char(i.issued_at, 'YYYY-MM') AS m, sum(i.grand_total) AS a FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status <> 'void' AND i.currency = $4 AND i.issued_at BETWEEN $2 AND $3 AND " + inv + ' GROUP BY 1', S);
  var mCol = await pool.query("SELECT to_char(p.date, 'YYYY-MM') AS m, sum(p.amount) AS a FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id WHERE p.currency = $4 AND p.date BETWEEN $2 AND $3 AND " + inv + ' GROUP BY 1', S);
  var mExp = await pool.query("SELECT to_char(e.date, 'YYYY-MM') AS m, sum(e.amount) AS a FROM expenses e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status IN ('approved','paid') AND e.date BETWEEN $2 AND $3 AND " + exp + ' GROUP BY 1', S.slice(0, 3));
  var mPay = await pool.query("SELECT to_char(pr.pay_date, 'YYYY-MM') AS m, sum(s.gross_pay + s.ssnit_employer) AS a FROM payslips s JOIN pay_runs pr ON pr.id = s.pay_run_id JOIN employees e ON e.id = s.employee_id JOIN departments d ON d.id = e.department_id WHERE pr.status IN ('approved','paid') AND pr.pay_date BETWEEN $2 AND $3 AND " + payScope + ' GROUP BY 1', S.slice(0, 3));
  function mapOf(rows) { var m = {}; rows.forEach(function (r) { m[r.m] = Number(r.a); }); return m; }
  var mi = mapOf(mInv.rows), mc = mapOf(mCol.rows), me = mapOf(mExp.rows), mp = mapOf(mPay.rows);
  var months = [];
  for (var k = 0; k < 12; k++) {
    var key = addMonths(first, k).slice(0, 7);
    months.push({ month: key, invoiced: mi[key] || 0, collected: mc[key] || 0, expenses: me[key] || 0, payroll: mp[key] || 0 });
  }

  var pr = payroll.rows[0];
  var r2 = function (n) { return Math.round(Number(n) * 100) / 100; };
  return {
    company: { code: co.code, name: co.name }, from: from, to: to, today: t, baseCurrency: base,
    invoiced: invoiced.rows.map(function (r) { return { currency: r.currency, amount: r2(r.amount), count: r.n }; }),
    collected: collected.rows.map(function (r) { return { currency: r.currency, amount: r2(r.amount), count: r.n }; }),
    owed: owed.rows.map(function (r) { return { currency: r.currency, amount: r2(r.amount), overdue: r2(r.overdue || 0), count: r.n }; }),
    expenses: { byCategory: byCat.rows.map(function (r) { return { category: r.category, amount: r2(r.amount), count: r.n }; }), total: r2(byCat.rows.reduce(function (a, r) { return a + Number(r.amount); }, 0)), pending: r2(pendingExp.rows[0].amount), pendingCount: pendingExp.rows[0].n },
    payroll: { runs: pr.runs, net: r2(pr.net), gross: r2(pr.gross), paye: r2(pr.paye), ssnitEmployee: r2(pr.ssnit_ee), ssnitEmployer: r2(pr.ssnit_er), cost: r2(Number(pr.gross) + Number(pr.ssnit_er)) },
    quotations: quotes.rows[0], orders: orders.rows[0].n,
    topCustomers: byCustomer.rows.map(function (r) { return { id: r.id, name: r.name, currency: r.currency, amount: r2(r.amount), invoices: r.n }; }),
    months: months
  };
}

// ── marketing dashboard, one company at a time ────────────────────────
// Bamboo Products (and any company with its own customers, like Poki) is a
// trade business: customers moving from lead to VIP, quotations, sales
// orders. Its customers and quotations are the ones with no company set
// (everything made before companies existed) or its own. Star Bar and
// Bamboo Garden are restaurants: no quotations, but a till and a guest
// list, so theirs is built from those (restaurant.read to see it).

// The companies with a dashboard, for the switcher: [{ id, code, name, kind }]
// in the social tracker's order (Bamboo Products, the restaurants), then
// the rest by name.
async function marketingCompanyList(ctx) {
  var rows = (await pool.query(
    "SELECT co.id, co.code, co.name, " +
    "(co.code = 'BPL' OR EXISTS (SELECT 1 FROM customers c WHERE c.company_id = co.id)) AS trade, " +
    '(EXISTS (SELECT 1 FROM restaurant_orders o WHERE o.company_id = co.id) OR EXISTS (SELECT 1 FROM restaurant_menu_items m WHERE m.company_id = co.id) ' +
    ' OR EXISTS (SELECT 1 FROM restaurant_guests g WHERE g.company_id = co.id)) AS restaurant, ' +
    'EXISTS (SELECT 1 FROM marketing_channels ch WHERE ch.company_id = co.id) AS social ' +
    "FROM companies co WHERE co.status = 'active' ORDER BY co.name"
  )).rows;
  // Star Bar and Bamboo Garden count as restaurants even before their
  // first sale (found by code or name, as in the social tracker).
  var mc = require('./marketingChannels');
  mc.trackedCompanies(rows).forEach(function (t) {
    if (t.channels === mc.RESTAURANT_CHANNELS) rows.forEach(function (r) { if (r.id === t.id) r.restaurant = true; });
  });
  var list = rows
    .filter(function (r) { return r.restaurant ? ctx.can('restaurant.read') : r.trade; })
    .map(function (r) { return { id: r.id, code: r.code, name: r.name, kind: r.restaurant ? 'restaurant' : 'trade', hasSocialTracker: r.social }; });
  var order = mc.trackedCompanies(list).map(function (t) { return t.id; });
  function rank(r) { var i = order.indexOf(r.id); return i < 0 ? order.length : i; }
  return list.slice().sort(function (x, y) { return rank(x) - rank(y); });
}

async function marketingCompanies(ctx) {
  if (!ctx.can('customer.read')) fail('forbidden', 'Your role does not allow this action (customer.read).');
  return (await marketingCompanyList(ctx)).map(function (c) { return { code: c.code, name: c.name, kind: c.kind }; });
}

// kernel.js: handlers['marketing.dashboard'] -> GET /api/reports/marketing?company=
async function marketingDashboard(ctx, companyCode) {
  if (!ctx.can('customer.read')) fail('forbidden', 'Your role does not allow this action (customer.read).');
  var code = String(companyCode || 'BPL').trim().toUpperCase();
  var co = (await marketingCompanyList(ctx)).filter(function (c) { return c.code.toUpperCase() === code; })[0];
  if (!co) fail('invalid', 'There is no marketing dashboard for "' + code + '".');
  var company = { code: co.code, name: co.name, kind: co.kind, hasSocialTracker: co.hasSocialTracker };
  var result = co.kind === 'restaurant' ? await restaurantMarketing(co) : await tradeMarketing(co);
  return Object.assign({ company: company, kind: co.kind }, result);
}

async function tradeMarketing(co) {
  // Which customers are this company's (c. is the customers alias).
  var mine = co.code === 'BPL' ? '(c.company_id IS NULL OR c.company_id = $1)' : 'c.company_id = $1';
  var cats = ['lead', 'prospect', 'active', 'vip', 'inactive'];
  var pipelineRes = await pool.query('SELECT c.category, count(*)::int AS n FROM customers c WHERE ' + mine + ' GROUP BY c.category', [co.id]);
  var pipelineByCat = {}; pipelineRes.rows.forEach(function (r) { pipelineByCat[r.category] = r.n; });
  var pipeline = cats.map(function (c) { return { category: c, count: pipelineByCat[c] || 0 }; });

  var totalCustomers = await pool.query('SELECT count(*)::int AS n FROM customers c WHERE ' + mine, [co.id]);
  var funnelRes = await pool.query(
    "SELECT count(*) FILTER (WHERE q.status != 'draft')::int AS sent, count(*) FILTER (WHERE q.status = 'accepted')::int AS accepted, " +
    "count(*) FILTER (WHERE q.status IN ('rejected','expired'))::int AS rejected, count(*) FILTER (WHERE q.status IN ('sent','viewed'))::int AS waiting " +
    'FROM quotations q JOIN customers c ON c.id = q.customer_id WHERE ' + mine, [co.id]
  );
  var f = funnelRes.rows[0];

  // Quotations sent (or opened) and not yet answered — the ones to chase,
  // soonest to expire first.
  var waitingRes = await pool.query(
    "SELECT q.quote_no, q.grand_total, q.currency, q.status, q.created_at, q.valid_until, c.name AS customer_name " +
    "FROM quotations q JOIN customers c ON c.id = q.customer_id WHERE q.status IN ('sent','viewed') AND " + mine +
    ' ORDER BY q.valid_until NULLS LAST, q.created_at LIMIT 20', [co.id]
  );
  // Biggest customers by what they were invoiced over the last twelve
  // months (voided invoices left out) — invoices are where every sale ends
  // up, whether it came through a quotation, a sales order or neither.
  var topCustomersRes = await pool.query(
    'SELECT c.name, i.currency, sum(i.grand_total) AS total, count(*)::int AS invoices FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
    "WHERE i.status <> 'void' AND i.issued_at > CURRENT_DATE - 365 AND " + docScope(co, 'i', 'c') +
    ' GROUP BY c.name, i.currency ORDER BY total DESC LIMIT 5', [co.id]
  );
  var leadsRes = await pool.query(
    "SELECT c.*, m.first_name, m.last_name, " +
    "(SELECT count(*)::int FROM quotations q WHERE q.customer_id = c.id AND q.status IN ('sent','viewed')) AS open_quotes, " +
    '(SELECT max(q.created_at) FROM quotations q WHERE q.customer_id = c.id) AS last_quote_at ' +
    "FROM customers c LEFT JOIN employees m ON m.id = c.account_manager_id WHERE c.category IN ('lead','prospect') AND " + mine + ' ORDER BY c.category DESC, c.name', [co.id]
  );
  var recentQuotesRes = await pool.query(
    'SELECT q.quote_no, q.grand_total, q.currency, q.status, q.created_at, q.valid_until, c.name AS customer_name FROM quotations q JOIN customers c ON c.id = q.customer_id WHERE ' + mine +
    ' ORDER BY q.created_at DESC LIMIT 5', [co.id]
  );
  function day(d) { return d ? (d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }

  return {
    pipeline: pipeline, totalCustomers: totalCustomers.rows[0].n,
    funnel: {
      sent: f.sent, accepted: f.accepted, rejected: f.rejected, waiting: f.waiting,
      conversionRate: f.sent ? Math.round((f.accepted / f.sent) * 100) : 0
    },
    topCustomers: topCustomersRes.rows.map(function (r) { return { name: r.name, currency: r.currency, total: Number(r.total), invoices: r.invoices }; }),
    leads: leadsRes.rows.map(function (r) {
      return {
        id: r.id, name: r.name, contactPerson: r.contact_person, email: r.email, phone: r.phone, category: r.category,
        managerName: r.first_name ? r.first_name + ' ' + r.last_name : '—', hasManager: !!r.first_name,
        openQuotes: r.open_quotes, lastQuoteAt: day(r.last_quote_at)
      };
    }),
    recentQuotes: recentQuotesRes.rows.map(function (r) { return { quoteNo: r.quote_no, customerName: r.customer_name, currency: r.currency, total: Number(r.grand_total), status: r.status, createdAt: day(r.created_at), validUntil: day(r.valid_until) }; }),
    waitingQuotes: waitingRes.rows.map(function (r) { return { quoteNo: r.quote_no, customerName: r.customer_name, currency: r.currency, total: Number(r.grand_total), status: r.status, createdAt: day(r.created_at), validUntil: day(r.valid_until) }; })
  };
}

// A restaurant's: the last 30 days against the 30 before, its guests
// (who comes back, who stopped coming), best sellers and busiest days.
// Voided orders never count.
async function restaurantMarketing(co) {
  var currency = await baseCurrency();
  var DAYS = 30;
  var salesRes = await pool.query(
    "SELECT count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS orders, " +
    "coalesce(sum(total) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS revenue, " +
    "count(*) FILTER (WHERE created_at >= now() - interval '30 days' AND guest_id IS NOT NULL)::int AS with_guest, " +
    "count(*) FILTER (WHERE created_at >= now() - interval '60 days' AND created_at < now() - interval '30 days')::int AS prev_orders, " +
    "coalesce(sum(total) FILTER (WHERE created_at >= now() - interval '60 days' AND created_at < now() - interval '30 days'), 0) AS prev_revenue, " +
    'max(created_at) AS last_order_at ' +
    "FROM restaurant_orders WHERE company_id = $1 AND status = 'completed'", [co.id]
  );
  var s = salesRes.rows[0];
  var guestRes = await pool.query(
    'SELECT count(*)::int AS total, ' +
    "count(*) FILTER (WHERE g.created_at >= now() - interval '30 days')::int AS new_guests, " +
    'count(*) FILTER (WHERE v.orders >= 2)::int AS returning, ' +
    "count(*) FILTER (WHERE v.last_visit >= now() - interval '30 days')::int AS active " +
    'FROM restaurant_guests g LEFT JOIN (' +
    "  SELECT guest_id, count(*) AS orders, max(created_at) AS last_visit FROM restaurant_orders WHERE company_id = $1 AND status = 'completed' AND guest_id IS NOT NULL GROUP BY guest_id" +
    ') v ON v.guest_id = g.id WHERE g.company_id = $1', [co.id]
  );
  var perGuest =
    'SELECT g.name, g.phone, count(o.id)::int AS orders, coalesce(sum(o.total), 0) AS total, max(o.created_at) AS last_visit ' +
    "FROM restaurant_guests g JOIN restaurant_orders o ON o.guest_id = g.id AND o.status = 'completed' WHERE g.company_id = $1 GROUP BY g.id, g.name, g.phone ";
  var topGuestsRes = await pool.query(perGuest + 'ORDER BY total DESC LIMIT 8', [co.id]);
  var lapsedRes = await pool.query(perGuest + "HAVING count(o.id) >= 2 AND max(o.created_at) < now() - interval '30 days' ORDER BY total DESC LIMIT 10", [co.id]);
  var bestRes = await pool.query(
    'SELECT i.name, sum(i.qty) AS qty, sum(i.line_total) AS revenue FROM restaurant_order_items i JOIN restaurant_orders o ON o.id = i.order_id ' +
    "WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at >= now() - interval '30 days' GROUP BY i.name ORDER BY qty DESC, revenue DESC LIMIT 8", [co.id]
  );
  var weekRes = await pool.query(
    "SELECT extract(isodow FROM created_at)::int AS dow, count(*)::int AS orders, coalesce(sum(total), 0) AS revenue FROM restaurant_orders " +
    "WHERE company_id = $1 AND status = 'completed' AND created_at >= now() - interval '90 days' GROUP BY dow", [co.id]
  );
  var byDow = {}; weekRes.rows.forEach(function (r) { byDow[r.dow] = r; });
  function guestRow(r) {
    return { name: r.name, phone: r.phone, orders: r.orders, total: Number(r.total), lastVisit: r.last_visit ? r.last_visit.toISOString().slice(0, 10) : null };
  }
  var g = guestRes.rows[0];
  var orders = s.orders, revenue = Number(s.revenue);
  return {
    currency: currency, days: DAYS,
    sales: {
      orders: orders, revenue: revenue, avgOrder: orders ? Math.round((revenue / orders) * 100) / 100 : 0,
      prevOrders: s.prev_orders, prevRevenue: Number(s.prev_revenue),
      prevAvgOrder: s.prev_orders ? Math.round((Number(s.prev_revenue) / s.prev_orders) * 100) / 100 : 0,
      withGuest: s.with_guest, lastOrderAt: s.last_order_at ? s.last_order_at.toISOString().slice(0, 10) : null
    },
    guests: { total: g.total, newGuests: g.new_guests, returning: g.returning, active: g.active },
    topGuests: topGuestsRes.rows.map(guestRow),
    lapsed: lapsedRes.rows.map(guestRow),
    bestSellers: bestRes.rows.map(function (r) { return { name: r.name, qty: Number(r.qty), revenue: Number(r.revenue) }; }),
    weekdays: [1, 2, 3, 4, 5, 6, 7].map(function (d) { var r = byDow[d]; return { dow: d, orders: r ? r.orders : 0, revenue: r ? Number(r.revenue) : 0 }; })
  };
}

// ── finance and quotations & invoicing, one company at a time ──────────
// Same companies as the marketing dashboard's switcher. A document
// (quotation, invoice, and a payment through its invoice) belongs to the
// company set on it or, failing that, on its customer; with neither it is
// Bamboo Products' (everything made before companies existed). An expense
// belongs to its department's company, Bamboo Products' without one.
function docCompany(docAlias, custAlias) { return 'coalesce(' + docAlias + '.company_id, ' + custAlias + '.company_id)'; }
// ALL_COMPANIES (id null) counts every company together — used by the AI
// assistant's company overview, which has always been group-wide.
var ALL_COMPANIES = { id: null, code: '*', name: 'All companies', kind: 'trade' };
function docScope(co, docAlias, custAlias) {
  var c = docCompany(docAlias, custAlias);
  if (co.id === null) return '$1::uuid IS NULL';
  return co.code === 'BPL' ? '(' + c + ' IS NULL OR ' + c + ' = $1)' : c + ' = $1';
}
function expenseScope(co) {
  if (co.id === null) return '$1::uuid IS NULL';
  return co.code === 'BPL' ? '(d.company_id = $1 OR e.department_id IS NULL)' : 'd.company_id = $1';
}
async function resolveDashboardCompany(ctx, code, onlyTrade) {
  var c = String(code || 'BPL').trim().toUpperCase();
  var list = await marketingCompanyList(ctx);
  if (onlyTrade) list = list.filter(function (x) { return x.kind === 'trade'; });
  var co = list.filter(function (x) { return x.code.toUpperCase() === c; })[0];
  if (!co) fail('invalid', 'There is no dashboard for "' + c + '".');
  return co;
}
function dayStr(d) { return d ? (d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function daysBetweenIso(a, b) { return Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000); }
// The periods the trend chart covers: [{ key: 'YYYY-MM' | 'YYYY', label }].
function trendPeriods(periodType, periodCount) {
  var out = [];
  for (var i = periodCount - 1; i >= 0; i--) {
    if (periodType === 'years') {
      var yr = String(new Date().getFullYear() - i);
      out.push({ key: yr, label: yr, fmt: 'YYYY' });
    } else {
      var dt = new Date(); dt.setDate(1); dt.setMonth(dt.getMonth() - i);
      out.push({ key: dt.toISOString().slice(0, 7), label: dt.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), fmt: 'YYYY-MM' });
    }
  }
  return out;
}
// Month so far, and the same days of last month, as [from, to] dates.
function monthToDate(t) {
  var from = t.slice(0, 8) + '01';
  var d = new Date(t + 'T00:00'); var day = d.getDate();
  var prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  var prevLastDay = new Date(d.getFullYear(), d.getMonth(), 0).getDate();
  function iso(x) { return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
  return { from: from, to: t, prevFrom: iso(prev), prevTo: iso(new Date(prev.getFullYear(), prev.getMonth(), Math.min(day, prevLastDay))) };
}

async function financeCompanies(ctx) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  return (await marketingCompanyList(ctx)).map(function (c) { return { code: c.code, name: c.name, kind: c.kind }; });
}
async function commercialCompanies(ctx) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  return (await marketingCompanyList(ctx)).filter(function (c) { return c.kind === 'trade'; })
    .map(function (c) { return { code: c.code, name: c.name, kind: c.kind }; });
}

// Expense figures shared by both kinds of company.
async function expenseFigures(co, t, mtd) {
  var scope = expenseScope(co);
  var pendingRes = await pool.query(
    "SELECT e.category, e.amount, e.date, e.created_at, emp.first_name, emp.last_name, d.name AS dept_name FROM expenses e " +
    "JOIN employees emp ON emp.id = e.requester_id LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'pending' AND " + scope +
    ' ORDER BY e.created_at', [co.id]
  );
  var sumsRes = await pool.query(
    "SELECT coalesce(sum(e.amount) FILTER (WHERE e.date BETWEEN $2 AND $3), 0) AS this_month, " +
    "coalesce(sum(e.amount) FILTER (WHERE e.date BETWEEN $4 AND $5), 0) AS last_month_same_days " +
    "FROM expenses e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status IN ('approved','paid') AND " + scope,
    [co.id, mtd.from, mtd.to, mtd.prevFrom, mtd.prevTo]
  );
  var byCatRes = await pool.query(
    "SELECT e.category, sum(e.amount) AS amount FROM expenses e LEFT JOIN departments d ON d.id = e.department_id " +
    "WHERE e.status IN ('approved','paid') AND e.date BETWEEN $2 AND $3 AND " + scope + ' GROUP BY e.category ORDER BY amount DESC LIMIT 8',
    [co.id, mtd.from, mtd.to]
  );
  return {
    pendingExpenses: pendingRes.rows.map(function (r) {
      return {
        category: r.category, amount: Number(r.amount), requesterName: r.first_name + ' ' + r.last_name, departmentName: r.dept_name || '—',
        date: dayStr(r.date), daysWaiting: Math.max(0, daysBetweenIso(dayStr(r.created_at), t))
      };
    }),
    pendingExpensesTotal: pendingRes.rows.reduce(function (s, r) { return s + Number(r.amount); }, 0),
    approvedExpensesThisMonth: Number(sumsRes.rows[0].this_month),
    approvedExpensesLastMonthSameDays: Number(sumsRes.rows[0].last_month_same_days),
    expenseByCategoryThisMonth: byCatRes.rows.map(function (r) { return { category: r.category, amount: Number(r.amount) }; })
  };
}
async function expenseTrend(co, periods) {
  var out = [];
  for (var i = 0; i < periods.length; i++) {
    var p = periods[i];
    var r = await pool.query(
      "SELECT coalesce(sum(e.amount),0) AS s FROM expenses e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status IN ('approved','paid') AND to_char(e.date::date, '" + p.fmt + "') = $2 AND " + expenseScope(co),
      [co.id, p.key]
    );
    out.push(Number(r.rows[0].s));
  }
  return out;
}

// kernel.js: handlers['finance.dashboard'] -> GET /api/reports/finance?company=&periodType=&periodCount=
async function financeDashboard(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  params = params || {};
  var co = await resolveDashboardCompany(ctx, params.company, false);
  var periodType = params.periodType === 'years' ? 'years' : 'months';
  var periodCount = Math.max(1, Math.min(12, Number(params.periodCount) || 6));
  var t = todayISO();
  var base = await baseCurrency();
  var mtd = monthToDate(t);
  var periods = trendPeriods(periodType, periodCount);
  var company = { code: co.code, name: co.name, kind: co.kind };
  var head = { company: company, kind: co.kind, baseCurrency: base, today: t, periodType: periodType, periodCount: periodCount };
  var exp = await expenseFigures(co, t, mtd);
  var expTrend = await expenseTrend(co, periods);
  if (co.kind === 'restaurant') return Object.assign(head, exp, await restaurantFinance(ctx, co, t, mtd, periods, expTrend, exp));
  return Object.assign(head, exp, await tradeFinance(co, t, base, mtd, periods, expTrend, exp));
}

async function tradeFinance(co, t, base, mtd, periods, expTrend, exp) {
  var inv = docScope(co, 'i', 'c');
  var open = "i.status NOT IN ('paid','void') AND i.balance_due > 0";
  var collectedRes = await pool.query(
    'SELECT pm.currency, coalesce(sum(pm.amount) FILTER (WHERE pm.date BETWEEN $2 AND $3), 0) AS this_month, ' +
    'coalesce(sum(pm.amount) FILTER (WHERE pm.date BETWEEN $4 AND $5), 0) AS last_month ' +
    'FROM payments pm JOIN invoices i ON i.id = pm.invoice_id JOIN customers c ON c.id = i.customer_id WHERE ' + inv + ' GROUP BY pm.currency',
    [co.id, mtd.from, mtd.to, mtd.prevFrom, mtd.prevTo]
  );
  var outstandingRes = await pool.query(
    'SELECT i.currency, sum(i.balance_due) AS s, count(*)::int AS n, ' +
    'sum(i.balance_due) FILTER (WHERE i.due_date < $2) AS overdue, count(*) FILTER (WHERE i.due_date < $2)::int AS overdue_n ' +
    'FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE ' + open + ' AND ' + inv + ' GROUP BY i.currency', [co.id, t]
  );
  var overdueRes = await pool.query(
    'SELECT i.invoice_no, i.balance_due, i.currency, i.due_date, c.name AS customer_name, c.phone FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
    'WHERE ' + open + ' AND i.due_date < $2 AND ' + inv + ' ORDER BY i.due_date LIMIT 25', [co.id, t]
  );
  var dueSoonRes = await pool.query(
    'SELECT i.invoice_no, i.balance_due, i.currency, i.due_date, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
    "WHERE " + open + " AND i.due_date BETWEEN $2 AND ($2::date + 14) AND " + inv + ' ORDER BY i.due_date LIMIT 10', [co.id, t]
  );
  // How late the money owed is, in the base currency.
  var agingRes = await pool.query(
    'SELECT coalesce(sum(i.balance_due) FILTER (WHERE i.due_date IS NULL OR i.due_date >= $2), 0) AS current, ' +
    "coalesce(sum(i.balance_due) FILTER (WHERE i.due_date < $2 AND i.due_date >= $2::date - 30), 0) AS d1, " +
    "coalesce(sum(i.balance_due) FILTER (WHERE i.due_date < $2::date - 30 AND i.due_date >= $2::date - 60), 0) AS d31, " +
    "coalesce(sum(i.balance_due) FILTER (WHERE i.due_date < $2::date - 60 AND i.due_date >= $2::date - 90), 0) AS d61, " +
    "coalesce(sum(i.balance_due) FILTER (WHERE i.due_date < $2::date - 90), 0) AS d90 " +
    'FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE ' + open + ' AND i.currency = $3 AND ' + inv, [co.id, t, base]
  );
  var debtorsRes = await pool.query(
    'SELECT c.name, c.phone, sum(i.balance_due) AS owed, count(*)::int AS invoices, min(i.due_date) AS oldest_due FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
    'WHERE ' + open + ' AND i.currency = $2 AND ' + inv + ' GROUP BY c.id, c.name, c.phone ORDER BY owed DESC LIMIT 5', [co.id, base]
  );
  var recentRes = await pool.query(
    'SELECT pm.amount, pm.currency, pm.date, pm.method, c.name AS customer_name, i.invoice_no FROM payments pm JOIN invoices i ON i.id = pm.invoice_id ' +
    'JOIN customers c ON c.id = i.customer_id WHERE ' + inv + ' ORDER BY pm.date DESC, pm.id LIMIT 8', [co.id]
  );
  var trend = [];
  for (var k = 0; k < periods.length; k++) {
    var p = periods[k];
    var rev = await pool.query(
      "SELECT coalesce(sum(pm.amount),0) AS s FROM payments pm JOIN invoices i ON i.id = pm.invoice_id JOIN customers c ON c.id = i.customer_id " +
      "WHERE pm.currency = $2 AND to_char(pm.date, '" + p.fmt + "') = $3 AND " + inv, [co.id, base, p.key]
    );
    trend.push({ month: p.label, key: p.key, revenue: Number(rev.rows[0].s), expense: expTrend[k] });
  }
  var baseRow = collectedRes.rows.filter(function (r) { return r.currency === base; })[0] || { this_month: 0, last_month: 0 };
  var a = agingRes.rows[0];
  var overdueList = overdueRes.rows.map(function (r) {
    var due = dayStr(r.due_date);
    return { invoiceNo: r.invoice_no, customerName: r.customer_name, phone: r.phone || '', currency: r.currency, amount: Number(r.balance_due), dueDate: due, daysOverdue: daysBetweenIso(due, t) };
  }).sort(function (x, y) { return y.daysOverdue - x.daysOverdue; });
  return {
    cashCollectedThisMonthByCurrency: collectedRes.rows.filter(function (r) { return Number(r.this_month); }).map(function (r) { return { currency: r.currency, amount: Number(r.this_month) }; }),
    cashCollectedThisMonth: Number(baseRow.this_month), cashCollectedLastMonthSameDays: Number(baseRow.last_month),
    outstandingByCurrency: outstandingRes.rows.map(function (r) { return { currency: r.currency, amount: Number(r.s) }; }),
    unpaidCount: outstandingRes.rows.reduce(function (s, r) { return s + r.n; }, 0),
    overdueCount: outstandingRes.rows.reduce(function (s, r) { return s + r.overdue_n; }, 0),
    overdueTotalByCurrency: outstandingRes.rows.filter(function (r) { return r.overdue != null && Number(r.overdue); }).map(function (r) { return { currency: r.currency, amount: Number(r.overdue) }; }),
    overdueInvoices: overdueList,
    dueSoon: dueSoonRes.rows.map(function (r) { var due = dayStr(r.due_date); return { invoiceNo: r.invoice_no, customerName: r.customer_name, currency: r.currency, amount: Number(r.balance_due), dueDate: due, daysLeft: daysBetweenIso(t, due) }; }),
    aging: { current: Number(a.current), d1to30: Number(a.d1), d31to60: Number(a.d31), d61to90: Number(a.d61), d90plus: Number(a.d90) },
    topDebtors: debtorsRes.rows.map(function (r) { return { name: r.name, phone: r.phone || '', owed: Number(r.owed), invoices: r.invoices, oldestDue: dayStr(r.oldest_due) }; }),
    netPositionThisMonth: Number(baseRow.this_month) - exp.approvedExpensesThisMonth,
    monthlyTrend: trend,
    recentPayments: recentRes.rows.map(function (r) { return { customerName: r.customer_name, invoiceNo: r.invoice_no, amount: Number(r.amount), currency: r.currency, date: dayStr(r.date), method: r.method }; })
  };
}

// A restaurant's money: what the till took, what was spent, whether the
// cash drawers balanced, and voided orders. Voided orders never count as
// sales.
async function restaurantFinance(ctx, co, t, mtd, periods, expTrend, exp) {
  var salesRes = await pool.query(
    "SELECT coalesce(sum(total) FILTER (WHERE status = 'completed' AND created_at::date BETWEEN $2 AND $3), 0) AS this_month, " +
    "count(*) FILTER (WHERE status = 'completed' AND created_at::date BETWEEN $2 AND $3)::int AS orders, " +
    "coalesce(sum(total) FILTER (WHERE status = 'completed' AND created_at::date BETWEEN $4 AND $5), 0) AS last_month, " +
    "count(*) FILTER (WHERE status = 'completed' AND created_at::date BETWEEN $4 AND $5)::int AS last_orders, " +
    "count(*) FILTER (WHERE status = 'voided' AND created_at::date BETWEEN $2 AND $3)::int AS voided, " +
    "coalesce(sum(total) FILTER (WHERE status = 'voided' AND created_at::date BETWEEN $2 AND $3), 0) AS voided_amount " +
    'FROM restaurant_orders WHERE company_id = $1', [co.id, mtd.from, mtd.to, mtd.prevFrom, mtd.prevTo]
  );
  var methodRes = await pool.query(
    "SELECT payment_method AS method, sum(total) AS amount, count(*)::int AS orders FROM restaurant_orders WHERE company_id = $1 AND status = 'completed' " +
    'AND created_at::date BETWEEN $2 AND $3 GROUP BY payment_method ORDER BY amount DESC', [co.id, mtd.from, mtd.to]
  );
  var dailyRes = await pool.query(
    "SELECT d::date AS day, coalesce(sum(o.total), 0) AS sales, count(o.id)::int AS orders FROM generate_series($2::date - 13, $2::date, interval '1 day') d " +
    "LEFT JOIN restaurant_orders o ON o.company_id = $1 AND o.status = 'completed' AND o.created_at::date = d::date GROUP BY d ORDER BY d", [co.id, t]
  );
  var trend = [];
  for (var k = 0; k < periods.length; k++) {
    var p = periods[k];
    var r = await pool.query(
      "SELECT coalesce(sum(total),0) AS s FROM restaurant_orders WHERE company_id = $1 AND status = 'completed' AND to_char(created_at, '" + p.fmt + "') = $2", [co.id, p.key]
    );
    trend.push({ month: p.label, key: p.key, revenue: Number(r.rows[0].s), expense: expTrend[k] });
  }
  // Cash drawers closed in the last 30 days: did the count match what the
  // till expected?
  var from30 = new Date(new Date(t + 'T00:00').getTime() - 30 * 86400000).toISOString().slice(0, 10);
  var drawers = await require('./restaurantPos.service').listDrawerSessions(ctx, co.id, { from: from30, limit: 200 });
  var closed = drawers.sessions.filter(function (s) { return s.difference !== null; });
  var off = closed.filter(function (s) { return Math.abs(s.difference) >= 0.01; });
  var s = salesRes.rows[0];
  var sales = Number(s.this_month);
  return {
    salesThisMonth: sales, ordersThisMonth: s.orders, salesLastMonthSameDays: Number(s.last_month), ordersLastMonthSameDays: s.last_orders,
    avgOrderThisMonth: s.orders ? Math.round((sales / s.orders) * 100) / 100 : 0,
    voidedThisMonth: s.voided, voidedAmountThisMonth: Number(s.voided_amount),
    byMethod: methodRes.rows.map(function (r) { return { method: r.method, amount: Number(r.amount), orders: r.orders }; }),
    daily: dailyRes.rows.map(function (r) { return { date: dayStr(r.day), sales: Number(r.sales), orders: r.orders }; }),
    netPositionThisMonth: sales - exp.approvedExpensesThisMonth,
    monthlyTrend: trend,
    drawers: {
      closed: closed.length, open: drawers.sessions.filter(function (x) { return x.difference === null; }).length,
      balanced: closed.length - off.length,
      short: off.filter(function (x) { return x.difference < 0; }).reduce(function (a, x) { return a + x.difference; }, 0),
      over: off.filter(function (x) { return x.difference > 0; }).reduce(function (a, x) { return a + x.difference; }, 0),
      mismatches: off.slice(0, 10).map(function (x) {
        return { cashierName: x.cashierName, date: dayStr(x.session.closedAt || x.session.openedAt), expected: x.expected, actual: x.actual, difference: x.difference, note: x.session.closingNote || '' };
      })
    }
  };
}

// kernel.js: handlers['commercial.dashboard'] -> GET /api/reports/commercial?company=
async function commercialDashboard(ctx, companyCode, opts) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var co = opts && opts.allCompanies ? ALL_COMPANIES : await resolveDashboardCompany(ctx, companyCode, true);
  var t = todayISO();
  var base = await baseCurrency();
  await quotationsService.list(ctx).catch(function () {}); // triggers autoExpireQuotations as a side effect, same as kernel
  var qs = docScope(co, 'q', 'c');
  var is = docScope(co, 'i', 'c');

  var qCountsRes = await pool.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE q.status IN ('sent','viewed'))::int AS awaiting, " +
    "count(*) FILTER (WHERE q.status = 'accepted')::int AS accepted, count(*) FILTER (WHERE q.status = 'rejected')::int AS rejected, " +
    "count(*) FILTER (WHERE q.status = 'expired')::int AS expired, count(*) FILTER (WHERE q.status != 'draft')::int AS sent, " +
    "count(*) FILTER (WHERE q.status = 'draft')::int AS drafts " +
    'FROM quotations q JOIN customers c ON c.id = q.customer_id WHERE ' + qs, [co.id]
  );
  var q = qCountsRes.rows[0];
  var qValueRes = await pool.query(
    "SELECT q.currency, sum(q.grand_total) AS s, sum(q.grand_total) FILTER (WHERE q.status IN ('sent','viewed')) AS awaiting, " +
    "sum(q.grand_total) FILTER (WHERE q.status = 'accepted') AS accepted FROM quotations q JOIN customers c ON c.id = q.customer_id WHERE " + qs + ' GROUP BY q.currency', [co.id]
  );
  var invCountsRes = await pool.query(
    "SELECT count(*) FILTER (WHERE i.status != 'void')::int AS total, count(*) FILTER (WHERE i.status NOT IN ('paid','void') AND i.balance_due > 0 AND i.due_date < $2)::int AS overdue_count, " +
    "count(*) FILTER (WHERE i.status = 'paid')::int AS paid_count FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE " + is, [co.id, t]
  );
  var inv = invCountsRes.rows[0];
  var invValueRes = await pool.query(
    "SELECT i.currency, sum(i.grand_total) AS invoiced, sum(i.amount_paid) AS paid, sum(i.balance_due) FILTER (WHERE i.status != 'paid') AS outstanding, " +
    "sum(i.balance_due) FILTER (WHERE i.status != 'paid' AND i.balance_due > 0 AND i.due_date < $2) AS overdue_amount, " +
    "sum(i.grand_total) FILTER (WHERE to_char(i.issued_at,'YYYY-MM') = $3) AS revenue_month, " +
    "sum(i.grand_total) FILTER (WHERE to_char(i.issued_at,'YYYY') = $4) AS revenue_year " +
    "FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status != 'void' AND " + is + ' GROUP BY i.currency',
    [co.id, t, t.slice(0, 7), t.slice(0, 4)]
  );
  // How long customers take to pay, over the last 180 days of payments.
  var daysToPayRes = await pool.query(
    'SELECT round(avg(pm.date - i.issued_at))::int AS days FROM payments pm JOIN invoices i ON i.id = pm.invoice_id JOIN customers c ON c.id = i.customer_id ' +
    "WHERE pm.date >= $2::date - 180 AND " + is, [co.id, t]
  );

  var months = [];
  for (var m = 5; m >= 0; m--) {
    var dt = new Date(); dt.setDate(1); dt.setMonth(dt.getMonth() - m);
    var key = dt.toISOString().slice(0, 7);
    var invoicedRes = await pool.query("SELECT coalesce(sum(i.grand_total),0) AS s FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status != 'void' AND i.currency = $2 AND to_char(i.issued_at,'YYYY-MM') = $3 AND " + is, [co.id, base, key]);
    var paidRes = await pool.query("SELECT coalesce(sum(pm.amount),0) AS s FROM payments pm JOIN invoices i ON i.id = pm.invoice_id JOIN customers c ON c.id = i.customer_id WHERE pm.currency = $2 AND to_char(pm.date::date,'YYYY-MM') = $3 AND " + is, [co.id, base, key]);
    months.push({ month: dt.toLocaleDateString('en-GB', { month: 'short' }), key: key, invoiced: Number(invoicedRes.rows[0].s), paid: Number(paidRes.rows[0].s) });
  }

  var open = "i.status NOT IN ('paid','void') AND i.balance_due > 0";
  var upcomingRes = await pool.query("SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE " + open + ' AND i.due_date >= $2 AND ' + is + ' ORDER BY i.due_date LIMIT 6', [co.id, t]);
  var overdueListRes = await pool.query("SELECT i.*, c.name AS customer_name, c.phone FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE " + open + ' AND i.due_date < $2 AND ' + is + ' ORDER BY i.due_date', [co.id, t]);
  var recentQuotesRes = await pool.query('SELECT q.*, c.name AS customer_name FROM quotations q JOIN customers c ON c.id = q.customer_id WHERE ' + qs + ' ORDER BY q.created_at DESC LIMIT 5', [co.id]);
  var recentInvoicesRes = await pool.query('SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE ' + is + ' ORDER BY i.issued_at DESC, i.invoice_no DESC LIMIT 5', [co.id]);
  var recentPaymentsRes = await pool.query(
    'SELECT pm.*, c.name AS customer_name, i.invoice_no FROM payments pm JOIN invoices i ON i.id = pm.invoice_id JOIN customers c ON c.id = i.customer_id WHERE ' + is + ' ORDER BY pm.date DESC LIMIT 5', [co.id]
  );

  function invRow(r) {
    var due = dayStr(r.due_date);
    return { invoiceNo: r.invoice_no, customerName: r.customer_name, phone: r.phone || '', currency: r.currency, balanceDue: Number(r.balance_due), dueDate: due, days: due ? daysBetweenIso(t, due) : null };
  }
  function recentInvoiceRow(r) { return { invoiceNo: r.invoice_no, customerName: r.customer_name, currency: r.currency, grandTotal: Number(r.grand_total), balanceDue: Number(r.balance_due), status: r.status, issuedAt: dayStr(r.issued_at), dueDate: dayStr(r.due_date) }; }
  function quoteRow(r) { return { quoteNo: r.quote_no, customerName: r.customer_name, currency: r.currency, grandTotal: Number(r.grand_total), status: r.status, createdAt: dayStr(r.created_at), validUntil: dayStr(r.valid_until) }; }
  var baseInv = invValueRes.rows.filter(function (r) { return r.currency === base; })[0];

  return {
    company: { code: co.code, name: co.name, kind: co.kind }, baseCurrency: base, today: t,
    totalQuotations: q.total, draftQuotations: q.drafts, sentQuotations: q.sent, awaitingResponse: q.awaiting, acceptedQuotations: q.accepted, rejectedQuotations: q.rejected, expiredQuotations: q.expired,
    totalQuotationValueByCurrency: byCurrencyArr(qValueRes.rows, 's'),
    awaitingValueByCurrency: byCurrencyArr(qValueRes.rows.filter(function (r) { return r.awaiting != null; }), 'awaiting'),
    acceptedValueByCurrency: byCurrencyArr(qValueRes.rows.filter(function (r) { return r.accepted != null; }), 'accepted'),
    conversionRate: q.sent ? Math.round((q.accepted / q.sent) * 100) : 0,
    totalInvoices: inv.total, paidInvoices: inv.paid_count,
    totalInvoicedByCurrency: byCurrencyArr(invValueRes.rows, 'invoiced'),
    totalPaidByCurrency: byCurrencyArr(invValueRes.rows, 'paid'),
    outstandingByCurrency: byCurrencyArr(invValueRes.rows.filter(function (r) { return r.outstanding != null; }), 'outstanding'),
    collectionRate: baseInv && Number(baseInv.invoiced) ? Math.round((Number(baseInv.paid) / Number(baseInv.invoiced)) * 100) : null,
    averageDaysToPay: daysToPayRes.rows[0].days,
    overdueCount: inv.overdue_count, overdueAmountByCurrency: byCurrencyArr(invValueRes.rows.filter(function (r) { return r.overdue_amount != null; }), 'overdue_amount'),
    revenueThisMonthByCurrency: byCurrencyArr(invValueRes.rows.filter(function (r) { return r.revenue_month != null; }), 'revenue_month'),
    revenueThisYearByCurrency: byCurrencyArr(invValueRes.rows.filter(function (r) { return r.revenue_year != null; }), 'revenue_year'),
    monthly: months, upcomingDue: upcomingRes.rows.map(invRow), overdueInvoices: overdueListRes.rows.map(invRow),
    recentQuotes: recentQuotesRes.rows.map(quoteRow), recentInvoices: recentInvoicesRes.rows.map(recentInvoiceRow),
    recentPayments: recentPaymentsRes.rows.map(function (r) { return { invoiceNo: r.invoice_no, customerName: r.customer_name, amount: Number(r.amount), currency: r.currency, date: dayStr(r.date), method: r.method }; })
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

// The company a statement is for: any company with a dashboard (trade or
// restaurant), or every company together ('ALL', the default — how these
// statements have always been). Each source is narrowed the same way the
// dashboards narrow it: documents by their own company or their client's
// (no company = Bamboo Products), expense claims, purchase requests and
// payroll by the department's company, restaurant sales and supplies by
// their restaurant, raw bamboo to Bamboo Products.
async function statementCompany(ctx, code) {
  var c = String(code || 'ALL').trim().toUpperCase();
  if (c === 'ALL' || c === '*') return ALL_COMPANIES;
  var co = (await marketingCompanyList(ctx)).filter(function (x) { return x.code.toUpperCase() === c; })[0];
  if (!co) fail('invalid', 'There is no company "' + c + '".');
  return co;
}
// The companies a statement can be for, for the page's switcher: every
// company together first, then each company with a dashboard.
async function statementCompanies(ctx) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  return [{ code: 'ALL', name: 'All companies', kind: 'all' }].concat((await marketingCompanyList(ctx)).map(function (c) { return { code: c.code, name: c.name, kind: c.kind }; }));
}
function scopes(co) {
  var all = co.id === null;
  var bpl = co.code === 'BPL';
  return {
    inv: docScope(co, 'i', 'c'),
    exp: expenseScope(co),
    pay: all ? '$1::uuid IS NULL' : 'd.company_id = $1',
    proc: all ? '$1::uuid IS NULL' : bpl ? '(d.company_id = $1 OR pr.department_id IS NULL)' : 'd.company_id = $1',
    rest: all ? '$1::uuid IS NULL' : 'o.company_id = $1',
    moves: all ? '$1::uuid IS NULL' : 'm.company_id = $1',
    raw: all || bpl
  };
}
function periodParams(params) {
  var period = defaultPeriod(params);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.from) || !/^\d{4}-\d{2}-\d{2}$/.test(period.to)) fail('invalid', 'Dates must look like 2026-01-31.');
  if (period.to < period.from) fail('invalid', 'The end of the period is before its start.');
  return period;
}

// What was bought and received in a period: purchase requests at their real
// cost (the estimate when none was entered) on the day they arrived, raw
// bamboo batches on the day they came in, and restaurant supplies and
// ingredients delivered. Supplier payments aren't recorded in the OS, so a
// purchase counts as a cost — and, on the cash flow, as paid — when it is
// received.
async function purchasesIn(co, sc, from, to) {
  var P = [co.id, from, to];
  var procRes = await pool.query(
    'SELECT coalesce(sum(coalesce(pr.actual_cost, pr.estimated_price)),0) AS s, count(*)::int AS n FROM procurement_requests pr LEFT JOIN departments d ON d.id = pr.department_id ' +
    "WHERE pr.status = 'received' AND pr.received_at::date BETWEEN $2 AND $3 AND " + sc.proc, P);
  var rawRes = sc.raw ? await pool.query('SELECT coalesce(sum(cost),0) AS s, count(*)::int AS n FROM raw_batches WHERE date_received BETWEEN $1 AND $2', [from, to]) : { rows: [{ s: 0, n: 0 }] };
  var movesRes = await pool.query(
    "SELECT coalesce(sum(m.delta * m.unit_cost),0) AS s, count(*)::int AS n FROM restaurant_stock_moves m WHERE m.kind = 'received' AND m.created_at::date BETWEEN $2 AND $3 AND " + sc.moves, P);
  var out = {
    procurement: Number(procRes.rows[0].s), procurementCount: procRes.rows[0].n,
    rawBamboo: Number(rawRes.rows[0].s), rawBambooCount: rawRes.rows[0].n,
    restaurantSupplies: Number(movesRes.rows[0].s), restaurantSuppliesCount: movesRes.rows[0].n
  };
  out.total = Math.round((out.procurement + out.rawBamboo + out.restaurantSupplies) * 100) / 100;
  return out;
}

// kernel.js: handlers['reports.profitAndLoss']
// Revenue less the cost of what was bought, then less expense claims and
// payroll. Netting only makes sense in one currency — expenses and payroll
// have none of their own, and FX conversion is out of scope (see
// documents.js's resolveCurrency()) — so invoices count only in the base
// currency (baseCurrency in the response); restaurant till sales are in it
// already. An invoice in another currency still shows on its own record and
// in the Invoices list, just not in these blended statements.
async function profitAndLoss(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var period = periodParams(params);
  var co = await statementCompany(ctx, params && params.company);
  var sc = scopes(co);
  var base = await baseCurrency();
  var P = [co.id, period.from, period.to];

  var invRes = await pool.query("SELECT coalesce(sum(i.grand_total),0) AS s FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status != 'void' AND i.currency = $4 AND i.issued_at BETWEEN $2 AND $3 AND " + sc.inv, P.concat([base]));
  var restRes = await pool.query("SELECT coalesce(sum(o.total),0) AS s FROM restaurant_orders o WHERE o.status = 'completed' AND o.created_at::date BETWEEN $2 AND $3 AND " + sc.rest, P);
  var expByCatRes = await pool.query(
    "SELECT e.category, sum(e.amount) AS amount FROM expenses e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status IN ('approved','paid') AND e.date BETWEEN $2 AND $3 AND " + sc.exp + ' GROUP BY e.category ORDER BY amount DESC', P);
  var payrollRes = await pool.query(
    'SELECT coalesce(sum(ps.gross_pay + ps.ssnit_employer),0) AS s FROM payslips ps JOIN pay_runs pr ON pr.id = ps.pay_run_id JOIN employees e ON e.id = ps.employee_id JOIN departments d ON d.id = e.department_id ' +
    "WHERE pr.status IN ('approved','paid') AND pr.pay_date BETWEEN $2 AND $3 AND " + sc.pay, P);
  var purchases = await purchasesIn(co, sc, period.from, period.to);

  var invoiced = Number(invRes.rows[0].s), restaurant = Number(restRes.rows[0].s);
  var revenue = invoiced + restaurant;
  var expenseByCategory = expByCatRes.rows.map(function (r) { return { category: r.category, amount: Number(r.amount) }; });
  var totalExpenses = expenseByCategory.reduce(function (sum, r) { return sum + r.amount; }, 0);
  var payrollCost = Number(payrollRes.rows[0].s);
  var r2 = function (n) { return Math.round(n * 100) / 100; };

  return {
    from: period.from, to: period.to, baseCurrency: base, company: { code: co.code === '*' ? 'ALL' : co.code, name: co.name },
    revenue: r2(revenue), revenueLines: { invoiced: invoiced, restaurant: restaurant },
    purchases: purchases, grossProfit: r2(revenue - purchases.total),
    expenseByCategory: expenseByCategory, totalExpenses: r2(totalExpenses),
    payrollCost: payrollCost, totalCosts: r2(purchases.total + totalExpenses + payrollCost),
    netProfit: r2(revenue - purchases.total - totalExpenses - payrollCost)
  };
}

// kernel.js: handlers['reports.cashFlow'] — base currency only, as the P&L.
// Money counts on the day it moved: payments and restaurant takings in;
// expense claims when paid out (the day they were claimed for older ones
// with no pay-out date), pay runs when marked paid, purchases when received.
// Claims approved but not paid out, and runs approved but not paid, are
// still to go out and are listed separately rather than counted.
async function cashFlow(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var period = periodParams(params);
  var co = await statementCompany(ctx, params && params.company);
  var sc = scopes(co);
  var base = await baseCurrency();
  var P = [co.id, period.from, period.to];

  var inRes = await pool.query('SELECT p.method, sum(p.amount) AS s FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id WHERE p.currency = $4 AND p.date BETWEEN $2 AND $3 AND ' + sc.inv + ' GROUP BY p.method', P.concat([base]));
  var restRes = await pool.query("SELECT o.payment_method AS method, sum(o.total) AS s FROM restaurant_orders o WHERE o.status = 'completed' AND o.created_at::date BETWEEN $2 AND $3 AND " + sc.rest + ' GROUP BY o.payment_method', P);
  var expRes = await pool.query(
    "SELECT coalesce(sum(e.amount),0) AS s FROM expenses e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'paid' AND coalesce(e.paid_at::date, e.date) BETWEEN $2 AND $3 AND " + sc.exp, P);
  var expDueRes = await pool.query(
    "SELECT coalesce(sum(e.amount),0) AS s, count(*)::int AS n FROM expenses e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'approved' AND " + sc.exp, [co.id]);
  var payRes = await pool.query(
    'SELECT coalesce(sum(ps.gross_pay + ps.ssnit_employer),0) AS s FROM payslips ps JOIN pay_runs pr ON pr.id = ps.pay_run_id JOIN employees e ON e.id = ps.employee_id JOIN departments d ON d.id = e.department_id ' +
    "WHERE pr.status = 'paid' AND pr.pay_date BETWEEN $2 AND $3 AND " + sc.pay, P);
  var payDueRes = await pool.query(
    'SELECT coalesce(sum(ps.gross_pay + ps.ssnit_employer),0) AS s, count(DISTINCT pr.id)::int AS n FROM payslips ps JOIN pay_runs pr ON pr.id = ps.pay_run_id JOIN employees e ON e.id = ps.employee_id JOIN departments d ON d.id = e.department_id ' +
    "WHERE pr.status = 'approved' AND " + sc.pay, [co.id]);
  var purchases = await purchasesIn(co, sc, period.from, period.to);

  var byMethod = {};
  inRes.rows.concat(restRes.rows).forEach(function (r) { byMethod[r.method] = (byMethod[r.method] || 0) + Number(r.s); });
  var fromInvoices = inRes.rows.reduce(function (sum, r) { return sum + Number(r.s); }, 0);
  var fromRestaurants = restRes.rows.reduce(function (sum, r) { return sum + Number(r.s); }, 0);
  var cashIn = fromInvoices + fromRestaurants;
  var expensesOut = Number(expRes.rows[0].s), payrollOut = Number(payRes.rows[0].s);
  var cashOut = expensesOut + payrollOut + purchases.total;
  var r2 = function (n) { return Math.round(n * 100) / 100; };

  return {
    from: period.from, to: period.to, baseCurrency: base, company: { code: co.code === '*' ? 'ALL' : co.code, name: co.name },
    cashIn: r2(cashIn), cashInFromInvoices: r2(fromInvoices), cashInFromRestaurants: r2(fromRestaurants),
    cashInByMethod: Object.keys(byMethod).map(function (m) { return { method: m, amount: r2(byMethod[m]) }; }).sort(function (a, b) { return b.amount - a.amount; }),
    expensesOut: expensesOut, payrollOut: payrollOut, purchasesOut: purchases.total, purchases: purchases, cashOut: r2(cashOut),
    netCashFlow: r2(cashIn - cashOut),
    stillToPay: { expenses: Number(expDueRes.rows[0].s), expenseCount: expDueRes.rows[0].n, payroll: Number(payDueRes.rows[0].s), payrollRuns: payDueRes.rows[0].n }
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
  var restRes = await pool.query("SELECT coalesce(sum(total),0) AS s FROM restaurant_orders WHERE status = 'completed'");
  var allPurchases = await purchasesIn(ALL_COMPANIES, scopes(ALL_COMPANIES), '1900-01-01', '2999-12-31');

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
  var retainedEarnings = Number(revRes.rows[0].s) + Number(restRes.rows[0].s) - allPurchases.total - Number(expRes.rows[0].s) - Number(payrollRes.rows[0].s);
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
async function arAging(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var t = todayISO();
  var co = await statementCompany(ctx, params && params.company);
  var res = await pool.query(
    "SELECT i.id, i.invoice_no, i.balance_due, i.currency, i.due_date, c.name AS customer_name, c.phone FROM invoices i JOIN customers c ON c.id = i.customer_id " +
    "WHERE i.status != 'void' AND i.balance_due > 0 AND " + scopes(co).inv + " ORDER BY i.due_date NULLS LAST", [co.id]
  );
  var bucketKeys = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'];
  var buckets = {}; bucketKeys.forEach(function (k) { buckets[k] = {}; });
  var totals = {};
  var rows = res.rows.map(function (r) {
    var daysOverdue = r.due_date ? Math.floor((new Date(t) - new Date(r.due_date)) / 86400000) : -1;
    var bucket = daysOverdue <= 0 ? 'current' : daysOverdue <= 30 ? 'd1_30' : daysOverdue <= 60 ? 'd31_60' : daysOverdue <= 90 ? 'd61_90' : 'd90_plus';
    buckets[bucket][r.currency] = (buckets[bucket][r.currency] || 0) + Number(r.balance_due);
    totals[r.currency] = (totals[r.currency] || 0) + Number(r.balance_due);
    return { invoiceId: r.id, invoiceNo: r.invoice_no, customerName: r.customer_name, phone: r.phone || '', currency: r.currency, balanceDue: Number(r.balance_due), dueDate: r.due_date, daysOverdue: Math.max(0, daysOverdue), bucket: bucket };
  });
  var toArr = function (obj) { return Object.keys(obj).map(function (c) { return { currency: c, amount: obj[c] }; }); };
  var bucketsArr = {}; bucketKeys.forEach(function (k) { bucketsArr[k] = toArr(buckets[k]); });
  return { asOf: t, invoices: rows, buckets: bucketsArr, totalByCurrency: toArr(totals) };
}

// kernel.js: handlers['reports.expenseDetail']
async function expenseDetail(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var period = periodParams(params);
  var co = await statementCompany(ctx, params && params.company);
  var res = await pool.query(
    "SELECT e.id, e.category, e.amount, e.date, e.description, e.status, emp.first_name, emp.last_name, d.name AS dept_name " +
    "FROM expenses e JOIN employees emp ON emp.id = e.requester_id LEFT JOIN departments d ON d.id = e.department_id " +
    "WHERE e.status IN ('approved','paid') AND e.date BETWEEN $2 AND $3 AND " + scopes(co).exp + " ORDER BY e.date DESC",
    [co.id, period.from, period.to]
  );
  var byCategory = {}, byDept = {};
  var rows = res.rows.map(function (r) {
    byCategory[r.category] = (byCategory[r.category] || 0) + Number(r.amount);
    byDept[r.dept_name || '—'] = (byDept[r.dept_name || '—'] || 0) + Number(r.amount);
    return { id: r.id, category: r.category, amount: Number(r.amount), date: r.date, description: r.description, status: r.status, requesterName: r.first_name + ' ' + r.last_name, departmentName: r.dept_name || '—' };
  });
  return {
    from: period.from, to: period.to, items: rows,
    total: rows.reduce(function (s, r) { return s + r.amount; }, 0),
    byCategory: Object.keys(byCategory).map(function (k) { return { category: k, amount: byCategory[k] }; }).sort(function (a, b) { return b.amount - a.amount; }),
    byDepartment: Object.keys(byDept).map(function (k) { return { department: k, amount: byDept[k] }; }).sort(function (a, b) { return b.amount - a.amount; })
  };
}

// kernel.js: handlers['reports.taxSummary']
// Tax is recorded as a plain percentage — on each line (document_line_items.
// tax_rate) and, since the document editor gained one, on the whole
// document (invoices.tax_rate, applied after discounts). Neither links back
// to a named tax (VAT/NHIL/GETFund/WHT), so this groups by the exact rate
// and labels it with whichever configured tax(es) share that percentage —
// ambiguous when two share a rate (NHIL and GETFund both default to 2.5%),
// which the label says rather than guessing. Whole-document tax is worked
// out per invoice as what its recorded tax_total holds beyond its lines'
// tax, so the two together reconcile to the invoices' own totals; any gap
// left is shown as a difference to look into.
async function taxSummary(ctx, params) {
  if (!ctx.can('report.read')) fail('forbidden', 'Your role does not allow this action (report.read).');
  var period = periodParams(params);
  var co = await statementCompany(ctx, params && params.company);
  var base = await baseCurrency();

  var settingsRes = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var taxRates = (settingsRes.rows[0].commercial && settingsRes.rows[0].commercial.taxRates) || [];
  var nameByRate = {};
  taxRates.forEach(function (t) {
    var key = Number(t.rate).toFixed(3);
    nameByRate[key] = nameByRate[key] ? nameByRate[key] + ' / ' + t.name : t.name;
  });

  var P = [co.id, base, period.from, period.to];
  var invRes = await pool.query(
    "SELECT i.id, i.tax_rate, i.tax_total FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status != 'void' AND i.currency = $2 AND i.issued_at BETWEEN $3 AND $4 AND " + scopes(co).inv, P);
  var ids = invRes.rows.map(function (r) { return r.id; });
  var linesRes = ids.length ? await pool.query(
    "SELECT li.tax_rate, li.qty, li.unit_price, li.discount, li.discount_type, li.document_id AS invoice_id FROM document_line_items li WHERE li.document_type = 'invoice' AND li.document_id = ANY($1::uuid[])", [ids]) : { rows: [] };

  var byRate = {};
  function add(rate, baseAmt, tax, invoiceId, whole) {
    var key = Number(rate).toFixed(3) + (whole ? 'd' : '');
    if (!byRate[key]) byRate[key] = { rate: Number(rate), whole: !!whole, taxableBase: 0, taxCollected: 0, invoiceIds: {} };
    byRate[key].taxableBase += baseAmt;
    byRate[key].taxCollected += tax;
    byRate[key].invoiceIds[invoiceId] = true;
  }
  var lineTaxByInvoice = {};
  var totalTaxFromLineItems = 0;
  linesRes.rows.forEach(function (r) {
    var line = Number(r.qty) * Number(r.unit_price);
    var lineDiscount = r.discount_type === 'percent' ? (line * Number(r.discount)) / 100 : Number(r.discount);
    var afterDiscount = Math.max(0, line - lineDiscount);
    var rate = Number(r.tax_rate);
    var tax = (afterDiscount * rate) / 100;
    add(rate, afterDiscount, tax, r.invoice_id, false);
    lineTaxByInvoice[r.invoice_id] = (lineTaxByInvoice[r.invoice_id] || 0) + tax;
    totalTaxFromLineItems += tax;
  });
  var recordedTaxTotal = 0, docTaxTotal = 0;
  invRes.rows.forEach(function (r) {
    var recorded = Number(r.tax_total);
    recordedTaxTotal += recorded;
    var rest = Math.round((recorded - (lineTaxByInvoice[r.id] || 0)) * 100) / 100;
    var rate = Number(r.tax_rate) || 0;
    if (rate > 0 && rest > 0.005) {
      add(rate, (rest * 100) / rate, rest, r.id, true);
      docTaxTotal += rest;
    }
  });

  var r2 = function (n) { return Math.round(n * 100) / 100; };
  var byRateArr = Object.keys(byRate)
    .sort(function (a, b) { return byRate[b].rate - byRate[a].rate || (byRate[a].whole ? 1 : -1); })
    .map(function (key) {
      var r = byRate[key];
      var nameKey = r.rate.toFixed(3);
      return {
        rate: r.rate, onWholeDocument: r.whole,
        label: nameByRate[nameKey] || (r.rate === 0 ? 'Zero-rated / no tax' : 'Custom (' + r.rate + '%)'),
        taxableBase: r2(r.taxableBase), taxCollected: r2(r.taxCollected),
        invoiceCount: Object.keys(r.invoiceIds).length
      };
    });

  return {
    from: period.from, to: period.to, baseCurrency: base, company: { code: co.code === '*' ? 'ALL' : co.code, name: co.name }, byRate: byRateArr,
    totalTaxFromLineItems: r2(totalTaxFromLineItems), totalTaxOnWholeDocuments: r2(docTaxTotal),
    recordedTaxTotal: r2(recordedTaxTotal),
    reconciliationDiff: r2(recordedTaxTotal - totalTaxFromLineItems - docTaxTotal)
  };
}

module.exports = {
  summary: summary, marketingDashboard: marketingDashboard, marketingCompanies: marketingCompanies, financeCompanies: financeCompanies, commercialCompanies: commercialCompanies, financeDashboard: financeDashboard, commercialDashboard: commercialDashboard,
  profitAndLoss: profitAndLoss, cashFlow: cashFlow, balanceSheet: balanceSheet, arAging: arAging, expenseDetail: expenseDetail,
  getBalanceSheetInputs: getBalanceSheetInputs, saveBalanceSheetInputs: saveBalanceSheetInputs, taxSummary: taxSummary, statementCompanies: statementCompanies
};
