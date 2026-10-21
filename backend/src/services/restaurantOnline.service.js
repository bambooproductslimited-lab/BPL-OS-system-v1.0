var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var config = require('../config');
var { internationalNumber } = require('../utils/phone');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var kitchen = require('./restaurantKitchen.service');
var tillMenu = require('./restaurantTillMenu.service');
var restaurantService = require('./restaurant.service');
var delivery = require('./restaurantDelivery.service');

// Ordering on the restaurant's website (online.starbartema.com, migration
// 0159). Anyone sees the menu and places an order — delivered to a pin on
// the map, or picked up — paid on delivery or at pickup, in cash or by
// Mobile Money. It waits on the delivery screen for the restaurant to
// accept it (it becomes an open order on the till, sent to the kitchen
// like any other) or turn it down with a reason. The customer follows it
// on a link of their own (track): accepted, cooking, ready, the rider on
// the map, delivered. No sign-in: the order's link is its key.
//
//   pending → accepted → done (paid at the till)      or rejected / cancelled

var MAX_LINES = 40;
var MAX_QTY = 50;
var MAX_PENDING_PER_PHONE = 3;
// Orders placed from one address, at most, in an hour (a backstop against
// someone filling the screen with fake orders).
var PER_IP_HOUR = 8;
var placedBy = new Map();

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function hash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function pos() { return require('./restaurantPos.service'); }
function ref(n) { return 'W-' + String(n).padStart(4, '0'); }
function fullPhotoUrl(id, key) { var u = restaurantService.menuThumbUrl(id, key); return u ? u.replace('?size=thumb&', '?') : null; }

// The restaurant by its code, if it takes orders on the website at all
// (it has delivery settings).
async function shopOf(code) {
  var co = (await pool.query('SELECT id, code, name FROM companies WHERE code = $1', [String(code || '').trim().toUpperCase().slice(0, 12)])).rows[0];
  var row = co && (await pool.query('SELECT 1 FROM restaurant_delivery_settings WHERE company_id = $1', [co.id])).rows[0];
  if (!row) fail('notfound', 'This restaurant does not take orders online.');
  co.settings = await delivery.settingsOf(co.id);
  return co;
}
function shopOut(co) {
  var s = co.settings;
  return {
    code: co.code, name: co.name, open: s.open, delivery: s.delivery, pickup: s.pickup, phone: s.phone, note: s.note,
    location: s.location, fee: s.fee, maxKm: s.maxKm, minOrder: s.minOrder, readyMinutes: s.readyMinutes, payMethods: ['cash', 'mobile_money']
  };
}

// GET /api/pos/online/:code/menu — the restaurant and what it sells now:
// each dish with its photo, sizes, and whether it is sold out.
async function menu(code) {
  var co = await shopOf(code);
  var rows = (await pool.query('SELECT id, name, category, price, photo_object_key FROM restaurant_menu_items WHERE company_id = $1 AND active = true ORDER BY category, name', [co.id])).rows;
  var vars = rows.length ? (await pool.query('SELECT id, menu_item_id, name, price FROM restaurant_menu_item_variations WHERE menu_item_id = ANY($1::uuid[]) ORDER BY sort_order, created_at',
    [rows.map(function (r) { return r.id; })])).rows : [];
  var items = rows.map(function (r) {
    return {
      id: r.id, name: r.name, category: r.category || '', price: Number(r.price),
      photoUrl: restaurantService.menuThumbUrl(r.id, r.photo_object_key), photoFull: fullPhotoUrl(r.id, r.photo_object_key),
      variations: vars.filter(function (v) { return v.menu_item_id === r.id; }).map(function (v) { return { id: v.id, name: v.name, price: Number(v.price) }; })
    };
  });
  await tillMenu.tileStock(co.id, items);
  items.forEach(function (i) { i.soldOut = !!(i.stock && i.stock.soldOut); delete i.stock; });
  var categories = [];
  items.forEach(function (i) { if (categories.indexOf(i.category) < 0) categories.push(i.category); });
  return { restaurant: shopOut(co), categories: categories, items: items };
}

function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (placedBy.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many orders from here in the last hour. Call the restaurant instead.');
  list.push(now);
  placedBy.set(key, list);
  if (placedBy.size > 5000) placedBy.clear();
}

