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
function deliveries() { return require('./restaurantDelivery.service'); }
function gifts() { return require('./restaurantGiftCards.service'); }
function loyalty() { return require('./restaurantLoyalty.service'); }
function apps() { return require('./restaurantApps.service'); }
function paystack() { return require('./restaurantPaystack.service'); }
function costs() { return require('./restaurantCosts.service'); }
var tillMenu = require('./restaurantTillMenu.service');
var check = require('./restaurantTillCheck.service');
var times = require('./restaurantTillTimes.service');

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
  var where = app === 'kds' || app === 'delivery' ? app : 'till';
  await activity.log(pool, { companyId: emp.company_id, employeeId: emp.id, app: where, action: where + '.signin',
    summary: emp.first_name + ' ' + emp.last_name + ' signed in to the ' + (screen ? 'kitchen screen ' + screen.name + '.' : where === 'delivery' ? 'delivery screen.' : 'till.'),
    refType: screen ? 'screen' : null, refId: screen ? screen.id : null });
  var claims = { posEmployeeId: emp.id, posCompanyId: emp.company_id };
  if (where === 'delivery') claims.app = 'delivery';
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
  var kds = !!session.kdsScreenId, dl = session.app === 'delivery', idle = reason === 'idle';
  var app = kds ? 'kds' : dl ? 'delivery' : 'till';
  var where = kds ? 'kitchen screen' : dl ? 'delivery screen' : 'till';
  var drawer = kds || dl ? null : (await pool.query("SELECT id FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId])).rows[0];
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: app, action: app + '.signout',
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

// ── taken while the till was offline (migration 0167) ──
// A sale or an order for the kitchen made while the till could not reach
// the server is kept on the till and sent when it can, with a reference of
// its own (clientRef): sent again, it is the one already made, not another.
var CLIENT_REF = /^[A-Za-z0-9_-]{8,64}$/;
function clientRefOf(p) {
  if (!p.clientRef) return null;
  var r = String(p.clientRef);
  if (!CLIENT_REF.test(r)) fail('invalid', 'That order\'s reference from the till is not right.');
  return r;
}
// When an offline sale was taken: the till's time, if it is in the last
// three days and not ahead of now.
function takenAtOf(v) {
  var d = v ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) return null;
  var now = Date.now();
  if (d.getTime() > now + 5 * 60000 || d.getTime() < now - 3 * 86400000) return null;
  return new Date(Math.min(d.getTime(), now));
}
// The sale a reference made already, as createOrder returns it; or null.
async function saleByRef(companyId, clientRef) {
  var o = (await pool.query('SELECT * FROM restaurant_orders WHERE company_id = $1 AND client_ref = $2', [companyId, clientRef])).rows[0];
  if (!o) return null;
  var items = (await pool.query('SELECT ' + ITEM_COLS + ' FROM restaurant_order_items WHERE order_id = $1 ORDER BY sort_order', [o.id])).rows.map(itemRow);
  var paid = (await money.paymentsOf(pool, [o.id])).get(o.id) || [];
  return Object.assign(rowToOrder(o, items, paid), { kitchenTicket: null, vipBalance: null, replayed: true });
}

// payments: the parts it was paid in (restaurantTillMoney.paymentsOf), or
// none for a sale from before they were kept.
function rowToOrder(order, items, payments) {
  payments = payments || [];
  var change = payments.length ? Math.round(payments.reduce(function (a, p) { return a + (p.changeGiven || 0); }, 0) * 100) / 100 : null;
  var cashGiven = order.cash_tendered == null ? null : Number(order.cash_tendered);
  var itemsGross = Math.round(items.reduce(function (a, it) { return a + Number(it.gross != null ? it.gross : it.lineTotal); }, 0) * 100) / 100;
  var adj = order.adjustments || {};
  return {
    id: order.id, companyId: order.company_id, orderNo: order.order_no, cashierId: order.cashier_id,
    subtotal: Number(order.subtotal), total: Number(order.total), paymentMethod: order.payment_method,
    itemsGross: itemsGross, discountTotal: Number(order.discount_total || 0), serviceCharge: Number(order.service_charge || 0),
    serviceName: adj.service ? adj.service.name : null, serviceRate: adj.service ? adj.service.rate : 0, serviceOff: !!adj.serviceOff,
    billDiscount: adj.discount ? { name: adj.discount.name, amount: adj.discount.amount, by: adj.discount.by } : null,
    taxes: order.taxes || [], taxTotal: Number(order.tax_total || 0), taxIncluded: Number(adj.taxIncluded || 0),
    receiptUrl: receiptUrl(order.receipt_token, order.order_no), receiptSends: (order.receipt_sends || []).map(function (x) { return { channel: x.channel, to: x.to, at: x.at, by: x.by }; }),
    status: order.status, createdAt: order.created_at, offlineAt: order.offline_at || null,
    tableId: order.table_id, waiterId: order.waiter_id, guestId: order.guest_id,
    fulfillment: order.fulfillment || '', customerName: order.customer_name || '', customerPhone: order.customer_phone || '', deliveryAddress: order.delivery_address || '',
    cashTendered: cashGiven,
    change: payments.length ? (change > 0 || cashGiven != null ? change : null) : (cashGiven == null ? null : Math.round((cashGiven - Number(order.total)) * 100) / 100),
    payments: payments, guests: order.guests || null, allergy: order.allergy || null,
    tip: Number(order.tip || 0), pointsEarned: order.points_earned || 0, pointsUsed: order.points_used || 0,
    channel: order.channel || 'till', app: order.app ? { key: order.app, ref: order.app_ref || '', commission: Number(order.app_commission || 0) } : null,
    items: items.map(function (it) {
      return { menuItemId: it.menuItemId, name: it.name, qty: it.qty, unitPrice: it.unitPrice, lineTotal: it.lineTotal, note: it.note || '', custom: !!it.custom,
        modifiers: it.modifiers || [], gross: it.gross != null ? Number(it.gross) : it.lineTotal, discount: Number(it.discount || 0), discountName: it.discountName || null, compReason: it.compReason || null,
        seat: it.seat || null, course: it.course != null ? it.course : null };
    })
  };
}
// A sale's line as it is kept (restaurant_order_items), for rowToOrder.
var ITEM_COLS = 'menu_item_id, name, qty, unit_price, line_total, gross, note, custom, modifiers, discount, discount_name, comp_reason, seat, course';
function itemRow(r) {
  return { menuItemId: r.menu_item_id, name: r.name, qty: Number(r.qty), unitPrice: Number(r.unit_price), lineTotal: Number(r.line_total), note: r.note, custom: r.custom,
    gross: r.gross == null ? null : Number(r.gross), modifiers: r.modifiers || [], discount: Number(r.discount || 0), discountName: r.discount_name, compReason: r.comp_reason,
    seat: r.seat, course: r.course };
}

// POS menu — active items only, for the company the till session is
// scoped to. Not gated on restaurant.read (the till has no logged-in
// user), gated on a valid POS session instead.
async function menuForSession(token) {
  var session = await access.need(token, 'till');
  var res = await pool.query(
    'SELECT id, name, category, price, photo_object_key, favorite, allergens, sku FROM restaurant_menu_items WHERE company_id = $1 AND active = true ORDER BY category, name',
    [session.posCompanyId]
  );
  var tiles = await attachVariationsToTiles(res.rows.map(rowToTile));
  // Each dish's add-on groups (restaurantTillCheck): a dish with any opens
  // its add-ons on the till.
  var groups = await check.groupsFor(pool, tiles.map(function (t) { return t.id; }));
  tiles.forEach(function (t) { t.addOns = groups.get(t.id) || []; t.combo = t.addOns.some(function (g) { return g.combo; }); });
  await tillMenu.tileStock(session.posCompanyId, tiles);
  // A combo's choice that is sold out shows so (its dish's own tile says).
  var out = new Map(tiles.filter(function (t) { return t.stock && t.stock.soldOut; }).map(function (t) { return [t.id, true]; }));
  tiles.forEach(function (t) { t.addOns.forEach(function (g) { if (g.combo) g.options.forEach(function (o) { if (out.get(o.menuItemId)) o.soldOut = true; }); }); });
  return tiles;
}

function rowToTile(r) {
  return {
    id: r.id, name: r.name, category: r.category, price: Number(r.price),
    photoUrl: restaurantService.menuThumbUrl(r.id, r.photo_object_key),
    favorite: r.favorite, variations: [], allergens: r.allergens || [],
    // Its barcode or SKU, for a scanner at the till (till/barcode.js).
    sku: r.sku || ''
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
    'SELECT id, menu_item_id, name, price, sku FROM restaurant_menu_item_variations WHERE menu_item_id = ANY($1) ORDER BY sort_order, created_at',
    [tiles.map(function (t) { return t.id; })]
  );
  var byItem = new Map();
  res.rows.forEach(function (r) {
    if (!byItem.has(r.menu_item_id)) byItem.set(r.menu_item_id, []);
    byItem.get(r.menu_item_id).push({ id: r.id, name: r.name, price: Number(r.price), sku: r.sku || '' });
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
    iouAllowed: !!r.iou_allowed, iouLimit: r.iou_limit == null ? null : Number(r.iou_limit), iouOwed: r.owed == null ? 0 : Math.round(Number(r.owed) * 100) / 100,
    points: r.points == null ? 0 : Number(r.points),
    email: r.email || '', birthday: r.birthday ? new Date(r.birthday).toISOString().slice(0, 10) : null, marketing: r.marketing || 'unknown'
  };
}
var GUEST_SELECT =
  'SELECT g.id, g.name, g.phone, g.iou_allowed, g.iou_limit, g.email, g.birthday, g.marketing, v.balance AS vip_balance, (v.guest_id IS NOT NULL) AS vip, i.owed, ' +
  '  (SELECT sum(l.points) FROM restaurant_loyalty_entries l WHERE l.guest_id = g.id) AS points ' +
  'FROM restaurant_guests g LEFT JOIN (SELECT guest_id, sum(amount) AS balance FROM restaurant_vip_entries GROUP BY guest_id) v ON v.guest_id = g.id ' +
  "LEFT JOIN (SELECT guest_id, sum(owed) AS owed FROM (SELECT guest_id, total - refunded_total AS owed FROM restaurant_orders WHERE payment_method = 'iou' AND status = 'completed' AND iou_paid_at IS NULL " +
  '  UNION ALL SELECT guest_id, amount FROM restaurant_iou_advances WHERE paid_at IS NULL) x GROUP BY guest_id) i ON i.guest_id = g.id ';

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
  var c = contactOf(p);
  var res = await pool.query(
    "INSERT INTO restaurant_guests (company_id, name, phone, source, email, birthday, marketing, marketing_at) VALUES ($1,$2,$3,'till',$4,$5,$6,CASE WHEN $6 <> 'unknown' THEN now() END) " +
    'RETURNING id, name, phone, iou_allowed, iou_limit, email, birthday, marketing',
    [session.posCompanyId, name, (p.phone || '').trim().slice(0, 40), c.email || '', c.birthday || null, c.marketing || 'unknown']
  );
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.customer',
    summary: 'Added the customer ' + name + '.', refType: 'guest', refId: res.rows[0].id });
  return rowToGuestTile(res.rows[0]);
}

