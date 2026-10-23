var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var config = require('../config');
var access = require('./restaurantTillAccess.service');
var times = require('./restaurantTillTimes.service');
var activity = require('./restaurantActivity.service');
var kitchen = require('./restaurantKitchen.service');
var tillMenu = require('./restaurantTillMenu.service');

// Ordering from the table (migration 0166). Each table has a QR code (its
// qr_token, printed from the till settings) that opens the restaurant's
// menu on the customer's phone: online.starbartema.com/q/<code>. What they
// send waits on the till for someone to accept it — onto the table's open
// order, sent to the kitchen like any other round — or turn it down with a
// reason; or, if the restaurant says so (till settings qrOrders), it goes
// to the kitchen straight away. The customer follows it on the same page,
// sees what the table has had, and can call the waiter or ask for the bill.
// Paid at the till as the table's open order, as ever.
//
//   pending → accepted        or rejected / cancelled (by the customer, while it waits)

var MAX_LINES = 30;
var MAX_QTY = 20;
var MAX_PENDING_PER_TABLE = 4;
// Orders and calls from one address, at most, in an hour.
var PER_IP_HOUR = 20;
var fromIp = new Map();

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function hash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function pos() { return require('./restaurantPos.service'); }
function online() { return require('./restaurantOnline.service'); }
function ref(n) { return 'Q-' + String(n).padStart(4, '0'); }
function newCode() { return crypto.randomBytes(9).toString('base64url'); }
function minutesSince(ts) { return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60000)); }
function tableUrl(code) { return config.onlineSiteUrl + '/q/' + code; }

function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (fromIp.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many orders from this phone in the last hour. Ask a waiter.');
  list.push(now);
  fromIp.set(key, list);
  if (fromIp.size > 5000) fromIp.clear();
}

// The table a QR code is on, with its restaurant and the till's settings.
async function tableOf(code, client) {
  var t = (await (client || pool).query(
    "SELECT t.id, t.name, t.area, t.company_id, c.code AS company_code, c.name AS company_name FROM restaurant_tables t JOIN companies c ON c.id = t.company_id " +
    "WHERE t.qr_token = $1 AND t.status = 'active'", [String(code || '').slice(0, 40)])).rows[0];
  if (!t) fail('notfound', 'This table\'s code is not working any more. Ask a waiter for a new one.');
  t.settings = await access.settingsOf(t.company_id);
  return t;
}
// What the table has had so far: its open order on the till.
async function billOf(t) {
  var tab = (await pos().tabRows(t.company_id, ' AND t.table_id = $2', [t.id]))[0];
  if (!tab) return { items: [], total: 0 };
  // With its add-ons and discounts, and the service charge and taxes (restaurantPos billOut).
  return {
    items: tab.lines.map(function (l) { return { name: l.name, qty: l.qty, lineTotal: l.lineTotal, modifiers: l.modifiers || [], discount: l.discount || 0, compReason: l.compReason || null }; }),
    total: tab.total, serviceCharge: tab.bill ? tab.bill.serviceCharge : 0, serviceName: tab.bill ? tab.bill.serviceName : null,
    taxes: tab.bill ? tab.bill.taxes : [], discountTotal: tab.bill ? tab.bill.discountTotal : 0
  };
}
function orderOut(o, ticketState) {
  var stage = o.status === 'pending' ? 'waiting' : o.status === 'accepted' ? (ticketState === 'served' ? 'served' : ticketState === 'ready' ? 'ready' : 'cooking') : o.status;
  return {
    ref: ref(o.number), status: o.status, stage: stage, items: o.items, subtotal: round2(o.subtotal), note: o.note, name: o.customer_name,
    rejectReason: o.reject_reason, placedAt: o.created_at, decidedAt: o.decided_at, canCancel: o.status === 'pending'
  };
}
async function ticketStates(companyId, ids) {
  var ids2 = ids.filter(Boolean);
  if (!ids2.length) return {};
  var rows = (await pool.query("SELECT id, CASE WHEN served_at IS NOT NULL OR status = 'served' THEN 'served' ELSE status END AS state FROM restaurant_kitchen_tickets WHERE company_id = $1 AND id = ANY($2::uuid[])",
    [companyId, ids2])).rows;
  var out = {};
  rows.forEach(function (r) { out[r.id] = r.state; });
  return out;
}
async function openCalls(tableId) {
  return (await pool.query('SELECT kind, created_at FROM restaurant_table_calls WHERE table_id = $1 AND answered_at IS NULL', [tableId])).rows
    .map(function (r) { return { kind: r.kind, at: r.created_at }; });
}

