var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var crm = require('./crm.service');

// The Sales & CRM overview as the CEO or a sales manager reads it: how much
// was sold and collected against the period before, what customers owe and
// how late, what is quoted and how much of it is won, how each rep is doing,
// who the best customers are and which good ones have stopped buying, what
// sells, and how fast customers get an answer.
//
// All of it from the OS itself: the CRM company's sale invoices (the same
// scope as crm.service.js — the company chosen in the CRM settings, else
// Bamboo Products Limited), their payments, quotations, the CRM leads and
// the inbox. Money is in GHS; invoices in another currency are counted
// apart (otherCurrency) rather than added in.
//
// A sale's rep is its sales order's rep, else the customer's account
// manager — the same rule as the Invoices page.

var STALE_BUYER_DAYS = 90;
var OPEN_STAGES = crm.OPEN_STAGES;

function r2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dateOnly(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function personName(first, last) { return [first, last].filter(Boolean).join(' '); }
function median(list) {
  if (!list.length) return null;
  var s = list.slice().sort(function (a, b) { return a - b; }), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quarterOf(iso) {
  var y = Number(iso.slice(0, 4)), q = Math.floor((Number(iso.slice(5, 7)) - 1) / 3);
  return { from: y + '-' + String(q * 3 + 1).padStart(2, '0') + '-01', to: addDays((q === 3 ? y + 1 : y) + '-' + String(q === 3 ? 1 : q * 3 + 4).padStart(2, '0') + '-01', -1) };
}
function monthsBack(to, n) {
  var y = Number(to.slice(0, 4)), m = Number(to.slice(5, 7)), out = [];
  for (var i = 0; i < n; i++) {
    out.unshift(y + '-' + String(m).padStart(2, '0'));
    m--; if (!m) { m = 12; y--; }
  }
  return out;
}

// Query text with numbered parameters, built as it goes.
function Q() {
  var args = [];
  return { args: args, p: function (v) { args.push(v); return '$' + args.length; } };
}
// The CRM company's quotations (q.) — the invoices' rule (crm.service.js
// invoiceScope), for quotations.
function quoteScope(co, p) {
  if (!co.id) return 'true';
  var x = p(co.id);
  if (co.code === 'BPL') return '(q.company_id = ' + x + ' OR (q.company_id IS NULL AND (c.company_id IS NULL OR c.company_id = ' + x + ')))';
  return 'q.company_id = ' + x;
}
var SALE = "i.doc_kind = 'sale' AND i.status <> 'void' AND i.currency = 'GHS'";
var REP = 'COALESCE(so.rep_id, c.account_manager_id)';
var FROM_INV = 'FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN sales_orders so ON so.id = i.sales_order_id ';

async function money(co, from, to) {
  var q = Q();
  var inv = (await pool.query(
    'SELECT count(*)::int AS n, coalesce(sum(i.grand_total - i.credit_total), 0) AS sales, count(DISTINCT i.customer_id)::int AS buyers, ' +
    'count(DISTINCT i.customer_id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM invoices o WHERE o.customer_id = i.customer_id AND o.doc_kind = \'sale\' AND o.status <> \'void\' AND o.issued_at < ' + q.p(from) + '))::int AS new_buyers ' +
    FROM_INV + 'WHERE ' + SALE + ' AND i.issued_at BETWEEN ' + q.p(from) + ' AND ' + q.p(to) + ' AND ' + crm._invoiceScope(co, q.p), q.args)).rows[0];
  var q2 = Q();
  var paid = (await pool.query(
    'SELECT coalesce(sum(p.amount), 0) AS cash FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id ' +
    'WHERE ' + SALE + ' AND p.date BETWEEN ' + q2.p(from) + ' AND ' + q2.p(to) + ' AND ' + crm._invoiceScope(co, q2.p), q2.args)).rows[0];
  var q3 = Q();
  var quotes = (await pool.query(
    "SELECT count(*)::int AS sent, coalesce(sum(q.grand_total), 0) AS sent_value, " +
    "count(*) FILTER (WHERE q.status = 'accepted')::int AS won, coalesce(sum(q.grand_total) FILTER (WHERE q.status = 'accepted'), 0) AS won_value, " +
    "count(*) FILTER (WHERE q.status IN ('rejected', 'expired', 'cancelled') OR (q.status IN ('sent', 'viewed') AND q.valid_until < CURRENT_DATE))::int AS lost " +
    'FROM quotations q JOIN customers c ON c.id = q.customer_id ' +
    "WHERE q.status <> 'draft' AND q.currency = 'GHS' AND COALESCE(q.sent_at, q.created_at)::date BETWEEN " + q3.p(from) + ' AND ' + q3.p(to) + ' AND ' + quoteScope(co, q3.p), q3.args)).rows[0];
  var leads = (await pool.query(
    "SELECT count(*)::int AS n, count(*) FILTER (WHERE stage = 'won')::int AS won FROM crm_leads WHERE received_on BETWEEN $1 AND $2", [from, to])).rows[0];
  var sales = r2(inv.sales), decided = quotes.won + quotes.lost;
  return {
    sales: sales, cash: r2(paid.cash), invoices: inv.n, averageInvoice: inv.n ? r2(sales / inv.n) : null,
    buyers: inv.buyers, newBuyers: inv.new_buyers, returningBuyers: inv.buyers - inv.new_buyers,
    quotesSent: quotes.sent, quotesValue: r2(quotes.sent_value), quotesWon: quotes.won, quotesWonValue: r2(quotes.won_value), quotesLost: quotes.lost,
    winRate: decided ? Math.round(quotes.won / decided * 100) : null,
    leads: leads.n, leadsWon: leads.won
  };
}

// Every customer message that started a run of theirs, and when we answered.
async function replies(from, to) {
  var rows = (await pool.query(
    'SELECT s.conversation_id, s.sent_at, v.channel, cu.account_manager_id AS rep_id, ' +
    "  (SELECT min(o.sent_at) FROM crm_messages o WHERE o.conversation_id = s.conversation_id AND o.direction = 'out' AND o.sent_at > s.sent_at) AS answered_at " +
    'FROM (SELECT m.conversation_id, m.direction, m.sent_at, lag(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at, m.created_at) AS prev ' +
    '      FROM crm_messages m) s ' +
    'JOIN crm_conversations v ON v.id = s.conversation_id LEFT JOIN customers cu ON cu.id = v.customer_id ' +
    "WHERE s.direction = 'in' AND (s.prev IS NULL OR s.prev = 'out') AND s.sent_at >= $1::date AND s.sent_at < ($2::date + 1)",
    [from, to])).rows;
  return rows.map(function (r) {
    return { channel: r.channel, repId: r.rep_id, minutes: r.answered_at ? Math.max(0, Math.round((new Date(r.answered_at) - new Date(r.sent_at)) / 60000)) : null };
  });
}
function replyStats(list) {
  var answered = list.filter(function (x) { return x.minutes !== null; }).map(function (x) { return x.minutes; });
  return {
    asked: list.length, answered: answered.length, medianMinutes: median(answered),
    withinHour: answered.length ? Math.round(answered.filter(function (m) { return m <= 60; }).length / list.length * 100) : null
  };
}

async function summary(ctx, query) {
  if (!ctx.can('crm.read')) fail('forbidden', 'Your role does not allow this action (crm.read).');
  query = query || {};
  var today = todayISO();
  var period = query.from && query.to ? { from: V.date(query.from, 'From'), to: V.date(query.to, 'To') } : quarterOf(today);
  if (period.to < period.from) fail('invalid', 'The period ends before it starts.');
  var len = daysBetween(period.from, period.to) + 1;
  var prev = { from: addDays(period.from, -len), to: addDays(period.from, -1) };
  var co = await crm._salesCompany(await crm._settingsRow());

  var now = await money(co, period.from, period.to);
  var before = await money(co, prev.from, prev.to);

  // Sales and cash, month by month, for the twelve months to the period's
  // end, or to this month when the period runs on into the future.
  var trendTo = period.to > today ? today : period.to;
  var months = monthsBack(trendTo, 12);
  var tFrom = months[0] + '-01';
  var qt = Q();
  var tSales = (await pool.query(
    "SELECT to_char(i.issued_at, 'YYYY-MM') AS m, coalesce(sum(i.grand_total - i.credit_total), 0) AS v " + FROM_INV +
    'WHERE ' + SALE + ' AND i.issued_at BETWEEN ' + qt.p(tFrom) + ' AND ' + qt.p(trendTo) + ' AND ' + crm._invoiceScope(co, qt.p) + ' GROUP BY 1', qt.args)).rows;
  var qc = Q();
  var tCash = (await pool.query(
    "SELECT to_char(p.date, 'YYYY-MM') AS m, coalesce(sum(p.amount), 0) AS v FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id " +
    'WHERE ' + SALE + ' AND p.date BETWEEN ' + qc.p(tFrom) + ' AND ' + qc.p(trendTo) + ' AND ' + crm._invoiceScope(co, qc.p) + ' GROUP BY 1', qc.args)).rows;
  function at(rows, m) { var x = rows.find(function (r) { return r.m === m; }); return x ? r2(x.v) : 0; }
  var trend = months.map(function (m) { return { month: m, sales: at(tSales, m), cash: at(tCash, m) }; });

  // What customers owe now, by how late.
  var qo = Q();
  var owing = (await pool.query(
    'SELECT i.id, i.balance_due, i.due_date, i.customer_id, ' + REP + ' AS rep_id ' + FROM_INV +
    "WHERE " + SALE + " AND i.status IN ('unpaid', 'partially_paid') AND i.balance_due > 0 AND " + crm._invoiceScope(co, qo.p), qo.args)).rows;
  var AGES = [['current', -1e9, 0], ['d30', 1, 30], ['d60', 31, 60], ['d90', 61, 90], ['d365', 91, 365], ['older', 366, 1e9]];
  var aging = AGES.map(function (a) { return { key: a[0], amount: 0, invoices: 0 }; });
  var owed = 0, overdue = 0;
  owing.forEach(function (o) {
    var late = o.due_date ? daysBetween(dateOnly(o.due_date), today) : 0;
    var k = AGES.findIndex(function (a) { return late >= a[1] && late <= a[2]; });
    aging[k].amount = r2(aging[k].amount + Number(o.balance_due)); aging[k].invoices++;
    owed = r2(owed + Number(o.balance_due));
    if (late > 0) overdue = r2(overdue + Number(o.balance_due));
  });

  // Quotations still open: what could still be won.
  var qq = Q();
  var openQuotes = (await pool.query(
    "SELECT q.id, q.quote_no, q.grand_total, q.valid_until, q.customer_id, c.name, c.account_manager_id AS rep_id FROM quotations q JOIN customers c ON c.id = q.customer_id " +
    "WHERE q.status IN ('sent', 'viewed') AND q.currency = 'GHS' AND (q.valid_until IS NULL OR q.valid_until >= CURRENT_DATE) AND " + quoteScope(co, qq.p) +
    ' ORDER BY q.grand_total DESC', qq.args)).rows;
  var pipeline = {
    count: openQuotes.length, value: r2(openQuotes.reduce(function (a, x) { return a + Number(x.grand_total); }, 0)),
    expiringSoon: openQuotes.filter(function (x) { return x.valid_until && dateOnly(x.valid_until) <= addDays(today, 7); }).length,
    biggest: openQuotes.slice(0, 5).map(function (x) { return { id: x.id, quoteNo: x.quote_no, customer: x.name, amount: r2(x.grand_total), validUntil: dateOnly(x.valid_until) }; })
  };

  // Best customers in the period, and how much of the sales they are.
  var qb = Q();
  var top = (await pool.query(
    'SELECT c.id, c.name, sum(i.grand_total - i.credit_total) AS sales, count(*)::int AS invoices, sum(i.balance_due) AS owes, ' +
    "  max(e.first_name || ' ' || e.last_name) AS rep_name " + FROM_INV + 'LEFT JOIN employees e ON e.id = c.account_manager_id ' +
    'WHERE ' + SALE + ' AND i.issued_at BETWEEN ' + qb.p(period.from) + ' AND ' + qb.p(period.to) + ' AND ' + crm._invoiceScope(co, qb.p) +
    ' GROUP BY c.id, c.name ORDER BY sales DESC LIMIT 8', qb.args)).rows.map(function (x) {
    return { id: x.id, name: x.name, sales: r2(x.sales), invoices: x.invoices, owes: r2(x.owes), repName: x.rep_name || null, share: now.sales > 0 ? Math.round(Number(x.sales) / now.sales * 100) : 0 };
  });
  var top5 = top.slice(0, 5).reduce(function (a, x) { return a + x.sales; }, 0);

  // Good customers who have stopped buying: two or more sales in the last two
  // years, none in the last 90 days. Biggest buyers first.
  var qs = Q();
  var quiet = (await pool.query(
    'SELECT c.id, c.name, c.last_contact_at, count(*)::int AS invoices, sum(i.grand_total - i.credit_total) AS lifetime, max(i.issued_at) AS last_bought, ' +
    "  max(e.first_name || ' ' || e.last_name) AS rep_name " + FROM_INV + 'LEFT JOIN employees e ON e.id = c.account_manager_id ' +
    'WHERE ' + SALE + ' AND i.issued_at >= ' + qs.p(addDays(today, -730)) + ' AND ' + crm._invoiceScope(co, qs.p) +
    ' GROUP BY c.id, c.name, c.last_contact_at HAVING count(*) >= 2 AND max(i.issued_at) < ' + qs.p(addDays(today, -STALE_BUYER_DAYS)) +
    ' ORDER BY lifetime DESC LIMIT 8', qs.args)).rows.map(function (x) {
    return { id: x.id, name: x.name, invoices: x.invoices, lifetime: r2(x.lifetime), lastBought: dateOnly(x.last_bought), lastContact: x.last_contact_at, repName: x.rep_name || null };
  });

  // What sells: invoice lines in the period, by what they are called.
  var qp = Q();
  var products = (await pool.query(
    "SELECT max(li.description) AS name, sum(li.qty) AS qty, " +
    "  sum(CASE WHEN li.discount_type = 'percent' THEN li.qty * li.unit_price * (1 - li.discount / 100) ELSE li.qty * li.unit_price - li.discount END) AS amount, " +
    '  count(DISTINCT i.customer_id)::int AS buyers ' +
    "FROM document_line_items li JOIN invoices i ON li.document_type = 'invoice' AND li.document_id = i.id JOIN customers c ON c.id = i.customer_id " +
    'WHERE ' + SALE + ' AND i.issued_at BETWEEN ' + qp.p(period.from) + ' AND ' + qp.p(period.to) + ' AND ' + crm._invoiceScope(co, qp.p) +
    " AND trim(li.description) <> '' GROUP BY lower(trim(li.description)) ORDER BY amount DESC LIMIT 8", qp.args)).rows.map(function (x) {
    return { name: x.name, qty: Number(x.qty), amount: r2(x.amount), buyers: x.buyers };
  });

  // How fast customers get an answer.
  var rNow = await replies(period.from, period.to), rPrev = await replies(prev.from, prev.to);
  var waitingRows = (await pool.query(
    "SELECT v.id, v.channel, v.last_message_at, cu.account_manager_id AS rep_id FROM crm_conversations v LEFT JOIN customers cu ON cu.id = v.customer_id " +
    "WHERE v.status = 'open' AND v.last_direction = 'in'")).rows;
  var channels = {};
  rNow.forEach(function (x) { channels[x.channel] = channels[x.channel] || []; channels[x.channel].push(x); });
  var service = Object.assign(replyStats(rNow), {
    before: replyStats(rPrev),
    waiting: waitingRows.length,
    oldestWaitingHours: waitingRows.length ? Math.round((Date.now() - Math.min.apply(null, waitingRows.map(function (w) { return new Date(w.last_message_at).getTime(); }))) / 3600000) : null,
    channels: Object.keys(channels).map(function (k) { return Object.assign({ channel: k }, replyStats(channels[k])); }).sort(function (a, b) { return b.asked - a.asked; })
  });

  // The team: each rep's numbers side by side.
  var people = {};
  function rep(id) { var k = id || 'none'; people[k] = people[k] || { repId: id || null, name: null, customers: 0, sales: 0, cash: 0, invoices: 0, openQuotes: 0, overdue: 0, waiting: 0, followUpsDue: 0, replies: [] }; return people[k]; }
  var qr = Q();
  (await pool.query(
    'SELECT ' + REP + ' AS rep_id, count(*)::int AS n, sum(i.grand_total - i.credit_total) AS sales ' + FROM_INV +
    'WHERE ' + SALE + ' AND i.issued_at BETWEEN ' + qr.p(period.from) + ' AND ' + qr.p(period.to) + ' AND ' + crm._invoiceScope(co, qr.p) + ' GROUP BY 1', qr.args)).rows
    .forEach(function (x) { var r = rep(x.rep_id); r.sales = r2(x.sales); r.invoices = x.n; });
  var qr2 = Q();
  (await pool.query(
    'SELECT ' + REP + ' AS rep_id, sum(p.amount) AS cash FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id LEFT JOIN sales_orders so ON so.id = i.sales_order_id ' +
    'WHERE ' + SALE + ' AND p.date BETWEEN ' + qr2.p(period.from) + ' AND ' + qr2.p(period.to) + ' AND ' + crm._invoiceScope(co, qr2.p) + ' GROUP BY 1', qr2.args)).rows
    .forEach(function (x) { rep(x.rep_id).cash = r2(x.cash); });
  (await pool.query("SELECT account_manager_id AS rep_id, count(*)::int AS n FROM customers WHERE account_manager_id IS NOT NULL AND coalesce(status, 'active') <> 'inactive' GROUP BY 1")).rows
    .forEach(function (x) { rep(x.rep_id).customers = x.n; });
  owing.forEach(function (o) { if (o.due_date && dateOnly(o.due_date) < today) { var r = rep(o.rep_id); r.overdue = r2(r.overdue + Number(o.balance_due)); } });
  openQuotes.forEach(function (x) { var r = rep(x.rep_id); r.openQuotes = r2(r.openQuotes + Number(x.grand_total)); });
  waitingRows.forEach(function (w) { rep(w.rep_id).waiting++; });
  rNow.forEach(function (x) { if (x.minutes !== null) rep(x.repId).replies.push(x.minutes); });
  (await pool.query('SELECT account_manager_id AS rep_id, count(*)::int AS n FROM customers WHERE account_manager_id IS NOT NULL AND follow_up_on <= CURRENT_DATE GROUP BY 1')).rows
    .forEach(function (x) { rep(x.rep_id).followUpsDue += x.n; });
  (await pool.query('SELECT rep_id, count(*)::int AS n FROM crm_leads WHERE rep_id IS NOT NULL AND stage = ANY($1) AND next_follow_up <= CURRENT_DATE GROUP BY 1', [OPEN_STAGES])).rows
    .forEach(function (x) { rep(x.rep_id).followUpsDue += x.n; });
  var ids = Object.keys(people).filter(function (k) { return k !== 'none'; });
  if (ids.length) {
    (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ANY($1::uuid[])', [ids])).rows
      .forEach(function (e) { people[e.id].name = personName(e.first_name, e.last_name); });
  }
  var team = Object.keys(people).map(function (k) {
    var r = people[k];
    var out = Object.assign({}, r, { replyMedianMinutes: median(r.replies), share: now.sales > 0 ? Math.round(r.sales / now.sales * 100) : 0 });
    delete out.replies;
    return out;
  }).filter(function (r) { return r.repId ? r.name !== null : (r.sales || r.waiting || r.overdue || r.openQuotes); })
    .sort(function (a, b) { return (a.repId ? 0 : 1) - (b.repId ? 0 : 1) || b.sales - a.sales || b.customers - a.customers; });

  var otherCurrency = (await pool.query(
    "SELECT count(*)::int AS n FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.doc_kind = 'sale' AND i.status <> 'void' AND i.currency <> 'GHS' AND i.issued_at BETWEEN $1 AND $2",
    [period.from, period.to])).rows[0].n;

  return {
    period: period, previous: prev, company: co.name,
    now: now, before: before, trend: trend,
    receivables: { owed: owed, overdue: overdue, invoices: owing.length, aging: aging },
    pipeline: pipeline,
    customers: { top: top, topFiveShare: now.sales > 0 ? Math.round(top5 / now.sales * 100) : null, quiet: quiet, quietAfterDays: STALE_BUYER_DAYS },
    products: products,
    service: service,
    team: team,
    otherCurrency: otherCurrency
  };
}

module.exports = { summary: summary };
