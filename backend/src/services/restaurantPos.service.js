var jwt = require('jsonwebtoken');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var config = require('../config');
var pinAuth = require('../lib/pinAuth');
var kitchen = require('./restaurantKitchen.service');
var money = require('./restaurantTillMoney.service');
var restaurantService = require('./restaurant.service');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var screens = require('./restaurantKdsScreens.service');
var disputes = require('./restaurantDisputes.service');
var tillMenu = require('./restaurantTillMenu.service');

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

// app 'kds': on a kitchen screen a manager has set up (screenToken), at
// the cook's own restaurant; the session carries the screen.
async function login(pin, ip, app, screenToken) {
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
  // Their role decides whether they use the till or the kitchen screen.
  await access.checkSignIn(emp.company_id, emp.id, app);
  var screen = app === 'kds' ? await screens.forSignIn(screenToken, emp.company_id, emp.id) : null;
  await activity.log(pool, { companyId: emp.company_id, employeeId: emp.id, app: app === 'kds' ? 'kds' : 'till', action: app === 'kds' ? 'kds.signin' : 'till.signin',
    summary: emp.first_name + ' ' + emp.last_name + ' signed in to the ' + (screen ? 'kitchen screen ' + screen.name + '.' : 'till.'), refType: screen ? 'screen' : null, refId: screen ? screen.id : null });
  var claims = { posEmployeeId: emp.id, posCompanyId: emp.company_id };
  if (screen) claims.kdsScreenId = screen.id;
  var token = jwt.sign(claims, config.jwt.secret, { expiresIn: POS_TOKEN_EXPIRES_IN });
  return {
    screen: screen ? { id: screen.id, name: screen.name, stationId: screen.station_id, stationName: screen.station_name || null } : undefined,
    token: token,
    employeeName: emp.first_name + ' ' + emp.last_name,
    companyId: emp.company_id,
    companyName: emp.company_name,
    companyCode: emp.company_code
  };
}

// Someone signs out of the till or the kitchen screen — to step away, or
// the till signed them out after going unused (reason 'idle') — for the
// activity log. Their cash drawer is not touched: it stays open, with all
// it holds, until they count and close it.
async function signOut(token, reason) {
  var session = verifyPosToken(token);
  var emp = (await pool.query('SELECT first_name, last_name FROM employees WHERE id = $1', [session.posEmployeeId])).rows[0];
  if (!emp) return { signedOut: true };
  var kds = !!session.kdsScreenId, idle = reason === 'idle';
  var where = kds ? 'kitchen screen' : 'till';
  var drawer = kds ? null : (await pool.query("SELECT id FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId])).rows[0];
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: kds ? 'kds' : 'till', action: kds ? 'kds.signout' : 'till.signout',
    summary: emp.first_name + ' ' + emp.last_name + (idle ? ' was signed out after the ' + where + ' went unused' : ' signed out of the ' + where) + (drawer ? '; their cash drawer stays open.' : '.'),
    refType: drawer ? 'drawer' : (kds ? 'screen' : null), refId: drawer ? drawer.id : (kds ? session.kdsScreenId : null), details: { reason: idle ? 'idle' : 'manual', drawerOpen: !!drawer } });
  return { signedOut: true, drawerOpen: !!drawer };
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

// payments: the parts it was paid in (restaurantTillMoney.paymentsOf), or
// none for a sale from before they were kept.
function rowToOrder(order, items, payments) {
  payments = payments || [];
  var change = payments.length ? Math.round(payments.reduce(function (a, p) { return a + (p.changeGiven || 0); }, 0) * 100) / 100 : null;
  var cashGiven = order.cash_tendered == null ? null : Number(order.cash_tendered);
  return {
    id: order.id, companyId: order.company_id, orderNo: order.order_no, cashierId: order.cashier_id,
    subtotal: Number(order.subtotal), total: Number(order.total), paymentMethod: order.payment_method,
    status: order.status, createdAt: order.created_at,
    tableId: order.table_id, waiterId: order.waiter_id, guestId: order.guest_id,
    fulfillment: order.fulfillment || '', customerName: order.customer_name || '', customerPhone: order.customer_phone || '', deliveryAddress: order.delivery_address || '',
    cashTendered: cashGiven,
    change: payments.length ? (change > 0 || cashGiven != null ? change : null) : (cashGiven == null ? null : Math.round((cashGiven - Number(order.total)) * 100) / 100),
    payments: payments,
    items: items.map(function (it) { return { menuItemId: it.menuItemId, name: it.name, qty: it.qty, unitPrice: it.unitPrice, lineTotal: it.lineTotal, note: it.note || '', custom: !!it.custom }; })
  };
}

// POS menu — active items only, for the company the till session is
// scoped to. Not gated on restaurant.read (the till has no logged-in
// user), gated on a valid POS session instead.
async function menuForSession(token) {
  var session = await access.need(token, 'till');
  var res = await pool.query(
    'SELECT id, name, category, price, photo_object_key, favorite FROM restaurant_menu_items WHERE company_id = $1 AND active = true ORDER BY category, name',
    [session.posCompanyId]
  );
  return tillMenu.tileStock(session.posCompanyId, await attachVariationsToTiles(res.rows.map(rowToTile)));
}

function rowToTile(r) {
  return {
    id: r.id, name: r.name, category: r.category, price: Number(r.price),
    photoUrl: restaurantService.menuThumbUrl(r.id, r.photo_object_key),
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
  var session = await access.need(token, 'favorites');
  var res = await pool.query(
    'UPDATE restaurant_menu_items SET favorite = NOT favorite, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING id, favorite',
    [itemId, session.posCompanyId]
  );
  if (!res.rows[0]) fail('notfound', 'Menu item not found.');
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.favorite',
    summary: (res.rows[0].favorite ? 'Starred a dish as a favourite.' : 'Took a dish off the favourites.'), refType: 'menu_item', refId: itemId });
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
  var session = await access.need(token, 'till');
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
  return tillMenu.tileStock(session.posCompanyId, await attachVariationsToTiles(tiles));
}

