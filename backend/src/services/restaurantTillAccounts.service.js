var { pool } = require('../db/pool');

// The till settings' "IOUs and VIP" report: what customers owe and paid
// back — sales on IOU and cash lent on IOU accounts — and the VIP money put
// down, spent and given back, for some days (the last 30 by default).
// Every IOU still owed is listed whatever its date.

var DAY = /^\d{4}-\d{2}-\d{2}$/;
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

async function report(companyId, q) {
  q = q || {};
  var to = DAY.test(q.to || '') ? q.to : new Date().toISOString().slice(0, 10);
  var from = DAY.test(q.from || '') ? q.from : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  var args = [companyId, from, to];
  var IN = function (col) { return '(' + col + ' >= $2::date AND ' + col + " < $3::date + interval '1 day')"; };

  var ious = (await pool.query(
    "SELECT o.id, o.order_no, o.created_at, o.total - o.refunded_total AS owed, o.iou_paid_at, o.iou_paid_method, o.iou_paid_amount, " +
    "g.name AS customer, g.phone, ce.first_name || ' ' || ce.last_name AS cashier, pe.first_name || ' ' || pe.last_name AS paid_by " +
    'FROM restaurant_orders o LEFT JOIN restaurant_guests g ON g.id = o.guest_id LEFT JOIN employees ce ON ce.id = o.cashier_id LEFT JOIN employees pe ON pe.id = o.iou_paid_by ' +
    "WHERE o.company_id = $1 AND o.payment_method = 'iou' AND o.status = 'completed' AND (o.iou_paid_at IS NULL OR " + IN('o.created_at') + ' OR ' + IN('o.iou_paid_at') + ') ' +
    'ORDER BY (o.iou_paid_at IS NULL) DESC, o.created_at DESC LIMIT 500', args)).rows;
  var lent = (await pool.query(
    "SELECT a.id, a.number, a.created_at, a.amount, a.note, a.paid_at, a.paid_method, a.paid_amount, g.name AS customer, g.phone, " +
    "ce.first_name || ' ' || ce.last_name AS cashier, pe.first_name || ' ' || pe.last_name AS paid_by " +
    'FROM restaurant_iou_advances a JOIN restaurant_guests g ON g.id = a.guest_id LEFT JOIN employees ce ON ce.id = a.cashier_id LEFT JOIN employees pe ON pe.id = a.paid_by ' +
    'WHERE a.company_id = $1 AND (a.paid_at IS NULL OR ' + IN('a.created_at') + ' OR ' + IN('a.paid_at') + ') ORDER BY (a.paid_at IS NULL) DESC, a.created_at DESC LIMIT 500', args)).rows;
  var lentSum = (await pool.query(
    'SELECT coalesce(sum(amount) FILTER (WHERE paid_at IS NULL), 0) AS owed, coalesce(sum(paid_amount) FILTER (WHERE ' + IN('paid_at') + '), 0) AS paid, ' +
    'coalesce(sum(amount) FILTER (WHERE ' + IN('created_at') + '), 0) AS lent, count(*) FILTER (WHERE ' + IN('created_at') + ')::int AS lent_n ' +
    'FROM restaurant_iou_advances WHERE company_id = $1', args)).rows[0];
  var owing = (await pool.query(
    "SELECT count(DISTINCT guest_id)::int AS n FROM (SELECT guest_id FROM restaurant_orders WHERE company_id = $1 AND payment_method = 'iou' AND status = 'completed' AND iou_paid_at IS NULL " +
    'UNION SELECT guest_id FROM restaurant_iou_advances WHERE company_id = $1 AND paid_at IS NULL) x', [companyId])).rows[0].n;
  var iouSum = (await pool.query(
    "SELECT coalesce(sum(total - refunded_total) FILTER (WHERE iou_paid_at IS NULL), 0) AS owed, count(DISTINCT guest_id) FILTER (WHERE iou_paid_at IS NULL)::int AS customers, " +
    'coalesce(sum(iou_paid_amount) FILTER (WHERE ' + IN('iou_paid_at') + '), 0) AS paid, count(*) FILTER (WHERE ' + IN('created_at') + ')::int AS sold_n, ' +
    'coalesce(sum(total) FILTER (WHERE ' + IN('created_at') + "), 0) AS sold FROM restaurant_orders WHERE company_id = $1 AND payment_method = 'iou' AND status = 'completed'", args)).rows[0];

  var vip = (await pool.query(
    "SELECT v.id, v.kind, v.amount, v.method, v.created_at, v.note, g.name AS customer, o.order_no, ce.first_name || ' ' || ce.last_name AS cashier " +
    'FROM restaurant_vip_entries v JOIN restaurant_guests g ON g.id = v.guest_id LEFT JOIN restaurant_orders o ON o.id = v.order_id LEFT JOIN employees ce ON ce.id = v.cashier_id ' +
    'WHERE v.company_id = $1 AND ' + IN('v.created_at') + ' ORDER BY v.created_at DESC LIMIT 500', args)).rows;
  var vipSum = (await pool.query(
    "SELECT coalesce(sum(amount) FILTER (WHERE kind = 'topup' AND " + IN('created_at') + '), 0) AS topped, ' +
    "coalesce(-sum(amount) FILTER (WHERE kind = 'sale' AND " + IN('created_at') + '), 0) AS spent, ' +
    "coalesce(sum(amount) FILTER (WHERE kind = 'refund' AND " + IN('created_at') + '), 0) AS back, ' +
    "coalesce(-sum(amount) FILTER (WHERE kind = 'cashout' AND " + IN('created_at') + '), 0) AS cashed_out, ' +
    'coalesce(sum(amount), 0) AS held, count(DISTINCT guest_id)::int AS customers FROM restaurant_vip_entries WHERE company_id = $1', args)).rows[0];

  var now = Date.now();
  return {
    from: from, to: to,
    ious: ious.map(function (r) {
      return {
        id: r.id, orderNo: r.order_no, at: r.created_at, customer: r.customer || null, phone: r.phone || '', owed: round2(r.owed), cashier: r.cashier || null,
        paid: !!r.iou_paid_at, paidAt: r.iou_paid_at, paidMethod: r.iou_paid_method, paidAmount: r.iou_paid_amount == null ? null : round2(r.iou_paid_amount), paidBy: r.paid_by || null,
        days: r.iou_paid_at ? null : Math.floor((now - new Date(r.created_at).getTime()) / 86400000), kind: 'sale'
      };
    }).concat(lent.map(function (r) {
      return {
        id: r.id, orderNo: 'A-' + String(r.number).padStart(4, '0'), at: r.created_at, customer: r.customer, phone: r.phone || '', owed: round2(r.amount), cashier: r.cashier || null,
        paid: !!r.paid_at, paidAt: r.paid_at, paidMethod: r.paid_method, paidAmount: r.paid_amount == null ? null : round2(r.paid_amount), paidBy: r.paid_by || null,
        days: r.paid_at ? null : Math.floor((now - new Date(r.created_at).getTime()) / 86400000), kind: 'advance', note: r.note || ''
      };
    })).sort(function (a, b) { return (a.paid - b.paid) || (new Date(b.at) - new Date(a.at)); }),
    vip: vip.map(function (r) {
      return { id: r.id, kind: r.kind, amount: round2(r.amount), method: r.method, at: r.created_at, note: r.note, customer: r.customer, orderNo: r.order_no || null, cashier: r.cashier || null };
    }),
    totals: {
      owedNow: round2(Number(iouSum.owed) + Number(lentSum.owed)), owingCustomers: owing, iouPaid: round2(Number(iouSum.paid) + Number(lentSum.paid)), iouSold: round2(iouSum.sold), iouSoldCount: iouSum.sold_n,
      iouLent: round2(lentSum.lent), iouLentCount: lentSum.lent_n,
      vipToppedUp: round2(vipSum.topped), vipSpent: round2(vipSum.spent), vipBack: round2(vipSum.back), vipCashedOut: round2(vipSum.cashed_out), vipHeld: round2(vipSum.held), vipCustomers: vipSum.customers
    }
  };
}

module.exports = { report: report };
