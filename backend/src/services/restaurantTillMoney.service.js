var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

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
// Paying in and out of the drawer for a customer's account (migration
// 0165, the till's Pay in / Pay out): in, VIP money put down or IOUs paid
// back; out, VIP money given back in cash (a manager's PIN) or cash lent on
// the IOU account (an advance, owed like an unpaid sale, within the limit).
//
// Cash that comes in or goes out this way belongs to the drawer of the
// cashier who handled it (drawerCash, for restaurantPos.buildReport).
//
// A sale is paid one way or several (a split bill), each part in cedis or
// in US dollars / Chinese yuan at the manager's rate (migration 0157,
// restaurant_order_payments: planPayments below). VIP takes its part from
// the customer's VIP account; an IOU is for the whole bill and needs a
// customer whose IOU account allows it.

// What the till takes for a sale (the till's settings choose which it
// offers), and how money changes hands otherwise.
var TILL_METHODS = access.TILL_METHODS;
// The money each way of paying is taken in: Alipay and WeChat Pay in RMB
// only, Mobile Money in cedis only, cash in cedis or US dollars; VIP and IOU
// are accounts kept in cedis.
var METHOD_CURRENCIES = { cash: ['GHS', 'USD'], mobile_money: ['GHS'], alipay: ['CNY'], wechat: ['CNY'], vip: ['GHS'], iou: ['GHS'] };
var PAID_IN = { cash: 'Cash is taken in cedis or US dollars.', mobile_money: 'Mobile Money is paid in cedis only.', alipay: 'Alipay is paid in RMB only.',
  wechat: 'WeChat Pay is paid in RMB only.', vip: 'VIP is in cedis.', iou: 'An IOU is in cedis.' };
var MONEY = ['cash', 'mobile_money'];
var CURRENCY_NAME = { GHS: 'GHS', USD: 'USD', CNY: 'RMB' };
var METHOD_NAME = { cash: 'cash', mobile_money: 'Mobile Money', alipay: 'Alipay', wechat: 'WeChat Pay', vip: 'VIP', iou: 'IOU', other: 'other' };

// Every completed sale's money, by way of paying: the parts of a sale
// paid since migration 0157, and older sales whole. Columns: order_id,
// company_id, created_at, cashier_id, method, amount (the part of the
// bill), net (less its share of refunds). For reports and the shift.
var ORDER_METHODS_SQL =
  '(SELECT o.id AS order_id, o.company_id, o.created_at, o.cashier_id, p.method, p.amount, ' +
  '   round(p.amount - CASE WHEN o.total > 0 THEN o.refunded_total * p.amount / o.total ELSE 0 END, 2) AS net ' +
  " FROM restaurant_order_payments p JOIN restaurant_orders o ON o.id = p.order_id WHERE o.status = 'completed' " +
  ' UNION ALL ' +
  ' SELECT o.id, o.company_id, o.created_at, o.cashier_id, o.payment_method, o.total, o.total - o.refunded_total ' +
  " FROM restaurant_orders o WHERE o.status = 'completed' AND NOT EXISTS (SELECT 1 FROM restaurant_order_payments p WHERE p.order_id = o.id))";

