var jwt = require('jsonwebtoken');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var config = require('../config');
var pinAuth = require('../lib/pinAuth');

// Restaurant module, Phase 2 (POS): a till device, shared across whoever
// is working the counter that shift — same "no per-person login, one
// 4-digit PIN identifies you" model as the clock-in kiosk (kiosk.service.js),
// reusing the exact same kiosk_pin_hash column and rate limiter
// (lib/pinAuth.js) rather than a second PIN to remember.
//
// Unlike the kiosk (which re-verifies the PIN on every single tap and
// keeps no session at all), a POS till rings up many sales in a row —
// re-entering a PIN before every sale would make it unusable for a busy
// counter. login() below verifies the PIN once and issues a short-lived
// signed token (same JWT_SECRET as the real user-login tokens, but a
// distinct payload shape — see verifyPosToken) scoping subsequent
// menu-read/order-create calls to that one employee+company pair for the
// rest of their shift, without ever needing a real user account (most
// restaurant staff won't have one).
var POS_TOKEN_EXPIRES_IN = '12h';

async function login(pin, ip) {
  pinAuth.checkRateLimit(ip);
  pinAuth.validatePinFormat(pin);
  var hash = pinAuth.hashPin(pin);
  var res = await pool.query(
    "SELECT e.id, e.first_name, e.last_name, d.company_id, c.name AS company_name FROM employees e " +
    "JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id " +
    "WHERE e.kiosk_pin_hash = $1 AND e.status = 'active'",
    [hash]
  );
  var emp = res.rows[0];
  if (!emp) {
    pinAuth.recordFailure(ip);
    fail('invalid', 'Incorrect PIN.');
  }
  pinAuth.recordSuccess(ip);
  var token = jwt.sign({ posEmployeeId: emp.id, posCompanyId: emp.company_id }, config.jwt.secret, { expiresIn: POS_TOKEN_EXPIRES_IN });
  return {
    token: token,
    employeeName: emp.first_name + ' ' + emp.last_name,
    companyId: emp.company_id,
    companyName: emp.company_name
  };
}

// Verifies a POS till token (not a real user login token — jwt.verify
// alone can't tell them apart since both use config.jwt.secret, so this
// also checks the payload actually has the POS shape) and returns the
// { posEmployeeId, posCompanyId } it was issued for.
function verifyPosToken(token) {
  if (!token) fail('auth', 'Your till session has expired — please log in again.');
  var payload;
  try {
    payload = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    fail('auth', 'Your till session has expired — please log in again.');
  }
  if (!payload.posEmployeeId || !payload.posCompanyId) fail('auth', 'Your till session has expired — please log in again.');
  return payload;
}

function rowToOrder(order, items) {
  return {
    id: order.id, companyId: order.company_id, orderNo: order.order_no, cashierId: order.cashier_id,
    subtotal: Number(order.subtotal), total: Number(order.total), paymentMethod: order.payment_method,
    status: order.status, createdAt: order.created_at,
    items: items.map(function (it) { return { menuItemId: it.menuItemId, name: it.name, qty: it.qty, unitPrice: it.unitPrice, lineTotal: it.lineTotal }; })
  };
}

// POS menu — active items only, for the company the till session is
// scoped to. Not gated on restaurant.read (the till has no logged-in
// user), gated on a valid POS session instead.
async function menuForSession(token) {
  var session = verifyPosToken(token);
  var res = await pool.query(
    'SELECT id, name, category, price FROM restaurant_menu_items WHERE company_id = $1 AND active = true ORDER BY category, name',
    [session.posCompanyId]
  );
  return res.rows.map(function (r) { return { id: r.id, name: r.name, category: r.category, price: Number(r.price) }; });
}

// kernel-of-a-sale — rings up a completed order in one transaction: every
// line is re-priced against the LIVE menu (never trusts a client-supplied
// price), a company-scoped order number comes from restaurant_order_seq
// (migration 0042 — a Postgres sequence, so it's race-safe under a busy
// counter with no row locking needed), and the whole thing is one insert
// per row inside withTransaction so a partial order can never be saved.
async function createOrder(token, p) {
  var session = verifyPosToken(token);
  var items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) fail('invalid', 'Add at least one item.');
  var paymentMethod = V.oneOf(p.paymentMethod || 'cash', ['cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other'], 'Payment method');

  return withTransaction(async function (client) {
    var lines = [];
    var subtotal = 0;
    for (var i = 0; i < items.length; i++) {
      var qty = Math.max(0.01, Number(items[i].qty) || 0);
      var menuRes = await client.query(
        'SELECT * FROM restaurant_menu_items WHERE id = $1 AND company_id = $2 AND active = true',
        [items[i].menuItemId, session.posCompanyId]
      );
      var m = menuRes.rows[0];
      if (!m) fail('invalid', 'One of the items in this order is no longer available.');
      var lineTotal = Math.round(qty * Number(m.price) * 100) / 100;
      subtotal += lineTotal;
      lines.push({ menuItemId: m.id, name: m.name, qty: qty, unitPrice: Number(m.price), lineTotal: lineTotal });
    }
    subtotal = Math.round(subtotal * 100) / 100;

    var companyRes = await client.query('SELECT code FROM companies WHERE id = $1', [session.posCompanyId]);
    var seqRes = await client.query("SELECT nextval('restaurant_order_seq') AS n");
    var orderNo = companyRes.rows[0].code + '-' + String(seqRes.rows[0].n).padStart(6, '0');

    var orderRes = await client.query(
      'INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, payment_method) VALUES ($1,$2,$3,$4,$4,$5) RETURNING *',
      [session.posCompanyId, orderNo, session.posEmployeeId, subtotal, paymentMethod]
    );
    var order = orderRes.rows[0];
    for (var j = 0; j < lines.length; j++) {
      await client.query(
        'INSERT INTO restaurant_order_items (order_id, menu_item_id, name, qty, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6)',
        [order.id, lines[j].menuItemId, lines[j].name, lines[j].qty, lines[j].unitPrice, lines[j].lineTotal]
      );
    }
    return rowToOrder(order, lines);
  });
}

// ── management view (inside the regular authenticated app, not the till) ──

async function listOrders(ctx, companyId) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  var args = [];
  var where = '';
  if (companyId) { args.push(companyId); where = 'WHERE o.company_id = $1'; }
  var res = await pool.query(
    'SELECT o.*, e.first_name, e.last_name FROM restaurant_orders o JOIN employees e ON e.id = o.cashier_id ' +
    where + ' ORDER BY o.created_at DESC LIMIT 200',
    args
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, companyId: r.company_id, orderNo: r.order_no, cashierName: r.first_name + ' ' + r.last_name,
      subtotal: Number(r.subtotal), total: Number(r.total), paymentMethod: r.payment_method, status: r.status, createdAt: r.created_at
    };
  });
}

async function voidOrder(ctx, id) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var res = await pool.query("UPDATE restaurant_orders SET status = 'voided' WHERE id = $1 AND status = 'completed' RETURNING *", [id]);
  if (!res.rows[0]) fail('notfound', 'Order not found, or already voided.');
  return true;
}

module.exports = {
  login: login, menuForSession: menuForSession, createOrder: createOrder,
  listOrders: listOrders, voidOrder: voidOrder
};