// Active tables for the till's own company — the fixed, management-set
// list (restaurant.service.js's createTable), not free text.
// With where each stands on the floor map (set in the till settings).
async function tablesForSession(token) {
  var session = await access.need(token, 'till');
  var res = await pool.query(
    "SELECT id, name, map_x, map_y, shape, seats, area FROM restaurant_tables WHERE company_id = $1 AND status = 'active' ORDER BY name",
    [session.posCompanyId]
  );
  return res.rows.map(access.tableOut);
}

// Waiters — any active employee at the till's company, not just whoever
// has a kiosk PIN (the person serving a table doesn't need till access
// themselves; the cashier picks their name from this list). Same
// department-join pattern login() already uses to resolve a company from
// an employee.
async function waitersForSession(token) {
  var session = await access.need(token, 'till');
  var res = await pool.query(
    "SELECT e.id, e.first_name, e.last_name FROM employees e JOIN departments d ON d.id = e.department_id " +
    "WHERE d.company_id = $1 AND e.status = 'active' ORDER BY e.first_name, e.last_name",
    [session.posCompanyId]
  );
  return res.rows.map(function (r) { return { id: r.id, name: r.first_name + ' ' + r.last_name }; });
}

// A customer, with their accounts: VIP (money put down — they have one
// once anything was put down) and IOU (allowed to owe, by a manager).
function rowToGuestTile(r) {
  return {
    id: r.id, name: r.name, phone: r.phone,
    vip: !!r.vip, vipBalance: r.vip_balance == null ? 0 : Math.round(Number(r.vip_balance) * 100) / 100,
    iouAllowed: !!r.iou_allowed, iouLimit: r.iou_limit == null ? null : Number(r.iou_limit), iouOwed: r.owed == null ? 0 : Math.round(Number(r.owed) * 100) / 100
  };
}
var GUEST_SELECT =
  'SELECT g.id, g.name, g.phone, g.iou_allowed, g.iou_limit, v.balance AS vip_balance, (v.guest_id IS NOT NULL) AS vip, i.owed ' +
  'FROM restaurant_guests g LEFT JOIN (SELECT guest_id, sum(amount) AS balance FROM restaurant_vip_entries GROUP BY guest_id) v ON v.guest_id = g.id ' +
  "LEFT JOIN (SELECT guest_id, sum(total - refunded_total) AS owed FROM restaurant_orders WHERE payment_method = 'iou' AND status = 'completed' AND iou_paid_at IS NULL GROUP BY guest_id) i ON i.guest_id = g.id ";

async function guestsForSession(token, q) {
  var session = await access.need(token, 'till');
  var args = [session.posCompanyId];
  var where = 'g.company_id = $1';
  if (q) { args.push('%' + q + '%'); where += ' AND (g.name ILIKE $2 OR g.phone ILIKE $2)'; }
  var res = await pool.query(GUEST_SELECT + 'WHERE ' + where + ' ORDER BY (v.guest_id IS NOT NULL OR g.iou_allowed) DESC, g.name LIMIT 50', args);
  return res.rows.map(rowToGuestTile);
}
async function guestById(db, companyId, id) {
  return (await db.query(GUEST_SELECT + 'WHERE g.id = $1 AND g.company_id = $2', [id, companyId])).rows[0] || null;
}

// Quick-add from the till itself — a walk-in the cashier hasn't seen
// before shouldn't require leaving the sale screen to go set them up in
// the management app first.
async function createGuestForSession(token, p) {
  var session = await access.need(token, 'till');
  var name = V.text(p.name, 'Name', 100);
  var res = await pool.query(
    "INSERT INTO restaurant_guests (company_id, name, phone, source) VALUES ($1,$2,$3,'till') RETURNING id, name, phone, iou_allowed, iou_limit",
    [session.posCompanyId, name, (p.phone || '').trim().slice(0, 40)]
  );
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.customer',
    summary: 'Added the customer ' + name + '.', refType: 'guest', refId: res.rows[0].id });
  return rowToGuestTile(res.rows[0]);
}