// The parts a sale is paid in, checked: each a way of paying the till
// offers, in the money that way takes (METHOD_CURRENCIES) and, if foreign,
// one the manager has turned on with its rate, adding up to the bill. One part pays the whole bill unless it
// says how much. Cash can say what was handed over (in its currency): the
// change is given in cedis. Returns { rows, method, cashTendered }.
function planPayments(session, total, list) {
  var settings = session.access.settings;
  if (!Array.isArray(list) || !list.length) fail('invalid', 'Choose how it is paid.');
  if (list.length > 6) fail('invalid', 'Split a bill into at most 6 payments.');
  total = round2(total);
  var rows = list.map(function (p, i) {
    p = p || {};
    var method = V.oneOf(p.method || 'cash', TILL_METHODS, 'Payment method');
    if (settings.paymentMethods.indexOf(method) < 0) fail('invalid', 'That way of paying is turned off in the till settings.');
    if (method === 'iou' && !session.access.can.iou) fail('forbidden', 'Your role on the till cannot sell on IOU. Ask a manager.');
    var currency = p.currency || METHOD_CURRENCIES[method][0];
    if (METHOD_CURRENCIES[method].indexOf(currency) < 0) fail('invalid', PAID_IN[method]);
    var rate = 1;
    if (currency !== 'GHS') {
      var cur = settings.currencies[currency];
      if (!cur || !cur.on || !(cur.rate > 0)) {
        fail('invalid', currency === 'CNY' ? 'Alipay and WeChat Pay are charged in RMB: a manager sets the RMB rate in the till settings first.'
          : 'The till does not take US dollars now. A manager turns them on with their rate.');
      }
      rate = cur.rate;
    }
    var amount = list.length === 1 && (p.amount === undefined || p.amount === null || p.amount === '') ? total : round2(p.amount);
    if (!(amount > 0)) fail('invalid', 'Each part of the bill needs an amount.');
    var foreign = currency === 'GHS' ? null : round2(amount / rate);
    var tendered = null, change = 0;
    if (method === 'cash' && p.tendered !== undefined && p.tendered !== null && p.tendered !== '') {
      tendered = round2(p.tendered);
      var owes = currency === 'GHS' ? amount : foreign;
      if (!(tendered >= owes)) fail('invalid', 'The cash received is less than ' + (list.length > 1 ? 'that part of the bill.' : 'the total.'));
      change = round2(tendered * rate - amount);
      if (change < 0) change = 0;
    }
    return { method: method, amount: amount, currency: currency, rate: rate, foreignAmount: foreign, tendered: tendered, changeGiven: change, sortOrder: i };
  });
  var sum = round2(rows.reduce(function (a, r) { return a + r.amount; }, 0));
  if (Math.abs(sum - total) > 0.009) {
    fail('invalid', sum < total ? 'The payments add up to ' + sum.toFixed(2) + '; the bill is ' + total.toFixed(2) + '. ' + (total - sum).toFixed(2) + ' is still to pay.'
      : 'The payments add up to ' + sum.toFixed(2) + ', more than the bill of ' + total.toFixed(2) + '.');
  }
  if (rows.length > 1 && rows.some(function (r) { return r.method === 'iou'; })) fail('invalid', 'An IOU is for the whole bill: it cannot be split.');
  var one = rows.length === 1 ? rows[0] : null;
  return {
    rows: rows,
    method: one ? one.method : 'split',
    cashTendered: one && one.method === 'cash' && one.currency === 'GHS' ? one.tendered : null
  };
}
async function savePayments(client, orderId, rows) {
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    await client.query(
      'INSERT INTO restaurant_order_payments (order_id, method, amount, currency, rate, foreign_amount, tendered, change_given, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [orderId, r.method, r.amount, r.currency, r.rate, r.foreignAmount, r.tendered, r.changeGiven, r.sortOrder]);
  }
}
async function paymentsOf(db, orderIds) {
  if (!orderIds.length) return new Map();
  var rows = (await db.query('SELECT * FROM restaurant_order_payments WHERE order_id = ANY($1::uuid[]) ORDER BY sort_order, created_at', [orderIds])).rows;
  var by = new Map();
  rows.forEach(function (r) {
    if (!by.has(r.order_id)) by.set(r.order_id, []);
    by.get(r.order_id).push({ method: r.method, amount: round2(r.amount), currency: r.currency, rate: Number(r.rate), foreignAmount: r.foreign_amount == null ? null : round2(r.foreign_amount),
      tendered: r.tendered == null ? null : round2(r.tendered), changeGiven: round2(r.change_given) });
  });
  return by;
}
function paymentText(rows) {
  return rows.map(function (r) {
    return METHOD_NAME[r.method] + ' ' + (r.currency === 'GHS' ? r.amount.toFixed(2) : CURRENCY_NAME[r.currency] + ' ' + Number(r.foreignAmount).toFixed(2) + ' (GHS ' + r.amount.toFixed(2) + ')');
  }).join(' + ');
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function fullName(r, prefix) { return r[prefix + '_first'] ? r[prefix + '_first'] + ' ' + r[prefix + '_last'] : null; }

async function openDrawer(client, cashierId) {
  return (await client.query("SELECT id FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [cashierId])).rows[0] || null;
}
// Money is taken (a sale, VIP money, an IOU paid) and given back (a
// refund) only by the cashier on duty, on their own open drawer — whatever
// the way of paying.
async function needDrawer(client, cashierId) {
  if (!(await openDrawer(client, cashierId))) fail('conflict', 'Only the cashier on duty takes and gives back money: open your cash drawer first.');
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

// What a customer owes on their IOU account: sales not paid yet (but the
// one being charged) and cash lent not paid back.
async function owedBy(db, guestId, exceptOrderId) {
  var r = (await db.query(
    "SELECT (SELECT coalesce(sum(total - refunded_total), 0) FROM restaurant_orders WHERE guest_id = $1 AND payment_method = 'iou' AND status = 'completed' AND iou_paid_at IS NULL AND id <> $2) + " +
    '(SELECT coalesce(sum(amount), 0) FROM restaurant_iou_advances WHERE guest_id = $1 AND paid_at IS NULL) AS o',
    [guestId, exceptOrderId || '00000000-0000-0000-0000-000000000000'])).rows[0];
  return round2(r.o);
}

// Called by restaurantPos.createOrder inside its transaction, once the
// sale is saved: the VIP part is paid from the customer's VIP account
// (which must cover it); an IOU needs a customer whose IOU account allows
// it, within its limit. rows: the sale's payments (planPayments).
async function chargeSale(client, companyId, order, cashierId, rows) {
  rows = rows || [{ method: order.payment_method, amount: round2(order.total) }];
  var vipPart = round2(rows.filter(function (r) { return r.method === 'vip'; }).reduce(function (a, r) { return a + r.amount; }, 0));
  var iou = rows.some(function (r) { return r.method === 'iou'; });
  if (!vipPart && !iou) return null;
  if (!order.guest_id) {
    fail('invalid', vipPart
      ? 'VIP is paid from a customer\'s VIP account: pick the customer first.'
      : 'An IOU needs the customer who owes it: pick the customer first.');
  }
  var g = (await client.query('SELECT id, name, iou_allowed, iou_limit FROM restaurant_guests WHERE id = $1 AND company_id = $2', [order.guest_id, companyId])).rows[0];
  if (!g) fail('notfound', 'That customer is no longer available.');
  if (iou) {
    if (!g.iou_allowed) fail('invalid', g.name + ' has no IOU account. A manager opens one in the till settings (Customers).');
    if (g.iou_limit != null) {
      var owed = await owedBy(client, g.id, order.id);
      if (owed + round2(order.total) > Number(g.iou_limit) + 0.009) {
        fail('invalid', g.name + ' already owes ' + owed.toFixed(2) + '; their IOU limit is ' + Number(g.iou_limit).toFixed(2) + '.');
      }
    }
    return null;
  }
  await lockGuest(client, order.guest_id);
  var hasAccount = (await client.query('SELECT 1 FROM restaurant_vip_entries WHERE guest_id = $1 LIMIT 1', [g.id])).rows.length > 0;
  if (!hasAccount) fail('invalid', g.name + ' has no VIP account. Put money down for them first (VIP).');
  var balance = await balanceOf(client, order.guest_id);
  if (balance < vipPart) {
    fail('invalid', g.name + ' has ' + balance.toFixed(2) + ' on their VIP balance and this sale is ' + vipPart.toFixed(2) + '. Top it up first.');
  }
  await client.query(
    "INSERT INTO restaurant_vip_entries (company_id, guest_id, kind, amount, order_id, cashier_id) VALUES ($1,$2,'sale',$3,$4,$5)",
    [companyId, order.guest_id, -vipPart, order.id, cashierId]);
  return { balance: round2(balance - vipPart) };
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
    await needDrawer(client, session.posEmployeeId);
    await lockGuest(client, g.id);
    await client.query(
      "INSERT INTO restaurant_vip_entries (company_id, guest_id, kind, amount, method, cashier_id, note) VALUES ($1,$2,'topup',$3,$4,$5,$6)",
      [session.posCompanyId, g.id, amount, method, session.posEmployeeId, String(p.note || '').trim().slice(0, 200)]);
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.vip',
      summary: 'VIP money put down for ' + g.name + ': ' + amount.toFixed(2) + ' (' + METHOD_NAME[method] + ').', amount: amount, refType: 'guest', refId: g.id, details: { method: method, customer: g.name } });
    return { guest: { id: g.id, name: g.name, phone: g.phone }, amount: amount, method: method, balance: await balanceOf(client, g.id) };
  });
}

