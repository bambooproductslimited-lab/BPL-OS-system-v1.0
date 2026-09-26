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
    tableId: order.table_id, waiterId: order.waiter_id, guestId: order.guest_id,
    cashTendered: order.cash_tendered == null ? null : Number(order.cash_tendered),
    change: order.cash_tendered == null ? null : Math.round((Number(order.cash_tendered) - Number(order.total)) * 100) / 100,
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
  return attachVariationsToTiles(res.rows.map(rowToTile));
}

function rowToTile(r) {
  return {
    id: r.id, name: r.name, category: r.category, price: Number(r.price),
    photoUrl: r.photo_object_key ? '/api/menu-photos/' + r.id : null,
    favorite: r.favorite, variations: []
  };
}

// Attaches each tile's named price variations (a second query, same
// pattern as restaurant.service.js's attachVariations, kept separate since
// this module never imports that one) — a tile with none sells at its own
// flat price exactly as before; the till only opens a variation picker for
// tiles that have some.
async function attachVariationsToTiles(tiles) {
  if (!tiles.length) return tiles;
  var res = await pool.query(
    'SELECT id, menu_item_id, name, price FROM restaurant_menu_item_variations WHERE menu_item_id = ANY($1) ORDER BY sort_order, created_at',
    [tiles.map(function (t) { return t.id; })]
  );
  var byItem = new Map();
  res.rows.forEach(function (r) {
    if (!byItem.has(r.menu_item_id)) byItem.set(r.menu_item_id, []);
    byItem.get(r.menu_item_id).push({ id: r.id, name: r.name, price: Number(r.price) });
  });
  tiles.forEach(function (t) { t.variations = byItem.get(t.id) || []; });
  return tiles;
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
  var tiles = res.rows.map(function (r) {
    var tile = rowToTile(r);
    tile.qtySold = Number(r.qty_sold);
    return tile;
  });
  return attachVariationsToTiles(tiles);
}

// Active tables for the till's own company — the fixed, management-set
// list (restaurant.service.js's createTable), not free text.
async function tablesForSession(token) {
  var session = verifyPosToken(token);
  var res = await pool.query(
    "SELECT id, name FROM restaurant_tables WHERE company_id = $1 AND status = 'active' ORDER BY name",
    [session.posCompanyId]
  );
  return res.rows;
}

// Waiters — any active employee at the till's company, not just whoever
// has a kiosk PIN (the person serving a table doesn't need till access
// themselves; the cashier picks their name from this list). Same
// department-join pattern login() already uses to resolve a company from
// an employee.
async function waitersForSession(token) {
  var session = verifyPosToken(token);
  var res = await pool.query(
    "SELECT e.id, e.first_name, e.last_name FROM employees e JOIN departments d ON d.id = e.department_id " +
    "WHERE d.company_id = $1 AND e.status = 'active' ORDER BY e.first_name, e.last_name",
    [session.posCompanyId]
  );
  return res.rows.map(function (r) { return { id: r.id, name: r.first_name + ' ' + r.last_name }; });
}

function rowToGuestTile(r) { return { id: r.id, name: r.name, phone: r.phone }; }

async function guestsForSession(token, q) {
  var session = verifyPosToken(token);
  var args = [session.posCompanyId];
  var where = 'company_id = $1';
  if (q) { args.push('%' + q + '%'); where += ' AND (name ILIKE $2 OR phone ILIKE $2)'; }
  var res = await pool.query('SELECT id, name, phone FROM restaurant_guests WHERE ' + where + ' ORDER BY name LIMIT 50', args);
  return res.rows.map(rowToGuestTile);
}

// Quick-add from the till itself — a walk-in the cashier hasn't seen
// before shouldn't require leaving the sale screen to go set them up in
// the management app first.
async function createGuestForSession(token, p) {
  var session = verifyPosToken(token);
  var name = V.text(p.name, 'Name', 100);
  var res = await pool.query(
    'INSERT INTO restaurant_guests (company_id, name, phone) VALUES ($1,$2,$3) RETURNING id, name, phone',
    [session.posCompanyId, name, (p.phone || '').trim()]
  );
  return rowToGuestTile(res.rows[0]);
}