// POST /api/pos/online/:code/orders — an order placed: { name, phone,
// fulfillment: delivery|pickup, address, landmark, lat, lng, note,
// payMethod: cash|mobile_money, items: [{ menuItemId, variationId, qty,
// note }] }. Priced from the menu as it is now, the delivery fee from the
// distance by road (restaurantDelivery quote). Returns its number and the
// link to follow it.
async function place(code, p, ip) {
  p = p || {};
  // A field people never see: filled in, it was not a person.
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  var co = await shopOf(code);
  var s = co.settings;
  if (!s.open) fail('conflict', co.name + ' is not taking orders online right now.' + (s.phone ? ' Call ' + s.phone + '.' : ''));
  var fulfillment = V.oneOf(p.fulfillment || 'delivery', ['delivery', 'pickup'], 'Delivery or pickup');
  if (!s[fulfillment]) fail('invalid', fulfillment === 'delivery' ? co.name + ' is not delivering right now: pick it up instead.' : co.name + ' only delivers.');
  var name = V.text(cleanText(p.name, 80), 'Your name', 80);
  var phone = cleanText(p.phone, 30);
  if (!internationalNumber(phone)) fail('invalid', 'Give a phone number we can call you on.');
  var address = cleanText(p.address, 200), landmark = cleanText(p.landmark, 200);
  var point = delivery.pointOf(p.lat, p.lng);
  if (fulfillment === 'delivery') {
    if (!point) fail('invalid', 'Show us where to bring it: drop the pin on the map, or use your location.');
    if (!address) fail('invalid', 'Write the address or the area, for the rider.');
  }
  var payMethod = V.oneOf(p.payMethod || 'cash', ['cash', 'mobile_money'], 'How you pay');
  if (!Array.isArray(p.items) || !p.items.length) fail('invalid', 'Your basket is empty.');
  if (p.items.length > MAX_LINES) fail('invalid', 'That is a lot of dishes: call the restaurant for a big order.');
  var items = p.items.map(function (i) {
    var qty = Math.round(Number(i && i.qty));
    if (!(qty >= 1 && qty <= MAX_QTY)) fail('invalid', 'Choose between 1 and ' + MAX_QTY + ' of each dish.');
    return { menuItemId: String(i.menuItemId || ''), variationId: i.variationId || undefined, qty: qty, note: cleanText(i.note, 140) };
  });
  var priced = await pos().priceLines(pool, co.id, items, false);
  await tillMenu.checkOrder(pool, co.id, priced.lines, null, null);
  if (s.minOrder > 0 && priced.subtotal < s.minOrder) fail('invalid', 'The smallest order is ' + s.minOrder.toFixed(2) + ' before delivery.');
  var q = delivery.quote(s, priced.subtotal, point, fulfillment);
  if (!q.deliverable) fail('invalid', 'That is ' + q.distanceKm + ' km away by road: ' + co.name + ' delivers up to ' + s.maxKm + ' km. Pick it up instead?');
  var pending = (await pool.query("SELECT count(*)::int AS n FROM restaurant_online_orders WHERE company_id = $1 AND customer_phone = $2 AND status = 'pending'", [co.id, phone])).rows[0].n;
  if (pending >= MAX_PENDING_PER_PHONE) fail('conflict', 'You have orders waiting for the restaurant already. Wait for their answer, or call them.');
  throttle(ip);

  var token = crypto.randomBytes(24).toString('base64url');
  var saved = await withTransaction(async function (client) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('online:' || $1))", [co.id]);
    var number = (await client.query('SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_online_orders WHERE company_id = $1', [co.id])).rows[0].n;
    var lines = priced.lines.map(function (l, i) { return { menuItemId: l.menuItemId, variationId: l.variationId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, note: items[i].note || '' }; });
    var row = (await client.query(
      'INSERT INTO restaurant_online_orders (company_id, number, token_hash, fulfillment, customer_name, customer_phone, address, landmark, lat, lng, note, pay_method, items, subtotal, delivery_fee, total, distance_km, ip) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *',
      [co.id, number, hash(token), fulfillment, name, phone, address, landmark, point ? point.lat : null, point ? point.lng : null, cleanText(p.note, 300), payMethod, JSON.stringify(lines),
        priced.subtotal, q.fee, round2(priced.subtotal + q.fee), q.distanceKm, String(ip || '').slice(0, 60)])).rows[0];
    await activity.log(client, { companyId: co.id, employeeId: null, app: 'online', action: 'online.placed',
      summary: name + ' ordered ' + ref(number) + ' on the website: ' + (fulfillment === 'delivery' ? 'delivery' : 'pickup') + ', ' + round2(priced.subtotal + q.fee).toFixed(2) + '.',
      amount: round2(priced.subtotal + q.fee), refType: 'online', refId: row.id });
    return row;
  });
  return { ref: ref(saved.number), token: token, trackUrl: config.onlineSiteUrl + '/t/' + token, order: await trackOut(saved) };
}