// Pay out, for a VIP account: money on the balance given back in cash from
// the drawer — no more than the balance, with a manager's PIN, as a refund.
async function vipCashOut(token, p, ip) {
  var session = await access.need(token, 'vipTopUp');
  p = p || {};
  var amount = round2(p.amount);
  if (!(amount > 0)) fail('invalid', 'Enter an amount greater than zero.');
  var manager = await access.refundApprover(session.posCompanyId, p.managerPin, ip);
  return withTransaction(async function (client) {
    var g = await guestOf(client, session.posCompanyId, p.guestId);
    await needDrawer(client, session.posEmployeeId);
    await lockGuest(client, g.id);
    var balance = await balanceOf(client, g.id);
    if (amount > balance + 0.004) fail('invalid', g.name + ' has ' + balance.toFixed(2) + ' on their VIP balance: no more can be given back.');
    var note = String(p.note || '').trim().slice(0, 200);
    await client.query(
      "INSERT INTO restaurant_vip_entries (company_id, guest_id, kind, amount, method, cashier_id, approved_by, note) VALUES ($1,$2,'cashout',$3,'cash',$4,$5,$6)",
      [session.posCompanyId, g.id, -amount, session.posEmployeeId, manager.id, note]);
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.vip_cashout',
      summary: 'VIP money given back to ' + g.name + ' in cash: ' + amount.toFixed(2) + ' (approved by ' + manager.first_name + ' ' + manager.last_name + ')' + (note ? ': ' + note : '') + '.',
      amount: amount, refType: 'guest', refId: g.id, details: { customer: g.name, approvedBy: manager.id } });
    return { guest: { id: g.id, name: g.name, phone: g.phone }, amount: amount, balance: await balanceOf(client, g.id), approvedBy: manager.first_name + ' ' + manager.last_name };
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
    id: r.id, kind: 'sale', orderNo: r.order_no, total: round2(r.total), refunded: round2(r.refunded_total), owed: round2(Number(r.total) - Number(r.refunded_total)), guestId: r.guest_id || null,
    guestName: r.guest_name || null, guestPhone: r.guest_phone || null, tableName: r.table_name || null, dishes: r.dishes || '',
    cashierName: fullName(r, 'cashier'), createdAt: r.created_at,
    paidAt: r.iou_paid_at || null, paidMethod: r.iou_paid_method || null, paidAmount: r.iou_paid_amount == null ? null : round2(r.iou_paid_amount), paidBy: fullName(r, 'paid')
  };
}

