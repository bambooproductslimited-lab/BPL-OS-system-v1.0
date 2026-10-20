var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var access = require('./restaurantTillAccess.service');

// The till's money beyond a plain sale (migration 0153):
//
//   VIP     a guest puts money down at the till (a top-up, cash or Mobile
//           Money) and later sales are paid from it. The balance is the
//           sum of the guest's entries, never stored, so it cannot drift.
//   IOU     a sale a named guest owes; paid later at the till, in cash or
//           Mobile Money, by whoever is on the till that day.
//   Refund  some or all of a sale's dishes given back, with a reason and a
//           manager's PIN: cash from the drawer, Mobile Money, back to the
//           VIP balance, or off an unpaid IOU.
//
// Cash that comes in or goes out this way belongs to the drawer of the
// cashier who handled it (drawerCash, for restaurantPos.buildReport).

// What the till takes for a sale (Other: paid some other way, outside the
// drawer; the till's settings choose which it offers), and how money
// changes hands otherwise.
var TILL_METHODS = access.TILL_METHODS;
var MONEY = ['cash', 'mobile_money'];

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function fullName(r, prefix) { return r[prefix + '_first'] ? r[prefix + '_first'] + ' ' + r[prefix + '_last'] : null; }

async function openDrawer(client, cashierId) {
  return (await client.query("SELECT id FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [cashierId])).rows[0] || null;
}
async function needDrawerForCash(client, cashierId, method, what) {
  if (method === 'cash' && !(await openDrawer(client, cashierId))) fail('conflict', 'Open your cash drawer first: ' + what);
}

// ── VIP balances ───────────────────────────────────────────────────────

async function lockGuest(client, guestId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('vip:' || $1))", [guestId]);
}
async function balanceOf(db, guestId) {
  return round2((await db.query('SELECT coalesce(sum(amount), 0) AS b FROM restaurant_vip_entries WHERE guest_id = $1', [guestId])).rows[0].b);
}
async function guestOf(db, companyId, guestId) {
  var g = (await db.query('SELECT id, name, phone FROM restaurant_guests WHERE id = $1 AND company_id = $2', [guestId, companyId])).rows[0];
  if (!g) fail('notfound', 'That guest is no longer available.');
  return g;
}

// Called by restaurantPos.createOrder inside its transaction, once the
// sale is saved: a VIP sale is paid from the guest's balance (which must
// cover it); an IOU needs to know who owes it.
async function chargeSale(client, companyId, order, cashierId) {
  if (order.payment_method !== 'vip' && order.payment_method !== 'iou') return null;
  if (!order.guest_id) {
    fail('invalid', order.payment_method === 'vip'
      ? 'A VIP sale is paid from a guest\'s balance: pick the guest first.'
      : 'An IOU needs the name of the guest who owes it: pick or add the guest first.');
  }
  if (order.payment_method === 'iou') return null;
  await lockGuest(client, order.guest_id);
  var balance = await balanceOf(client, order.guest_id);
  var total = round2(order.total);
  if (balance < total) {
    var g = await guestOf(client, companyId, order.guest_id);
    fail('invalid', g.name + ' has ' + balance.toFixed(2) + ' on their VIP balance and this sale is ' + total.toFixed(2) + '. Top it up first.');
  }
  await client.query(
    "INSERT INTO restaurant_vip_entries (company_id, guest_id, kind, amount, order_id, cashier_id) VALUES ($1,$2,'sale',$3,$4,$5)",
    [companyId, order.guest_id, -total, order.id, cashierId]);
  return { balance: round2(balance - total) };
}

// Guests with VIP money (or a search for any guest, to top up a new one).
async function vipGuests(token, q) {
  var session = await access.need(token, 'till');
  var args = [session.posCompanyId];
  var where = 'g.company_id = $1';
  if (q && String(q).trim()) { args.push('%' + String(q).trim() + '%'); where += ' AND (g.name ILIKE $2 OR g.phone ILIKE $2)'; }
  else where += ' AND v.guest_id IS NOT NULL';
  var rows = (await pool.query(
    'SELECT g.id, g.name, g.phone, coalesce(v.balance, 0) AS balance, v.last_at, v.topped_up FROM restaurant_guests g ' +
    'LEFT JOIN (SELECT guest_id, sum(amount) AS balance, max(created_at) AS last_at, ' +
    "  coalesce(sum(amount) FILTER (WHERE kind = 'topup'), 0) AS topped_up FROM restaurant_vip_entries WHERE company_id = $1 GROUP BY guest_id) v ON v.guest_id = g.id " +
    'WHERE ' + where + ' ORDER BY coalesce(v.balance, 0) DESC, g.name LIMIT 60', args)).rows;
  return rows.map(function (r) {
    return { id: r.id, name: r.name, phone: r.phone, balance: round2(r.balance), toppedUp: round2(r.topped_up || 0), lastAt: r.last_at || null };
  });
}

async function vipGuest(token, guestId) {
  var session = await access.need(token, 'till');
  var g = await guestOf(pool, session.posCompanyId, guestId);
  var entries = (await pool.query(
    "SELECT v.*, o.order_no, e.first_name AS by_first, e.last_name AS by_last FROM restaurant_vip_entries v LEFT JOIN restaurant_orders o ON o.id = v.order_id " +
    'LEFT JOIN employees e ON e.id = v.cashier_id WHERE v.guest_id = $1 ORDER BY v.created_at DESC LIMIT 25', [g.id])).rows;
  return {
    guest: { id: g.id, name: g.name, phone: g.phone }, balance: await balanceOf(pool, g.id),
    entries: entries.map(function (r) {
      return { id: r.id, kind: r.kind, amount: round2(r.amount), method: r.method, orderNo: r.order_no || null, note: r.note, by: fullName(r, 'by'), createdAt: r.created_at };
    })
  };
}

async function vipTopUp(token, p) {
  var session = await access.need(token, 'vipTopUp');
  var amount = round2(p.amount);
  if (!(amount > 0)) fail('invalid', 'Enter an amount greater than zero.');
  var method = V.oneOf(p.method, MONEY, 'Paid with');
  return withTransaction(async function (client) {
    var g = await guestOf(client, session.posCompanyId, p.guestId);
    await needDrawerForCash(client, session.posEmployeeId, method, 'the cash goes into it.');
    await lockGuest(client, g.id);
    await client.query(
      "INSERT INTO restaurant_vip_entries (company_id, guest_id, kind, amount, method, cashier_id, note) VALUES ($1,$2,'topup',$3,$4,$5,$6)",
      [session.posCompanyId, g.id, amount, method, session.posEmployeeId, String(p.note || '').trim().slice(0, 200)]);
    return { guest: { id: g.id, name: g.name, phone: g.phone }, amount: amount, method: method, balance: await balanceOf(client, g.id) };
  });
}

// ── IOUs ───────────────────────────────────────────────────────────────

var IOU_SELECT =
  'SELECT o.*, g.name AS guest_name, g.phone AS guest_phone, t.name AS table_name, ' +
  '  ce.first_name AS cashier_first, ce.last_name AS cashier_last, pe.first_name AS paid_first, pe.last_name AS paid_last, ' +
  '  (SELECT coalesce(string_agg(trim(to_char(i.qty, \'FM999990.##\')) || \'× \' || i.name, \', \' ORDER BY i.name), \'\') FROM restaurant_order_items i WHERE i.order_id = o.id) AS dishes ' +
  'FROM restaurant_orders o LEFT JOIN restaurant_guests g ON g.id = o.guest_id LEFT JOIN restaurant_tables t ON t.id = o.table_id ' +
  'LEFT JOIN employees ce ON ce.id = o.cashier_id LEFT JOIN employees pe ON pe.id = o.iou_paid_by ';

function iouOut(r) {
  return {
    id: r.id, orderNo: r.order_no, total: round2(r.total), refunded: round2(r.refunded_total), owed: round2(Number(r.total) - Number(r.refunded_total)),
    guestName: r.guest_name || null, guestPhone: r.guest_phone || null, tableName: r.table_name || null, dishes: r.dishes || '',
    cashierName: fullName(r, 'cashier'), createdAt: r.created_at,
    paidAt: r.iou_paid_at || null, paidMethod: r.iou_paid_method || null, paidAmount: r.iou_paid_amount == null ? null : round2(r.iou_paid_amount), paidBy: fullName(r, 'paid')
  };
}

// What is still owed at this restaurant, oldest first, and what was paid
// today.
async function iouList(token, q) {
  var session = await access.need(token, 'iouPaid');
  var args = [session.posCompanyId];
  var search = '';
  if (q && String(q).trim()) { args.push('%' + String(q).trim() + '%'); search = ' AND (g.name ILIKE $2 OR g.phone ILIKE $2 OR o.order_no ILIKE $2)'; }
  var open = (await pool.query(IOU_SELECT +
    "WHERE o.company_id = $1 AND o.payment_method = 'iou' AND o.status = 'completed' AND o.iou_paid_at IS NULL" + search + ' ORDER BY o.created_at LIMIT 200', args)).rows;
  var paid = (await pool.query(IOU_SELECT +
    "WHERE o.company_id = $1 AND o.payment_method = 'iou' AND o.iou_paid_at >= date_trunc('day', now())" + search + ' ORDER BY o.iou_paid_at DESC LIMIT 30', args)).rows;
  var list = open.map(iouOut);
  return { open: list, owed: round2(list.reduce(function (s, x) { return s + x.owed; }, 0)), paidToday: paid.map(iouOut) };
}

async function payIou(token, orderId, p) {
  var session = await access.need(token, 'iouPaid');
  var method = V.oneOf(p && p.method, MONEY, 'Paid with');
  return withTransaction(async function (client) {
    var o = (await client.query('SELECT * FROM restaurant_orders WHERE id = $1 AND company_id = $2 FOR UPDATE', [orderId, session.posCompanyId])).rows[0];
    if (!o || o.payment_method !== 'iou') fail('notfound', 'IOU not found.');
    if (o.status !== 'completed') fail('conflict', 'That sale was voided: nothing is owed.');
    if (o.iou_paid_at) fail('conflict', 'That IOU has already been paid.');
    await needDrawerForCash(client, session.posEmployeeId, method, 'the cash goes into it.');
    var owed = round2(Number(o.total) - Number(o.refunded_total));
    await client.query('UPDATE restaurant_orders SET iou_paid_at = now(), iou_paid_method = $2, iou_paid_by = $3, iou_paid_amount = $4 WHERE id = $1',
      [o.id, method, session.posEmployeeId, owed]);
    return iouOut((await client.query(IOU_SELECT + 'WHERE o.id = $1', [o.id])).rows[0]);
  });
}

// ── refunds ────────────────────────────────────────────────────────────

// How a sale's refund can go back: the way it was paid where money can go
// back that way, to the VIP balance, or off what is still owed.
function refundMethodsFor(o) {
  if (o.payment_method === 'vip') return ['vip'];
  if (o.payment_method === 'iou') return o.iou_paid_at ? MONEY : ['iou'];
  return o.payment_method === 'mobile_money' ? ['mobile_money', 'cash'] : ['cash', 'mobile_money'];
}

// This restaurant's sales to refund from: a search (number, table, guest)
// or today's and yesterday's, newest first.
async function salesToRefund(token, q) {
  var session = await access.need(token, 'refund');
  var args = [session.posCompanyId];
  var where = "o.company_id = $1 AND o.status = 'completed'";
  if (q && String(q).trim()) {
    args.push('%' + String(q).trim() + '%');
    where += ' AND (o.order_no ILIKE $2 OR t.name ILIKE $2 OR g.name ILIKE $2)';
  } else where += " AND o.created_at >= date_trunc('day', now()) - interval '1 day'";
  var rows = (await pool.query(
    'SELECT o.id, o.order_no, o.total, o.refunded_total, o.payment_method, o.created_at, t.name AS table_name, g.name AS guest_name, ' +
    '  ce.first_name AS cashier_first, ce.last_name AS cashier_last, (SELECT sum(qty) FROM restaurant_order_items i WHERE i.order_id = o.id) AS items ' +
    'FROM restaurant_orders o LEFT JOIN restaurant_tables t ON t.id = o.table_id LEFT JOIN restaurant_guests g ON g.id = o.guest_id ' +
    'LEFT JOIN employees ce ON ce.id = o.cashier_id WHERE ' + where + ' ORDER BY o.created_at DESC LIMIT 40', args)).rows;
  return rows.map(function (r) {
    return {
      id: r.id, orderNo: r.order_no, total: round2(r.total), refunded: round2(r.refunded_total), paymentMethod: r.payment_method,
      createdAt: r.created_at, tableName: r.table_name || null, guestName: r.guest_name || null, cashierName: fullName(r, 'cashier'), items: Number(r.items || 0)
    };
  });
}

async function refundsOf(db, orderId) {
  var refunds = (await db.query(
    'SELECT r.*, ce.first_name AS cashier_first, ce.last_name AS cashier_last, ae.first_name AS approver_first, ae.last_name AS approver_last ' +
    'FROM restaurant_refunds r JOIN employees ce ON ce.id = r.cashier_id JOIN employees ae ON ae.id = r.approved_by WHERE r.order_id = $1 ORDER BY r.created_at', [orderId])).rows;
  if (!refunds.length) return [];
  var items = (await db.query('SELECT * FROM restaurant_refund_items WHERE refund_id = ANY($1::uuid[]) ORDER BY name', [refunds.map(function (r) { return r.id; })])).rows;
  return refunds.map(function (r) {
    return {
      id: r.id, amount: round2(r.amount), method: r.method, reason: r.reason, createdAt: r.created_at,
      cashierName: fullName(r, 'cashier'), approvedByName: fullName(r, 'approver'),
      items: items.filter(function (i) { return i.refund_id === r.id; }).map(function (i) { return { name: i.name, qty: Number(i.qty), amount: round2(i.amount) }; })
    };
  });
}

async function saleForRefund(db, companyId, orderId) {
  var o = (await db.query(
    'SELECT o.*, t.name AS table_name, g.name AS guest_name, ce.first_name AS cashier_first, ce.last_name AS cashier_last FROM restaurant_orders o ' +
    'LEFT JOIN restaurant_tables t ON t.id = o.table_id LEFT JOIN restaurant_guests g ON g.id = o.guest_id LEFT JOIN employees ce ON ce.id = o.cashier_id ' +
    'WHERE o.id = $1 AND o.company_id = $2', [orderId, companyId])).rows[0];
  if (!o) fail('notfound', 'Sale not found.');
  var items = (await db.query(
    'SELECT i.id, i.name, i.qty, i.unit_price, i.line_total, coalesce((SELECT sum(ri.qty) FROM restaurant_refund_items ri WHERE ri.order_item_id = i.id), 0) AS refunded_qty ' +
    'FROM restaurant_order_items i WHERE i.order_id = $1 ORDER BY i.name', [o.id])).rows;
  return {
    order: o,
    out: {
      id: o.id, orderNo: o.order_no, status: o.status, total: round2(o.total), refunded: round2(o.refunded_total), paymentMethod: o.payment_method,
      createdAt: o.created_at, tableName: o.table_name || null, guestName: o.guest_name || null, cashierName: fullName(o, 'cashier'),
      iouPaid: !!o.iou_paid_at, methods: refundMethodsFor(o),
      items: items.map(function (i) {
        return { id: i.id, name: i.name, qty: Number(i.qty), unitPrice: round2(i.unit_price), lineTotal: round2(i.line_total), refundedQty: Number(i.refunded_qty) };
      }),
      refunds: await refundsOf(db, o.id)
    }
  };
}

async function saleForRefundSession(token, orderId) {
  var session = await access.need(token, 'refund');
  return (await saleForRefund(pool, session.posCompanyId, orderId)).out;
}

async function refundSale(token, orderId, p, ip) {
  var session = await access.need(token, 'refund');
  p = p || {};
  var reason = String(p.reason || '').trim();
  if (reason.length < 3) fail('invalid', 'Say why the sale is refunded.');
  var wanted = Array.isArray(p.items) ? p.items : [];
  if (!wanted.length) fail('invalid', 'Pick what to refund.');
  // Approved with the PIN of someone whose till role may approve refunds,
  // or whose OS account may manage restaurants.
  var manager = await access.refundApprover(session.posCompanyId, p.managerPin, ip);

  return withTransaction(async function (client) {
    var o = (await client.query('SELECT * FROM restaurant_orders WHERE id = $1 AND company_id = $2 FOR UPDATE', [orderId, session.posCompanyId])).rows[0];
    if (!o) fail('notfound', 'Sale not found.');
    if (o.status !== 'completed') fail('conflict', 'That sale was voided: there is nothing to refund.');
    var methods = refundMethodsFor(o);
    var method = p.method || methods[0];
    if (methods.indexOf(method) < 0) fail('invalid', 'This sale cannot be refunded that way.');
    if (method === 'vip' && !o.guest_id) fail('invalid', 'This VIP sale has no guest to give the money back to.');
    await needDrawerForCash(client, session.posEmployeeId, method, 'the cash comes out of it.');

    var items = (await client.query(
      'SELECT i.*, coalesce((SELECT sum(ri.qty) FROM restaurant_refund_items ri WHERE ri.order_item_id = i.id), 0) AS refunded_qty FROM restaurant_order_items i WHERE i.order_id = $1',
      [o.id])).rows;
    var lines = [];
    wanted.forEach(function (w) {
      var it = items.find(function (i) { return i.id === w.id; });
      if (!it) fail('invalid', 'One of the dishes is not on this sale.');
      var qty = round2(w.qty);
      if (!(qty > 0)) return;
      var left = round2(Number(it.qty) - Number(it.refunded_qty));
      if (qty > left) fail('invalid', left > 0 ? 'Only ' + left + ' × ' + it.name + ' is left to refund.' : it.name + ' has already been refunded.');
      lines.push({ item: it, qty: qty, amount: round2(Number(it.line_total) * qty / Number(it.qty)) });
    });
    if (!lines.length) fail('invalid', 'Pick what to refund.');
    var amount = round2(lines.reduce(function (s, l) { return s + l.amount; }, 0));
    var left = round2(Number(o.total) - Number(o.refunded_total));
    if (amount > left) amount = left;
    if (!(amount > 0)) fail('invalid', 'Nothing is left to refund on this sale.');

    var refund = (await client.query(
      'INSERT INTO restaurant_refunds (company_id, order_id, amount, method, reason, cashier_id, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [o.company_id, o.id, amount, method, reason.slice(0, 300), session.posEmployeeId, manager.id])).rows[0];
    for (var j = 0; j < lines.length; j++) {
      await client.query('INSERT INTO restaurant_refund_items (refund_id, order_item_id, name, qty, amount) VALUES ($1,$2,$3,$4,$5)',
        [refund.id, lines[j].item.id, lines[j].item.name, lines[j].qty, lines[j].amount]);
    }
    await client.query('UPDATE restaurant_orders SET refunded_total = refunded_total + $2 WHERE id = $1', [o.id, amount]);
    if (method === 'vip') {
      await lockGuest(client, o.guest_id);
      await client.query("INSERT INTO restaurant_vip_entries (company_id, guest_id, kind, amount, order_id, refund_id, cashier_id) VALUES ($1,$2,'refund',$3,$4,$5,$6)",
        [o.company_id, o.guest_id, amount, o.id, refund.id, session.posEmployeeId]);
    }
    // Refunded off an IOU down to nothing: nothing is owed any more.
    if (method === 'iou' && round2(left - amount) <= 0) {
      await client.query('UPDATE restaurant_orders SET iou_paid_at = now(), iou_paid_amount = 0, iou_paid_by = $2 WHERE id = $1', [o.id, session.posEmployeeId]);
    }
    var sale = (await saleForRefund(client, session.posCompanyId, o.id)).out;
    return { refund: sale.refunds.find(function (r) { return r.id === refund.id; }), sale: sale };
  });
}

// A voided VIP sale never happened: what is left of it goes back to the
// guest's balance (restaurantPos.voidOrder, in its transaction).
async function onVoid(client, o) {
  if (o.payment_method !== 'vip' || !o.guest_id) return;
  var back = round2(Number(o.total) - Number(o.refunded_total));
  if (!(back > 0)) return;
  await lockGuest(client, o.guest_id);
  await client.query("INSERT INTO restaurant_vip_entries (company_id, guest_id, kind, amount, order_id, note) VALUES ($1,$2,'refund',$3,$4,'Sale voided')",
    [o.company_id, o.guest_id, back, o.id]);
}

// ── for the drawer and the shift ───────────────────────────────────────

// Cash this cashier took in or paid out between two times besides cash
// sales: refunds paid in cash, IOUs paid in cash, VIP top-ups in cash.
async function drawerCash(db, cashierId, companyId, from, to) {
  var r = (await db.query(
    "SELECT (SELECT coalesce(sum(amount), 0) FROM restaurant_refunds WHERE cashier_id = $1 AND company_id = $2 AND method = 'cash' AND created_at >= $3 AND created_at <= $4) AS refunds, " +
    "(SELECT coalesce(sum(iou_paid_amount), 0) FROM restaurant_orders WHERE iou_paid_by = $1 AND company_id = $2 AND iou_paid_method = 'cash' AND iou_paid_at >= $3 AND iou_paid_at <= $4) AS iou_paid, " +
    "(SELECT coalesce(sum(amount), 0) FROM restaurant_vip_entries WHERE cashier_id = $1 AND company_id = $2 AND kind = 'topup' AND method = 'cash' AND created_at >= $3 AND created_at <= $4) AS vip_topups",
    [cashierId, companyId, from, to])).rows[0];
  return { refunds: round2(r.refunds), iouPaid: round2(r.iou_paid), vipTopUps: round2(r.vip_topups) };
}

// The same, every way it was paid, for the shift summary.
async function shiftMoney(cashierId, companyId, from) {
  var refunds = (await pool.query(
    'SELECT method, count(*)::int AS n, sum(amount) AS total FROM restaurant_refunds WHERE cashier_id = $1 AND company_id = $2 AND created_at >= $3 GROUP BY method',
    [cashierId, companyId, from])).rows;
  var ious = (await pool.query(
    "SELECT iou_paid_method AS method, count(*)::int AS n, sum(iou_paid_amount) AS total FROM restaurant_orders WHERE iou_paid_by = $1 AND company_id = $2 AND iou_paid_at >= $3 AND iou_paid_method IS NOT NULL GROUP BY 1",
    [cashierId, companyId, from])).rows;
  var topups = (await pool.query(
    "SELECT method, count(*)::int AS n, sum(amount) AS total FROM restaurant_vip_entries WHERE cashier_id = $1 AND company_id = $2 AND kind = 'topup' AND created_at >= $3 GROUP BY method",
    [cashierId, companyId, from])).rows;
  function rows(list) { return list.map(function (r) { return { method: r.method, count: r.n, total: round2(r.total) }; }); }
  function sum(list) { return round2(list.reduce(function (s, r) { return s + Number(r.total); }, 0)); }
  return {
    refunds: { total: sum(refunds), count: refunds.reduce(function (s, r) { return s + r.n; }, 0), byMethod: rows(refunds) },
    iouPaid: { total: sum(ious), count: ious.reduce(function (s, r) { return s + r.n; }, 0), byMethod: rows(ious) },
    vipTopUps: { total: sum(topups), count: topups.reduce(function (s, r) { return s + r.n; }, 0), byMethod: rows(topups) }
  };
}

module.exports = {
  TILL_METHODS: TILL_METHODS,
  chargeSale: chargeSale, vipGuests: vipGuests, vipGuest: vipGuest, vipTopUp: vipTopUp,
  iouList: iouList, payIou: payIou,
  salesToRefund: salesToRefund, saleForRefund: saleForRefundSession, refundSale: refundSale, refundsOf: refundsOf, onVoid: onVoid,
  drawerCash: drawerCash, shiftMoney: shiftMoney
};