// GET /api/pos/table/:code — the table, its restaurant, the menu (the
// till's, every dish), what the table has had, and the calls waiting.
async function page(code) {
  var t = await tableOf(code);
  var m = await online().menuItems(t.company_id, false);
  return {
    restaurant: { code: t.company_code, name: t.company_name }, table: { name: t.name, area: t.area || '' }, open: t.settings.qrOrders.on, straight: t.settings.qrOrders.straightToKitchen,
    categories: m.categories, items: m.items, bill: await billOf(t), calls: await openCalls(t.id)
  };
}

// POST /api/pos/table/:code/orders { items: [{ menuItemId, variationId, qty,
// note }], name, note } — sent from the table. Priced from the menu as it is
// now. Returns its number and the key to follow it with.
async function place(code, p, ip) {
  p = p || {};
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  var t = await tableOf(code);
  if (!t.settings.qrOrders.on) fail('conflict', 'Ordering from the table is off right now. Ask a waiter.');
  if (!Array.isArray(p.items) || !p.items.length) fail('invalid', 'Your basket is empty.');
  if (p.items.length > MAX_LINES) fail('invalid', 'That is a lot of dishes: ask a waiter to take this order.');
  var items = p.items.map(function (i) {
    var qty = Math.round(Number(i && i.qty));
    if (!(qty >= 1 && qty <= MAX_QTY)) fail('invalid', 'Choose between 1 and ' + MAX_QTY + ' of each dish.');
    return { menuItemId: String(i.menuItemId || ''), variationId: i.variationId || undefined, qty: qty, note: cleanText(i.note, 140), modifiers: require('./restaurantOnline.service').modsFrom(i.modifiers) };
  });
  var priced = await pos().priceLines(pool, t.company_id, items, false);
  await tillMenu.checkOrder(pool, t.company_id, priced.lines, null, null);
  // Served now (breakfast in the morning), and a happy hour on now goes on its dishes.
  times.checkHours(t.settings, priced.lines, null);
  times.applyHappy(t.settings, priced.lines);
  var pending = (await pool.query("SELECT count(*)::int AS n FROM restaurant_table_orders WHERE table_id = $1 AND status = 'pending'", [t.id])).rows[0].n;
  if (pending >= MAX_PENDING_PER_TABLE) fail('conflict', 'Your table has orders waiting already. A waiter is coming.');
  throttle(ip);
  var token = crypto.randomBytes(24).toString('base64url');
  var name = cleanText(p.name, 60);
  var saved = await withTransaction(async function (client) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('table-orders:' || $1))", [t.company_id]);
    var number = (await client.query('SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_table_orders WHERE company_id = $1', [t.company_id])).rows[0].n;
    var lines = priced.lines.map(function (l, i) { return Object.assign({ menuItemId: l.menuItemId, variationId: l.variationId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, note: items[i].note || '', modifiers: l.modifiers || [] }, l.discount ? { discount: l.discount } : {}); });
    var row = (await client.query(
      'INSERT INTO restaurant_table_orders (company_id, table_id, number, token_hash, customer_name, note, items, subtotal, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [t.company_id, t.id, number, hash(token), name, cleanText(p.note, 200), JSON.stringify(lines), priced.subtotal, String(ip || '').slice(0, 60)])).rows[0];
    await activity.log(client, { companyId: t.company_id, employeeId: null, app: 'table', action: 'table.ordered',
      summary: t.name + ' ordered ' + ref(number) + ' from the table' + (name ? ' (' + name + ')' : '') + ': ' + lines.map(function (l) { return l.qty + '× ' + l.name; }).join(', ') + ', ' + round2(priced.subtotal).toFixed(2) + '.',
      amount: priced.subtotal, refType: 'table_order', refId: row.id });
    return row;
  });
  // Straight to the kitchen, if the restaurant says so and nobody has to pick the waiter.
  if (t.settings.qrOrders.straightToKitchen) {
    try { saved = (await acceptRow(saved, null, {})).row; } catch (e) { /* it waits on the till instead */ }
  }
  return { ref: ref(saved.number), token: token, order: orderOut(saved, null) };
}