// Cash lent on an IOU account (an advance): A-0001, A-0002… per restaurant.
var ADVANCE_SELECT =
  'SELECT a.*, g.name AS guest_name, g.phone AS guest_phone, ce.first_name AS cashier_first, ce.last_name AS cashier_last, pe.first_name AS paid_first, pe.last_name AS paid_last ' +
  'FROM restaurant_iou_advances a JOIN restaurant_guests g ON g.id = a.guest_id LEFT JOIN employees ce ON ce.id = a.cashier_id LEFT JOIN employees pe ON pe.id = a.paid_by ';
function advanceRef(n) { return 'A-' + String(n).padStart(4, '0'); }
function advanceOut(r) {
  return {
    id: r.id, kind: 'advance', orderNo: advanceRef(r.number), total: round2(r.amount), refunded: 0, owed: round2(r.amount),
    guestId: r.guest_id, guestName: r.guest_name || null, guestPhone: r.guest_phone || null, tableName: null, dishes: '', note: r.note || '',
    cashierName: fullName(r, 'cashier'), createdAt: r.created_at,
    paidAt: r.paid_at || null, paidMethod: r.paid_method || null, paidAmount: r.paid_amount == null ? null : round2(r.paid_amount), paidBy: fullName(r, 'paid')
  };
}

// What is still owed at this restaurant, oldest first — sales on IOU and
// cash lent — and what was paid today.
async function iouList(token, q) {
  var session = await access.need(token, 'iouPaid');
  var args = [session.posCompanyId];
  var search = '', searchA = '';
  if (q && String(q).trim()) {
    args.push('%' + String(q).trim() + '%');
    search = ' AND (g.name ILIKE $2 OR g.phone ILIKE $2 OR o.order_no ILIKE $2)';
    searchA = " AND (g.name ILIKE $2 OR g.phone ILIKE $2 OR 'A-' || lpad(a.number::text, 4, '0') ILIKE $2)";
  }
  var open = (await pool.query(IOU_SELECT +
    "WHERE o.company_id = $1 AND o.payment_method = 'iou' AND o.status = 'completed' AND o.iou_paid_at IS NULL" + search + ' ORDER BY o.created_at LIMIT 200', args)).rows.map(iouOut)
    .concat((await pool.query(ADVANCE_SELECT + 'WHERE a.company_id = $1 AND a.paid_at IS NULL' + searchA + ' ORDER BY a.created_at LIMIT 200', args)).rows.map(advanceOut));
  var paid = (await pool.query(IOU_SELECT +
    "WHERE o.company_id = $1 AND o.payment_method = 'iou' AND o.iou_paid_at >= date_trunc('day', now())" + search + ' ORDER BY o.iou_paid_at DESC LIMIT 30', args)).rows.map(iouOut)
    .concat((await pool.query(ADVANCE_SELECT + "WHERE a.company_id = $1 AND a.paid_at >= date_trunc('day', now())" + searchA + ' ORDER BY a.paid_at DESC LIMIT 30', args)).rows.map(advanceOut));
  open.sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  paid.sort(function (a, b) { return new Date(b.paidAt) - new Date(a.paidAt); });
  return { open: open, owed: round2(open.reduce(function (s, x) { return s + x.owed; }, 0)), paidToday: paid };
}

