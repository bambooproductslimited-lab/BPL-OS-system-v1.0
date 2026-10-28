var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var displays = require('./restaurantDisplays.service');

// The "ready for pickup" board (migration 0180; Square's order-ready
// display): a TV facing the customers, opened at /ready-board on the till's
// website and paired with a 6-digit code from the till (More → Ready board),
// like the customer's screen and the kiosk. Two columns from the kitchen
// screen: Preparing and Ready — the kiosk's, the website's and the counter's
// orders (not the tables'), by their number (K-0012, W-0003, else the
// ticket's #) and the first name given, nothing more. An order leaves the
// board when it is handed over (served on the kitchen screen, or the
// expo's bump) or half an hour after it was ready.

var WINDOW_HOURS = 3;
var READY_MINUTES = 30;
function clean(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

async function boardOf(key) {
  var d = await displays.byKey(key);
  if (!d || d.kind !== 'board') fail('auth', 'This board was taken off the till. It shows a new code.');
  return d;
}

// POST /api/pos/board/hello { key }
function hello(key, ip, ua) { return displays.hello(key, ip, ua, 'board'); }

function refOf(r) {
  var m = /^([KWQ]-\d{3,})/.exec(r.label || '');
  return m ? m[1] : '#' + r.number;
}
function firstName(r) {
  var label = String(r.label || '');
  var name = r.guest_name || r.customer_name || (label.indexOf('·') >= 0 ? label.split('·').slice(1).join('·') : /^[KWQ]-\d+\s+/.test(label) ? label.replace(/^[KWQ]-\d+\s+/, '') : '');
  return clean(name, 40).split(' ')[0] || '';
}

// The orders on the board: the counter's, by where their food stands.
async function ordersOf(companyId) {
  var rows = (await pool.query(
    "SELECT k.id, k.number, k.label, k.status, k.created_at, k.ready_at, k.tab_id, k.order_id, k.guest_name, coalesce(t.customer_name, o.customer_name) AS customer_name, " +
    "  coalesce(t.fulfillment, o.fulfillment) AS fulfillment FROM restaurant_kitchen_tickets k LEFT JOIN restaurant_open_tabs t ON t.id = k.tab_id LEFT JOIN restaurant_orders o ON o.id = k.order_id " +
    "WHERE k.company_id = $1 AND k.status IN ('held', 'cooking', 'ready', 'served') AND k.created_at > now() - ($2 || ' hours')::interval " +
    "  AND (coalesce(t.fulfillment, o.fulfillment) IN ('pickup', 'togo') OR k.label ~ '^[KW]-[0-9]') ORDER BY k.created_at", [companyId, String(WINDOW_HOURS)])).rows;
  var groups = {}, order = [];
  rows.forEach(function (r) {
    var g = r.tab_id || r.order_id || r.id;
    if (!groups[g]) { groups[g] = { id: g, ref: refOf(r), name: firstName(r), tickets: [], since: r.created_at }; order.push(g); }
    groups[g].tickets.push(r);
  });
  var preparing = [], ready = [];
  order.forEach(function (g) {
    var x = groups[g];
    var open = x.tickets.filter(function (t) { return t.status !== 'served'; });
    if (!open.length) return;
    var cooking = open.some(function (t) { return t.status === 'cooking' || t.status === 'held'; });
    var item = { id: x.id, ref: x.ref, name: x.name, since: x.since };
    if (cooking) preparing.push(item);
    else {
      var readyAt = open.reduce(function (a, t) { return t.ready_at && (!a || new Date(t.ready_at) > a) ? new Date(t.ready_at) : a; }, null);
      if (readyAt && Date.now() - readyAt.getTime() > READY_MINUTES * 60000) return;
      ready.push(Object.assign(item, { readyAt: readyAt }));
    }
  });
  ready.sort(function (a, b) { return new Date(b.readyAt || 0) - new Date(a.readyAt || 0); });
  return { preparing: preparing.slice(0, 30), ready: ready.slice(0, 20) };
}

// GET /api/pos/board — its code while it waits for a till; then the orders.
async function view(key) {
  var d = await boardOf(key);
  if (!d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > 15000) await pool.query('UPDATE restaurant_displays SET last_seen_at = now() WHERE id = $1', [d.id]);
  if (!d.company_id) return displays.viewOf(d);
  return Object.assign({ paired: true, name: d.name, restaurant: { code: d.company_code, name: d.company_name }, now: new Date().toISOString() }, await ordersOf(d.company_id));
}

// ── on the till ──
function boardOut(d) {
  return { id: d.id, name: d.name || 'Ready board', pairedAt: d.paired_at, online: !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < 45000, lastSeenAt: d.last_seen_at };
}
// GET /api/pos/boards — this restaurant's boards, and what they show now.
async function list(token) {
  var session = await access.need(token, 'till');
  var rows = (await pool.query("SELECT * FROM restaurant_displays WHERE company_id = $1 AND kind = 'board' ORDER BY paired_at", [session.posCompanyId])).rows;
  return Object.assign({ boards: rows.map(boardOut) }, await ordersOf(session.posCompanyId));
}
// POST /api/pos/boards/pair { code, name }
async function pair(token, p) {
  var session = await access.need(token, 'charge');
  p = p || {};
  var code = String(p.code || '').replace(/\D/g, '');
  if (code.length !== 6) fail('invalid', 'Type the 6 numbers the board shows.');
  var d = (await pool.query("SELECT * FROM restaurant_displays WHERE pair_code = $1 AND company_id IS NULL AND code_expires > now() AND kind = 'board'", [code])).rows[0];
  if (!d) fail('notfound', 'No board shows that code. Check the numbers, or reload the board for a new code.');
  var name = clean(p.name, 40) || 'Ready board';
  await pool.query('UPDATE restaurant_displays SET company_id = $2, name = $3, paired_by = $4, paired_at = now(), pair_code = NULL, code_expires = NULL WHERE id = $1',
    [d.id, session.posCompanyId, name, session.posEmployeeId]);
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'board.paired',
    summary: 'A ready-for-pickup board (' + name + ') now shows this restaurant\'s orders.', refType: 'display', refId: d.id });
  return list(token);
}
// POST /api/pos/boards/:id/unpair
async function unpair(token, id) {
  var session = await access.need(token, 'charge');
  var d = (await pool.query("DELETE FROM restaurant_displays WHERE id = $1 AND company_id = $2 AND kind = 'board' RETURNING name", [id, session.posCompanyId])).rows[0];
  if (!d) fail('notfound', 'That board is not this restaurant\'s.');
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'board.unpaired',
    summary: 'A ready-for-pickup board (' + d.name + ') was taken off the till.', refType: 'display', refId: id });
  return list(token);
}

module.exports = { hello: hello, view: view, list: list, pair: pair, unpair: unpair, ordersOf: ordersOf, refOf: refOf };