async function byToken(raw, lock, client) {
  var o = (await (client || pool).query('SELECT * FROM restaurant_table_orders WHERE token_hash = $1' + (lock ? ' FOR UPDATE' : ''), [hash(String(raw || ''))])).rows[0];
  if (!o) fail('notfound', 'We cannot find that order.');
  return o;
}
// GET /api/pos/table/orders/:token — one order, where it stands.
async function track(raw) {
  var o = await byToken(raw);
  var st = await ticketStates(o.company_id, [o.kitchen_ticket_id]);
  return orderOut(o, st[o.kitchen_ticket_id] || null);
}
// POST /api/pos/table/orders/:token/cancel — while it waits for the till.
async function cancel(raw) {
  var o = await withTransaction(async function (client) {
    var row = await byToken(raw, true, client);
    if (row.status !== 'pending') fail('conflict', row.status === 'accepted' ? 'It has gone to the kitchen already: ask a waiter to change it.' : 'This order is not waiting any more.');
    var up = (await client.query("UPDATE restaurant_table_orders SET status = 'cancelled', reject_reason = 'Cancelled at the table.', updated_at = now() WHERE id = $1 RETURNING *", [row.id])).rows[0];
    await activity.log(client, { companyId: row.company_id, app: 'table', action: 'table.cancelled', summary: ref(row.number) + ' was cancelled at the table before it was accepted.', refType: 'table_order', refId: row.id });
    return up;
  });
  return orderOut(o, null);
}
// POST /api/pos/table/:code/call { kind: waiter | bill } — once until answered.
async function call(code, p, ip) {
  var t = await tableOf(code);
  var kind = (p || {}).kind === 'bill' ? 'bill' : 'waiter';
  var open = (await pool.query('SELECT id FROM restaurant_table_calls WHERE table_id = $1 AND kind = $2 AND answered_at IS NULL', [t.id, kind])).rows[0];
  if (!open) {
    throttle(ip);
    await pool.query('INSERT INTO restaurant_table_calls (company_id, table_id, kind) VALUES ($1,$2,$3)', [t.company_id, t.id, kind]);
    await activity.log(pool, { companyId: t.company_id, app: 'table', action: 'table.call', summary: t.name + (kind === 'bill' ? ' asked for the bill.' : ' called the waiter.') });
  }
  return { calls: await openCalls(t.id) };
}

// ── on the till ──

function staffOut(o) {
  return {
    id: o.id, ref: ref(o.number), status: o.status, tableId: o.table_id, tableName: o.table_name, area: o.area || '', name: o.customer_name, note: o.note,
    items: o.items, subtotal: round2(o.subtotal), placedAt: o.created_at, waitingMinutes: minutesSince(o.created_at), rejectReason: o.reject_reason,
    hasOpenOrder: !!o.open_tab, waiterName: o.waiter_name || null
  };
}
var STAFF_SELECT =
  "SELECT o.*, t.name AS table_name, t.area, tab.id AS open_tab, w.first_name || ' ' || w.last_name AS waiter_name FROM restaurant_table_orders o JOIN restaurant_tables t ON t.id = o.table_id " +
  'LEFT JOIN restaurant_open_tabs tab ON tab.table_id = o.table_id AND tab.company_id = o.company_id LEFT JOIN employees w ON w.id = tab.waiter_id ';

// GET /api/pos/table-orders — what the tables are asking for: orders
// waiting for an answer and calls not answered, oldest first.
async function inbox(token) {
  var session = await access.need(token, 'till');
  var company = session.posCompanyId;
  var orders = (await pool.query(STAFF_SELECT + "WHERE o.company_id = $1 AND o.status = 'pending' ORDER BY o.created_at", [company])).rows.map(staffOut);
  var calls = (await pool.query(
    'SELECT c.id, c.kind, c.created_at, c.table_id, t.name AS table_name, t.area FROM restaurant_table_calls c JOIN restaurant_tables t ON t.id = c.table_id ' +
    'WHERE c.company_id = $1 AND c.answered_at IS NULL ORDER BY c.created_at', [company])).rows
    .map(function (c) { return { id: c.id, kind: c.kind, tableId: c.table_id, tableName: c.table_name, area: c.area || '', at: c.created_at, minutes: minutesSince(c.created_at) }; });
  return { orders: orders, calls: calls, settings: session.access.settings.qrOrders, requireWaiter: session.access.settings.requireWaiter };
}