// One IOU paid in full — a sale on IOU or cash lent — inside a transaction.
async function payOne(client, session, id, method) {
  var o = (await client.query('SELECT * FROM restaurant_orders WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, session.posCompanyId])).rows[0];
  if (!o) {
    var a = (await client.query('SELECT * FROM restaurant_iou_advances WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, session.posCompanyId])).rows[0];
    if (!a) fail('notfound', 'IOU not found.');
    if (a.paid_at) fail('conflict', 'That IOU has already been paid.');
    await client.query('UPDATE restaurant_iou_advances SET paid_at = now(), paid_method = $2, paid_by = $3, paid_amount = amount WHERE id = $1', [a.id, method, session.posEmployeeId]);
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.iou_paid',
      summary: 'IOU ' + advanceRef(a.number) + ' (cash lent) paid back: ' + round2(a.amount).toFixed(2) + ' (' + METHOD_NAME[method] + ').', amount: round2(a.amount), refType: 'guest', refId: a.guest_id, details: { method: method, advance: a.id } });
    return advanceOut((await client.query(ADVANCE_SELECT + 'WHERE a.id = $1', [a.id])).rows[0]);
  }
  if (o.payment_method !== 'iou') fail('notfound', 'IOU not found.');
  if (o.status !== 'completed') fail('conflict', 'That sale was voided: nothing is owed.');
  if (o.iou_paid_at) fail('conflict', 'That IOU has already been paid.');
  var owed = round2(Number(o.total) - Number(o.refunded_total));
  await client.query('UPDATE restaurant_orders SET iou_paid_at = now(), iou_paid_method = $2, iou_paid_by = $3, iou_paid_amount = $4 WHERE id = $1',
    [o.id, method, session.posEmployeeId, owed]);
  await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.iou_paid',
    summary: 'IOU ' + o.order_no + ' paid: ' + owed.toFixed(2) + ' (' + METHOD_NAME[method] + ').', amount: owed, refType: 'order', refId: o.id, details: { method: method } });
  return iouOut((await client.query(IOU_SELECT + 'WHERE o.id = $1', [o.id])).rows[0]);
}
async function payIou(token, id, p) {
  var session = await access.need(token, 'iouPaid');
  var method = V.oneOf(p && p.method, MONEY, 'Paid with');
  return withTransaction(async function (client) {
    await needDrawer(client, session.posEmployeeId);
    return payOne(client, session, id, method);
  });
}
// POST /api/pos/ious/pay { ids, method } — Pay in, for an IOU account:
// several of a customer's IOUs paid back together, all or none.
async function payIous(token, p) {
  var session = await access.need(token, 'iouPaid');
  p = p || {};
  var method = V.oneOf(p.method || 'cash', MONEY, 'Paid with');
  var ids = Array.isArray(p.ids) ? p.ids.filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 50) : [];
  if (!ids.length) fail('invalid', 'Pick what is being paid back.');
  return withTransaction(async function (client) {
    await needDrawer(client, session.posEmployeeId);
    var paid = [];
    for (var i = 0; i < ids.length; i++) paid.push(await payOne(client, session, String(ids[i]), method));
    return { paid: paid, total: round2(paid.reduce(function (s, x) { return s + x.owed; }, 0)) };
  });
}
// POST /api/pos/ious/advances { guestId, amount, note } — Pay out, for an
// IOU account: cash lent from the drawer, owed until it is paid back, within
// the account's limit.
async function iouAdvance(token, p) {
  var session = await access.need(token, 'iou');
  p = p || {};
  var amount = round2(p.amount);
  if (!(amount > 0)) fail('invalid', 'Enter an amount greater than zero.');
  var note = String(p.note || '').trim().slice(0, 200);
  return withTransaction(async function (client) {
    var g = (await client.query('SELECT id, name, phone, iou_allowed, iou_limit FROM restaurant_guests WHERE id = $1 AND company_id = $2 FOR UPDATE', [p.guestId, session.posCompanyId])).rows[0];
    if (!g) fail('notfound', 'That customer is no longer available.');
    if (!g.iou_allowed) fail('invalid', g.name + ' has no IOU account. A manager opens one in the till settings (Customers).');
    await needDrawer(client, session.posEmployeeId);
    var owed = await owedBy(client, g.id);
    if (g.iou_limit != null && owed + amount > Number(g.iou_limit) + 0.009) fail('invalid', g.name + ' already owes ' + owed.toFixed(2) + '; their IOU limit is ' + Number(g.iou_limit).toFixed(2) + '.');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('iou-advance:' || $1))", [session.posCompanyId]);
    var number = (await client.query('SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_iou_advances WHERE company_id = $1', [session.posCompanyId])).rows[0].n;
    var a = (await client.query('INSERT INTO restaurant_iou_advances (company_id, number, guest_id, amount, note, cashier_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [session.posCompanyId, number, g.id, amount, note, session.posEmployeeId])).rows[0];
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.iou_advance',
      summary: 'Cash lent to ' + g.name + ' on their IOU account: ' + amount.toFixed(2) + ' (' + advanceRef(number) + ')' + (note ? ': ' + note : '') + '.',
      amount: amount, refType: 'guest', refId: g.id, details: { customer: g.name, advance: a.id } });
    return { advance: advanceOut((await client.query(ADVANCE_SELECT + 'WHERE a.id = $1', [a.id])).rows[0]), owed: round2(owed + amount), limit: g.iou_limit == null ? null : round2(g.iou_limit) };
  });
}