// Dine in (at a table), pickup (at the counter) or delivery (needs who, a
// phone and where). An order from before these says nothing ('').
var FULFILLMENT_NAME = { dine_in: 'Dine in', pickup: 'Pickup', delivery: 'Delivery' };
function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
async function orderType(client, companyId, p, refs) {
  var f = p.fulfillment === undefined || p.fulfillment === null || p.fulfillment === '' ? '' : V.oneOf(p.fulfillment, access.FULFILLMENTS, 'Dine in, pickup or delivery');
  var guest = refs.guestId ? (await client.query('SELECT name, phone FROM restaurant_guests WHERE id = $1', [refs.guestId])).rows[0] : null;
  var out = { fulfillment: f, customerName: cleanText(p.customerName, 120) || (guest ? guest.name : ''), customerPhone: cleanText(p.customerPhone, 40) || (guest ? guest.phone || '' : ''), deliveryAddress: '' };
  if (f === 'dine_in' && !refs.tableId) {
    var hasTables = (await client.query("SELECT 1 FROM restaurant_tables WHERE company_id = $1 AND status = 'active' LIMIT 1", [companyId])).rows.length > 0;
    if (hasTables) fail('invalid', 'Pick the table for this dine-in order.');
  }
  if (f === 'pickup' || f === 'delivery') refs.tableId = null;
  if (f === 'delivery') {
    out.deliveryAddress = cleanText(p.deliveryAddress, 300);
    if (!out.customerName) fail('invalid', 'A delivery needs the customer\'s name.');
    if (!out.customerPhone) fail('invalid', 'A delivery needs a phone number to reach the customer.');
    if (!out.deliveryAddress) fail('invalid', 'A delivery needs the location to take it to.');
  }
  return out;
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
// The table's, waiter's and customer's names, for a kitchen ticket; a
// pickup is at the counter, and a delivery goes to its customer.
async function refNames(client, refs, type) {
  var r = (await client.query(
    "SELECT (SELECT name FROM restaurant_tables WHERE id = $1) AS table_name, (SELECT first_name || ' ' || last_name FROM employees WHERE id = $2) AS waiter_name, " +
    '(SELECT name FROM restaurant_guests WHERE id = $3) AS guest_name', [refs.tableId, refs.waiterId, refs.guestId])).rows[0];
  type = type || {};
  return {
    tableName: r.table_name || (type.fulfillment === 'pickup' ? 'Counter' : type.fulfillment === 'delivery' ? 'Delivery' : null),
    waiterName: r.waiter_name || null, guestName: r.guest_name || type.customerName || null,
    fulfillment: type.fulfillment || '', customerPhone: type.customerPhone || '', deliveryAddress: type.deliveryAddress || ''
  };
}

// Prices each line against the LIVE menu (never a client-supplied price).
// If an item has price variations (Square-style "M" vs "Jellyfish"), the
// till must say which one was picked — never fall back to the item's own
// flat price, which isn't meaningful once variations exist. An item with
// none ignores whatever variationId the client sends.
// A dish not on the menu (custom: { name, price, category }) is priced as
// the till says — only for roles that may add one (allowCustom). Each line
// may carry a note for the kitchen ("no onions").
async function priceLines(client, companyId, items, allowCustom) {
  if (!Array.isArray(items) || !items.length) fail('invalid', 'Add at least one item.');
  var lines = [];
  var subtotal = 0;
  for (var i = 0; i < items.length; i++) {
    var qty = Math.max(0.01, Number(items[i].qty) || 0);
    var note = cleanText(items[i].note, 140);
    if (items[i].custom) {
      if (!allowCustom) fail('forbidden', 'Your role on the till cannot add a dish that is not on the menu. Ask a manager.');
      var cname = cleanText(items[i].custom.name, 80);
      var cprice = Math.round(Number(items[i].custom.price) * 100) / 100;
      if (!cname) fail('invalid', 'Give the dish that is not on the menu a name.');
      if (!(cprice >= 0 && cprice < 1000000)) fail('invalid', 'Give ' + cname + ' a price.');
      var cTotal = Math.round(qty * cprice * 100) / 100;
      subtotal += cTotal;
      lines.push({ menuItemId: null, variationId: null, name: cname, qty: qty, unitPrice: cprice, lineTotal: cTotal, note: note, custom: true, category: cleanText(items[i].custom.category, 120) });
      continue;
    }
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
    lines.push({ menuItemId: m.id, variationId: variationId, name: name, qty: qty, unitPrice: unitPrice, lineTotal: lineTotal, note: note, custom: false });
  }
  return { lines: lines, subtotal: Math.round(subtotal * 100) / 100 };
}

// Rings up a sale, paid one way or several (p.payments: [{ method,
// amount, currency, tendered }] — restaurantTillMoney.planPayments; an
// older till sends paymentMethod and cashTendered). Paying an order kept
// open (tabId) rings it up and removes it in the same transaction, so it
// is never paid twice. Dine in needs its table, pickup is at the counter,
// a delivery needs who, a phone and where (orderType).
async function createOrder(token, p) {
  var session = await access.need(token, 'charge');
  p = p || {};
  var tillSettings = session.access.settings;
  if (tillSettings.requireWaiter && p.tableId && !p.waiterId && p.fulfillment !== 'pickup' && p.fulfillment !== 'delivery') fail('invalid', 'Pick the waiter for this table.');
  var asked = Array.isArray(p.payments) && p.payments.length ? p.payments
    : [{ method: p.paymentMethod || 'cash', tendered: p.cashTendered }];

  return withTransaction(async function (client) {
    await money.needDrawer(client, session.posEmployeeId);
    var tab = null;
    if (p.tabId) {
      var tabRes = await client.query('SELECT id, label FROM restaurant_open_tabs WHERE id = $1 AND company_id = $2 FOR UPDATE', [p.tabId, session.posCompanyId]);
      if (!tabRes.rows[0]) fail('conflict', 'That open order has already been paid or removed.');
      tab = tabRes.rows[0];
    }
    var refs = await resolveRefs(client, session.posCompanyId, p);
    var type = await orderType(client, session.posCompanyId, p, refs);
    var priced = await priceLines(client, session.posCompanyId, p.items, session.access.can.customItem);
    var lines = priced.lines;
    var subtotal = priced.subtotal;
    // A new sale cannot take more than is left of a counted dish; an open
    // order's food was sent already and is always paid.
    if (!tab) await tillMenu.checkOrder(client, session.posCompanyId, lines, null, null);
    var plan = money.planPayments(session, subtotal, asked);

    var companyRes = await client.query('SELECT code FROM companies WHERE id = $1', [session.posCompanyId]);
    var seqRes = await client.query("SELECT nextval('restaurant_order_seq') AS n");
    var orderNo = companyRes.rows[0].code + '-' + String(seqRes.rows[0].n).padStart(6, '0');

    var orderRes = await client.query(
      'INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, payment_method, table_id, waiter_id, guest_id, cash_tendered, ' +
      '  fulfillment, customer_name, customer_phone, delivery_address) ' +
      'VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
      [session.posCompanyId, orderNo, session.posEmployeeId, subtotal, plan.method, refs.tableId, refs.waiterId, refs.guestId, plan.cashTendered,
        type.fulfillment, type.customerName, type.customerPhone, type.deliveryAddress]
    );
    var order = orderRes.rows[0];
    for (var j = 0; j < lines.length; j++) {
      await client.query(
        'INSERT INTO restaurant_order_items (order_id, menu_item_id, variation_id, name, qty, unit_price, line_total, gross, note, custom, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)',
        [order.id, lines[j].menuItemId, lines[j].variationId, lines[j].name, lines[j].qty, lines[j].unitPrice, lines[j].lineTotal, lines[j].note || '', !!lines[j].custom, j]
      );
    }
    await tillMenu.deductForSale(client, session.posCompanyId, order.id, session.posEmployeeId, lines);
    await money.savePayments(client, order.id, plan.rows);
    var vip = await money.chargeSale(client, session.posCompanyId, order, session.posEmployeeId, plan.rows);
    // To the kitchen: what was not sent with the open order yet, or the
    // whole sale; the open order's tickets now belong to the sale.
    var names = await refNames(client, refs, type);
    var ticket = await kitchen.fire(client, session.posCompanyId, Object.assign({
      lines: lines, tabId: tab ? tab.id : null, orderId: order.id, label: tab ? (tab.label || names.tableName || names.guestName || orderNo) : (type.customerName || orderNo),
      note: p.kitchenNote, sentBy: session.posEmployeeId
    }, names));
    if (tab) {
      await client.query('UPDATE restaurant_kitchen_tickets SET order_id = $1 WHERE tab_id = $2 AND company_id = $3', [order.id, tab.id, session.posCompanyId]);
      await client.query('DELETE FROM restaurant_open_tabs WHERE id = $1', [p.tabId]);
    }
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.sale',
      summary: 'Sale ' + orderNo + ': ' + subtotal.toFixed(2) + ' by ' + money.paymentText(plan.rows) +
        (type.fulfillment ? ' · ' + FULFILLMENT_NAME[type.fulfillment] : '') + (names.tableName && type.fulfillment !== 'pickup' && type.fulfillment !== 'delivery' ? ' · ' + names.tableName : '') +
        (names.guestName ? ' · ' + names.guestName : '') + '.',
      amount: subtotal, refType: 'order', refId: order.id,
      details: { method: plan.method, payments: plan.rows.map(function (r) { return { method: r.method, amount: r.amount, currency: r.currency }; }),
        dishes: lines.map(function (l) { return l.qty + '× ' + l.name + (l.note ? ' (' + l.note + ')' : ''); }), fulfillment: type.fulfillment, kitchenTicket: ticket ? ticket.number : null } });
    var paid = (await money.paymentsOf(client, [order.id])).get(order.id) || [];
    return Object.assign(rowToOrder(order, lines, paid), { kitchenTicket: ticket, vipBalance: vip ? vip.balance : null });
  });
}