// ── following an order (the customer's link) ──

async function byToken(raw, lock, client) {
  var o = (await (client || pool).query('SELECT * FROM restaurant_online_orders WHERE token_hash = $1' + (lock ? ' FOR UPDATE' : ''), [hash(String(raw || ''))])).rows[0];
  if (!o) fail('notfound', 'We cannot find that order. Check the link.');
  return o;
}
// Where an order stands, for its customer: one of waiting, rejected,
// cancelled, preparing, ready (pickup: ready_pickup), rider (on the way to
// the restaurant), on_the_way, arrived, delivered, collected, failed.
async function stageOf(o, d) {
  if (o.status === 'pending' || o.status === 'rejected' || o.status === 'cancelled') return o.status === 'pending' ? 'waiting' : o.status;
  if (d) {
    if (d.status === 'assigned') return 'rider';
    if (d.status === 'picked_up') return 'on_the_way';
    if (d.status === 'arrived') return 'arrived';
    if (d.status === 'delivered') return 'delivered';
    if (d.status === 'failed') return 'failed';
  }
  if (o.status === 'done') return o.fulfillment === 'pickup' ? 'collected' : 'delivered';
  var st = o.tab_id ? (await kitchen.statusOf(pool, o.company_id, 'tab_id', [o.tab_id]))[o.tab_id] : null;
  if (st && (st.state === 'ready' || st.state === 'served')) return o.fulfillment === 'pickup' ? 'ready_pickup' : 'ready';
  return 'preparing';
}
async function trackOut(o) {
  var d = o.status === 'accepted' || o.status === 'done' ? await delivery.forOnline(o.id) : null;
  var stage = await stageOf(o, d);
  var r = await delivery.restaurantOf(o.company_id);
  return {
    ref: ref(o.number), status: o.status, stage: stage, fulfillment: o.fulfillment,
    customer: { name: o.customer_name, phone: o.customer_phone, address: o.address, landmark: o.landmark, lat: o.lat, lng: o.lng },
    items: o.items, note: o.note, payMethod: o.pay_method, subtotal: round2(o.subtotal), deliveryFee: round2(o.delivery_fee), total: round2(o.total),
    distanceKm: o.distance_km == null ? null : Number(o.distance_km), readyMinutes: o.ready_minutes, rejectReason: o.reject_reason,
    placedAt: o.created_at, decidedAt: o.decided_at,
    restaurant: { code: r.code, name: r.name, phone: r.phone, location: r.location },
    delivery: d ? {
      ref: d.ref, status: d.status, rider: { name: d.rider.name, phone: d.rider.phone, vehicle: d.rider.vehicle, plate: d.rider.plate },
      riderAt: d.riderAt, etaMinutes: d.etaMinutes, distanceKm: d.distanceKm, createdAt: d.createdAt, pickedUpAt: d.pickedUpAt, arrivedAt: d.arrivedAt, endedAt: d.endedAt,
      toCollect: d.toCollect, collectMethod: d.collectMethod, note: d.status === 'failed' ? d.note : ''
    } : null
  };
}
// GET /api/pos/online/track/:token
async function track(raw) { return trackOut(await byToken(raw)); }
// POST /api/pos/online/track/:token/cancel — while it still waits for the restaurant.
async function cancel(raw) {
  var o = await withTransaction(async function (client) {
    var row = await byToken(raw, true, client);
    if (row.status !== 'pending') fail('conflict', row.status === 'accepted' ? 'The restaurant has started on your order already: call them to change it.' : 'This order is not waiting any more.');
    var up = (await client.query("UPDATE restaurant_online_orders SET status = 'cancelled', reject_reason = 'Cancelled by the customer.', updated_at = now() WHERE id = $1 RETURNING *", [row.id])).rows[0];
    await activity.log(client, { companyId: row.company_id, app: 'online', action: 'online.cancelled', summary: row.customer_name + ' cancelled ' + ref(row.number) + ' before it was accepted.', refType: 'online', refId: row.id });
    return up;
  });
  return trackOut(o);
}

// ── the restaurant's answer (the delivery screen) ──

