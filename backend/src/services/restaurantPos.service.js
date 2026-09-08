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
    "SELECT e.id, e.first_name, e.last_name, d.company_id, c.name AS company_name, c.code AS company_code FROM employees e " +
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
    companyName: emp.company_name,
    companyCode: emp.company_code
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
    'SELECT id, name, category, price, photo_object_key, favorite FROM restaurant_menu_items WHERE company_id = $1 AND active = true ORDER BY category, name',
    [session.posCompanyId]
  );
  return res.rows.map(rowToTile);
}

function rowToTile(r) {
  return {
    id: r.id, name: r.name, category: r.category, price: Number(r.price),
    photoUrl: r.photo_object_key ? '/api/menu-photos/' + r.id : null,
    favorite: r.favorite
  };
}

// Shared across whoever's on the till, not per-cashier — see migration
// 0046's comment. Scoped to the caller's own company_id in the WHERE
// clause (not just the id), so a Star Bar session can never toggle a
// Bamboo Garden item even if it somehow guessed its id.
async function toggleFavorite(token, itemId) {
  var session = verifyPosToken(token);
  var res = await pool.query(
    'UPDATE restaurant_menu_items SET favorite = NOT favorite, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING id, favorite',
    [itemId, session.posCompanyId]
  );
  if (!res.rows[0]) fail('notfound', 'Menu item not found.');
  return res.rows[0];
}

// "Mostly bought" quick-access tab — real sales frequency, not a manual
// curation like favorites. Windowed to the last 90 days rather than
// all-time: at Square-import scale (tens of thousands of historical
// orders per restaurant) an all-time ranking would mostly reflect
// whatever sold heavily back when the data was imported, not what's
// actually popular right now, and the window also keeps the aggregate
// query scanning a bounded slice of restaurant_order_items instead of
// the entire history on every till load.
var MOSTLY_BOUGHT_WINDOW_DAYS = 90;
var MOSTLY_BOUGHT_LIMIT = 24;
async function mostlyBought(token) {
  var session = verifyPosToken(token);
  var res = await pool.query(
    'SELECT mi.id, mi.name, mi.category, mi.price, mi.photo_object_key, mi.favorite, SUM(oi.qty) AS qty_sold ' +
    'FROM restaurant_order_items oi ' +
    'JOIN restaurant_orders o ON o.id = oi.order_id ' +
    'JOIN restaurant_menu_items mi ON mi.id = oi.menu_item_id ' +
    "WHERE o.company_id = $1 AND o.status != 'voided' AND o.created_at >= now() - ($2 || ' days')::interval " +
    'AND mi.active = true ' +
    'GROUP BY mi.id ' +
    'ORDER BY qty_sold DESC ' +
    'LIMIT $3',
    [session.posCompanyId, MOSTLY_BOUGHT_WINDOW_DAYS, MOSTLY_BOUGHT_LIMIT]
  );
  return res.rows.map(function (r) {
    var tile = rowToTile(r);
    tile.qtySold = Number(r.qty_sold);
    return tile;
  });
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

// Server-side paged, not the client-side "load everything, filter in the
// browser" pattern every other list page here uses — fine for hundreds of
// rows, but the Square historical import (Restaurant module Phase 4) can
// leave tens of thousands of orders for one company, which a plain <table>
// can't render without hanging the page. limit/offset + an optional
// created_at date range (from/to, inclusive) keep a query cheap regardless
// of how much history exists; total comes back via a window function so
// the frontend can show "X of Y" without a second round trip.
async function listOrders(ctx, companyId, opts) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  opts = opts || {};
  var limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  var offset = Math.max(Number(opts.offset) || 0, 0);

  var args = [];
  var where = [];
  if (companyId) { args.push(companyId); where.push('o.company_id = $' + args.length); }
  if (opts.from) { args.push(opts.from); where.push('o.created_at >= $' + args.length); }
  if (opts.to) { args.push(opts.to + ' 23:59:59'); where.push('o.created_at <= $' + args.length); }
  var whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  args.push(limit); var limitParam = '$' + args.length;
  args.push(offset); var offsetParam = '$' + args.length;

  // revenue_total/voided_count are window functions too — computed over the
  // whole WHERE-filtered set before LIMIT clips it to one page, same as
  // total_count, so the Sales tab's stat tiles show true range-wide figures
  // rather than a partial, misleadingly-small sum of just the visible page.
  var res = await pool.query(
    'SELECT o.*, e.first_name, e.last_name, count(*) OVER() AS total_count, ' +
    "coalesce(sum(o.total) OVER(), 0) AS revenue_total, count(*) FILTER (WHERE o.status = 'voided') OVER() AS voided_count " +
    'FROM restaurant_orders o JOIN employees e ON e.id = o.cashier_id ' +
    whereSql + ' ORDER BY o.created_at DESC LIMIT ' + limitParam + ' OFFSET ' + offsetParam,
    args
  );
  var total = res.rows[0] ? Number(res.rows[0].total_count) : 0;
  var revenueTotal = res.rows[0] ? Number(res.rows[0].revenue_total) : 0;
  var voidedCount = res.rows[0] ? Number(res.rows[0].voided_count) : 0;
  return {
    orders: res.rows.map(function (r) {
      return {
        id: r.id, companyId: r.company_id, orderNo: r.order_no, cashierName: r.first_name + ' ' + r.last_name,
        subtotal: Number(r.subtotal), total: Number(r.total), paymentMethod: r.payment_method, status: r.status, createdAt: r.created_at
      };
    }),
    total: total, revenueTotal: revenueTotal, voidedCount: voidedCount, limit: limit, offset: offset
  };
}

// Single-order detail (with its line items) — deliberately not folded into
// listOrders' one big query: at Square-import scale (tens of thousands of
// orders) fetching every order's items up front would be a huge, mostly-
// wasted payload, so this is fetched lazily, one order at a time, only when
// someone actually opens it.
async function getOrder(ctx, id) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  var orderRes = await pool.query(
    'SELECT o.*, e.first_name, e.last_name FROM restaurant_orders o JOIN employees e ON e.id = o.cashier_id WHERE o.id = $1',
    [id]
  );
  var order = orderRes.rows[0];
  if (!order) fail('notfound', 'Order not found.');
  var itemsRes = await pool.query(
    'SELECT name, qty, unit_price, line_total FROM restaurant_order_items WHERE order_id = $1 ORDER BY name', [id]
  );
  return {
    id: order.id, companyId: order.company_id, orderNo: order.order_no, cashierName: order.first_name + ' ' + order.last_name,
    subtotal: Number(order.subtotal), total: Number(order.total), paymentMethod: order.payment_method, status: order.status, createdAt: order.created_at,
    items: itemsRes.rows.map(function (r) { return { name: r.name, qty: Number(r.qty), unitPrice: Number(r.unit_price), lineTotal: Number(r.line_total) }; })
  };
}

async function voidOrder(ctx, id) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var res = await pool.query("UPDATE restaurant_orders SET status = 'voided' WHERE id = $1 AND status = 'completed' RETURNING *", [id]);
  if (!res.rows[0]) fail('notfound', 'Order not found, or already voided.');
  return true;
}

module.exports = {
  login: login, menuForSession: menuForSession, createOrder: createOrder,
  listOrders: listOrders, getOrder: getOrder, voidOrder: voidOrder,
  toggleFavorite: toggleFavorite, mostlyBought: mostlyBought
};