// ── open tables ────────────────────────────────────────────────────────
// An order kept on the till to add to and pay later. Priced for display at
// today's menu prices each time it is read; the sale itself is priced when
// it is paid (createOrder with tabId).

async function tabRows(companyId, where, args) {
  var res = await pool.query(
    'SELECT t.*, rt.name AS table_name, g.name AS guest_name, g.phone AS guest_phone, ' +
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
        var priced = await priceLines(pool, companyId, [it], true);
        lines.push(Object.assign({ variationId: it.variationId || null }, priced.lines[0]));
        total += priced.lines[0].lineTotal;
      } catch (e) { gone += 1; }
    }
    out.push({
      id: r.id, label: r.label || '', tableId: r.table_id, tableName: r.table_name || null,
      waiterId: r.waiter_id, waiterName: r.waiter_name || null, guestId: r.guest_id, guestName: r.guest_name || null, guestPhone: r.guest_phone || null,
      fulfillment: r.fulfillment || 'dine_in', customerName: r.customer_name || '', customerPhone: r.customer_phone || '', deliveryAddress: r.delivery_address || '',
      openedBy: r.opened_by_name || null, createdAt: r.created_at, updatedAt: r.updated_at,
      lines: lines, total: Math.round(total * 100) / 100, unavailable: gone, kitchen: null
    });
  }
  // Where each one's food stands: cooking, ready, served (a tag on the till).
  var st = await kitchen.statusOf(pool, companyId, 'tab_id', out.map(function (t) { return t.id; }));
  out.forEach(function (t) { t.kitchen = st[t.id] || null; });
  return out;
}

async function listTabs(token) {
  var session = await access.need(token, 'till');
  return tabRows(session.posCompanyId);
}