// A guest's email, birthday and whether they want to hear from the
// restaurant (texts and emails, restaurantCampaigns), as the till gives them.
function contactOf(p) {
  p = p || {};
  var out = {};
  if (p.email !== undefined) {
    var email = String(p.email || '').trim().slice(0, 120);
    if (email && !require('./mail.service').isEmail(email)) fail('invalid', 'That email address does not look right.');
    out.email = email;
  }
  if (p.birthday !== undefined) {
    var b = String(p.birthday || '');
    if (b && !/^\d{4}-\d{2}-\d{2}$/.test(b)) fail('invalid', 'The birthday as a date, e.g. 1990-05-21.');
    out.birthday = b || null;
  }
  if (p.marketing !== undefined) out.marketing = ['yes', 'no', 'unknown'].indexOf(p.marketing) >= 0 ? p.marketing : fail('invalid', 'Do they want texts and emails: yes, no, or not asked?');
  return out;
}
// POST /api/pos/guests/:id/contact { email, birthday, marketing } — from the till.
async function guestContact(token, id, p) {
  var session = await access.need(token, 'till');
  var c = contactOf(p);
  var g = (await pool.query('SELECT id, name, marketing FROM restaurant_guests WHERE id = $1 AND company_id = $2', [id, session.posCompanyId])).rows[0];
  if (!g) fail('notfound', 'That customer is not this restaurant\'s.');
  await pool.query('UPDATE restaurant_guests SET email = coalesce($3, email), birthday = CASE WHEN $4 THEN $5::date ELSE birthday END, ' +
    "marketing = coalesce($6, marketing), marketing_at = CASE WHEN $6 IS NOT NULL AND $6 <> marketing THEN now() ELSE marketing_at END, updated_at = now() WHERE id = $1 AND company_id = $2",
    [id, session.posCompanyId, c.email !== undefined ? c.email : null, c.birthday !== undefined, c.birthday || null, c.marketing || null]);
  if (c.marketing && c.marketing !== g.marketing) {
    await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.customer',
      summary: g.name + (c.marketing === 'yes' ? ' agreed to texts and emails.' : c.marketing === 'no' ? ' wants no texts or emails.' : ': texts and emails not asked.'), refType: 'guest', refId: id });
  }
  return rowToGuestTile(await guestById(pool, session.posCompanyId, id));
}

