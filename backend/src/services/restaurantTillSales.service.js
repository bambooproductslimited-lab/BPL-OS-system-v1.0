var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var money = require('./restaurantTillMoney.service');

// The till settings' sales report (TillSettings.jsx, "Sales"): every sale
// and refund of a day range, newest first, with what a manager reads off
// the day — gross sales, refunds given, net; the money by way of paying,
// by order type, by cashier and by hour; the dishes sold most; dollars and
// yuan taken. A sale counts on the day it was rung up, a refund on the day
// it was given (net = gross − refunds of the same days), as on a Z report.
// Filters: a way of paying, an order type, a cashier, words (order number,
// customer, table), which transactions (sales, refunds, voided, IOU), and
// where a sale was rung up: on this till, or on Square before it (brought
// in by restaurantSquareImport — source 'square'). Up to a year at a time.
// It also counts the guests who sat down, for the spend per guest.

var KINDS = ['all', 'sales', 'refunds', 'voided', 'iou'];
var FULFILLMENTS = ['dine_in', 'togo', 'pickup', 'delivery'];
var DAY = /^\d{4}-\d{2}-\d{2}$/;

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

function datesOf(q) {
  var today = new Date().toISOString().slice(0, 10);
  var from = q.from || today, to = q.to || from;
  if (!DAY.test(from) || !DAY.test(to)) fail('invalid', 'Pick the days for the report.');
  if (to < from) { var x = from; from = to; to = x; }
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) fail('invalid', 'The sales report covers at most a year at a time.');
  return { from: from, to: to };
}