// Sends the order to the kitchen and keeps it open to pay later, or
// updates one (id) with a new round. A table can only have one open order
// at a time, so a second round is added to the first. Pickup orders wait
// at the counter under the customer's name; a delivery keeps who, the
// phone and where.
async function saveTab(token, p) {
  var session = await access.need(token, 'keepOpen');
  p = p || {};
  if (session.access.settings.requireWaiter && p.tableId && !p.waiterId && p.fulfillment !== 'pickup' && p.fulfillment !== 'delivery') fail('invalid', 'Pick the waiter for this table.');
  var company = session.posCompanyId;
  var refs = await resolveRefs(pool, company, p);
  var type = await orderType(pool, company, p, refs);
  var priced = await priceLines(pool, company, p.items, session.access.can.customItem);
  var items = priced.lines.map(function (l) {
    return l.custom ? { custom: { name: l.name, price: l.unitPrice, category: l.category || '' }, qty: l.qty, note: l.note || '' }
      : { menuItemId: l.menuItemId, variationId: l.variationId, qty: l.qty, note: l.note || '' };
  });
  var label = (typeof p.label === 'string' ? p.label.trim() : '').slice(0, 60);
  if (!label && type.fulfillment !== 'dine_in' && type.customerName) label = type.customerName.slice(0, 60);
  if (!refs.tableId && !label && !refs.guestId) fail('invalid', 'Pick a table or a customer, or give the order a name, so it can be found again.');
  if (refs.tableId) {
    var clash = await pool.query('SELECT id FROM restaurant_open_tabs WHERE company_id = $1 AND table_id = $2 AND id <> $3', [company, refs.tableId, p.id || '00000000-0000-0000-0000-000000000000']);
    if (clash.rows[0]) fail('conflict', 'That table already has an open order. Open it and add to it instead.');
  }
  // No more of a counted dish than is left (what the order held already stays).
  var before = p.id ? (await pool.query('SELECT items FROM restaurant_open_tabs WHERE id = $1 AND company_id = $2', [p.id, company])).rows[0] : null;
  await tillMenu.checkOrder(pool, company, priced.lines, p.id || null, before ? before.items : null);
  // Saved and sent to the kitchen together: the new round goes, what was
  // taken off is cancelled (restaurantKitchen.service.js fire).
  var sent = await withTransaction(async function (client) {
    var id;
    if (p.id) {
      var up = await client.query(
        'UPDATE restaurant_open_tabs SET label = $3, table_id = $4, waiter_id = $5, guest_id = $6, items = $7, fulfillment = $8, customer_name = $9, customer_phone = $10, delivery_address = $11, updated_at = now() ' +
        'WHERE id = $1 AND company_id = $2 RETURNING id',
        [p.id, company, label, refs.tableId, refs.waiterId, refs.guestId, JSON.stringify(items), type.fulfillment || 'dine_in', type.customerName, type.customerPhone, type.deliveryAddress]);
      if (!up.rows[0]) fail('notfound', 'That open order has already been paid or removed.');
      id = up.rows[0].id;
    } else {
      id = (await client.query(
        'INSERT INTO restaurant_open_tabs (company_id, label, table_id, waiter_id, guest_id, items, opened_by, fulfillment, customer_name, customer_phone, delivery_address) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
        [company, label, refs.tableId, refs.waiterId, refs.guestId, JSON.stringify(items), session.posEmployeeId, type.fulfillment || 'dine_in', type.customerName, type.customerPhone, type.deliveryAddress])).rows[0].id;
    }
    var names = await refNames(client, refs, type);
    var ticket = await kitchen.fire(client, company, Object.assign({
      lines: priced.lines, tabId: id, label: label || names.tableName || names.guestName || '', note: p.kitchenNote, sentBy: session.posEmployeeId
    }, names));
    await activity.log(client, { companyId: company, employeeId: session.posEmployeeId, app: 'till', action: 'till.kitchen',
      summary: (ticket ? 'Sent to the kitchen as #' + ticket.number + ': ' : 'Kept open (nothing new for the kitchen): ') + (label || names.tableName || names.guestName || 'order') +
        (type.fulfillment ? ' · ' + FULFILLMENT_NAME[type.fulfillment] : '') + ' · ' + priced.subtotal.toFixed(2) + '.',
      amount: priced.subtotal, refType: 'tab', refId: id, details: { dishes: ticket ? ticket.dishes : [], fulfillment: type.fulfillment, kitchenTicket: ticket ? ticket.number : null } });
    return { id: id, ticket: ticket };
  });
  return Object.assign((await tabRows(company, ' AND t.id = $2', [sent.id]))[0], { kitchenTicket: sent.ticket });
}

async function removeTab(token, id) {
  var session = await access.need(token, 'removeTable');
  return withTransaction(async function (client) {
    var res = await client.query('DELETE FROM restaurant_open_tabs WHERE id = $1 AND company_id = $2 RETURNING id, label, table_id', [id, session.posCompanyId]);
    if (!res.rows[0]) fail('notfound', 'That open order has already been paid or removed.');
    // Nothing more to cook for it.
    await kitchen.cancelForTab(client, session.posCompanyId, id);
    var tname = res.rows[0].table_id ? (await client.query('SELECT name FROM restaurant_tables WHERE id = $1', [res.rows[0].table_id])).rows[0] : null;
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.removed',
      summary: 'Removed the open order ' + (res.rows[0].label || (tname && tname.name) || '') + ' (not paid).', refType: 'tab', refId: id });
    return { removed: true };
  });
}

