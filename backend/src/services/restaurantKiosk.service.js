var crypto = require('crypto');
var config = require('../config');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var displays = require('./restaurantDisplays.service');
var times = require('./restaurantTillTimes.service');
var tillMenu = require('./restaurantTillMenu.service');
var check = require('./restaurantTillCheck.service');

// The self-order kiosk at the counter (migration 0177): a tablet opened at
// /self-order on the till's website (or /self-order in the OS) that says
// hello like the customer's screen and is paired with a 6-digit code from
// the till (More → Self-order kiosk). Customers order on it — the menu with
// photos and add-ons, eat here or take away, a name to be called by — and
// either pay at the counter (the order waits on the till with the tables'
// QR orders, K-0012) or, when the restaurant takes Paystack, pay on the
// kiosk by card or Mobile Money first. Straight to the kitchen if the
// restaurant says so (till settings kiosk); the cashier takes the money
// when the customer comes to the counter with their number.

var MAX_LINES = 30;
var MAX_QTY = 20;
var PAY_MINUTES = 20; // an order paid on the kiosk: that long to pay

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function clean(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function pos() { return require('./restaurantPos.service'); }
function online() { return require('./restaurantOnline.service'); }
function orders() { return require('./restaurantTableOrders.service'); }
function paystack() { return require('./restaurantPaystack.service'); }

// The kiosk a key belongs to, paired (or fails as the screen expects: a new code).
async function kioskOf(key) {
  var d = await displays.byKey(key);
  if (!d || d.kind !== 'kiosk') fail('auth', 'This kiosk was taken off the till. It shows a new code.');
  return d;
}
async function seen(d) {
  if (!d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > 15000) await pool.query('UPDATE restaurant_displays SET last_seen_at = now() WHERE id = $1', [d.id]);
}

// POST /api/pos/kiosk/hello { key } — a kiosk with its key, or a new one with its code.
function hello(key, ip, ua) { return displays.hello(key, ip, ua, 'kiosk'); }

// GET /api/pos/kiosk — what the kiosk is: its code while it waits for a
// till; then its restaurant, whether it takes orders now and how they are paid.
async function view(key) {
  var d = await kioskOf(key);
  await seen(d);
  if (!d.company_id) return displays.viewOf(d);
  var s = await access.settingsOf(d.company_id);
  return {
    paired: true, name: d.name, restaurant: { code: d.company_code, name: d.company_name },
    on: s.kiosk.on, payHere: s.kiosk.payHere && paystack().configured(), straight: s.kiosk.straightToKitchen,
    idleSeconds: s.kiosk.idleSeconds, welcome: s.kiosk.welcome
  };
}
// GET /api/pos/kiosk/menu — the menu (the till's, as the website shows it) and the bill's rules.
async function menu(key) {
  var d = await kioskOf(key);
  if (!d.company_id) fail('conflict', 'This kiosk is not on a till yet.');
  var m = await online().menuItems(d.company_id, false);
  var s = await access.settingsOf(d.company_id);
  return { categories: m.categories, items: m.items, bill: online().billRules(s, 'kiosk') };
}
// GET /api/pos/kiosk/promo?code= — a promo code's deal, for the basket to show (checked again with the order).
async function promo(key, q, ip) {
  online().promoThrottle(ip);
  var d = await kioskOf(key);
  if (!d.company_id) fail('conflict', 'This kiosk is not on a till yet.');
  return { promo: online().promoByCode(await access.settingsOf(d.company_id), q && q.code, 'kiosk') };
}

// POST /api/pos/kiosk/orders { items, dining: 'here' | 'away', name, note, pay: 'counter' | 'here', back }
// — a customer's order. Paid here: Paystack's page to pay on (back to the kiosk after).
async function place(key, p, ip) {
  p = p || {};
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  var d = await kioskOf(key);
  if (!d.company_id) fail('conflict', 'This kiosk is not on a till yet.');
  var s = await access.settingsOf(d.company_id);
  if (!s.kiosk.on) fail('conflict', 'The kiosk is not taking orders right now. Please order at the counter.');
  var dining = p.dining === 'here' ? 'here' : p.dining === 'away' ? 'away' : fail('invalid', 'Eat here or take away?');
  var payHere = p.pay === 'here';
  if (payHere && !(s.kiosk.payHere && paystack().configured())) fail('conflict', 'Paying on the kiosk is not on: please pay at the counter.');
  if (!Array.isArray(p.items) || !p.items.length) fail('invalid', 'Your order is empty.');
  if (p.items.length > MAX_LINES) fail('invalid', 'That is a lot of dishes: please order at the counter.');
  var items = p.items.map(function (i) {
    var qty = Math.round(Number(i && i.qty));
    if (!(qty >= 1 && qty <= MAX_QTY)) fail('invalid', 'Choose between 1 and ' + MAX_QTY + ' of each dish.');
    return { menuItemId: String(i.menuItemId || ''), variationId: i.variationId || undefined, qty: qty, note: clean(i.note, 140), modifiers: online().modsFrom(i.modifiers) };
  });
  var priced = await pos().priceLines(pool, d.company_id, items, false);
  await tillMenu.checkOrder(pool, d.company_id, priced.lines, null, null);
  times.checkHours(s, priced.lines, null);
  times.applyHappy(s, priced.lines);
  // The bill as the till will charge it (service charge and taxes on top, if any).
  // (A deal, restaurantPromos: on by itself, or with the code the customer typed.)
  var bill = check.compute(priced.lines, { promoCode: p.promoCode || undefined }, s, dining === 'here' ? 'dine_in' : 'pickup', { can: {}, before: null, channel: 'kiosk' });
  orders().throttle(ip);
  var name = clean(p.name, 40);
  var row = await withTransaction(async function (client) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('table-orders:' || $1))", [d.company_id]);
    var number = (await client.query('SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_table_orders WHERE company_id = $1', [d.company_id])).rows[0].n;
    var lines = priced.lines.map(function (l, i) { return Object.assign({ menuItemId: l.menuItemId, variationId: l.variationId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, note: items[i].note || '', modifiers: l.modifiers || [] }, l.discount ? { discount: l.discount } : {}); });
    var r = (await client.query(
      "INSERT INTO restaurant_table_orders (company_id, table_id, kind, kiosk_id, dining, number, token_hash, customer_name, note, items, subtotal, ip, status, adjust) VALUES ($1,NULL,'kiosk',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
      [d.company_id, d.id, dining, number, crypto.createHash('sha256').update(crypto.randomBytes(24)).digest('hex'), name, clean(p.note, 200), JSON.stringify(lines), priced.subtotal,
        String(ip || '').slice(0, 60), payHere ? 'unpaid' : 'pending', JSON.stringify(bill.adjust || {})])).rows[0];
    await activity.log(client, { companyId: d.company_id, employeeId: null, app: 'kiosk', action: 'kiosk.ordered',
      summary: orders().refOf(r) + ' ordered on the kiosk' + (name ? ' (' + name + ')' : '') + ', ' + (dining === 'here' ? 'eat here' : 'take away') + ': ' +
        lines.map(function (l) { return l.qty + '× ' + l.name; }).join(', ') + ', ' + round2(bill.total).toFixed(2) + (payHere ? ', paying on the kiosk.' : ', to pay at the counter.'),
      amount: bill.total, refType: 'table_order', refId: r.id });
    return r;
  });
  var outp = { ref: orders().refOf(row), number: row.number, total: round2(bill.total), dining: dining };
  if (payHere) {
    // Back to the kiosk after paying (Paystack adds ?reference= to it).
    var pay = await paystack().begin(d.company_id, bill.total, 'kiosk', null, row.id, backUrl(p.back));
    await pool.query('UPDATE restaurant_table_orders SET paystack_ref = $2 WHERE id = $1', [row.id, pay.reference]);
    return Object.assign(outp, { status: 'unpaid', pay: { reference: pay.reference, url: pay.url } });
  }
  return Object.assign(outp, await afterPlaced(row, s));
}
// Where Paystack sends the customer back to: the kiosk's own page, if it is one of ours.
function backUrl(back) {
  var u;
  try { u = new URL(String(back || '')); } catch (e) { return null; }
  var origins = config.restaurantSiteOrigins.concat(config.corsOrigin);
  return origins.indexOf(u.origin) >= 0 ? u.origin + u.pathname : null;
}
// Straight to the kitchen (the restaurant's choice, or paid on the kiosk).
async function afterPlaced(row, s) {
  if (s.kiosk.straightToKitchen || row.paystack_ref) {
    try { var r = await orders().acceptRow(row, null, {}); return { status: 'accepted', kitchen: r.tab.kitchenTicket ? r.tab.kitchenTicket.number : null }; }
    catch (e) { /* it waits on the till instead */ }
  }
  return { status: 'pending' };
}