// kernel-of-a-sale — rings up a completed order in one transaction: every
// line is re-priced against the LIVE menu (never trusts a client-supplied
// price), a company-scoped order number comes from restaurant_order_seq
// (migration 0042 — a Postgres sequence, so it's race-safe under a busy
// counter with no row locking needed), and the whole thing is one insert
// per row inside withTransaction so a partial order can never be saved.
// table/waiter/guest are all optional, and each re-checked against this
// till's own company_id — never trust a client-supplied id without scoping
// it, so a Star Bar sale can't attribute itself to a Bamboo Garden
// table/guest/waiter even if it somehow guessed the id.
async function resolveRefs(client, companyId, p) {
  var tableId = null;
  if (p.tableId) {
    var tableRes = await client.query("SELECT id FROM restaurant_tables WHERE id = $1 AND company_id = $2 AND status = 'active'", [p.tableId, companyId]);
    if (!tableRes.rows[0]) fail('invalid', 'That table is no longer available.');
    tableId = tableRes.rows[0].id;
  }
  var waiterId = null;
  if (p.waiterId) {
    var waiterRes = await client.query(
      "SELECT e.id FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.id = $1 AND d.company_id = $2 AND e.status = 'active'",
      [p.waiterId, companyId]
    );
    if (!waiterRes.rows[0]) fail('invalid', 'That waiter is no longer available.');
    waiterId = waiterRes.rows[0].id;
  }
  var guestId = null;
  if (p.guestId) {
    var guestRes = await client.query('SELECT id FROM restaurant_guests WHERE id = $1 AND company_id = $2', [p.guestId, companyId]);
    if (!guestRes.rows[0]) fail('invalid', 'That guest is no longer available.');
    guestId = guestRes.rows[0].id;
  }
  return { tableId: tableId, waiterId: waiterId, guestId: guestId };
}

// Prices each line against the LIVE menu (never a client-supplied price).
// If an item has price variations (Square-style "M" vs "Jellyfish"), the
// till must say which one was picked — never fall back to the item's own
// flat price, which isn't meaningful once variations exist. An item with
// none ignores whatever variationId the client sends.
async function priceLines(client, companyId, items) {
  if (!Array.isArray(items) || !items.length) fail('invalid', 'Add at least one item.');
  var lines = [];
  var subtotal = 0;
  for (var i = 0; i < items.length; i++) {
    var qty = Math.max(0.01, Number(items[i].qty) || 0);
    var menuRes = await client.query(
      'SELECT * FROM restaurant_menu_items WHERE id = $1 AND company_id = $2 AND active = true',
      [items[i].menuItemId, companyId]
    );
    var m = menuRes.rows[0];
    if (!m) fail('invalid', 'One of the items in this order is no longer available.');
    var variationRes = await client.query('SELECT id, name, price FROM restaurant_menu_item_variations WHERE menu_item_id = $1', [m.id]);
    var name = m.name;
    var unitPrice = Number(m.price);
    var variationId = null;
    if (variationRes.rows.length) {
      var picked = items[i].variationId && variationRes.rows.find(function (v) { return v.id === items[i].variationId; });
      if (!picked) fail('invalid', m.name + ' has price variations — pick one.');
      variationId = picked.id;
      name = m.name + ' — ' + picked.name;
      unitPrice = Number(picked.price);
    }
    var lineTotal = Math.round(qty * unitPrice * 100) / 100;
    subtotal += lineTotal;
    lines.push({ menuItemId: m.id, variationId: variationId, name: name, qty: qty, unitPrice: unitPrice, lineTotal: lineTotal });
  }
  return { lines: lines, subtotal: Math.round(subtotal * 100) / 100 };
}