async function report(companyId, q) {
  q = q || {};
  var d = datesOf(q);
  var kind = KINDS.indexOf(q.kind) >= 0 ? q.kind : 'all';
  var args = [companyId, d.from, d.to];
  function arg(v) { args.push(v); return '$' + args.length; }

  // The filters, written for a sale (o) and for a refund (r of sale o).
  var common = [];
  if (FULFILLMENTS.indexOf(q.fulfillment) >= 0) common.push('o.fulfillment = ' + arg(q.fulfillment));
  if (q.source === 'square') common.push("o.source = 'square'");
  else if (q.source === 'till') common.push("o.source <> 'square'");
  if (q.q && String(q.q).trim()) {
    var w = arg('%' + String(q.q).trim().replace(/[%_]/g, '') + '%');
    common.push('(o.order_no ILIKE ' + w + ' OR o.customer_name ILIKE ' + w + ' OR o.ticket_name ILIKE ' + w + ' OR g.name ILIKE ' + w + ' OR t.name ILIKE ' + w + ')');
  }
  var saleWhere = ['o.company_id = $1', 'o.created_at >= $2::date', "o.created_at < $3::date + interval '1 day'"].concat(common);
  var refundWhere = ['r.company_id = $1', 'r.created_at >= $2::date', "r.created_at < $3::date + interval '1 day'"].concat(common);
  if (q.method) {
    var m = arg(String(q.method));
    saleWhere.push('(o.payment_method = ' + m + ' OR EXISTS (SELECT 1 FROM restaurant_order_payments p WHERE p.order_id = o.id AND p.method = ' + m + '))');
    refundWhere.push('r.method = ' + m);
  }
  if (q.cashierId) {
    var c = arg(String(q.cashierId));
    saleWhere.push('o.cashier_id = ' + c);
    refundWhere.push('r.cashier_id = ' + c);
  }
  var JOINS = ' LEFT JOIN restaurant_guests g ON g.id = o.guest_id LEFT JOIN restaurant_tables t ON t.id = o.table_id ';
  var SALES = ' FROM restaurant_orders o' + JOINS + 'WHERE ' + saleWhere.join(' AND ');
  var COMPLETED = SALES + " AND o.status = 'completed'";
  var REFUNDS = ' FROM restaurant_refunds r JOIN restaurant_orders o ON o.id = r.order_id' + JOINS + 'WHERE ' + refundWhere.join(' AND ');

  var head = (await pool.query(
    'SELECT count(*)::int AS n, coalesce(sum(o.total), 0) AS gross, ' +
    "count(*) FILTER (WHERE o.payment_method = 'iou' AND o.iou_paid_at IS NULL)::int AS iou_n, coalesce(sum(o.total - o.refunded_total) FILTER (WHERE o.payment_method = 'iou' AND o.iou_paid_at IS NULL), 0) AS iou_owed, " +
    'count(DISTINCT o.guest_id)::int AS customers, coalesce(sum(o.guests), 0)::int AS guests, coalesce(sum(o.total) FILTER (WHERE o.guests IS NOT NULL), 0) AS guest_sales, ' +
    "count(*) FILTER (WHERE o.source = 'square')::int AS square_n, coalesce(sum(o.total) FILTER (WHERE o.source = 'square'), 0) AS square_amount" + COMPLETED, args)).rows[0];
  var voided = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(o.total), 0) AS amount" + SALES + " AND o.status = 'voided'", args)).rows[0];
  var refunds = (await pool.query('SELECT count(*)::int AS n, coalesce(sum(r.amount), 0) AS amount' + REFUNDS, args)).rows[0];
  var dishes = (await pool.query('SELECT coalesce(sum(i.qty), 0) AS qty FROM restaurant_order_items i WHERE i.order_id IN (SELECT o.id' + COMPLETED + ')', args)).rows[0];

  // The money by way of paying: each part of a split sale under its own way.
  var paid = (await pool.query(
    'SELECT m.method, count(DISTINCT m.order_id)::int AS n, sum(m.amount) AS amount FROM ' + money.ORDER_METHODS_SQL + ' m JOIN restaurant_orders o ON o.id = m.order_id' + JOINS +
    'WHERE ' + saleWhere.join(' AND ') + ' GROUP BY m.method', args)).rows;
  var back = (await pool.query('SELECT r.method, sum(r.amount) AS amount' + REFUNDS + ' GROUP BY r.method', args)).rows;
  var byMethod = {};
  paid.forEach(function (r) { byMethod[r.method] = { method: r.method, sales: r.n, amount: round2(r.amount), refunded: 0 }; });
  back.forEach(function (r) {
    if (!byMethod[r.method]) byMethod[r.method] = { method: r.method, sales: 0, amount: 0, refunded: 0 };
    byMethod[r.method].refunded = round2(r.amount);
  });
  byMethod = Object.keys(byMethod).map(function (k) { var x = byMethod[k]; x.net = round2(x.amount - x.refunded); return x; })
    .sort(function (a, b) { return b.net - a.net; });

  var byFulfillment = (await pool.query(
    "SELECT coalesce(nullif(o.fulfillment, ''), 'other') AS fulfillment, count(*)::int AS n, sum(o.total) AS amount" + COMPLETED + ' GROUP BY 1 ORDER BY 3 DESC', args)).rows
    .map(function (r) { return { fulfillment: r.fulfillment, sales: r.n, amount: round2(r.amount) }; });
  var byCashier = (await pool.query(
    "SELECT o.cashier_id AS id, e.first_name || ' ' || e.last_name AS name, count(*)::int AS n, sum(o.total) AS amount" +
    COMPLETED.replace(' WHERE ', ' LEFT JOIN employees e ON e.id = o.cashier_id WHERE ') + ' GROUP BY 1, 2 ORDER BY 4 DESC', args)).rows
    .map(function (r) { return { id: r.id, name: r.name, sales: r.n, amount: round2(r.amount) }; });
  var byHour = (await pool.query('SELECT extract(hour FROM o.created_at)::int AS h, count(*)::int AS n, sum(o.total) AS amount' + COMPLETED + ' GROUP BY 1 ORDER BY 1', args)).rows
    .map(function (r) { return { hour: r.h, sales: r.n, amount: round2(r.amount) }; });
  // Day by day, or month by month over more than two months.
  var long = (Date.parse(d.to) - Date.parse(d.from)) / 86400000 > 62;
  var byDay = d.from === d.to ? [] : (await pool.query(
    "SELECT to_char(o.created_at, '" + (long ? 'YYYY-MM' : 'YYYY-MM-DD') + "') AS day, count(*)::int AS n, sum(o.total) AS amount" + COMPLETED + ' GROUP BY 1 ORDER BY 1', args)).rows
    .map(function (r) { return { day: r.day, sales: r.n, amount: round2(r.amount) }; });
  var topItems = (await pool.query(
    'SELECT i.name, bool_or(i.custom) AS custom, sum(i.qty) AS qty, sum(i.line_total) AS amount FROM restaurant_order_items i WHERE i.order_id IN (SELECT o.id' + COMPLETED + ') ' +
    'GROUP BY i.name ORDER BY 3 DESC, 4 DESC LIMIT 10', args)).rows
    .map(function (r) { return { name: r.name, custom: r.custom, qty: Number(r.qty), amount: round2(r.amount) }; });
  // Discounts given and dishes on the house (by why), the service charge
  // and the taxes, and the add-ons sold most (migration 0168).
  var extras = (await pool.query(
    'SELECT coalesce(sum(o.discount_total), 0) AS discounts, coalesce(sum(o.service_charge), 0) AS service, coalesce(sum(o.tax_total), 0) AS tax_added, ' +
    "count(*) FILTER (WHERE o.discount_total > 0)::int AS discounted, count(*) FILTER (WHERE (o.adjustments ? 'serviceOff'))::int AS service_off, " +
    'coalesce(sum(o.tip), 0) AS tips, count(*) FILTER (WHERE o.tip > 0)::int AS tipped, coalesce(sum(o.points_earned), 0)::int AS points_given, coalesce(sum(o.points_used), 0)::int AS points_used' + COMPLETED, args)).rows[0];
  // Tips by who served the table (else who rang it up), for sharing them out (migration 0172).
  var tipsBy = (await pool.query(
    "SELECT coalesce(o.waiter_id, o.cashier_id) AS id, e.first_name || ' ' || e.last_name AS name, count(*)::int AS n, sum(o.tip) AS amount" +
    COMPLETED.replace(' WHERE ', ' LEFT JOIN employees e ON e.id = coalesce(o.waiter_id, o.cashier_id) WHERE ') + ' AND o.tip > 0 GROUP BY 1, 2 ORDER BY 4 DESC', args)).rows
    .map(function (r) { return { id: r.id, name: r.name, sales: r.n, amount: round2(r.amount) }; });
  var comps = (await pool.query(
    'SELECT i.comp_reason AS reason, sum(i.qty) AS qty, sum(i.discount) AS amount FROM restaurant_order_items i WHERE i.comp_reason IS NOT NULL AND i.order_id IN (SELECT o.id' + COMPLETED + ') ' +
    'GROUP BY 1 ORDER BY 3 DESC', args)).rows.map(function (r) { return { reason: r.reason, qty: Number(r.qty), amount: round2(r.amount) }; });
  var discountsBy = (await pool.query(
    'SELECT i.discount_name AS name, count(DISTINCT i.order_id)::int AS n, sum(i.discount) AS amount FROM restaurant_order_items i ' +
    'WHERE i.discount > 0 AND i.comp_reason IS NULL AND i.order_id IN (SELECT o.id' + COMPLETED + ') GROUP BY 1 ORDER BY 3 DESC LIMIT 10', args)).rows
    .map(function (r) { return { name: r.name || 'Discount', sales: r.n, amount: round2(r.amount) }; });
  var taxes = (await pool.query(
    "SELECT tx->>'name' AS name, bool_or((tx->>'included')::boolean) AS included, sum((tx->>'amount')::numeric) AS amount FROM restaurant_orders o" + JOINS +
    ", jsonb_array_elements(o.taxes) tx WHERE " + saleWhere.join(' AND ') + " AND o.status = 'completed' GROUP BY 1 ORDER BY 3 DESC", args)).rows
    .map(function (r) { return { name: r.name, included: !!r.included, amount: round2(r.amount) }; });
  var addOns = (await pool.query(
    "SELECT m->>'name' AS name, m->>'how' AS how, sum(i.qty) AS qty, sum(i.qty * (m->>'price')::numeric) AS amount FROM restaurant_order_items i, jsonb_array_elements(i.modifiers) m " +
    'WHERE i.order_id IN (SELECT o.id' + COMPLETED + ") GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10", args)).rows
    .map(function (r) { return { name: r.name, how: r.how || 'add', qty: Number(r.qty), amount: round2(r.amount) }; });
  var foreign = (await pool.query(
    "SELECT p.currency, sum(p.foreign_amount) AS foreign_amount, sum(p.amount) AS cedis, count(*)::int AS n FROM restaurant_order_payments p WHERE p.currency <> 'GHS' AND p.order_id IN (SELECT o.id" + COMPLETED + ') GROUP BY 1 ORDER BY 1', args)).rows
    .map(function (r) { return { currency: r.currency, amount: round2(r.foreign_amount), cedis: round2(r.cedis), parts: r.n }; });
  var staff = (await pool.query(
    "SELECT DISTINCT e.id, e.first_name || ' ' || e.last_name AS name FROM restaurant_orders o JOIN employees e ON e.id = o.cashier_id WHERE o.company_id = $1 AND o.created_at > now() - interval '120 days' ORDER BY 2",
    [companyId])).rows;

  // The transactions, a page at a time.
  var limit = Math.min(Math.max(Number(q.limit) || 50, 1), 2000);
  var offset = Math.max(Number(q.offset) || 0, 0);
  var parts = [];
  if (kind === 'all' || kind === 'sales' || kind === 'iou' || kind === 'voided') {
    var only = kind === 'sales' ? " AND o.status = 'completed'" : kind === 'voided' ? " AND o.status = 'voided'" : kind === 'iou' ? " AND o.status = 'completed' AND o.payment_method = 'iou'" : '';
    parts.push("SELECT 'sale' AS kind, o.id, o.created_at AS at" + SALES + only);
  }
  if (kind === 'all' || kind === 'refunds') parts.push("SELECT 'refund' AS kind, r.id, r.created_at AS at" + REFUNDS);
  var page = (await pool.query('SELECT * FROM (' + parts.join(' UNION ALL ') + ') x ORDER BY at DESC, id DESC LIMIT ' + (limit + 1) + ' OFFSET ' + offset, args)).rows;
  var more = page.length > limit;
  page = page.slice(0, limit);
  var rows = await rowsOf(page);

  var gross = round2(head.gross), refunded = round2(refunds.amount);
  return {
    from: d.from, to: d.to,
    totals: {
      sales: head.n, gross: gross, refunds: refunds.n, refunded: refunded, net: round2(gross - refunded),
      average: head.n ? round2(gross / head.n) : 0, dishes: Number(dishes.qty), customers: head.customers,
      voided: voided.n, voidedAmount: round2(voided.amount), iouOpen: head.iou_n, iouOwed: round2(head.iou_owed),
      discounts: round2(extras.discounts), discounted: extras.discounted, serviceCharge: round2(extras.service), serviceOff: extras.service_off, taxAdded: round2(extras.tax_added),
      guests: head.guests, perGuest: head.guests ? round2(head.guest_sales / head.guests) : 0, fromSquare: { sales: head.square_n, amount: round2(head.square_amount) },
      tips: round2(extras.tips), tipped: extras.tipped, pointsGiven: extras.points_given, pointsUsed: extras.points_used
    },
    tipsBy: tipsBy, comps: comps, discountsBy: discountsBy, taxes: taxes, addOns: addOns,
    byMethod: byMethod, byFulfillment: byFulfillment, byCashier: byCashier, byHour: byHour, byDay: byDay, topItems: topItems, foreign: foreign,
    rows: rows, more: more, staff: staff, byMonth: long
  };
}