// GET /api/pos/kiosk/pay/:reference — the kiosk after Paystack: paid (the
// order goes to the till and the kitchen), still waiting, or not paid.
async function payStatus(key, reference) {
  var d = await kioskOf(key);
  var row = (await pool.query("SELECT * FROM restaurant_table_orders WHERE kiosk_id = $1 AND paystack_ref = $2 AND kind = 'kiosk'", [d.id, String(reference || '')])).rows[0];
  if (!row) fail('notfound', 'That order is not this kiosk\'s.');
  var p = await paystack().check(await paystack().rowOf(row.company_id, reference), true);
  if (row.status === 'unpaid') {
    if (p.status === 'success') {
      var moved = (await pool.query("UPDATE restaurant_table_orders SET status = 'pending', updated_at = now() WHERE id = $1 AND status = 'unpaid' RETURNING *", [row.id])).rows[0];
      if (moved) {
        var after = await afterPlaced(moved, await access.settingsOf(row.company_id));
        return { ref: orders().refOf(row), paid: true, status: after.status, kitchen: after.kitchen || null };
      }
    } else if (p.status === 'failed' || p.status === 'abandoned' || Date.now() - new Date(row.created_at).getTime() > PAY_MINUTES * 60000) {
      await pool.query("UPDATE restaurant_table_orders SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'unpaid'", [row.id]);
      return { ref: orders().refOf(row), paid: false, status: 'cancelled' };
    }
    return { ref: orders().refOf(row), paid: false, status: 'unpaid' };
  }
  return { ref: orders().refOf(row), paid: p.status === 'success', status: row.status };
}