// Dine in (at a table), pickup (at the counter) or delivery (needs who, a
// phone and where). An order from before these says nothing ('').
var FULFILLMENT_NAME = { dine_in: 'Dine in', pickup: 'Pickup', delivery: 'Delivery' };
function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
async function orderType(client, companyId, p, refs) {
  var f = p.fulfillment === undefined || p.fulfillment === null || p.fulfillment === '' ? '' : V.oneOf(p.fulfillment, access.FULFILLMENTS, 'Dine in, pickup or delivery');
  var guest = refs.guestId ? (await client.query('SELECT name, phone FROM restaurant_guests WHERE id = $1', [refs.guestId])).rows[0] : null;
  var out = { fulfillment: f, customerName: cleanText(p.customerName, 120) || (guest ? guest.name : ''), customerPhone: cleanText(p.customerPhone, 40) || (guest ? guest.phone || '' : ''), deliveryAddress: '' };
  if (f === 'dine_in' && !refs.tableId && !p.kioskOrder) {
    var hasTables = (await client.query("SELECT 1 FROM restaurant_tables WHERE company_id = $1 AND status = 'active' LIMIT 1", [companyId])).rows.length > 0;
    if (hasTables) fail('invalid', 'Pick the table for this dine-in order.');
  }
  if (f === 'pickup' || f === 'delivery') refs.tableId = null;
  // A pickup: who it is for, and a number to call when it is ready.
  // (A delivery app's order is handed to the app's rider; a kiosk's
  // customer is called by their number.)
  if (f === 'pickup' && !p.appOrder && !p.kioskOrder) {
    if (!out.customerName) fail('invalid', 'A pickup needs the customer\'s name.');
    if (!out.customerPhone) fail('invalid', 'A pickup needs a phone number, to call the customer when it is ready.');
  }
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
// A delivery fee is a line of its own on the order (custom.fee): charged
// like a dish, never cooked (restaurantKitchen fire leaves it out), put
// there with a website order (restaurantOnline accept) or at the till.
var FEE_NAME = 'Delivery fee';
// A dish's add-ons (restaurantTillCheck pickMods) are priced into it: its
// unit price is the dish (or its size) and what was added. A discount or
// "on the house" asked for a line rides along for restaurantTillCheck
// compute; lineTotal here is before any of that. A line also says the seat
// it is for and its course, if the till set them, and carries its menu
// category and allergens (the kitchen's ticket, the menu's hours).
function seatOf(v) { var n = Math.round(Number(v)); return n >= 1 && n <= 99 ? n : null; }
function courseAsked(v) { if (v === undefined || v === null || v === '') return null; var n = Math.round(Number(v)); return n >= 0 && n <= times.MAX_COURSES ? n : null; }
// How many sat down (1–200), or none said.
function guestsOf(v) { var n = Math.round(Number(v)); return n >= 1 && n <= 200 ? n : null; }
// An order's allergy alert for the kitchen: { list: allergen keys, note }, or null.
function allergyOf(a) {
  if (!a || typeof a !== 'object') return null;
  var list = times.cleanAllergens(a.list);
  var note = cleanText(a.note, 200);
  return list.length || note ? { list: list, note: note } : null;
}
async function priceLines(client, companyId, items, allowCustom) {
  if (!Array.isArray(items) || !items.length) fail('invalid', 'Add at least one item.');
  var lines = [];
  var subtotal = 0;
  var groups = await check.groupsFor(client, Array.from(new Set(items.map(function (it) { return it && it.menuItemId; }).filter(function (id) { return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id); }))));
  for (var i = 0; i < items.length; i++) {
    var qty = Math.max(0.01, Number(items[i].qty) || 0);
    var note = cleanText(items[i].note, 140);
    var asked = { discount: items[i].discount || null, comp: items[i].comp || null, seat: seatOf(items[i].seat), course: courseAsked(items[i].course) };
    if (items[i].custom) {
      var isFee = items[i].custom.fee === true;
      if (!allowCustom && !isFee) fail('forbidden', 'Your role on the till cannot add a dish that is not on the menu. Ask a manager.');
      var cname = isFee ? FEE_NAME : cleanText(items[i].custom.name, 80);
      var cprice = Math.round(Number(items[i].custom.price) * 100) / 100;
      if (!cname) fail('invalid', 'Give the dish that is not on the menu a name.');
      if (!(cprice >= 0 && cprice < (isFee ? 5000 : 1000000))) fail('invalid', isFee ? 'The delivery fee is out of range.' : 'Give ' + cname + ' a price.');
      if (isFee) qty = 1;
      var cTotal = Math.round(qty * cprice * 100) / 100;
      subtotal += cTotal;
      var cline = Object.assign({ menuItemId: null, variationId: null, name: cname, qty: qty, unitPrice: cprice, lineTotal: cTotal, note: isFee ? '' : note, custom: true, category: isFee ? '' : cleanText(items[i].custom.category, 120), modifiers: [] }, isFee ? {} : asked);
      if (isFee) cline.fee = true;
      lines.push(cline);
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
    var mods = check.pickMods(name, groups.get(m.id), items[i].modifiers);
    unitPrice = Math.round((unitPrice + check.modsPrice(mods)) * 100) / 100;
    var lineTotal = Math.round(qty * unitPrice * 100) / 100;
    subtotal += lineTotal;
    lines.push(Object.assign({ menuItemId: m.id, variationId: variationId, name: name, qty: qty, unitPrice: unitPrice, lineTotal: lineTotal, note: note, custom: false, modifiers: mods,
      category: m.category || '', allergens: m.allergens || [] }, asked));
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
  var clientRef = clientRefOf(p);
  if (clientRef) {
    var made = await saleByRef(session.posCompanyId, clientRef);
    if (made) return made;
  }
  try {
    return await chargeOrder(session, p, clientRef);
  } catch (e) {
    // Sent twice at once: the other one made it.
    if (clientRef && e.code === '23505') { var again = await saleByRef(session.posCompanyId, clientRef); if (again) return again; }
    throw e;
  }
}
async function chargeOrder(session, p, clientRef) {
  var tillSettings = session.access.settings;
  var takenAt = clientRef ? takenAtOf(p.takenAt) : null;
  // A delivery app's order (restaurantApps): at the app's prices, paid on
  // the app, handed to its rider.
  var app = p.app ? apps().appOf(tillSettings, p.app) : null;
  if (app) {
    if (p.tabId) fail('invalid', 'A delivery app\'s order is rung up on its own.');
    p = Object.assign({}, p, { fulfillment: 'pickup', tableId: null, appOrder: true, customerName: p.customerName || app.customer || app.name });
  }
  if (tillSettings.requireWaiter && p.tableId && !p.waiterId && p.fulfillment !== 'pickup' && p.fulfillment !== 'delivery') fail('invalid', 'Pick the waiter for this table.');
  var asked = Array.isArray(p.payments) && p.payments.length ? p.payments
    : [{ method: p.paymentMethod || 'cash', tendered: p.cashTendered }];
  // Paid through Paystack (the customer's phone, or the kiosk): checked with Paystack.
  var psRefs = asked.map(function (r) { return r && r.paystackRef ? String(r.paystackRef) : null; }).filter(Boolean);

  return withTransaction(async function (client) {
    await money.needDrawer(client, session.posEmployeeId);
    var psMap = psRefs.length ? await paystack().claimFor(client, session.posCompanyId, psRefs) : null;
    var tab = null;
    if (p.tabId) {
      var tabRes = await client.query('SELECT id, label, customer_name, customer_phone, items, adjust, table_id, guests, allergy FROM restaurant_open_tabs WHERE id = $1 AND company_id = $2 FOR UPDATE', [p.tabId, session.posCompanyId]);
      if (!tabRes.rows[0]) fail('conflict', 'That open order has already been paid or removed.');
      tab = tabRes.rows[0];
      // Ordered on the self-order kiosk: no table or phone number needed.
      if (await fromKiosk(client, tab.id)) p = Object.assign({}, p, { kioskOrder: true });
      // Who it is for, as the open order says, unless the till says otherwise.
      p = Object.assign({}, p, { customerName: p.customerName || tab.customer_name || '', customerPhone: p.customerPhone || tab.customer_phone || '' });
    }
    var refs = await resolveRefs(client, session.posCompanyId, p);
    var type = await orderType(client, session.posCompanyId, p, refs);
    var priced = await priceLines(client, session.posCompanyId, p.items, session.access.can.customItem);
    if (app && app.markup) {
      var marked = apps().applyMarkup(priced.lines, app);
      priced = { lines: marked, subtotal: Math.round(marked.reduce(function (a, l) { return a + l.lineTotal; }, 0) * 100) / 100 };
    }
    // The bill: discounts, dishes on the house, the service charge and the
    // taxes (restaurantTillCheck), allowed as an open order's were saved,
    // by the person's role or with a manager's approval.
    // (A deal on the bill, restaurantPromos: not on a delivery app's order; a large party's service charge by how many sat down.)
    var bill = check.compute(priced.lines, p.adjust, tillSettings, type.fulfillment || 'dine_in',
      { companyId: session.posCompanyId, name: await personName(client, session.posEmployeeId), can: session.access.can, before: tab ? { items: tab.items, adjust: tab.adjust || {} } : null,
        channel: app ? 'app' : undefined, guests: guestsOf(p.guests) || (tab ? tab.guests : null), at: takenAt || undefined });
    var lines = bill.lines;
    var subtotal = bill.subtotal;
    // Some of an open order's dishes paid on their own (split by dish): the
    // rest stays open. Only what is on the order as it was saved.
    var rest = null;
    if (tab && p.keepRest) {
      rest = takeOut(tab.items, lines);
      if (!rest.length) rest = null;
      else {
        var linked = (await client.query("SELECT (SELECT count(*) FROM restaurant_deliveries WHERE tab_id = $1 AND status <> 'cancelled') + (SELECT count(*) FROM restaurant_online_orders WHERE tab_id = $1) AS n", [tab.id])).rows[0];
        if (Number(linked.n) > 0) fail('conflict', 'A delivery or a website order is paid in one go.');
      }
    }
    // A new sale cannot take more than is left of a counted dish; an open
    // order's food was sent already and is always paid, and so is a sale
    // taken while the till was offline.
    if (!tab && !takenAt) await tillMenu.checkOrder(client, session.posCompanyId, lines, null, null);
    // Nor a dish outside its menu's hours (breakfast at night).
    if (!tab && !takenAt) times.checkHours(tillSettings, lines, null);
    // How many sat down and any allergy alert: as the till says, else as the open order has them.
    var guests = guestsOf(p.guests) || (tab ? tab.guests : null);
    var allergy = p.allergy !== undefined ? allergyOf(p.allergy) : tab ? tab.allergy : null;
    // Taken offline: on the books when it was taken (not before the drawer opened).
    var at = null;
    if (takenAt) {
      var opened = (await client.query("SELECT opened_at FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId])).rows[0];
      at = opened && new Date(opened.opened_at) > takenAt ? new Date(opened.opened_at) : takenAt;
    }
    // A tip on top (the till's settings, tips): paid with the bill, not a sale.
    var tip = tipOf(p.tip, bill.total, tillSettings);
    if (app && tip > 0) fail('invalid', 'A tip on an app\'s order is the app\'s to give.');
    var plan = money.planPayments(session, Math.round((bill.total + tip) * 100) / 100, asked, { app: !!app, paystack: psMap });
    if (tip > 0 && plan.rows.some(function (r) { return r.method === 'iou'; })) fail('invalid', 'A tip is paid in money, not on an IOU.');

    var companyRes = await client.query('SELECT code FROM companies WHERE id = $1', [session.posCompanyId]);
    var seqRes = await client.query("SELECT nextval('restaurant_order_seq') AS n");
    var orderNo = companyRes.rows[0].code + '-' + String(seqRes.rows[0].n).padStart(6, '0');

    var cols = check.saleColumns(bill);
    // Where it came from: the till, a delivery app, or (an open order) the website, a table's QR code or the kiosk.
    var channel = app ? 'app' : 'till';
    if (!app && tab) {
      var from = (await client.query(
        "SELECT (SELECT count(*) FROM restaurant_online_orders WHERE tab_id = $1)::int AS web, (SELECT max(kind) FROM restaurant_table_orders WHERE tab_id = $1) AS kind", [tab.id])).rows[0];
      channel = from.web > 0 ? 'website' : from.kind === 'kiosk' ? 'kiosk' : from.kind === 'table' ? 'table' : 'till';
    }
    var orderRes = await client.query(
      'INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, payment_method, table_id, waiter_id, guest_id, cash_tendered, ' +
      '  fulfillment, customer_name, customer_phone, delivery_address, client_ref, offline_at, created_at, discount_total, service_charge, tax_total, taxes, adjustments, receipt_token, guests, allergy, tip, ' +
      '  channel, app, app_ref, app_commission) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,coalesce($17, now()),$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) RETURNING *',
      [session.posCompanyId, orderNo, session.posEmployeeId, subtotal, bill.total, plan.method, refs.tableId, refs.waiterId, refs.guestId, plan.cashTendered,
        type.fulfillment, type.customerName, type.customerPhone, type.deliveryAddress, clientRef, takenAt, at,
        cols.discountTotal, cols.serviceCharge, cols.taxTotal, JSON.stringify(cols.taxes), JSON.stringify(cols.adjustments), newReceiptToken(), guests, allergy ? JSON.stringify(allergy) : null, tip,
        channel, app ? app.key : null, app ? app.ref : '', app ? apps().commissionOf(app, bill.total) : 0]
    );
    var order = orderRes.rows[0];
    if (psRefs.length) await paystack().markUsed(client, psRefs, order.id);
    // What each line cost to make (restaurantCosts: its recipe, or a cost set by hand).
    var lineCosts = await costs().forLines(client, session.posCompanyId, lines);
    for (var j = 0; j < lines.length; j++) {
      await client.query(
        'INSERT INTO restaurant_order_items (order_id, menu_item_id, variation_id, name, qty, unit_price, line_total, gross, note, custom, sort_order, modifiers, discount, discount_name, comp_reason, seat, course, unit_cost) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
        [order.id, lines[j].menuItemId, lines[j].variationId, lines[j].name, lines[j].qty, lines[j].unitPrice, lines[j].lineTotal, lines[j].gross, lines[j].note || '', !!lines[j].custom, j,
          JSON.stringify(lines[j].modifiers || []), lines[j].discount || 0, lines[j].discountName || null, lines[j].compReason || null, lines[j].seat || null,
          lines[j].course !== null && lines[j].course !== undefined ? lines[j].course : (tillSettings.courses.on ? times.courseOf(tillSettings, lines[j]) : null), lineCosts[j].unitCost]
      );
    }
    await tillMenu.deductForSale(client, session.posCompanyId, order.id, session.posEmployeeId, lines);
    await costs().drawDown(client, session.posCompanyId, order.id, session.posEmployeeId, lines, lineCosts);
    // Gift card parts off their cards (restaurantGiftCards), before the parts are kept with their card.
    await gifts().redeemForSale(client, session.posCompanyId, order, session.posEmployeeId, plan.rows);
    await money.savePayments(client, order.id, plan.rows);
    var vip = await money.chargeSale(client, session.posCompanyId, order, session.posEmployeeId, plan.rows);
    // Loyalty: a reward's points taken, the points this sale earns (restaurantLoyalty).
    var points = await loyalty().forSale(client, session, order, { guestId: refs.guestId, phone: type.customerPhone, adjust: bill.adjust, total: bill.total });
    // To the kitchen: what was not sent with the open order yet, or the
    // whole sale; the open order's tickets now belong to the sale.
    var names = await refNames(client, refs, type);
    var ticket = null;
    if (rest) {
      // Paid on their own: their food in the kitchen goes with this sale;
      // the rest of the order stays open (a bill-wide amount off is used up).
      await kitchen.moveItems(client, session.posCompanyId, tab.id, lines, Object.assign({ orderId: order.id, label: tab.label || names.tableName || names.guestName || orderNo }, names));
      var keptAdjust = Object.assign({}, tab.adjust || {});
      if (keptAdjust.discount && keptAdjust.discount.kind === 'amount') delete keptAdjust.discount;
      await client.query('UPDATE restaurant_open_tabs SET items = $2, adjust = $3, updated_at = now() WHERE id = $1', [tab.id, JSON.stringify(rest), JSON.stringify(keptAdjust)]);
    } else ticket = await kitchen.fire(client, session.posCompanyId, Object.assign({
      lines: lines, tabId: tab ? tab.id : null, orderId: order.id, label: tab ? (tab.label || names.tableName || names.guestName || orderNo) : app ? apps().labelOf(app) : (type.customerName || orderNo),
      note: p.kitchenNote, sentBy: session.posEmployeeId, settings: tillSettings, allergy: allergy, guests: guests
    }, names));
    // What goes to the cooks now, for the stations that print their tickets.
    var printNow = ticket ? ticket.ids.slice() : [];
    if (tab && !rest) {
      // Paid: courses still waiting are cooked now (nobody will call them).
      printNow = printNow.concat(await kitchen.releaseHeld(client, session.posCompanyId, 'tab_id', tab.id));
      await client.query('UPDATE restaurant_kitchen_tickets SET order_id = $1 WHERE tab_id = $2 AND company_id = $3', [order.id, tab.id, session.posCompanyId]);
      // Its delivery, or the website order it came from, now goes with the sale.
      await client.query('UPDATE restaurant_deliveries SET order_id = $1 WHERE tab_id = $2 AND company_id = $3', [order.id, tab.id, session.posCompanyId]);
      // The money its rider brought back is in: handed in (restaurantDelivery
      // handIn, with what was counted), or the order simply paid here.
      var outs = (await client.query("SELECT * FROM restaurant_deliveries WHERE tab_id = $1 AND company_id = $2 AND status NOT IN ('cancelled', 'failed') AND handed_at IS NULL AND to_collect > 0",
        [tab.id, session.posCompanyId])).rows;
      for (var k = 0; k < outs.length; k++) {
        var h = p.handIn && p.handIn.deliveryId === outs[k].id ? p.handIn : { amount: bill.total, method: plan.method, note: '', short: 0 };
        await deliveries().recordHandIn(client, session, outs[k], h, order.id);
      }
      await client.query("UPDATE restaurant_online_orders SET order_id = $1, status = 'done', updated_at = now() WHERE tab_id = $2 AND company_id = $3 AND status = 'accepted'",
        [order.id, tab.id, session.posCompanyId]);
      await client.query('DELETE FROM restaurant_open_tabs WHERE id = $1', [p.tabId]);
    }
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.sale',
      summary: 'Sale ' + orderNo + (takenAt ? ' (taken offline at ' + takenAt.toISOString().slice(11, 16) + ')' : '') + ': ' + bill.total.toFixed(2) + (tip > 0 ? ' + a tip of ' + tip.toFixed(2) : '') + ' by ' + money.paymentText(plan.rows) +
        (type.fulfillment ? ' · ' + FULFILLMENT_NAME[type.fulfillment] : '') + (names.tableName && type.fulfillment !== 'pickup' && type.fulfillment !== 'delivery' ? ' · ' + names.tableName : '') +
        (names.guestName ? ' · ' + names.guestName : '') + (rest ? ' · some dishes of the open order, the rest stays open' : '') + '.' + discountWords(bill),
      amount: bill.total, refType: 'order', refId: order.id,
      details: { method: plan.method, payments: plan.rows.map(function (r) { return { method: r.method, amount: r.amount, currency: r.currency }; }),
        dishes: lines.map(function (l) { var mods = check.modsText(l.modifiers); return l.qty + '× ' + l.name + (mods ? ' [' + mods + ']' : '') + (l.note ? ' (' + l.note + ')' : ''); }),
        fulfillment: type.fulfillment, kitchenTicket: ticket ? ticket.number : null,
        discounts: bill.discountTotal || undefined, serviceCharge: bill.serviceCharge || undefined, taxes: bill.taxes.length ? bill.taxes : undefined, approvedBy: bill.approvals.length ? bill.approvals : undefined } });
    var paid = (await money.paymentsOf(client, [order.id])).get(order.id) || [];
    var chits = await kitchen.chitsFor(client, printNow);
    var giftLeft = plan.rows.filter(function (r) { return r.method === 'gift_card'; }).map(function (r) { return { card: r.giftCode.slice(-4), left: r.giftLeft }; });
    return Object.assign(rowToOrder(Object.assign({}, order, points ? { points_earned: points.earned, points_used: points.used } : {}), lines, paid),
      { kitchenTicket: ticket, vipBalance: vip ? vip.balance : null, restOpen: rest ? tab.id : null, chits: chits, points: points, giftCards: giftLeft });
  });
}

// A tip asked for with a sale: none, or up to the bill (and 50 cedis on a small one), when the till takes tips.
function tipOf(v, total, settings) {
  if (v === undefined || v === null || v === '' || Number(v) === 0) return 0;
  var tip = Math.round(Number(v) * 100) / 100;
  if (!settings.tips.on) fail('invalid', 'Tips are turned off in the till settings.');
  if (!(tip > 0 && tip <= Math.max(total, 50))) fail('invalid', 'A tip is from 0.01 up to the bill.');
  return tip;
}

// ── open tables ────────────────────────────────────────────────────────
// An order kept on the till to add to and pay later. Priced for display at
// today's menu prices each time it is read; the sale itself is priced when
// it is paid (createOrder with tabId).

// A line as the till shows it and sends it back: its add-ons, what it sold
// for (gross), its discount (amount, and as asked: discountSpec) or why it
// is on the house, and what is paid for it.
function lineOut(l) {
  var o = {
    menuItemId: l.menuItemId, variationId: l.variationId || null, name: l.name, qty: l.qty, unitPrice: l.unitPrice, gross: l.gross != null ? l.gross : l.lineTotal,
    discount: l.discount || 0, discountName: l.discountName || null, compReason: l.compReason || null, lineTotal: l.lineTotal, note: l.note || '',
    custom: !!l.custom, modifiers: l.modifiers || [], discountSpec: l.discountAsked || null, comp: l.comp || null,
    seat: l.seat || null, course: l.course !== undefined ? l.course : null, category: l.category || '', allergens: l.allergens || []
  };
  if (l.fee) o.fee = true;
  return o;
}
// The bill's money (restaurantTillCheck compute), for the till and a receipt.
function billOut(b) {
  return {
    itemsGross: b.itemsGross, discountTotal: b.discountTotal, subtotal: b.subtotal, serviceCharge: b.serviceCharge, serviceName: b.serviceName, serviceRate: b.serviceRate,
    serviceOff: b.serviceOff, taxes: b.taxes, taxTotal: b.taxTotal, taxIncluded: b.taxIncluded, total: b.total
  };
}
// A sale's link to its receipt on the restaurant's website.
function newReceiptToken() { return require('crypto').randomBytes(16).toString('base64url'); }
// On the restaurant's own website when it has one (its code begins the order number).
function receiptUrl(token, orderNo) {
  if (!token) return null;
  var code = String(orderNo || '').split('-')[0];
  return (code ? require('./restaurantOnline.service').siteUrlFor(code) : config.onlineSiteUrl) + '/receipt/' + token;
}

// What stays on an open order once these lines leave it: each line taken
// off the order as it was saved (the same dish, size, add-ons, note and
// discount), refused when the order does not hold that many.
function sameKept(kept, l) {
  var kc = kept.custom ? { custom: kept.custom, modifiers: [] } : kept;
  if (check.identity(kc) !== check.identity(l)) return false;
  if (cleanText(kept.note, 140) !== cleanText(l.note, 140)) return false;
  if ((kept.seat || null) !== (l.seat || null)) return false;
  var kd = kept.comp ? 'comp:' + kept.comp.reason : kept.discount ? 'd:' + kept.discount.kind + ':' + Number(kept.discount.value) : '';
  var ld = l.compReason ? 'comp:' + l.compReason : l.discountAsked ? 'd:' + l.discountAsked.kind + ':' + Number(l.discountAsked.value) : '';
  return kd === ld;
}
function takeOut(items, lines) {
  var left = items.map(function (it) { return Object.assign({}, it); });
  lines.forEach(function (l) {
    var need = Math.round(Number(l.qty) * 100) / 100;
    for (var i = 0; i < left.length && need > 0; i++) {
      if (!sameKept(left[i], l)) continue;
      var take = Math.min(Number(left[i].qty), need);
      left[i].qty = Math.round((Number(left[i].qty) - take) * 100) / 100;
      need = Math.round((need - take) * 100) / 100;
    }
    if (need > 0) fail('invalid', l.name + ': the open order does not have that many.');
  });
  return left.filter(function (it) { return Number(it.qty) > 0; });
}

// A line as an open order keeps it (restaurant_open_tabs.items): the dish
// and its size, add-ons, note, seat and course, and its discount or why it
// is on the house with who allowed it.
function keptLine(l) {
  var kept = l.custom ? { custom: Object.assign({ name: l.name, price: l.unitPrice, category: l.category || '' }, l.fee ? { fee: true } : {}), qty: l.qty, note: l.note || '' }
    : { menuItemId: l.menuItemId, variationId: l.variationId, qty: l.qty, note: l.note || '', modifiers: check.modsAsked(l.modifiers) };
  if (l.seat) kept.seat = l.seat;
  if (l.course !== null && l.course !== undefined) kept.course = l.course;
  return Object.assign(kept, check.keepOnTab(l));
}

// The discounts and dishes on the house of a bill, for the activity log.
function discountWords(b) {
  var parts = [];
  b.lines.forEach(function (l) {
    if (l.compReason) parts.push(l.name + ' on the house (' + l.compReason + ', ' + l.discountBy + ')');
    else if (l.discountAsked) parts.push(l.discountAsked.name + ' on ' + l.name + ' (' + l.discountAsked.by + ')');
  });
  if (b.adjust.promo) parts.push('deal ' + b.adjust.promo.name + ' (' + Number(b.adjust.promo.amount).toFixed(2) + (b.adjust.promoCode ? ', code ' + b.adjust.promoCode : '') + ')');
  if (b.adjust.discount) parts.push(b.adjust.discount.name + ' on the bill (' + b.adjust.discount.by + ')');
  if (b.adjust.serviceOff) parts.push('service charge taken off (' + b.adjust.serviceOff.by + ')');
  return parts.length ? ' ' + parts.join('; ') + '.' : '';
}
async function personName(db, employeeId) {
  var r = (await db.query("SELECT first_name || ' ' || last_name AS n FROM employees WHERE id = $1", [employeeId])).rows[0];
  return r ? r.n : '';
}

async function tabRows(companyId, where, args) {
  var res = await pool.query(
    'SELECT t.*, rt.name AS table_name, g.name AS guest_name, g.phone AS guest_phone, ' +
    "  we.first_name || ' ' || we.last_name AS waiter_name, oe.first_name || ' ' || oe.last_name AS opened_by_name, " +
    // Paid on the self-order kiosk already (restaurantKiosk): the Paystack payment for the cashier to take.
    "  (SELECT json_build_object('ref', ps.reference, 'amount', ps.amount, 'channel', ps.channel) FROM restaurant_table_orders ko JOIN restaurant_paystack_payments ps ON ps.reference = ko.paystack_ref " +
    "     WHERE ko.tab_id = t.id AND ps.status = 'success' AND ps.used_by_order IS NULL LIMIT 1) AS kiosk_paid, " +
    "  EXISTS (SELECT 1 FROM restaurant_table_orders kk WHERE kk.tab_id = t.id AND kk.kind = 'kiosk') AS from_kiosk, " +
    // Paid by guests from the table (restaurantTablePay): for the cashier to take with the rest.
    "  (SELECT json_agg(json_build_object('ref', tp.reference, 'amount', tp.amount, 'tip', tp.tip, 'payer', tp.payer, 'channel', tp.channel) ORDER BY tp.paid_at) FROM restaurant_paystack_payments tp " +
    "     WHERE tp.tab_id = t.id AND tp.purpose = 'table' AND tp.status = 'success' AND tp.used_by_order IS NULL) AS table_paid " +
    'FROM restaurant_open_tabs t LEFT JOIN restaurant_tables rt ON rt.id = t.table_id LEFT JOIN restaurant_guests g ON g.id = t.guest_id ' +
    'LEFT JOIN employees we ON we.id = t.waiter_id LEFT JOIN employees oe ON oe.id = t.opened_by ' +
    'WHERE t.company_id = $1' + (where || '') + ' ORDER BY t.created_at', [companyId].concat(args || []));
  var out = [];
  var settings = res.rows.length ? await access.settingsOf(companyId) : null;
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    var priced = [];
    var gone = 0;
    for (var j = 0; j < r.items.length; j++) {
      var it = r.items[j];
      try {
        priced.push(Object.assign({ variationId: it.variationId || null }, (await priceLines(pool, companyId, [it], true)).lines[0]));
      } catch (e) { gone += 1; }
    }
    // Its discounts and service charge as they were given when it was saved.
    var bill;
    try { bill = check.compute(priced, r.adjust, settings, r.fulfillment || 'dine_in', { companyId: companyId, name: null, can: {}, before: { items: r.items, adjust: r.adjust || {} }, guests: r.guests }); }
    catch (e) { bill = check.compute(priced.map(function (l) { return Object.assign({}, l, { discount: null, comp: null }); }), {}, settings, r.fulfillment || 'dine_in', null); }
    var lines = bill.lines.map(lineOut);
    var total = bill.total;
    out.push({
      id: r.id, label: r.label || '', tableId: r.table_id, tableName: r.table_name || null,
      waiterId: r.waiter_id, waiterName: r.waiter_name || null, guestId: r.guest_id, guestName: r.guest_name || null, guestPhone: r.guest_phone || null,
      fulfillment: r.fulfillment || 'dine_in', customerName: r.customer_name || '', customerPhone: r.customer_phone || '', deliveryAddress: r.delivery_address || '',
      openedBy: r.opened_by_name || null, createdAt: r.created_at, updatedAt: r.updated_at,
      lines: lines, total: total, bill: billOut(bill), adjust: r.adjust || {}, unavailable: gone, kitchen: null,
      paidOnKiosk: r.kiosk_paid ? { ref: r.kiosk_paid.ref, amount: Number(r.kiosk_paid.amount), channel: r.kiosk_paid.channel } : null, fromKiosk: !!r.from_kiosk,
      paidAtTable: (r.table_paid || []).map(function (x) { return { ref: x.ref, amount: Number(x.amount), tip: Number(x.tip), payer: x.payer || '', channel: x.channel || '' }; }),
      guests: r.guests || null, allergy: r.allergy || null, firedCourse: r.fired_course || 0
    });
  }
  // Where each one's food stands: cooking, ready, served (a tag on the till).
  var st = await kitchen.statusOf(pool, companyId, 'tab_id', out.map(function (t) { return t.id; }));
  out.forEach(function (t) { t.kitchen = st[t.id] || null; });
  // A delivery gone out with a rider (restaurantDelivery send), and a website order it came from.
  if (out.length) {
    var ids = out.map(function (t) { return t.id; });
    var ds = (await pool.query("SELECT id, tab_id, number, status, rider_name, to_collect, collect_method, collected_amount, collected_method, collected_at, collected_note FROM restaurant_deliveries " +
      "WHERE tab_id = ANY($1::uuid[]) AND status <> 'cancelled' ORDER BY created_at DESC", [ids])).rows;
    var oo = (await pool.query('SELECT tab_id, number FROM restaurant_online_orders WHERE tab_id = ANY($1::uuid[])', [ids])).rows;
    out.forEach(function (t) {
      var d = ds.find(function (x) { return x.tab_id === t.id; });
      t.delivery = d ? { id: d.id, ref: 'D-' + String(d.number).padStart(3, '0'), status: d.status, riderName: d.rider_name, toCollect: Number(d.to_collect), collectMethod: d.collect_method,
        collected: d.collected_at ? { amount: Number(d.collected_amount), method: d.collected_method, at: d.collected_at, note: d.collected_note || '' } : null } : null;
      var o = oo.find(function (x) { return x.tab_id === t.id; });
      t.onlineRef = o ? 'W-' + String(o.number).padStart(4, '0') : null;
    });
  }
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
  return saveTabFor(await access.need(token, 'keepOpen'), Object.assign({}, p, { placed: undefined }));
}
// An open order saved and sent to the kitchen by whoever the session is: the
// till (saveTab), or the delivery screen accepting a website order
// (restaurantOnline accept).
async function saveTabFor(session, p) {
  p = p || {};
  // Sent from the till while it was offline, and made already: that one.
  var clientRef = p.id ? null : clientRefOf(p);
  var made = clientRef ? (await pool.query('SELECT id FROM restaurant_open_tabs WHERE company_id = $1 AND client_ref = $2', [session.posCompanyId, clientRef])).rows[0] : null;
  if (made) return Object.assign((await tabRows(session.posCompanyId, ' AND t.id = $2', [made.id]))[0], { kitchenTicket: null, replayed: true });
  try {
    return await keepTab(session, p, clientRef);
  } catch (e) {
    var again = clientRef && e.code === '23505' ? (await pool.query('SELECT id FROM restaurant_open_tabs WHERE company_id = $1 AND client_ref = $2', [session.posCompanyId, clientRef])).rows[0] : null;
    if (again) return Object.assign((await tabRows(session.posCompanyId, ' AND t.id = $2', [again.id]))[0], { kitchenTicket: null, replayed: true });
    throw e;
  }
}
// Whether an open order came from the self-order kiosk (restaurantKiosk).
async function fromKiosk(db, tabId) {
  return !!tabId && (await db.query("SELECT 1 FROM restaurant_table_orders WHERE tab_id = $1 AND kind = 'kiosk' LIMIT 1", [tabId])).rows.length > 0;
}
async function keepTab(session, p, clientRef) {
  if (p.id && !p.kioskOrder && await fromKiosk(pool, p.id)) p = Object.assign({}, p, { kioskOrder: true });
  if (session.access.settings.requireWaiter && p.tableId && !p.waiterId && p.fulfillment !== 'pickup' && p.fulfillment !== 'delivery') fail('invalid', 'Pick the waiter for this table.');
  var company = session.posCompanyId;
  var refs = await resolveRefs(pool, company, p);
  var type = await orderType(pool, company, p, refs);
  var priced = await priceLines(pool, company, p.items, session.access.can.customItem);
  // Its discounts, dishes on the house and service charge, allowed by the
  // person's role, a manager's approval, or given before (restaurantTillCheck).
  var stored = p.id ? (await pool.query('SELECT items, adjust, guests, allergy, fired_course FROM restaurant_open_tabs WHERE id = $1 AND company_id = $2', [p.id, company])).rows[0] : null;
  // Not sent by whoever adds to it (a table's QR order): as it was.
  var adjustAsked = p.adjust !== undefined ? p.adjust : stored ? stored.adjust : {};
  // A website or kiosk order's deal comes with it, as it was given there (placed: only from the server, never the till's own request).
  var given = stored ? { items: stored.items, adjust: stored.adjust || {} } : p.placed ? { items: [], adjust: p.placed.adjust || {} } : null;
  var bill = check.compute(priced.lines, adjustAsked, session.access.settings, type.fulfillment || 'dine_in',
    { companyId: company, name: session.posEmployeeId ? await personName(pool, session.posEmployeeId) : '', can: session.access.can || {}, before: given,
      guests: p.guests !== undefined ? guestsOf(p.guests) : stored ? stored.guests : null });
  var items = bill.lines.map(keptLine);
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
  // Nor a new dish outside its menu's hours.
  times.checkHours(session.access.settings, priced.lines, before ? before.items : null);
  // How many sat down and any allergy alert (as before when not said).
  var guests = p.guests !== undefined ? guestsOf(p.guests) : stored ? stored.guests : null;
  var allergy = p.allergy !== undefined ? allergyOf(p.allergy) : stored ? stored.allergy : null;
  // Courses: eaten in, the later ones wait at the kitchen until called.
  var hold = !!(session.access.settings.courses.on && (type.fulfillment || 'dine_in') === 'dine_in');
  // Saved and sent to the kitchen together: the new round goes, what was
  // taken off is cancelled (restaurantKitchen.service.js fire).
  var sent = await withTransaction(async function (client) {
    var id;
    if (p.id) {
      var up = await client.query(
        'UPDATE restaurant_open_tabs SET label = $3, table_id = $4, waiter_id = $5, guest_id = $6, items = $7, fulfillment = $8, customer_name = $9, customer_phone = $10, delivery_address = $11, adjust = $12, ' +
        '  guests = $13, allergy = $14, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING id',
        [p.id, company, label, refs.tableId, refs.waiterId, refs.guestId, JSON.stringify(items), type.fulfillment || 'dine_in', type.customerName, type.customerPhone, type.deliveryAddress, JSON.stringify(bill.adjust),
          guests, allergy ? JSON.stringify(allergy) : null]);
      if (!up.rows[0]) fail('notfound', 'That open order has already been paid or removed.');
      id = up.rows[0].id;
    } else {
      id = (await client.query(
        'INSERT INTO restaurant_open_tabs (company_id, label, table_id, waiter_id, guest_id, items, opened_by, fulfillment, customer_name, customer_phone, delivery_address, client_ref, adjust, guests, allergy) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id',
        [company, label, refs.tableId, refs.waiterId, refs.guestId, JSON.stringify(items), session.posEmployeeId, type.fulfillment || 'dine_in', type.customerName, type.customerPhone, type.deliveryAddress, clientRef, JSON.stringify(bill.adjust),
          guests, allergy ? JSON.stringify(allergy) : null])).rows[0].id;
    }
    var names = await refNames(client, refs, type);
    var ticket = await kitchen.fire(client, company, Object.assign({
      lines: priced.lines, tabId: id, label: label || names.tableName || names.guestName || '', note: p.kitchenNote, sentBy: session.posEmployeeId,
      settings: session.access.settings, hold: hold, firedCourse: stored ? stored.fired_course : 0, allergy: allergy, guests: guests
    }, names));
    if (ticket && ticket.firedCourse !== (stored ? stored.fired_course : 0)) await client.query('UPDATE restaurant_open_tabs SET fired_course = $2 WHERE id = $1', [id, ticket.firedCourse]);
    var chits = ticket ? await kitchen.chitsFor(client, ticket.ids) : [];
    await activity.log(client, { companyId: company, employeeId: session.posEmployeeId, app: 'till', action: 'till.kitchen',
      summary: (ticket ? 'Sent to the kitchen as #' + ticket.number + ': ' : 'Kept open (nothing new for the kitchen): ') + (label || names.tableName || names.guestName || 'order') +
        (type.fulfillment ? ' · ' + FULFILLMENT_NAME[type.fulfillment] : '') + ' · ' + bill.total.toFixed(2) + '.' + discountWords(bill),
      amount: bill.total, refType: 'tab', refId: id, details: { dishes: ticket ? ticket.dishes : [], fulfillment: type.fulfillment, kitchenTicket: ticket ? ticket.number : null, approvedBy: bill.approvals } });
    return { id: id, ticket: ticket, chits: chits };
  });
  return Object.assign((await tabRows(company, ' AND t.id = $2', [sent.id]))[0], { kitchenTicket: sent.ticket, chits: sent.chits });
}

// POST /api/pos/tabs/:id/fire { course } — the next course called: what
// waited at the kitchen for it is cooked now (restaurantKitchen fireCourse).
// course: up to which (the next one waiting, unless said).
async function fireCourse(token, id, p) {
  var session = await access.need(token, 'keepOpen');
  var company = session.posCompanyId;
  var names = session.access.settings.courses.names || [];
  var out = await withTransaction(async function (client) {
    var tab = await lockTab(client, company, id);
    var waiting = (await client.query("SELECT DISTINCT course FROM restaurant_kitchen_tickets WHERE company_id = $1 AND tab_id = $2 AND status = 'held' ORDER BY 1", [company, id])).rows.map(function (r) { return r.course; });
    if (!waiting.length) fail('invalid', 'Nothing is waiting to be called on this order.');
    var upTo = p && p.course !== undefined ? Math.round(Number(p.course)) : waiting[0];
    if (!(upTo >= waiting[0])) fail('invalid', 'That course has been called already.');
    var ids = await kitchen.fireCourse(client, company, id, upTo);
    await client.query('UPDATE restaurant_open_tabs SET fired_course = greatest(fired_course, $2), updated_at = now() WHERE id = $1', [id, upTo]);
    var n = await tabNames(client, tab);
    var called = waiting.filter(function (c) { return c <= upTo; }).map(function (c) { return names[c - 1] || 'course ' + c; });
    await activity.log(client, { companyId: company, employeeId: session.posEmployeeId, app: 'till', action: 'till.course',
      summary: 'Called ' + called.join(' and ') + ' for ' + tabWords(tab, n) + '.', refType: 'tab', refId: id });
    return { chits: await kitchen.chitsFor(client, ids), called: called };
  });
  return Object.assign((await tabRows(company, ' AND t.id = $2', [id]))[0], out);
}

async function removeTab(token, id) {
  var session = await access.need(token, 'removeTable');
  return withTransaction(async function (client) {
    var res = await client.query('DELETE FROM restaurant_open_tabs WHERE id = $1 AND company_id = $2 RETURNING id, label, table_id', [id, session.posCompanyId]);
    if (!res.rows[0]) fail('notfound', 'That open order has already been paid or removed.');
    // Nothing more to cook for it.
    await kitchen.cancelForTab(client, session.posCompanyId, id);
    // A website order it came from is cancelled (its customer sees so), and a delivery on its way stops.
    await client.query("UPDATE restaurant_online_orders SET status = 'cancelled', reject_reason = 'Cancelled by the restaurant.', updated_at = now() WHERE tab_id = $1 AND company_id = $2 AND status = 'accepted'",
      [id, session.posCompanyId]);
    await client.query("UPDATE restaurant_deliveries SET status = 'cancelled', ended_at = now(), note = 'The order was removed at the till.' WHERE tab_id = $1 AND company_id = $2 AND status IN ('assigned', 'picked_up', 'arrived')",
      [id, session.posCompanyId]);
    var tname = res.rows[0].table_id ? (await client.query('SELECT name FROM restaurant_tables WHERE id = $1', [res.rows[0].table_id])).rows[0] : null;
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.removed',
      summary: 'Removed the open order ' + (res.rows[0].label || (tname && tname.name) || '') + ' (not paid).', refType: 'tab', refId: id });
    return { removed: true };
  });
}