// An order from the table onto its open order on the till (made if there is
// none), sent to the kitchen as a new round. In the name of the person who
// accepted it, or (straight to the kitchen) of the table's waiter.
async function acceptRow(o, session, p) {
  var tab = (await pool.query('SELECT * FROM restaurant_open_tabs WHERE company_id = $1 AND table_id = $2 ORDER BY created_at LIMIT 1', [o.company_id, o.table_id])).rows[0] || null;
  var settings = session ? session.access.settings : await access.settingsOf(o.company_id);
  var waiterId = tab && tab.waiter_id ? tab.waiter_id : (p.waiterId || null);
  if (!session) {
    if (settings.requireWaiter && !waiterId) fail('invalid', 'Pick the waiter for this table.');
    session = { posCompanyId: o.company_id, posEmployeeId: waiterId, access: { settings: settings, can: { customItem: false } } };
  }
  var claimed = (await pool.query("UPDATE restaurant_table_orders SET decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1 AND status = 'pending' AND decided_at IS NULL RETURNING *",
    [o.id, session.posEmployeeId || null])).rows[0];
  if (!claimed) fail('conflict', 'Someone has answered that order already, or it was cancelled.');
  var add = claimed.items.map(function (l) { return Object.assign({ menuItemId: l.menuItemId, variationId: l.variationId || undefined, qty: l.qty, note: l.note || '', modifiers: require('./restaurantOnline.service').modsFrom(l.modifiers) }, l.discount ? { discount: l.discount } : {}); });
  var t;
  try {
    var note = [ref(claimed.number) + ' (ordered at the table)', claimed.note].filter(Boolean).join(' · ');
    t = tab
      ? await pos().saveTabFor(session, { id: tab.id, tableId: o.table_id, waiterId: waiterId || undefined, guestId: tab.guest_id || undefined, label: tab.label, fulfillment: 'dine_in',
        customerName: tab.customer_name, customerPhone: tab.customer_phone, items: (tab.items || []).concat(add), kitchenNote: note })
      : await pos().saveTabFor(session, { tableId: o.table_id, waiterId: waiterId || undefined, fulfillment: 'dine_in', label: '', customerName: claimed.customer_name, items: add, kitchenNote: note });
  } catch (err) {
    await pool.query('UPDATE restaurant_table_orders SET decided_by = NULL, decided_at = NULL WHERE id = $1', [o.id]);
    throw err;
  }
  var row = (await pool.query("UPDATE restaurant_table_orders SET status = 'accepted', tab_id = $2, kitchen_ticket_id = $3, updated_at = now() WHERE id = $1 RETURNING *",
    [o.id, t.id, t.kitchenTicket ? t.kitchenTicket.id : null])).rows[0];
  await activity.log(pool, { companyId: o.company_id, employeeId: session.posEmployeeId || null, app: 'till', action: 'table.accepted',
    summary: (session.posEmployeeId ? 'Accepted ' : 'Sent straight to the kitchen: ') + ref(claimed.number) + ' from ' + (await pool.query('SELECT name FROM restaurant_tables WHERE id = $1', [o.table_id])).rows[0].name +
      (t.kitchenTicket ? ', kitchen ticket #' + t.kitchenTicket.number : '') + '.',
    amount: round2(claimed.subtotal), refType: 'table_order', refId: o.id });
  return { row: row, tab: t };
}
// POST /api/pos/table-orders/:id/accept { waiterId } — onto the table's open order, to the kitchen.
async function accept(token, id, p) {
  var session = await access.need(token, 'keepOpen');
  var o = (await pool.query('SELECT * FROM restaurant_table_orders WHERE id = $1 AND company_id = $2', [id, session.posCompanyId])).rows[0];
  if (!o) fail('notfound', 'That order is not this restaurant\'s.');
  if (o.status !== 'pending') fail('conflict', o.status === 'cancelled' ? 'The table cancelled that order.' : 'Someone has answered that order already.');
  p = p || {};
  var tab = (await pool.query('SELECT waiter_id FROM restaurant_open_tabs WHERE company_id = $1 AND table_id = $2 LIMIT 1', [o.company_id, o.table_id])).rows[0];
  // The waiter: the table's, the one picked, or the person accepting if they wait tables.
  if (!(tab && tab.waiter_id) && !p.waiterId && session.access.role === 'waiter') p.waiterId = session.posEmployeeId;
  var r = await acceptRow(o, session, p);
  return { order: staffOut(Object.assign({}, r.row, { table_name: '', open_tab: r.tab.id })), tab: { id: r.tab.id, total: r.tab.total, kitchenTicket: r.tab.kitchenTicket || null } };
}
// POST /api/pos/table-orders/:id/reject { reason } — turned down; the table sees why.
async function reject(token, id, p) {
  var session = await access.need(token, 'till');
  var reason = cleanText((p || {}).reason, 200);
  if (!reason) fail('invalid', 'Say why, for the table.');
  var o = (await pool.query("UPDATE restaurant_table_orders SET status = 'rejected', reject_reason = $3, decided_by = $4, decided_at = now(), updated_at = now() " +
    "WHERE id = $1 AND company_id = $2 AND status = 'pending' AND decided_at IS NULL RETURNING *", [id, session.posCompanyId, reason, session.posEmployeeId])).rows[0];
  if (!o) fail('conflict', 'That order has been answered already, or cancelled.');
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'table.rejected',
    summary: 'Turned down ' + ref(o.number) + ' from the table: ' + reason, amount: round2(o.subtotal), refType: 'table_order', refId: o.id });
  return { ok: true };
}
// POST /api/pos/table-calls/:id/answer — someone is on their way.
async function answer(token, id) {
  var session = await access.need(token, 'till');
  var c = (await pool.query('UPDATE restaurant_table_calls SET answered_at = now(), answered_by = $3 WHERE id = $1 AND company_id = $2 AND answered_at IS NULL RETURNING id',
    [id, session.posCompanyId, session.posEmployeeId])).rows[0];
  if (!c) fail('conflict', 'Someone has answered that already.');
  return { ok: true };
}