// ── the shift ──────────────────────────────────────────────────────────
// What this cashier has sold since their drawer opened: how many orders,
// how much, by payment method, and the latest orders (to reprint a
// receipt); how many tables are open; and, before a drawer is opened, how
// the last drawer at this restaurant was counted.
async function shiftSummary(token) {
  var session = await access.need(token, 'till');
  var open = (await pool.query("SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId])).rows[0];
  var tabs = (await pool.query('SELECT count(*)::int AS n, min(created_at) AS oldest FROM restaurant_open_tabs WHERE company_id = $1', [session.posCompanyId])).rows[0];
  var ious = (await pool.query(
    "SELECT count(*)::int AS n, coalesce(sum(total - refunded_total), 0) AS owed FROM restaurant_orders WHERE company_id = $1 AND payment_method = 'iou' AND status = 'completed' AND iou_paid_at IS NULL",
    [session.posCompanyId])).rows[0];
  var last = (await pool.query(
    "SELECT s.closed_at, s.closing_actual_cash, e.first_name || ' ' || e.last_name AS cashier FROM restaurant_drawer_sessions s JOIN employees e ON e.id = s.cashier_id " +
    "WHERE s.company_id = $1 AND s.status = 'closed' ORDER BY s.closed_at DESC LIMIT 1", [session.posCompanyId])).rows[0];
  var out = {
    openTabs: tabs.n, oldestTab: tabs.oldest, iousOpen: ious.n, iousOwed: Number(ious.owed),
    lastClosed: last ? { closedAt: last.closed_at, counted: Number(last.closing_actual_cash || 0), cashierName: last.cashier } : null,
    orders: 0, sales: 0, byMethod: [], recent: []
  };
  if (!open) return out;
  var WHERE = "o.cashier_id = $1 AND o.company_id = $2 AND o.status = 'completed' AND o.created_at >= $3";
  var args = [session.posEmployeeId, session.posCompanyId, open.opened_at];
  var byMethod = (await pool.query(
    'SELECT o.method AS payment_method, count(DISTINCT o.order_id)::int AS n, sum(o.net) AS total FROM ' + money.ORDER_METHODS_SQL + ' o ' +
    'WHERE o.cashier_id = $1 AND o.company_id = $2 AND o.created_at >= $3 GROUP BY 1 ORDER BY 3 DESC', args)).rows;
  var orders = (await pool.query('SELECT count(*)::int AS n, coalesce(sum(o.total - o.refunded_total), 0) AS total FROM restaurant_orders o WHERE ' + WHERE, args)).rows[0];
  var recent = (await pool.query(
    'SELECT o.id, o.order_no, o.total, o.refunded_total, o.payment_method, o.created_at, o.fulfillment, o.customer_name, t.name AS table_name, ' +
    '  (SELECT sum(qty) FROM restaurant_order_items i WHERE i.order_id = o.id) AS items ' +
    'FROM restaurant_orders o LEFT JOIN restaurant_tables t ON t.id = o.table_id WHERE ' + WHERE + ' ORDER BY o.created_at DESC LIMIT 8', args)).rows;
  out.byMethod = byMethod.map(function (r) { return { method: r.payment_method, orders: r.n, total: Math.round(Number(r.total) * 100) / 100 }; });
  out.orders = orders.n;
  out.sales = Math.round(Number(orders.total) * 100) / 100;
  var st = await kitchen.statusOf(pool, session.posCompanyId, 'order_id', recent.map(function (r) { return r.id; }));
  out.recent = recent.map(function (r) {
    return { id: r.id, orderNo: r.order_no, total: Number(r.total), refunded: Number(r.refunded_total), paymentMethod: r.payment_method, createdAt: r.created_at,
      tableName: r.table_name || null, fulfillment: r.fulfillment || '', customerName: r.customer_name || '', items: Number(r.items || 0), kitchen: st[r.id] || null };
  });
  // Refunds, IOUs paid and VIP top-ups handled on this drawer.
  Object.assign(out, await money.shiftMoney(session.posEmployeeId, session.posCompanyId, open.opened_at));
  return out;
}

// One of this restaurant's orders again, for reprinting its receipt —
// printed by the cashier on duty only.
async function receiptForSession(token, id) {
  var session = await access.need(token, 'charge');
  await money.needDrawer(pool, session.posEmployeeId);
  var o = (await pool.query(
    "SELECT o.*, t.name AS table_name, g.name AS guest_name, we.first_name || ' ' || we.last_name AS waiter_name, ce.first_name || ' ' || ce.last_name AS cashier_name " +
    'FROM restaurant_orders o LEFT JOIN restaurant_tables t ON t.id = o.table_id LEFT JOIN restaurant_guests g ON g.id = o.guest_id ' +
    'LEFT JOIN employees we ON we.id = o.waiter_id LEFT JOIN employees ce ON ce.id = o.cashier_id WHERE o.id = $1 AND o.company_id = $2', [id, session.posCompanyId])).rows[0];
  if (!o) fail('notfound', 'Order not found.');
  var items = (await pool.query('SELECT menu_item_id, name, qty, unit_price, line_total, note, custom FROM restaurant_order_items WHERE order_id = $1 ORDER BY sort_order, id', [o.id])).rows;
  var paid = (await money.paymentsOf(pool, [o.id])).get(o.id) || [];
  return Object.assign(rowToOrder(o, items.map(function (it) {
    return { menuItemId: it.menu_item_id, name: it.name, qty: Number(it.qty), unitPrice: Number(it.unit_price), lineTotal: Number(it.line_total), note: it.note, custom: it.custom };
  }), paid), {
    tableName: o.table_name || null, guestName: o.guest_name || null, waiterName: o.waiter_name || null, cashierName: o.cashier_name || null,
    refunded: Number(o.refunded_total), refunds: await money.refundsOf(pool, o.id), iouPaidAt: o.iou_paid_at || null, iouPaidMethod: o.iou_paid_method || null
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

  // revenue_total/voided_count are window functions too (revenue counts
  // completed orders only — a voided sale was never money in) — computed over the
  // whole WHERE-filtered set before LIMIT clips it to one page, same as
  // total_count, so the Sales tab's stat tiles show true range-wide figures
  // rather than a partial, misleadingly-small sum of just the visible page.
  var res = await pool.query(
    'SELECT o.*, e.first_name, e.last_name, t.name AS table_name, w.first_name AS waiter_first_name, w.last_name AS waiter_last_name, ' +
    'g.name AS guest_name, count(*) OVER() AS total_count, ' +
    "coalesce(sum(o.total - o.refunded_total) FILTER (WHERE o.status = 'completed') OVER(), 0) AS revenue_total, count(*) FILTER (WHERE o.status = 'voided') OVER() AS voided_count " +
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
        subtotal: Number(r.subtotal), total: Number(r.total), refunded: Number(r.refunded_total), paymentMethod: r.payment_method, status: r.status, createdAt: r.created_at,
        iouPaidAt: r.iou_paid_at || null
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
    'SELECT name, qty, unit_price, line_total, note, custom FROM restaurant_order_items WHERE order_id = $1 ORDER BY name', [id]
  );
  var paid = (await money.paymentsOf(pool, [id])).get(id) || [];
  return {
    id: order.id, companyId: order.company_id, orderNo: order.order_no, cashierName: order.first_name + ' ' + order.last_name,
    tableName: order.table_name, waiterName: order.waiter_first_name ? order.waiter_first_name + ' ' + order.waiter_last_name : null,
    guestName: order.guest_name, guestPhone: order.guest_phone,
    subtotal: Number(order.subtotal), total: Number(order.total), paymentMethod: order.payment_method, status: order.status, createdAt: order.created_at,
    items: itemsRes.rows.map(function (r) { return { name: r.name, qty: Number(r.qty), unitPrice: Number(r.unit_price), lineTotal: Number(r.line_total), note: r.note || '', custom: !!r.custom }; }),
    payments: paid, fulfillment: order.fulfillment || '', customerName: order.customer_name || '', customerPhone: order.customer_phone || '', deliveryAddress: order.delivery_address || '',
    refunded: Number(order.refunded_total), refunds: await money.refundsOf(pool, order.id),
    iouPaidAt: order.iou_paid_at || null, iouPaidMethod: order.iou_paid_method || null, iouPaidAmount: order.iou_paid_amount == null ? null : Number(order.iou_paid_amount)
  };
}

async function voidOrder(ctx, id) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  return withTransaction(async function (client) {
    var res = await client.query("UPDATE restaurant_orders SET status = 'voided' WHERE id = $1 AND status = 'completed' RETURNING *", [id]);
    if (!res.rows[0]) fail('notfound', 'Order not found, or already voided.');
    // A voided sale is not cooked, and a VIP guest gets their money back.
    await kitchen.cancelForOrder(client, res.rows[0].company_id, id);
    await money.onVoid(client, res.rows[0]);
    await tillMenu.returnForVoid(client, res.rows[0]);
    return true;
  });
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
  // Cash kept in cedis (a foreign-money sale gives its change in cedis),
  // and foreign notes, which are counted apart.
  var sales = await money.cashSales(db, session.cashier_id, session.company_id, session.opened_at, endTime);
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
  var cashSales = sales.cash;
  // Besides cash sales: refunds paid out in cash, IOUs paid and VIP
  // top-ups taken in cash, by this cashier on this drawer.
  var other = await money.drawerCash(db, session.cashier_id, session.company_id, session.opened_at, endTime);
  var cashRefunds = other.refunds;
  var netPaidInOut = paidIn - paidOut;
  var expected = Math.round((startingCash + cashSales + other.iouPaid + other.vipTopUps - cashRefunds + netPaidInOut) * 100) / 100;
  var actual = session.closing_actual_cash == null ? null : Number(session.closing_actual_cash);
  return {
    session: rowToSession(session),
    startingCash: startingCash, cashSales: cashSales, cashRefunds: cashRefunds, iouPaidCash: other.iouPaid, vipTopUpsCash: other.vipTopUps, foreignCash: sales.foreign,
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
  var session = await access.need(token, 'till');
  var res = await pool.query(
    "SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId]
  );
  if (!res.rows[0]) return null;
  return buildReport(res.rows[0]);
}

// One cashier uses the drawer at a time: the cashier of the next shift
// opens theirs once the last one has closed (counted) theirs, or a manager
// has closed it for them (closeDrawerFor). Managers each run their own
// drawer beside it. Signing out leaves a drawer open: only counting and
// closing it ends it.
async function openDrawerSession(token, startingCash) {
  var session = await access.need(token, 'charge');
  return withTransaction(async function (client) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['restaurant-drawer:' + session.posCompanyId]);
    // Idempotent — a reload right after opening (or two tabs on the same
    // PIN) resumes the existing open session instead of erroring, same
    // spirit as the till-session token restore already does.
    var existing = await client.query("SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId]);
    if (existing.rows[0]) return buildReport(existing.rows[0], client);
    // A manager opens their own drawer whenever needed — the cashier on
    // duty stepped away, or did not come — beside the cashier's.
    var other = session.access.role === 'manager' ? null : await access.cashierOnDuty(session.posCompanyId, session.posEmployeeId, client);
    if (other) {
      fail('conflict', other.name + ' is the cashier on duty: their drawer has been open since ' + new Date(other.since).toISOString().slice(11, 16) +
        '. Only one cashier uses the drawer at a time; they close theirs before you open yours. A manager can open one beside it.');
    }
    var amount = Math.max(0, Number(startingCash) || 0);
    var res = await client.query(
      'INSERT INTO restaurant_drawer_sessions (company_id, cashier_id, starting_cash) VALUES ($1,$2,$3) RETURNING *',
      [session.posCompanyId, session.posEmployeeId, amount]
    );
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.drawer_open',
      summary: 'Opened the cash drawer with ' + amount.toFixed(2) + '.', amount: amount, refType: 'drawer', refId: res.rows[0].id });
    return buildReport(res.rows[0], client);
  });
}

async function addDrawerMovement(token, p) {
  var session = await access.need(token, 'charge');
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
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: direction === 'in' ? 'till.paid_in' : 'till.paid_out',
    summary: (direction === 'in' ? 'Paid in ' : 'Paid out ') + amount.toFixed(2) + ((p.note || '').trim() ? ': ' + (p.note || '').trim().slice(0, 120) : '') + '.', amount: amount, refType: 'drawer', refId: drawer.id });
  return buildReport(drawer);
}