// ── on the till ──
function kioskOut(d) {
  return { id: d.id, name: d.name || 'Kiosk', pairedAt: d.paired_at, online: !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < 45000, lastSeenAt: d.last_seen_at };
}
// GET /api/pos/kiosks — this restaurant's kiosks.
async function list(token) {
  var session = await access.need(token, 'till');
  var rows = (await pool.query("SELECT * FROM restaurant_displays WHERE company_id = $1 AND kind = 'kiosk' ORDER BY paired_at", [session.posCompanyId])).rows;
  var s = session.access.settings;
  return { kiosks: rows.map(kioskOut), settings: s.kiosk, paystack: paystack().configured() };
}
// POST /api/pos/kiosks/pair { code, name } — the kiosk showing that code takes this restaurant's orders.
async function pair(token, p) {
  var session = await access.need(token, 'charge');
  p = p || {};
  var code = String(p.code || '').replace(/\D/g, '');
  if (code.length !== 6) fail('invalid', 'Type the 6 numbers the kiosk shows.');
  var d = (await pool.query("SELECT * FROM restaurant_displays WHERE pair_code = $1 AND company_id IS NULL AND code_expires > now() AND kind = 'kiosk'", [code])).rows[0];
  if (!d) fail('notfound', 'No kiosk shows that code. Check the numbers, or reload the kiosk for a new code.');
  var name = clean(p.name, 40) || 'Kiosk';
  await pool.query('UPDATE restaurant_displays SET company_id = $2, name = $3, paired_by = $4, paired_at = now(), pair_code = NULL, code_expires = NULL WHERE id = $1',
    [d.id, session.posCompanyId, name, session.posEmployeeId]);
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'kiosk.paired',
    summary: 'A self-order kiosk (' + name + ') now takes this restaurant\'s orders.', refType: 'display', refId: d.id });
  return list(token);
}
// POST /api/pos/kiosks/:id/unpair — a kiosk off the till (it shows a new code).
async function unpair(token, id) {
  var session = await access.need(token, 'charge');
  var d = (await pool.query("DELETE FROM restaurant_displays WHERE id = $1 AND company_id = $2 AND kind = 'kiosk' RETURNING name", [id, session.posCompanyId])).rows[0];
  if (!d) fail('notfound', 'That kiosk is not this restaurant\'s.');
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'kiosk.unpaired',
    summary: 'A self-order kiosk (' + d.name + ') was taken off the till.', refType: 'display', refId: id });
  return list(token);
}

module.exports = { hello: hello, view: view, menu: menu, promo: promo, place: place, payStatus: payStatus, list: list, pair: pair, unpair: unpair, backUrl: backUrl };