// ── refunds ────────────────────────────────────────────────────────────

// How a sale's refund can go back: the way it was paid where money can go
// back that way, to the VIP balance, or off what is still owed.
// A split bill: any of the ways it was paid that money can go back by,
// cash always, and the VIP account if it paid a part.
function refundMethodsFor(o, parts) {
  if (o.payment_method === 'vip') return ['vip'];
  if (o.payment_method === 'iou') return o.iou_paid_at ? MONEY : ['iou'];
  if (o.payment_method === 'alipay' || o.payment_method === 'wechat') return [o.payment_method, 'cash'];
  if (o.payment_method === 'split') {
    var used = (parts || []).map(function (r) { return r.method; });
    var out = ['cash'];
    ['mobile_money', 'alipay', 'wechat', 'vip'].forEach(function (m) { if (used.indexOf(m) >= 0) out.push(m); });
    return out;
  }
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

// What a dish refunded gives back for each cedi it was paid: its share of
// the service charge and of any tax added on top (migration 0168) too.
function refundFactor(o, items) {
  var net = items.reduce(function (a, i) { return a + Number(i.line_total); }, 0);
  return net > 0 && Number(o.total) > net ? Number(o.total) / net : 1;
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
      iouPaid: !!o.iou_paid_at, methods: refundMethodsFor(o, (await paymentsOf(db, [o.id])).get(o.id)), refundFactor: refundFactor(o, items),
      payments: (await paymentsOf(db, [o.id])).get(o.id) || [],
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
    var methods = refundMethodsFor(o, (await paymentsOf(client, [o.id])).get(o.id));
    var method = p.method || methods[0];
    if (methods.indexOf(method) < 0) fail('invalid', 'This sale cannot be refunded that way.');
    if (method === 'vip' && !o.guest_id) fail('invalid', 'This VIP sale has no guest to give the money back to.');
    await needDrawer(client, session.posEmployeeId);

    var items = (await client.query(
      'SELECT i.*, coalesce((SELECT sum(ri.qty) FROM restaurant_refund_items ri WHERE ri.order_item_id = i.id), 0) AS refunded_qty FROM restaurant_order_items i WHERE i.order_id = $1',
      [o.id])).rows;
    var lines = [];
    var factor = refundFactor(o, items);
    wanted.forEach(function (w) {
      var it = items.find(function (i) { return i.id === w.id; });
      if (!it) fail('invalid', 'One of the dishes is not on this sale.');
      var qty = round2(w.qty);
      if (!(qty > 0)) return;
      var left = round2(Number(it.qty) - Number(it.refunded_qty));
      if (qty > left) fail('invalid', left > 0 ? 'Only ' + left + ' × ' + it.name + ' is left to refund.' : it.name + ' has already been refunded.');
      lines.push({ item: it, qty: qty, amount: round2(Number(it.line_total) * qty / Number(it.qty) * factor) });
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
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.refund',
      summary: 'Refund on ' + o.order_no + ': ' + amount.toFixed(2) + ' (' + METHOD_NAME[method] + '), approved by ' + manager.first_name + ' ' + manager.last_name + '. ' + reason.slice(0, 120),
      amount: amount, refType: 'order', refId: o.id, details: { method: method, reason: reason.slice(0, 200), approvedBy: manager.first_name + ' ' + manager.last_name, items: lines.map(function (l) { return l.qty + '× ' + l.item.name; }) } });
    return { refund: sale.refunds.find(function (r) { return r.id === refund.id; }), sale: sale };
  });
}