// A cash sale can say what the customer handed over (cashTendered), so the
// receipt shows the change; it can't be less than the total. Paying an
// open table (tabId) rings up the order and removes the tab in the same
// transaction, so a tab is never paid twice.
async function createOrder(token, p) {
  var session = verifyPosToken(token);
  var paymentMethod = V.oneOf(p.paymentMethod || 'cash', ['cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other'], 'Payment method');

  return withTransaction(async function (client) {
    if (p.tabId) {
      var tabRes = await client.query('SELECT id FROM restaurant_open_tabs WHERE id = $1 AND company_id = $2 FOR UPDATE', [p.tabId, session.posCompanyId]);
      if (!tabRes.rows[0]) fail('conflict', 'That open table has already been paid or removed.');
    }
    var refs = await resolveRefs(client, session.posCompanyId, p);
    var priced = await priceLines(client, session.posCompanyId, p.items);
    var lines = priced.lines;
    var subtotal = priced.subtotal;

    var cashTendered = null;
    if (paymentMethod === 'cash' && p.cashTendered !== undefined && p.cashTendered !== null && p.cashTendered !== '') {
      cashTendered = Math.round(Number(p.cashTendered) * 100) / 100;
      if (!(cashTendered >= subtotal)) fail('invalid', 'The cash received is less than the total.');
    }

    var companyRes = await client.query('SELECT code FROM companies WHERE id = $1', [session.posCompanyId]);
    var seqRes = await client.query("SELECT nextval('restaurant_order_seq') AS n");
    var orderNo = companyRes.rows[0].code + '-' + String(seqRes.rows[0].n).padStart(6, '0');

    var orderRes = await client.query(
      'INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, payment_method, table_id, waiter_id, guest_id, cash_tendered) ' +
      'VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9) RETURNING *',
      [session.posCompanyId, orderNo, session.posEmployeeId, subtotal, paymentMethod, refs.tableId, refs.waiterId, refs.guestId, cashTendered]
    );
    var order = orderRes.rows[0];
    for (var j = 0; j < lines.length; j++) {
      await client.query(
        'INSERT INTO restaurant_order_items (order_id, menu_item_id, variation_id, name, qty, unit_price, line_total, gross) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',
        [order.id, lines[j].menuItemId, lines[j].variationId, lines[j].name, lines[j].qty, lines[j].unitPrice, lines[j].lineTotal]
      );
    }
    if (p.tabId) await client.query('DELETE FROM restaurant_open_tabs WHERE id = $1', [p.tabId]);
    return rowToOrder(order, lines);
  });
}

// ── open tables ────────────────────────────────────────────────────────
// An order kept on the till to add to and pay later. Priced for display at
// today's menu prices each time it is read; the sale itself is priced when
// it is paid (createOrder with tabId).

async function tabRows(companyId, where, args) {
  var res = await pool.query(
    'SELECT t.*, rt.name AS table_name, g.name AS guest_name, ' +
    "  we.first_name || ' ' || we.last_name AS waiter_name, oe.first_name || ' ' || oe.last_name AS opened_by_name " +
    'FROM restaurant_open_tabs t LEFT JOIN restaurant_tables rt ON rt.id = t.table_id LEFT JOIN restaurant_guests g ON g.id = t.guest_id ' +
    'LEFT JOIN employees we ON we.id = t.waiter_id LEFT JOIN employees oe ON oe.id = t.opened_by ' +
    'WHERE t.company_id = $1' + (where || '') + ' ORDER BY t.created_at', [companyId].concat(args || []));
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    var lines = [];
    var total = 0;
    var gone = 0;
    for (var j = 0; j < r.items.length; j++) {
      var it = r.items[j];
      try {
        var priced = await priceLines(pool, companyId, [it]);
        lines.push(Object.assign({ variationId: it.variationId || null }, priced.lines[0]));
        total += priced.lines[0].lineTotal;
      } catch (e) { gone += 1; }
    }
    out.push({
      id: r.id, label: r.label || '', tableId: r.table_id, tableName: r.table_name || null,
      waiterId: r.waiter_id, waiterName: r.waiter_name || null, guestId: r.guest_id, guestName: r.guest_name || null,
      openedBy: r.opened_by_name || null, createdAt: r.created_at, updatedAt: r.updated_at,
      lines: lines, total: Math.round(total * 100) / 100, unavailable: gone
    });
  }
  return out;
}

async function listTabs(token) {
  var session = verifyPosToken(token);
  return tabRows(session.posCompanyId);
}