async function closeDrawerSession(token, p) {
  var session = await access.need(token, 'charge');
  return withTransaction(async function (client) {
    var openRes = await client.query("SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open' FOR UPDATE", [session.posEmployeeId]);
    var drawer = openRes.rows[0];
    if (!drawer) fail('conflict', 'No open drawer session to close.');
    return closeDrawer(client, drawer, p, session.posEmployeeId, null);
  });
}

// A drawer counted and closed — by its cashier, or by a manager for a
// cashier who left it open (closedBy, their name). Counted short, it opens
// a dispute by itself (restaurantDisputes.openForDrawer).
async function closeDrawer(client, drawer, p, byId, managerName) {
  p = p || {};
  var actualCash = Math.max(0, Number(p.actualCash) || 0);
  var note = (p.note || '').trim();
  if (managerName) note = 'Closed by ' + managerName + (note ? ': ' + note : '.');
  var closedRes = await client.query(
    "UPDATE restaurant_drawer_sessions SET status = 'closed', closed_at = now(), closing_actual_cash = $1, closing_note = $2 WHERE id = $3 RETURNING *",
    [actualCash, note, drawer.id]
  );
  var report = await buildReport(closedRes.rows[0], client);
  await activity.log(client, { companyId: drawer.company_id, employeeId: byId, app: managerName ? 'settings' : 'till', action: 'till.drawer_close',
    summary: (managerName ? 'Closed the cash drawer for the cashier: ' : 'Closed the cash drawer: ') + actualCash.toFixed(2) + ' counted, ' + report.expected.toFixed(2) + ' expected (' + (report.difference >= 0 ? '+' : '') + report.difference.toFixed(2) + ').',
    amount: actualCash, refType: 'drawer', refId: drawer.id, details: { expected: report.expected, difference: report.difference } });
  var d = await disputes.openForDrawer(client, closedRes.rows[0], report);
  if (d) report.disputeId = d.id;
  return report;
}