// A voided VIP sale never happened: what is left of it goes back to the
// guest's balance (restaurantPos.voidOrder, in its transaction).
async function onVoid(client, o) {
  if ((o.payment_method !== 'vip' && o.payment_method !== 'split') || !o.guest_id) return;
  var back = round2(Number(o.total) - Number(o.refunded_total));
  if (o.payment_method === 'split') {
    var spent = round2(-(await client.query("SELECT coalesce(sum(amount), 0) AS s FROM restaurant_vip_entries WHERE order_id = $1", [o.id])).rows[0].s);
    back = Math.min(back, spent);
  }
  if (!(back > 0)) return;
  await lockGuest(client, o.guest_id);
  await client.query("INSERT INTO restaurant_vip_entries (company_id, guest_id, kind, amount, order_id, note) VALUES ($1,$2,'refund',$3,$4,'Sale voided')",
    [o.company_id, o.guest_id, back, o.id]);
}

// ── for the drawer and the shift ───────────────────────────────────────

// Cash this cashier took in or paid out between two times besides cash
// sales: refunds paid in cash, IOUs paid in cash (sales and cash lent),
// VIP top-ups in cash; VIP money given back and cash lent on IOU accounts.
async function drawerCash(db, cashierId, companyId, from, to) {
  var r = (await db.query(
    "SELECT (SELECT coalesce(sum(amount), 0) FROM restaurant_refunds WHERE cashier_id = $1 AND company_id = $2 AND method = 'cash' AND created_at >= $3 AND created_at <= $4) AS refunds, " +
    "(SELECT coalesce(sum(iou_paid_amount), 0) FROM restaurant_orders WHERE iou_paid_by = $1 AND company_id = $2 AND iou_paid_method = 'cash' AND iou_paid_at >= $3 AND iou_paid_at <= $4) + " +
    "(SELECT coalesce(sum(paid_amount), 0) FROM restaurant_iou_advances WHERE paid_by = $1 AND company_id = $2 AND paid_method = 'cash' AND paid_at >= $3 AND paid_at <= $4) AS iou_paid, " +
    "(SELECT coalesce(sum(amount), 0) FROM restaurant_vip_entries WHERE cashier_id = $1 AND company_id = $2 AND kind = 'topup' AND method = 'cash' AND created_at >= $3 AND created_at <= $4) AS vip_topups, " +
    "(SELECT coalesce(-sum(amount), 0) FROM restaurant_vip_entries WHERE cashier_id = $1 AND company_id = $2 AND kind = 'cashout' AND created_at >= $3 AND created_at <= $4) AS vip_cashouts, " +
    '(SELECT coalesce(sum(amount), 0) FROM restaurant_iou_advances WHERE cashier_id = $1 AND company_id = $2 AND created_at >= $3 AND created_at <= $4) AS iou_lent',
    [cashierId, companyId, from, to])).rows[0];
  return { refunds: round2(r.refunds), iouPaid: round2(r.iou_paid), vipTopUps: round2(r.vip_topups), vipCashOuts: round2(r.vip_cashouts), iouLent: round2(r.iou_lent) };
}
// The same, one by one, for the drawer's list of money in and out: each
// with its customer — in: vip (put down), iou (paid back); out: vip (given
// back), iou (lent).
async function accountMoves(db, cashierId, companyId, from, to) {
  var args = [cashierId, companyId, from, to];
  var rows = (await db.query(
    "SELECT v.id, CASE WHEN v.kind = 'topup' THEN 'in' ELSE 'out' END AS direction, 'vip' AS account, abs(v.amount) AS amount, g.name AS customer, v.note, NULL::text AS ref, v.created_at AS at " +
    "FROM restaurant_vip_entries v JOIN restaurant_guests g ON g.id = v.guest_id WHERE v.cashier_id = $1 AND v.company_id = $2 AND v.method = 'cash' AND v.kind IN ('topup', 'cashout') AND v.created_at >= $3 AND v.created_at <= $4 " +
    "UNION ALL SELECT o.id, 'in', 'iou', o.iou_paid_amount, g.name, '', o.order_no, o.iou_paid_at FROM restaurant_orders o LEFT JOIN restaurant_guests g ON g.id = o.guest_id " +
    "WHERE o.iou_paid_by = $1 AND o.company_id = $2 AND o.iou_paid_method = 'cash' AND o.iou_paid_at >= $3 AND o.iou_paid_at <= $4 " +
    "UNION ALL SELECT a.id, 'in', 'iou', a.paid_amount, g.name, a.note, 'A-' || lpad(a.number::text, 4, '0'), a.paid_at FROM restaurant_iou_advances a JOIN restaurant_guests g ON g.id = a.guest_id " +
    "WHERE a.paid_by = $1 AND a.company_id = $2 AND a.paid_method = 'cash' AND a.paid_at >= $3 AND a.paid_at <= $4 " +
    "UNION ALL SELECT a.id, 'out', 'iou', a.amount, g.name, a.note, 'A-' || lpad(a.number::text, 4, '0'), a.created_at FROM restaurant_iou_advances a JOIN restaurant_guests g ON g.id = a.guest_id " +
    'WHERE a.cashier_id = $1 AND a.company_id = $2 AND a.created_at >= $3 AND a.created_at <= $4 ORDER BY 8', args)).rows;
  return rows.map(function (r) { return { id: r.id, direction: r.direction, account: r.account, amount: round2(r.amount), customer: r.customer || null, note: r.note || '', ref: r.ref || null, createdAt: r.at }; });
}