// POST /api/pos/settings/table-qr { managerPin, renew: tableId | 'all' } — a
// manager prints the tables' QR codes: each active table with its code
// (made the first time), or new codes for one table or all (the old ones
// stop working).
async function qrCodes(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  if (p.renew) {
    var which = p.renew === 'all' ? (await pool.query("SELECT id FROM restaurant_tables WHERE company_id = $1 AND status = 'active'", [company])).rows.map(function (r) { return r.id; }) : [p.renew];
    for (var i = 0; i < which.length; i++) await pool.query('UPDATE restaurant_tables SET qr_token = $3 WHERE id = $1 AND company_id = $2', [which[i], company, newCode()]);
    await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'till', action: 'table.qr',
      summary: p.renew === 'all' ? 'New QR codes for every table: the old ones stopped working.' : 'A new QR code for a table: its old one stopped working.' });
  }
  var rows = (await pool.query("SELECT id, name, area, qr_token FROM restaurant_tables WHERE company_id = $1 AND status = 'active' ORDER BY area, name", [company])).rows;
  for (var j = 0; j < rows.length; j++) {
    if (!rows[j].qr_token) {
      rows[j].qr_token = newCode();
      await pool.query('UPDATE restaurant_tables SET qr_token = $2 WHERE id = $1 AND qr_token IS NULL', [rows[j].id, rows[j].qr_token]);
    }
  }
  var co = (await pool.query('SELECT code, name FROM companies WHERE id = $1', [company])).rows[0];
  return {
    restaurant: { code: co.code, name: co.name }, settings: (await access.settingsOf(company)).qrOrders,
    tables: rows.map(function (r) { return { id: r.id, name: r.name, area: r.area || '', url: tableUrl(r.qr_token) }; })
  };
}

module.exports = { page: page, place: place, track: track, cancel: cancel, call: call, inbox: inbox, accept: accept, reject: reject, answer: answer, qrCodes: qrCodes, ref: ref };