// Each transaction of the page as the report lists it: the sale with its
// dishes and how it was paid, or the refund with what was given back.
async function rowsOf(page) {
  var saleIds = page.filter(function (r) { return r.kind === 'sale'; }).map(function (r) { return r.id; });
  var refundIds = page.filter(function (r) { return r.kind === 'refund'; }).map(function (r) { return r.id; });
  var sales = new Map(), refunds = new Map(), items = new Map(), refundItems = new Map();
  if (saleIds.length) {
    (await pool.query(
      "SELECT o.*, g.name AS guest_name, t.name AS table_name, c.first_name || ' ' || c.last_name AS cashier_name, w.first_name || ' ' || w.last_name AS waiter_name " +
      'FROM restaurant_orders o LEFT JOIN restaurant_guests g ON g.id = o.guest_id LEFT JOIN restaurant_tables t ON t.id = o.table_id ' +
      'LEFT JOIN employees c ON c.id = o.cashier_id LEFT JOIN employees w ON w.id = o.waiter_id WHERE o.id = ANY($1::uuid[])', [saleIds])).rows
      .forEach(function (o) { sales.set(o.id, o); });
    (await pool.query('SELECT order_id, name, qty, line_total, note, custom FROM restaurant_order_items WHERE order_id = ANY($1::uuid[]) ORDER BY sort_order, name', [saleIds])).rows
      .forEach(function (i) {
        if (!items.has(i.order_id)) items.set(i.order_id, []);
        items.get(i.order_id).push({ name: i.name, qty: Number(i.qty), lineTotal: round2(i.line_total), note: i.note || '', custom: i.custom });
      });
  }
  var payments = await money.paymentsOf(pool, saleIds);
  if (refundIds.length) {
    (await pool.query(
      "SELECT r.*, o.order_no, o.fulfillment, g.name AS guest_name, o.customer_name, t.name AS table_name, c.first_name || ' ' || c.last_name AS cashier_name, a.first_name || ' ' || a.last_name AS approver_name " +
      'FROM restaurant_refunds r JOIN restaurant_orders o ON o.id = r.order_id LEFT JOIN restaurant_guests g ON g.id = o.guest_id LEFT JOIN restaurant_tables t ON t.id = o.table_id ' +
      'LEFT JOIN employees c ON c.id = r.cashier_id LEFT JOIN employees a ON a.id = r.approved_by WHERE r.id = ANY($1::uuid[])', [refundIds])).rows
      .forEach(function (r) { refunds.set(r.id, r); });
    (await pool.query('SELECT refund_id, name, qty, amount FROM restaurant_refund_items WHERE refund_id = ANY($1::uuid[]) ORDER BY name', [refundIds])).rows
      .forEach(function (i) {
        if (!refundItems.has(i.refund_id)) refundItems.set(i.refund_id, []);
        refundItems.get(i.refund_id).push({ name: i.name, qty: Number(i.qty), lineTotal: round2(i.amount) });
      });
  }
  return page.map(function (p) {
    if (p.kind === 'sale') {
      var o = sales.get(p.id);
      var parts = payments.get(o.id) || [{ method: o.payment_method, amount: round2(o.total), currency: 'GHS', rate: 1, foreignAmount: null, tendered: null, changeGiven: 0 }];
      return {
        kind: 'sale', id: o.id, at: o.created_at, orderNo: o.order_no, status: o.status, source: o.source, sourceName: o.source_name || '', guests: o.guests || null, fulfillment: o.fulfillment || '',
        table: o.table_name || null, customer: o.guest_name || o.customer_name || o.ticket_name || null, deliveryAddress: o.delivery_address || '',
        cashier: o.cashier_name || null, waiter: o.waiter_name || null, total: round2(o.total), refunded: round2(o.refunded_total),
        method: o.payment_method, payments: parts, items: items.get(o.id) || [],
        iou: o.payment_method === 'iou' ? { paid: !!o.iou_paid_at, paidAt: o.iou_paid_at, method: o.iou_paid_method } : null
      };
    }
    var r = refunds.get(p.id);
    return {
      kind: 'refund', id: r.id, at: r.created_at, orderNo: r.order_no, fulfillment: r.fulfillment || '', table: r.table_name || null, customer: r.guest_name || r.customer_name || null,
      cashier: r.cashier_name || null, approvedBy: r.approver_name || null, total: -round2(r.amount), method: r.method, reason: r.reason, items: refundItems.get(r.id) || []
    };
  });
}

module.exports = { KINDS: KINDS, report: report };