// Cash sales this cashier took between two times, from the parts of each
// sale: cedis kept (the bill's part, after change), less change given in
// cedis for foreign money; and the foreign notes in the drawer, by
// currency. Sales from before migration 0157 count whole when paid cash.
async function cashSales(db, cashierId, companyId, from, to) {
  var r = (await db.query(
    "SELECT (SELECT coalesce(sum(o.total), 0) FROM restaurant_orders o WHERE o.cashier_id = $1 AND o.company_id = $2 AND o.payment_method = 'cash' AND o.status = 'completed' " +
    '   AND o.created_at >= $3 AND o.created_at <= $4 AND NOT EXISTS (SELECT 1 FROM restaurant_order_payments p WHERE p.order_id = o.id)) AS legacy, ' +
    "  (SELECT coalesce(sum(CASE WHEN p.currency = 'GHS' THEN p.amount ELSE -p.change_given END), 0) FROM restaurant_order_payments p JOIN restaurant_orders o ON o.id = p.order_id " +
    "   WHERE o.cashier_id = $1 AND o.company_id = $2 AND o.status = 'completed' AND p.method = 'cash' AND o.created_at >= $3 AND o.created_at <= $4) AS cedis",
    [cashierId, companyId, from, to])).rows[0];
  var foreign = (await db.query(
    "SELECT p.currency, sum(coalesce(p.tendered, p.foreign_amount)) AS amount, sum(p.amount) AS cedis FROM restaurant_order_payments p JOIN restaurant_orders o ON o.id = p.order_id " +
    "WHERE o.cashier_id = $1 AND o.company_id = $2 AND o.status = 'completed' AND p.method = 'cash' AND p.currency <> 'GHS' AND o.created_at >= $3 AND o.created_at <= $4 GROUP BY p.currency ORDER BY p.currency",
    [cashierId, companyId, from, to])).rows;
  return { cash: round2(Number(r.legacy) + Number(r.cedis)), foreign: foreign.map(function (f) { return { currency: f.currency, amount: round2(f.amount), cedis: round2(f.cedis) }; }) };
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
  TILL_METHODS: TILL_METHODS, METHOD_CURRENCIES: METHOD_CURRENCIES, ORDER_METHODS_SQL: ORDER_METHODS_SQL, METHOD_NAME: METHOD_NAME, needDrawer: needDrawer,
  planPayments: planPayments, savePayments: savePayments, paymentsOf: paymentsOf, paymentText: paymentText, cashSales: cashSales,
  chargeSale: chargeSale, vipGuests: vipGuests, vipGuest: vipGuest, vipTopUp: vipTopUp, vipCashOut: vipCashOut,
  iouList: iouList, payIou: payIou, payIous: payIous, iouAdvance: iouAdvance, owedBy: owedBy, accountMoves: accountMoves,
  salesToRefund: salesToRefund, saleForRefund: saleForRefundSession, refundSale: refundSale, refundsOf: refundsOf, onVoid: onVoid,
  drawerCash: drawerCash, shiftMoney: shiftMoney
};