// A manager closes a drawer its cashier left open, so the next cashier can
// open theirs (restaurantTillAccess.drawers).
async function closeDrawerFor(companyId, manager, drawerId, p) {
  return withTransaction(async function (client) {
    var drawer = (await client.query("SELECT * FROM restaurant_drawer_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE", [drawerId, companyId])).rows[0];
    if (!drawer) fail('notfound', 'That drawer is not this restaurant\'s.');
    if (drawer.status !== 'open') fail('conflict', 'That drawer is already closed.');
    if (p == null || p.actualCash === undefined || p.actualCash === '' || !(Number(p.actualCash) >= 0)) fail('invalid', 'Count the cash in the drawer and type it.');
    return closeDrawer(client, drawer, p, manager.id, manager.first_name + ' ' + manager.last_name);
  });
}

// Every drawer of some days (the last 30 by default), newest first, each
// with its figures: who (a manager's own drawer marked so), when, starting
// cash, expected, counted, over or short.
async function drawerHistory(companyId, q) {
  q = q || {};
  var today = new Date().toISOString().slice(0, 10);
  var from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  var to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : today;
  var rows = (await pool.query(
    "SELECT s.*, e.first_name || ' ' || e.last_name AS cashier_name, t.role AS holder_role FROM restaurant_drawer_sessions s JOIN employees e ON e.id = s.cashier_id " +
    'LEFT JOIN restaurant_till_staff t ON t.company_id = s.company_id AND t.employee_id = s.cashier_id ' +
    "WHERE s.company_id = $1 AND (s.status = 'open' OR (s.opened_at >= $2::date AND s.opened_at < $3::date + interval '1 day')) ORDER BY (s.status = 'open') DESC, s.opened_at DESC LIMIT 120",
    [companyId, from, to])).rows;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = await buildReport(rows[i]);
    r.cashierName = rows[i].cashier_name;
    r.byManager = rows[i].holder_role === 'manager';
    r.dispute = (await pool.query("SELECT id, status FROM restaurant_disputes WHERE drawer_session_id = $1 ORDER BY created_at DESC LIMIT 1", [rows[i].id])).rows[0] || null;
    out.push(r);
  }
  var closed = out.filter(function (d) { return d.session.status === 'closed'; });
  return {
    from: from, to: to, drawers: out,
    totals: {
      drawers: out.length, open: out.length - closed.length,
      short: Math.round(closed.reduce(function (a, d) { return a + Math.min(0, d.difference || 0); }, 0) * 100) / 100,
      over: Math.round(closed.reduce(function (a, d) { return a + Math.max(0, d.difference || 0); }, 0) * 100) / 100,
      cashSales: Math.round(out.reduce(function (a, d) { return a + d.cashSales; }, 0) * 100) / 100
    }
  };
}

// On the till: a complaint or a wrong charge about a sale or an open order.
async function raiseDispute(token, p) {
  var session = await access.need(token, 'till');
  return disputes.raise(session, p);
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
  shiftSummary: shiftSummary, receiptForSession: receiptForSession, verifyPosToken: verifyPosToken,
  closeDrawerFor: closeDrawerFor, signOut: signOut, drawerHistory: drawerHistory, raiseDispute: raiseDispute
};