// Saves the cart as an open table, or updates one (id). A table can only
// have one open tab at a time, so a second round is added to the first.
async function saveTab(token, p) {
  var session = verifyPosToken(token);
  var company = session.posCompanyId;
  var refs = await resolveRefs(pool, company, p);
  var priced = await priceLines(pool, company, p.items);
  var items = priced.lines.map(function (l) { return { menuItemId: l.menuItemId, variationId: l.variationId, qty: l.qty }; });
  var label = (typeof p.label === 'string' ? p.label.trim() : '').slice(0, 60);
  if (!refs.tableId && !label && !refs.guestId) fail('invalid', 'Pick a table or a guest, or give the order a name, so it can be found again.');
  if (refs.tableId) {
    var clash = await pool.query('SELECT id FROM restaurant_open_tabs WHERE company_id = $1 AND table_id = $2 AND id <> $3', [company, refs.tableId, p.id || '00000000-0000-0000-0000-000000000000']);
    if (clash.rows[0]) fail('conflict', 'That table already has an open order. Open it and add to it instead.');
  }
  var id;
  if (p.id) {
    var up = await pool.query(
      'UPDATE restaurant_open_tabs SET label = $3, table_id = $4, waiter_id = $5, guest_id = $6, items = $7, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING id',
      [p.id, company, label, refs.tableId, refs.waiterId, refs.guestId, JSON.stringify(items)]);
    if (!up.rows[0]) fail('notfound', 'That open table has already been paid or removed.');
    id = up.rows[0].id;
  } else {
    id = (await pool.query(
      'INSERT INTO restaurant_open_tabs (company_id, label, table_id, waiter_id, guest_id, items, opened_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [company, label, refs.tableId, refs.waiterId, refs.guestId, JSON.stringify(items), session.posEmployeeId])).rows[0].id;
  }
  return (await tabRows(company, ' AND t.id = $2', [id]))[0];
}

async function removeTab(token, id) {
  var session = verifyPosToken(token);
  var res = await pool.query('DELETE FROM restaurant_open_tabs WHERE id = $1 AND company_id = $2 RETURNING id', [id, session.posCompanyId]);
  if (!res.rows[0]) fail('notfound', 'That open table has already been paid or removed.');
  return { removed: true };
}

// ── the shift ──────────────────────────────────────────────────────────
// What this cashier has sold since their drawer opened: how many orders,
// how much, by payment method, and the latest orders (to reprint a
// receipt); how many tables are open; and, before a drawer is opened, how
// the last drawer at this restaurant was counted.
async function shiftSummary(token) {
  var session = verifyPosToken(token);
  var open = (await pool.query("SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId])).rows[0];
  var tabs = (await pool.query('SELECT count(*)::int AS n, min(created_at) AS oldest FROM restaurant_open_tabs WHERE company_id = $1', [session.posCompanyId])).rows[0];
  var last = (await pool.query(
    "SELECT s.closed_at, s.closing_actual_cash, e.first_name || ' ' || e.last_name AS cashier FROM restaurant_drawer_sessions s JOIN employees e ON e.id = s.cashier_id " +
    "WHERE s.company_id = $1 AND s.status = 'closed' ORDER BY s.closed_at DESC LIMIT 1", [session.posCompanyId])).rows[0];
  var out = {
    openTabs: tabs.n, oldestTab: tabs.oldest,
    lastClosed: last ? { closedAt: last.closed_at, counted: Number(last.closing_actual_cash || 0), cashierName: last.cashier } : null,
    orders: 0, sales: 0, byMethod: [], recent: []
  };
  if (!open) return out;
  var WHERE = "o.cashier_id = $1 AND o.company_id = $2 AND o.status = 'completed' AND o.created_at >= $3";
  var args = [session.posEmployeeId, session.posCompanyId, open.opened_at];
  var byMethod = (await pool.query('SELECT o.payment_method, count(*)::int AS n, sum(o.total) AS total FROM restaurant_orders o WHERE ' + WHERE + ' GROUP BY 1 ORDER BY 3 DESC', args)).rows;
  var recent = (await pool.query(
    'SELECT o.id, o.order_no, o.total, o.payment_method, o.created_at, t.name AS table_name, ' +
    '  (SELECT sum(qty) FROM restaurant_order_items i WHERE i.order_id = o.id) AS items ' +
    'FROM restaurant_orders o LEFT JOIN restaurant_tables t ON t.id = o.table_id WHERE ' + WHERE + ' ORDER BY o.created_at DESC LIMIT 8', args)).rows;
  out.byMethod = byMethod.map(function (r) { return { method: r.payment_method, orders: r.n, total: Number(r.total) }; });
  out.orders = out.byMethod.reduce(function (s, r) { return s + r.orders; }, 0);
  out.sales = Math.round(out.byMethod.reduce(function (s, r) { return s + r.total; }, 0) * 100) / 100;
  out.recent = recent.map(function (r) {
    return { id: r.id, orderNo: r.order_no, total: Number(r.total), paymentMethod: r.payment_method, createdAt: r.created_at, tableName: r.table_name || null, items: Number(r.items || 0) };
  });
  return out;
}

// One of this restaurant's orders again, for reprinting its receipt.
async function receiptForSession(token, id) {
  var session = verifyPosToken(token);
  var o = (await pool.query(
    "SELECT o.*, t.name AS table_name, g.name AS guest_name, we.first_name || ' ' || we.last_name AS waiter_name, ce.first_name || ' ' || ce.last_name AS cashier_name " +
    'FROM restaurant_orders o LEFT JOIN restaurant_tables t ON t.id = o.table_id LEFT JOIN restaurant_guests g ON g.id = o.guest_id ' +
    'LEFT JOIN employees we ON we.id = o.waiter_id LEFT JOIN employees ce ON ce.id = o.cashier_id WHERE o.id = $1 AND o.company_id = $2', [id, session.posCompanyId])).rows[0];
  if (!o) fail('notfound', 'Order not found.');
  var items = (await pool.query('SELECT menu_item_id, name, qty, unit_price, line_total FROM restaurant_order_items WHERE order_id = $1 ORDER BY id', [o.id])).rows;
  return Object.assign(rowToOrder(o, items.map(function (it) {
    return { menuItemId: it.menu_item_id, name: it.name, qty: Number(it.qty), unitPrice: Number(it.unit_price), lineTotal: Number(it.line_total) };
  })), { tableName: o.table_name || null, guestName: o.guest_name || null, waiterName: o.waiter_name || null, cashierName: o.cashier_name || null });
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

  // revenue_total/voided_count are window functions too (revenue counts
  // completed orders only — a voided sale was never money in) — computed over the
  // whole WHERE-filtered set before LIMIT clips it to one page, same as
  // total_count, so the Sales tab's stat tiles show true range-wide figures
  // rather than a partial, misleadingly-small sum of just the visible page.
  var res = await pool.query(
    'SELECT o.*, e.first_name, e.last_name, t.name AS table_name, w.first_name AS waiter_first_name, w.last_name AS waiter_last_name, ' +
    'g.name AS guest_name, count(*) OVER() AS total_count, ' +
    "coalesce(sum(o.total) FILTER (WHERE o.status = 'completed') OVER(), 0) AS revenue_total, count(*) FILTER (WHERE o.status = 'voided') OVER() AS voided_count " +
    'FROM restaurant_orders o JOIN employees e ON e.id = o.cashier_id ' +
    'LEFT JOIN restaurant_tables t ON t.id = o.table_id LEFT JOIN employees w ON w.id = o.waiter_id LEFT JOIN restaurant_guests g ON g.id = o.guest_id ' +
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
        tableName: r.table_name, waiterName: r.waiter_first_name ? r.waiter_first_name + ' ' + r.waiter_last_name : null, guestName: r.guest_name,
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
    'SELECT o.*, e.first_name, e.last_name, t.name AS table_name, w.first_name AS waiter_first_name, w.last_name AS waiter_last_name, g.name AS guest_name, g.phone AS guest_phone ' +
    'FROM restaurant_orders o JOIN employees e ON e.id = o.cashier_id ' +
    'LEFT JOIN restaurant_tables t ON t.id = o.table_id LEFT JOIN employees w ON w.id = o.waiter_id LEFT JOIN restaurant_guests g ON g.id = o.guest_id ' +
    'WHERE o.id = $1',
    [id]
  );
  var order = orderRes.rows[0];
  if (!order) fail('notfound', 'Order not found.');
  var itemsRes = await pool.query(
    'SELECT name, qty, unit_price, line_total FROM restaurant_order_items WHERE order_id = $1 ORDER BY name', [id]
  );
  return {
    id: order.id, companyId: order.company_id, orderNo: order.order_no, cashierName: order.first_name + ' ' + order.last_name,
    tableName: order.table_name, waiterName: order.waiter_first_name ? order.waiter_first_name + ' ' + order.waiter_last_name : null,
    guestName: order.guest_name, guestPhone: order.guest_phone,
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

// ── cash drawer sessions (till-side, PIN-scoped — same posToken as the
// rest of this file) ──────────────────────────────────────────────────

function rowToSession(r) {
  return {
    id: r.id, companyId: r.company_id, cashierId: r.cashier_id,
    openedAt: r.opened_at, closedAt: r.closed_at,
    startingCash: Number(r.starting_cash),
    closingActualCash: r.closing_actual_cash == null ? null : Number(r.closing_actual_cash),
    closingNote: r.closing_note, status: r.status
  };
}

// Every figure the reference "Drawer Report" receipt prints, computed
// fresh rather than stored — so it's always consistent with whatever
// orders/movements actually happened, even if this is called mid-shift
// (session still open, closedAt not set yet) to show a running total.
async function buildReport(session, client) {
  var db = client || pool;
  var endTime = session.closed_at || new Date();
  var salesRes = await db.query(
    "SELECT coalesce(sum(total), 0) AS cash_sales FROM restaurant_orders " +
    "WHERE cashier_id = $1 AND company_id = $2 AND payment_method = 'cash' AND status = 'completed' " +
    'AND created_at >= $3 AND created_at <= $4',
    [session.cashier_id, session.company_id, session.opened_at, endTime]
  );
  var movementsRes = await db.query(
    "SELECT direction, coalesce(sum(amount), 0) AS total FROM restaurant_drawer_movements WHERE session_id = $1 GROUP BY direction",
    [session.id]
  );
  var paidIn = 0, paidOut = 0;
  movementsRes.rows.forEach(function (r) {
    if (r.direction === 'in') paidIn = Number(r.total); else paidOut = Number(r.total);
  });
  var movementsListRes = await db.query(
    'SELECT id, direction, amount, note, created_at FROM restaurant_drawer_movements WHERE session_id = $1 ORDER BY created_at',
    [session.id]
  );
  var startingCash = Number(session.starting_cash);
  var cashSales = Number(salesRes.rows[0].cash_sales);
  // No refund tender exists on the till (voids are a manager-only action
  // on already-settled orders, not a cash-back-to-customer event) — kept
  // as an explicit zero, not omitted, so this report's shape always
  // matches the reference receipt's line items.
  var cashRefunds = 0;
  var netPaidInOut = paidIn - paidOut;
  var expected = Math.round((startingCash + cashSales - cashRefunds + netPaidInOut) * 100) / 100;
  var actual = session.closing_actual_cash == null ? null : Number(session.closing_actual_cash);
  return {
    session: rowToSession(session),
    startingCash: startingCash, cashSales: cashSales, cashRefunds: cashRefunds,
    paidIn: paidIn, paidOut: paidOut, netPaidInOut: netPaidInOut,
    expected: expected, actual: actual, difference: actual == null ? null : Math.round((actual - expected) * 100) / 100,
    movements: movementsListRes.rows.map(function (m) {
      return { id: m.id, direction: m.direction, amount: Number(m.amount), note: m.note, createdAt: m.created_at };
    })
  };
}

// Current cashier's open session, or null — checked on POS login/reload
// so the till knows whether to prompt for a starting-cash count before
// letting them sell anything.
async function getOpenDrawerSession(token) {
  var session = verifyPosToken(token);
  var res = await pool.query(
    "SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId]
  );
  if (!res.rows[0]) return null;
  return buildReport(res.rows[0]);
}

async function openDrawerSession(token, startingCash) {
  var session = verifyPosToken(token);
  // Idempotent — a reload right after opening (or two tabs on the same
  // PIN) resumes the existing open session instead of erroring, same
  // spirit as the till-session token restore already does.
  var existing = await pool.query("SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId]);
  if (existing.rows[0]) return buildReport(existing.rows[0]);

  var amount = Math.max(0, Number(startingCash) || 0);
  var res = await pool.query(
    'INSERT INTO restaurant_drawer_sessions (company_id, cashier_id, starting_cash) VALUES ($1,$2,$3) RETURNING *',
    [session.posCompanyId, session.posEmployeeId, amount]
  );
  return buildReport(res.rows[0]);
}

async function addDrawerMovement(token, p) {
  var session = verifyPosToken(token);
  var direction = V.oneOf(p.direction, ['in', 'out'], 'Direction');
  var amount = Number(p.amount);
  if (!(amount > 0)) fail('invalid', 'Enter an amount greater than zero.');

  var openRes = await pool.query("SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId]);
  var drawer = openRes.rows[0];
  if (!drawer) fail('conflict', 'No open drawer session — open one first.');

  await pool.query(
    'INSERT INTO restaurant_drawer_movements (session_id, direction, amount, note) VALUES ($1,$2,$3,$4)',
    [drawer.id, direction, Math.round(amount * 100) / 100, (p.note || '').trim()]
  );
  return buildReport(drawer);
}

async function closeDrawerSession(token, p) {
  var session = verifyPosToken(token);
  return withTransaction(async function (client) {
    var openRes = await client.query("SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open' FOR UPDATE", [session.posEmployeeId]);
    var drawer = openRes.rows[0];
    if (!drawer) fail('conflict', 'No open drawer session to close.');
    var actualCash = Math.max(0, Number(p.actualCash) || 0);
    var closedRes = await client.query(
      "UPDATE restaurant_drawer_sessions SET status = 'closed', closed_at = now(), closing_actual_cash = $1, closing_note = $2 WHERE id = $3 RETURNING *",
      [actualCash, (p.note || '').trim(), drawer.id]
    );
    return buildReport(closedRes.rows[0], client);
  });
}

// ── management view (inside the regular authenticated app) ────────────

async function listDrawerSessions(ctx, companyId, opts) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  opts = opts || {};
  var limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  var offset = Math.max(Number(opts.offset) || 0, 0);
  var args = [];
  var where = [];
  if (companyId) { args.push(companyId); where.push('s.company_id = $' + args.length); }
  if (opts.from) { args.push(opts.from); where.push('s.opened_at >= $' + args.length); }
  if (opts.to) { args.push(opts.to + ' 23:59:59'); where.push('s.opened_at <= $' + args.length); }
  var whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  args.push(limit); var limitParam = '$' + args.length;
  args.push(offset); var offsetParam = '$' + args.length;

  var res = await pool.query(
    'SELECT s.*, e.first_name, e.last_name, count(*) OVER() AS total_count ' +
    'FROM restaurant_drawer_sessions s JOIN employees e ON e.id = s.cashier_id ' +
    whereSql + ' ORDER BY s.opened_at DESC LIMIT ' + limitParam + ' OFFSET ' + offsetParam,
    args
  );
  var total = res.rows[0] ? Number(res.rows[0].total_count) : 0;
  var reports = await Promise.all(res.rows.map(function (r) { return buildReport(r); }));
  return {
    sessions: reports.map(function (rep, i) {
      var r = res.rows[i];
      return Object.assign({ cashierName: r.first_name + ' ' + r.last_name }, rep);
    }),
    total: total, limit: limit, offset: offset
  };
}

async function getDrawerSession(ctx, id) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  var res = await pool.query(
    'SELECT s.*, e.first_name, e.last_name FROM restaurant_drawer_sessions s JOIN employees e ON e.id = s.cashier_id WHERE s.id = $1', [id]
  );
  var r = res.rows[0];
  if (!r) fail('notfound', 'Drawer session not found.');
  var report = await buildReport(r);
  return Object.assign({ cashierName: r.first_name + ' ' + r.last_name }, report);
}

module.exports = {
  login: login, menuForSession: menuForSession, createOrder: createOrder,
  listOrders: listOrders, getOrder: getOrder, voidOrder: voidOrder,
  toggleFavorite: toggleFavorite, mostlyBought: mostlyBought,
  getOpenDrawerSession: getOpenDrawerSession, openDrawerSession: openDrawerSession,
  addDrawerMovement: addDrawerMovement, closeDrawerSession: closeDrawerSession,
  listDrawerSessions: listDrawerSessions, getDrawerSession: getDrawerSession,
  tablesForSession: tablesForSession, waitersForSession: waitersForSession,
  guestsForSession: guestsForSession, createGuestForSession: createGuestForSession,
  listTabs: listTabs, saveTab: saveTab, removeTab: removeTab,
  shiftSummary: shiftSummary, receiptForSession: receiptForSession
};