// ── bills: dishes moved, orders joined, an order moved ─────────────────
// Whoever may send orders to the kitchen (keepOpen) may move them about.
// The kitchen keeps cooking what moved (restaurantKitchen moveItems,
// retarget). An order with a delivery or a website order stays whole.

async function lockTab(client, companyId, id) {
  var t = (await client.query('SELECT * FROM restaurant_open_tabs WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, companyId])).rows[0];
  if (!t) fail('notfound', 'That open order has already been paid or removed.');
  return t;
}
async function wholeOnly(client, tab) {
  var n = (await client.query("SELECT (SELECT count(*) FROM restaurant_deliveries WHERE tab_id = $1 AND status <> 'cancelled') + (SELECT count(*) FROM restaurant_online_orders WHERE tab_id = $1) AS n", [tab.id])).rows[0].n;
  if (Number(n) > 0) fail('conflict', 'A delivery or a website order stays in one piece.');
}
async function tabNames(client, tab) {
  var n = await refNames(client, { tableId: tab.table_id, waiterId: tab.waiter_id, guestId: tab.guest_id }, { fulfillment: tab.fulfillment, customerName: tab.customer_name });
  return Object.assign(n, { label: tab.label || n.tableName || n.guestName || '' });
}
// Lines kept on an open order (its items) joined: the same line adds up.
function joinKept(into, more) {
  var out = into.map(function (it) { return Object.assign({}, it); });
  more.forEach(function (m) {
    var same = out.find(function (it) { return JSON.stringify(Object.assign({}, it, { qty: 0 })) === JSON.stringify(Object.assign({}, m, { qty: 0 })); });
    if (same) same.qty = Math.round((Number(same.qty) + Number(m.qty)) * 100) / 100;
    else out.push(Object.assign({}, m));
  });
  return out;
}
function tabWords(t, n) { return t.label || n.tableName || n.guestName || 'an order'; }

// Some dishes from one open order to another (toTabId), or to a new one at
// a free table (toTableId) or under a name (toLabel). lines: as the till
// has them (restaurantPos lineOut), each with the qty to move.
async function moveDishes(token, id, p) {
  var session = await access.need(token, 'keepOpen');
  p = p || {};
  var company = session.posCompanyId;
  if (!Array.isArray(p.lines) || !p.lines.length) fail('invalid', 'Pick the dishes to move.');
  var out = await withTransaction(async function (client) {
    var from = await lockTab(client, company, id);
    await wholeOnly(client, from);
    var priced = await priceLines(client, company, p.lines.map(function (l) {
      return l.custom ? { custom: { name: l.name, price: l.unitPrice, category: l.category || '' }, qty: l.qty, note: l.note, discount: l.discountSpec, comp: l.comp, seat: l.seat, course: l.course }
        : { menuItemId: l.menuItemId, variationId: l.variationId, qty: l.qty, note: l.note, modifiers: check.modsAsked(l.modifiers), discount: l.discountSpec, comp: l.comp, seat: l.seat, course: l.course };
    }), true);
    var bill = check.compute(priced.lines, {}, session.access.settings, from.fulfillment || 'dine_in',
      { companyId: company, name: '', can: {}, before: { items: from.items, adjust: {} } });
    var rest = takeOut(from.items, bill.lines);
    var moved = bill.lines.map(keptLine);
    var to;
    if (p.toTabId) {
      if (p.toTabId === id) fail('invalid', 'Pick another order to move them to.');
      to = await lockTab(client, company, p.toTabId);
      await wholeOnly(client, to);
      await client.query('UPDATE restaurant_open_tabs SET items = $2, updated_at = now() WHERE id = $1', [to.id, JSON.stringify(joinKept(to.items, moved))]);
    } else {
      var tableId = null;
      if (p.toTableId) {
        var tbl = (await client.query("SELECT id FROM restaurant_tables WHERE id = $1 AND company_id = $2 AND status = 'active'", [p.toTableId, company])).rows[0];
        if (!tbl) fail('invalid', 'That table is no longer available.');
        var busy = (await client.query('SELECT id FROM restaurant_open_tabs WHERE company_id = $1 AND table_id = $2', [company, tbl.id])).rows[0];
        if (busy) fail('conflict', 'That table has an open order: move the dishes to it instead.');
        tableId = tbl.id;
      }
      var label = cleanText(p.toLabel, 60);
      if (!tableId && !label) fail('invalid', 'Pick a free table or give the new order a name.');
      to = (await client.query(
        'INSERT INTO restaurant_open_tabs (company_id, label, table_id, waiter_id, items, opened_by, fulfillment) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [company, label, tableId, from.waiter_id, JSON.stringify(moved), session.posEmployeeId, 'dine_in'])).rows[0];
    }
    var toNames = await tabNames(client, to);
    var fromNames = await tabNames(client, from);
    await kitchen.moveItems(client, company, from.id, bill.lines, Object.assign({ tabId: to.id }, toNames));
    if (rest.length) await client.query('UPDATE restaurant_open_tabs SET items = $2, updated_at = now() WHERE id = $1', [from.id, JSON.stringify(rest)]);
    else await client.query('DELETE FROM restaurant_open_tabs WHERE id = $1', [from.id]);
    await activity.log(client, { companyId: company, employeeId: session.posEmployeeId, app: 'till', action: 'till.moved',
      summary: 'Moved ' + bill.lines.map(function (l) { return l.qty + '× ' + l.name; }).join(', ') + ' from ' + tabWords(from, fromNames) + ' to ' + tabWords(to, toNames) + (rest.length ? '.' : ' (nothing left there).'),
      amount: bill.total, refType: 'tab', refId: to.id });
    return { fromId: rest.length ? from.id : null, toId: to.id };
  });
  return {
    from: out.fromId ? (await tabRows(company, ' AND t.id = $2', [out.fromId]))[0] : null,
    to: (await tabRows(company, ' AND t.id = $2', [out.toId]))[0]
  };
}

// One open order joined to another (intoTabId): its dishes, and the
// kitchen's tickets for them; the other keeps its own discounts.
async function mergeTabs(token, id, p) {
  var session = await access.need(token, 'keepOpen');
  p = p || {};
  var company = session.posCompanyId;
  if (!p.intoTabId || p.intoTabId === id) fail('invalid', 'Pick the order to join it to.');
  var intoId = await withTransaction(async function (client) {
    var from = await lockTab(client, company, id);
    var into = await lockTab(client, company, p.intoTabId);
    await wholeOnly(client, from);
    await wholeOnly(client, into);
    await client.query('UPDATE restaurant_open_tabs SET items = $2, updated_at = now() WHERE id = $1', [into.id, JSON.stringify(joinKept(into.items, from.items))]);
    var names = await tabNames(client, into);
    var fromNames = await tabNames(client, from);
    await kitchen.retarget(client, company, from.id, into.id, names);
    await client.query('DELETE FROM restaurant_open_tabs WHERE id = $1', [from.id]);
    await activity.log(client, { companyId: company, employeeId: session.posEmployeeId, app: 'till', action: 'till.joined',
      summary: 'Joined ' + tabWords(from, fromNames) + ' to ' + tabWords(into, names) + '.', refType: 'tab', refId: into.id });
    return into.id;
  });
  return (await tabRows(company, ' AND t.id = $2', [intoId]))[0];
}

// An open order moved to another table, waiter or name: p { tableId,
// waiterId, label } (each only if given). The kitchen is told where its
// food goes now.
async function moveTab(token, id, p) {
  var session = await access.need(token, 'keepOpen');
  p = p || {};
  var company = session.posCompanyId;
  await withTransaction(async function (client) {
    var t = await lockTab(client, company, id);
    var before = await tabNames(client, t);
    var refs = await resolveRefs(client, company, {
      tableId: p.tableId !== undefined ? p.tableId : t.table_id, waiterId: p.waiterId !== undefined ? p.waiterId : t.waiter_id, guestId: t.guest_id
    });
    if (refs.tableId && (t.fulfillment || 'dine_in') !== 'dine_in') fail('invalid', 'Only a dine-in order sits at a table.');
    if (refs.tableId && refs.tableId !== t.table_id) {
      var busy = (await client.query('SELECT id FROM restaurant_open_tabs WHERE company_id = $1 AND table_id = $2 AND id <> $3', [company, refs.tableId, id])).rows[0];
      if (busy) fail('conflict', 'That table has an open order: join the two instead.');
    }
    var label = p.label !== undefined ? cleanText(p.label, 60) : t.label;
    if (!refs.tableId && !label && !t.guest_id && !t.customer_name) fail('invalid', 'Give the order a table or a name, so it can be found again.');
    var up = (await client.query('UPDATE restaurant_open_tabs SET table_id = $2, waiter_id = $3, label = $4, updated_at = now() WHERE id = $1 RETURNING *',
      [id, refs.tableId, refs.waiterId, label])).rows[0];
    var after = await tabNames(client, up);
    await kitchen.retarget(client, company, id, id, after);
    await activity.log(client, { companyId: company, employeeId: session.posEmployeeId, app: 'till', action: 'till.moved',
      summary: 'Moved ' + tabWords(t, before) + ' to ' + (after.tableName || after.label || 'no table') + (after.waiterName && after.waiterName !== before.waiterName ? ', waiter ' + after.waiterName : '') + '.',
      refType: 'tab', refId: id });
  });
  return (await tabRows(company, ' AND t.id = $2', [id]))[0];
}

// A manager's PIN for a discount, a dish on the house or the service
// charge taken off (restaurantTillCheck approval): { managerPin, what,
// discount, line } → { approval, by }.
async function approve(token, p, ip) {
  var session = await access.need(token, ['charge', 'keepOpen']);
  p = p || {};
  var manager = await access.approver(session.posCompanyId, p.managerPin, ip, p.what === 'comp' ? 'comp' : 'discount');
  return Object.assign(check.approval(session.posCompanyId, manager, p, session.access.settings), { by: manager.first_name + ' ' + manager.last_name });
}

// ── the receipt, sent ──────────────────────────────────────────────────
// A sale's receipt as a page on the restaurant's website (receiptUrl), sent
// to the customer: by text message (sms.service, the company's mNotify
// credit), or by WhatsApp — the till opens WhatsApp with the message
// written, and the cashier sends it. p: { channel: 'sms' | 'whatsapp',
// phone, text (the message in the till's language, with the link) }.
function phoneDigits(v) {
  var d = String(v || '').replace(/[^0-9+]/g, '');
  if (d.indexOf('+') === 0) d = d.slice(1);
  else if (d.indexOf('00') === 0) d = d.slice(2);
  else if (d.length === 10 && d[0] === '0') d = '233' + d.slice(1);
  return /^[0-9]{9,15}$/.test(d) ? d : null;
}
async function sendReceipt(token, orderId, p, ip) {
  var session = await access.need(token, 'charge');
  p = p || {};
  var channel = V.oneOf(p.channel, ['sms', 'whatsapp'], 'Send it by text message or WhatsApp');
  var digits = phoneDigits(p.phone);
  if (!digits) fail('invalid', 'Type the customer\'s phone number, e.g. 024 412 3456.');
  var o = (await pool.query('SELECT o.*, c.name AS company_name FROM restaurant_orders o JOIN companies c ON c.id = o.company_id WHERE o.id = $1 AND o.company_id = $2', [orderId, session.posCompanyId])).rows[0];
  if (!o) fail('notfound', 'Order not found.');
  var tok = o.receipt_token;
  if (!tok) tok = (await pool.query('UPDATE restaurant_orders SET receipt_token = coalesce(receipt_token, $2) WHERE id = $1 RETURNING receipt_token', [o.id, newReceiptToken()])).rows[0].receipt_token;
  var link = receiptUrl(tok, o.order_no);
  var msgText = cleanText(p.text, 300) || ('Thank you for coming to ' + o.company_name + '. Your receipt ' + o.order_no + ' (GHS ' + Number(o.total).toFixed(2) + '): ' + link);
  if (msgText.indexOf(link) < 0) msgText = (msgText + ' ' + link).slice(0, 420);
  var by = await personName(pool, session.posEmployeeId);
  var out = { channel: channel, link: link };
  if (channel === 'sms') {
    await require('./sms.service').send({ to: '+' + digits, message: msgText, purpose: 'receipt', refId: o.id });
    out.sent = true;
  } else {
    out.url = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(msgText);
  }
  var shown = '+' + digits;
  await pool.query("UPDATE restaurant_orders SET receipt_sends = receipt_sends || $2::jsonb WHERE id = $1", [o.id, JSON.stringify([{ channel: channel, to: shown, at: new Date().toISOString(), by: by }])]);
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.receipt',
    summary: 'Receipt ' + o.order_no + (channel === 'sms' ? ' texted to ' : ' sent by WhatsApp to ') + shown + '.', refType: 'order', refId: o.id });
  return out;
}

// The receipt page on the restaurant's website (GET /api/pos/receipt/:token):
// the sale as the customer's receipt — no phone, no address.
async function publicReceipt(tok) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(tok || ''))) fail('notfound', 'This receipt link is not right.');
  var o = (await pool.query(
    "SELECT o.*, c.name AS company_name, c.code AS company_code, t.name AS table_name, we.first_name AS waiter_first, ce.first_name AS cashier_first " +
    'FROM restaurant_orders o JOIN companies c ON c.id = o.company_id LEFT JOIN restaurant_tables t ON t.id = o.table_id ' +
    'LEFT JOIN employees we ON we.id = o.waiter_id LEFT JOIN employees ce ON ce.id = o.cashier_id WHERE o.receipt_token = $1', [tok])).rows[0];
  if (!o) fail('notfound', 'This receipt link is not right, or the sale is no longer there.');
  var items = (await pool.query('SELECT ' + ITEM_COLS + ' FROM restaurant_order_items WHERE order_id = $1 ORDER BY sort_order, id', [o.id])).rows.map(itemRow);
  var paid = (await money.paymentsOf(pool, [o.id])).get(o.id) || [];
  var full = rowToOrder(o, items, paid);
  var settings = await access.settingsOf(o.company_id);
  var refunds = (await money.refundsOf(pool, o.id)).map(function (r) { return { amount: r.amount, createdAt: r.createdAt, items: r.items }; });
  return {
    restaurant: { name: o.company_name, code: o.company_code, website: deliveries().shopUrl(o.company_code) },
    orderNo: o.order_no, createdAt: o.created_at, status: o.status, fulfillment: o.fulfillment || '', tableName: o.table_name || null,
    servedBy: o.waiter_first || o.cashier_first || null,
    items: full.items.map(function (it) { return { name: it.name, qty: it.qty, unitPrice: it.unitPrice, gross: it.gross, discount: it.discount, discountName: it.discountName, compReason: it.compReason, lineTotal: it.lineTotal, modifiers: it.modifiers, note: it.note }; }),
    itemsGross: full.itemsGross, discountTotal: full.discountTotal, billDiscount: full.billDiscount ? { name: full.billDiscount.name, amount: full.billDiscount.amount } : null,
    subtotal: full.subtotal, serviceCharge: full.serviceCharge, serviceName: full.serviceName, serviceRate: full.serviceRate,
    taxes: full.taxes, taxTotal: full.taxTotal, taxIncluded: full.taxIncluded, total: full.total,
    paymentMethod: o.payment_method, payments: paid.map(function (x) { return { method: x.method, amount: x.amount, currency: x.currency, foreignAmount: x.foreignAmount, rate: x.rate, tendered: x.tendered, giftCard: x.giftCard || null }; }),
    change: full.change, refunded: Number(o.refunded_total), refunds: refunds, tip: Number(o.tip || 0),
    points: o.points_earned || o.points_used ? { earned: o.points_earned || 0, used: o.points_used || 0 } : null,
    footer: settings.receipt.footer || '', extra: settings.receipt.extra || ''
  };
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
  var items = (await pool.query('SELECT ' + ITEM_COLS + ' FROM restaurant_order_items WHERE order_id = $1 ORDER BY sort_order, id', [o.id])).rows;
  var paid = (await money.paymentsOf(pool, [o.id])).get(o.id) || [];
  return Object.assign(rowToOrder(o, items.map(itemRow), paid), {
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
  var itemsRes = await pool.query('SELECT ' + ITEM_COLS + ' FROM restaurant_order_items WHERE order_id = $1 ORDER BY sort_order, name', [id]);
  var paid = (await money.paymentsOf(pool, [id])).get(id) || [];
  var full = rowToOrder(order, itemsRes.rows.map(itemRow), paid);
  return {
    id: order.id, companyId: order.company_id, orderNo: order.order_no, cashierName: order.first_name + ' ' + order.last_name,
    tableName: order.table_name, waiterName: order.waiter_first_name ? order.waiter_first_name + ' ' + order.waiter_last_name : null,
    guestName: order.guest_name, guestPhone: order.guest_phone,
    subtotal: Number(order.subtotal), total: Number(order.total), paymentMethod: order.payment_method, status: order.status, createdAt: order.created_at,
    items: full.items,
    itemsGross: full.itemsGross, discountTotal: full.discountTotal, serviceCharge: full.serviceCharge, serviceName: full.serviceName, serviceRate: full.serviceRate,
    billDiscount: full.billDiscount, taxes: full.taxes, taxTotal: full.taxTotal, taxIncluded: full.taxIncluded,
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
    await costs().returnForVoid(client, res.rows[0]);
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
  // top-ups taken in cash, VIP money given back and cash lent on IOU
  // accounts, by this cashier on this drawer.
  var other = await money.drawerCash(db, session.cashier_id, session.company_id, session.opened_at, endTime);
  var cashRefunds = other.refunds;
  var netPaidInOut = paidIn - paidOut;
  var expected = Math.round((startingCash + cashSales + other.iouPaid + other.vipTopUps + other.giftSold - cashRefunds - other.vipCashOuts - other.iouLent - other.giftVoided + netPaidInOut) * 100) / 100;
  var actual = session.closing_actual_cash == null ? null : Number(session.closing_actual_cash);
  return {
    session: rowToSession(session),
    startingCash: startingCash, cashSales: cashSales, cashRefunds: cashRefunds, iouPaidCash: other.iouPaid, vipTopUpsCash: other.vipTopUps, foreignCash: sales.foreign,
    vipCashOutsCash: other.vipCashOuts, iouLentCash: other.iouLent, giftSoldCash: other.giftSold, giftVoidedCash: other.giftVoided,
    paidIn: paidIn, paidOut: paidOut, netPaidInOut: netPaidInOut,
    expected: expected, actual: actual, difference: actual == null ? null : Math.round((actual - expected) * 100) / 100,
    movements: movementsListRes.rows.map(function (m) {
      return { id: m.id, direction: m.direction, account: null, amount: Number(m.amount), note: m.note, createdAt: m.created_at };
    }).concat(await money.accountMoves(db, session.cashier_id, session.company_id, session.opened_at, endTime))
      .sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); })
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
  moveDishes: moveDishes, mergeTabs: mergeTabs, moveTab: moveTab, approve: approve, sendReceipt: sendReceipt, publicReceipt: publicReceipt, phoneDigits: phoneDigits,
  login: login, menuForSession: menuForSession, createOrder: createOrder,
  listOrders: listOrders, getOrder: getOrder, voidOrder: voidOrder,
  toggleFavorite: toggleFavorite, mostlyBought: mostlyBought,
  getOpenDrawerSession: getOpenDrawerSession, openDrawerSession: openDrawerSession,
  addDrawerMovement: addDrawerMovement, closeDrawerSession: closeDrawerSession,
  listDrawerSessions: listDrawerSessions, getDrawerSession: getDrawerSession,
  tablesForSession: tablesForSession, waitersForSession: waitersForSession,
  guestsForSession: guestsForSession, createGuestForSession: createGuestForSession, guestContact: guestContact,
  listTabs: listTabs, saveTab: saveTab, saveTabFor: saveTabFor, removeTab: removeTab, fireCourse: fireCourse, tabRows: tabRows, priceLines: priceLines, FEE_NAME: FEE_NAME,
  shiftSummary: shiftSummary, receiptForSession: receiptForSession, verifyPosToken: verifyPosToken,
  closeDrawerFor: closeDrawerFor, signOut: signOut, drawerHistory: drawerHistory, raiseDispute: raiseDispute
};