function staffOut(o) {
  return {
    id: o.id, ref: ref(o.number), status: o.status, fulfillment: o.fulfillment,
    customer: { name: o.customer_name, phone: o.customer_phone, address: o.address, landmark: o.landmark, lat: o.lat, lng: o.lng },
    items: o.items, note: o.note, payMethod: o.pay_method, subtotal: round2(o.subtotal), deliveryFee: round2(o.delivery_fee), total: round2(o.total),
    distanceKm: o.distance_km == null ? null : Number(o.distance_km), rejectReason: o.reject_reason, readyMinutes: o.ready_minutes,
    placedAt: o.created_at, decidedAt: o.decided_at, waitingMinutes: Math.max(0, Math.floor((Date.now() - new Date(o.created_at).getTime()) / 60000))
  };
}
// POST /api/pos/delivery/online/:id/accept { readyMinutes } — it becomes an
// open order on the till (its dishes at today's prices, the delivery fee a
// line of its own), sent to the kitchen.
async function accept(token, id, p) {
  var session = await access.need(token, 'delivery');
  var company = session.posCompanyId;
  p = p || {};
  var settings = await delivery.settingsOf(company);
  var readyMinutes = Math.round(Math.min(240, Math.max(5, Number(p.readyMinutes) || settings.readyMinutes)));
  // Claimed first, so two people pressing Accept make one order.
  var o = (await pool.query("UPDATE restaurant_online_orders SET decided_by = $3, decided_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'pending' AND decided_at IS NULL RETURNING *",
    [id, company, session.posEmployeeId])).rows[0];
  if (!o) {
    var now = (await pool.query('SELECT status FROM restaurant_online_orders WHERE id = $1 AND company_id = $2', [id, company])).rows[0];
    if (!now) fail('notfound', 'That order is not this restaurant\'s.');
    fail('conflict', now.status === 'cancelled' ? 'The customer cancelled that order.' : 'Someone has answered that order already.');
  }
  var tab;
  try {
    var items = o.items.map(function (l) { return { menuItemId: l.menuItemId, variationId: l.variationId || undefined, qty: l.qty, note: l.note || '' }; });
    if (Number(o.delivery_fee) > 0) items.push({ custom: { name: pos().FEE_NAME, price: Number(o.delivery_fee), fee: true }, qty: 1 });
    tab = await pos().saveTabFor(session, {
      label: ref(o.number) + ' ' + o.customer_name, fulfillment: o.fulfillment, customerName: o.customer_name, customerPhone: o.customer_phone,
      deliveryAddress: o.fulfillment === 'delivery' ? (o.address + (o.landmark ? ' · ' + o.landmark : '')) : '',
      items: items, kitchenNote: [ref(o.number) + ' (website)', o.note].filter(Boolean).join(' · ')
    });
  } catch (err) {
    await pool.query('UPDATE restaurant_online_orders SET decided_by = NULL, decided_at = NULL WHERE id = $1', [o.id]);
    throw err;
  }
  var row = (await pool.query("UPDATE restaurant_online_orders SET status = 'accepted', tab_id = $2, ready_minutes = $3, updated_at = now() WHERE id = $1 RETURNING *", [o.id, tab.id, readyMinutes])).rows[0];
  await activity.log(pool, { companyId: company, employeeId: session.posEmployeeId, app: 'delivery', action: 'online.accepted',
    summary: 'Accepted ' + ref(o.number) + ' from ' + o.customer_name + ' (ready in about ' + readyMinutes + ' min)' + (tab.kitchenTicket ? '; kitchen ticket #' + tab.kitchenTicket.number : '') + '.',
    amount: round2(o.total), refType: 'online', refId: o.id });
  return { order: staffOut(row), tab: { id: tab.id, total: tab.total, kitchenTicket: tab.kitchenTicket || null } };
}
// POST /api/pos/delivery/online/:id/reject { reason } — turned down; the customer sees why.
async function reject(token, id, p) {
  var session = await access.need(token, 'delivery');
  var reason = V.text(cleanText((p || {}).reason, 200), 'Why it is turned down', 200);
  var o = (await pool.query("UPDATE restaurant_online_orders SET status = 'rejected', reject_reason = $3, decided_by = $4, decided_at = now(), updated_at = now() " +
    "WHERE id = $1 AND company_id = $2 AND status = 'pending' AND decided_at IS NULL RETURNING *", [id, session.posCompanyId, reason, session.posEmployeeId])).rows[0];
  if (!o) fail('conflict', 'That order has been answered already, or cancelled.');
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'delivery', action: 'online.rejected',
    summary: 'Turned down ' + ref(o.number) + ' from ' + o.customer_name + ': ' + reason, amount: round2(o.total), refType: 'online', refId: o.id });
  return { order: staffOut(o) };
}

module.exports = { menu: menu, place: place, track: track, cancel: cancel, accept: accept, reject: reject, staffOut: staffOut, ref: ref };
