var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var config = require('../config');
var secretBox = require('../utils/secretBox');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var kitchen = require('./restaurantKitchen.service');

// Deliveries (migration 0159): a delivery or website order sent out with a
// rider — one of the restaurant's riders, or someone whose name and phone
// are typed. The delivery screen (delivery.starbartema.com) and the till
// send them; the rider follows theirs on a link of their own that shares
// where they are (riderView, riderLocation, riderStatus) and moves it on:
// picked up, arrived, delivered (or could not deliver). Where the
// restaurant is, the delivery fee and how far it goes are the delivery
// settings (settingsOf); the website's orders are restaurantOnline.service.js.
//
//   assigned → picked_up → arrived → delivered      (or failed / cancelled)

var VEHICLES = ['motorbike', 'bicycle', 'car', 'on_foot'];
var ACTIVE = ['assigned', 'picked_up', 'arrived'];
var ENDED = ['delivered', 'failed', 'cancelled'];
var STEP = { assigned: 0, picked_up: 1, arrived: 2, delivered: 3, failed: 3, cancelled: 3 };
var STATUS_NAME = { assigned: 'Rider on the way to the restaurant', picked_up: 'Picked up, on the way', arrived: 'Arrived at the customer', delivered: 'Delivered', failed: 'Could not deliver', cancelled: 'Cancelled' };
// Town speeds (km/h), and how much longer the roads are than a straight line.
var SPEED = { motorbike: 24, car: 18, bicycle: 12, on_foot: 5 };
var ROAD = 1.3;
// A rider's link keeps working this long after the delivery ends.
var LINK_HOURS = 6;
var DEFAULTS = {
  open: false, delivery: true, pickup: true, phone: '', note: '',
  location: null, // { lat, lng, address }
  fee: { base: 10, perKm: 3, freeOver: 0 },
  maxKm: 12, minOrder: 0, readyMinutes: 25
};
var SITE = { delivery: function () { return config.deliverySiteUrl; } };

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function round1(n) { return Math.round(Number(n) * 10) / 10; }
function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function num(v, min, max, dflt) { var n = Number(v); return v === '' || v == null || !isFinite(n) ? dflt : Math.min(max, Math.max(min, n)); }
function hash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function newToken() { return crypto.randomBytes(24).toString('base64url'); }
function pos() { return require('./restaurantPos.service'); }

// A point on the map, or null: { lat, lng } in range.
function pointOf(lat, lng) {
  var a = Number(lat), b = Number(lng);
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;
  if (!isFinite(a) || !isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180 || (a === 0 && b === 0)) fail('invalid', 'That place on the map is not right. Drop the pin again.');
  return { lat: Math.round(a * 1e6) / 1e6, lng: Math.round(b * 1e6) / 1e6 };
}
// Straight-line kilometres between two points.
function km(a, b) {
  var R = 6371, rad = Math.PI / 180;
  var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}
// By road, roughly.
function roadKm(a, b) { return a && b ? round1(km(a, b) * ROAD) : null; }
function travelMinutes(distanceKm, vehicle) {
  if (distanceKm == null) return null;
  return Math.max(5, Math.round((distanceKm / (SPEED[vehicle] || SPEED.motorbike)) * 60) + 4);
}

// ── settings ──

function merged(s) {
  s = s || {};
  var out = JSON.parse(JSON.stringify(DEFAULTS));
  ['open', 'delivery', 'pickup'].forEach(function (k) { if (typeof s[k] === 'boolean') out[k] = s[k]; });
  if (typeof s.phone === 'string') out.phone = cleanText(s.phone, 40);
  if (typeof s.note === 'string') out.note = cleanText(s.note, 200);
  if (s.location && isFinite(Number(s.location.lat)) && isFinite(Number(s.location.lng))) {
    out.location = { lat: Number(s.location.lat), lng: Number(s.location.lng), address: cleanText(s.location.address, 200) };
  }
  if (s.fee) out.fee = { base: num(s.fee.base, 0, 1000, out.fee.base), perKm: num(s.fee.perKm, 0, 200, out.fee.perKm), freeOver: num(s.fee.freeOver, 0, 100000, 0) };
  out.maxKm = num(s.maxKm, 0, 200, out.maxKm);
  out.minOrder = num(s.minOrder, 0, 100000, out.minOrder);
  out.readyMinutes = Math.round(num(s.readyMinutes, 5, 240, out.readyMinutes));
  return out;
}
async function settingsRow(companyId, db) {
  return (await (db || pool).query('SELECT settings, updated_at FROM restaurant_delivery_settings WHERE company_id = $1', [companyId])).rows[0] || null;
}
async function settingsOf(companyId, db) {
  var row = await settingsRow(companyId, db);
  return merged(row && row.settings);
}

// What a delivery comes to: by road from the restaurant to the pin, the fee
// (base + per km, nothing over freeOver), and whether it is in reach.
function quote(settings, subtotal, point, fulfillment) {
  if (fulfillment === 'pickup') return { distanceKm: null, fee: 0, deliverable: true };
  var distance = settings.location && point ? roadKm(settings.location, point) : null;
  var fee = settings.fee.base + (distance != null ? settings.fee.perKm * distance : 0);
  if (settings.fee.freeOver > 0 && subtotal >= settings.fee.freeOver) fee = 0;
  fee = Math.round(fee);
  var deliverable = !(distance != null && settings.maxKm > 0 && distance > settings.maxKm);
  return { distanceKm: distance, fee: fee, deliverable: deliverable };
}

// GET/POST /api/pos/delivery/settings — a manager (the person signed in, or
// a manager's PIN) sets them.
async function settings(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  if (p.settings) {
    var s = p.settings;
    if (s.location) pointOf(s.location.lat, s.location.lng);
    var next = merged(Object.assign({}, (await settingsRow(company) || {}).settings || {}, s));
    if (next.open && !next.delivery && !next.pickup) fail('invalid', 'Offer delivery, pickup or both to take orders online.');
    await pool.query(
      'INSERT INTO restaurant_delivery_settings (company_id, settings, updated_by, updated_at) VALUES ($1,$2,$3,now()) ' +
      'ON CONFLICT (company_id) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()',
      [company, JSON.stringify(next), m.manager.id]);
    await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'delivery', action: 'delivery.settings',
      summary: 'Delivery settings changed: ' + Object.keys(s).join(', ') + (typeof s.open === 'boolean' ? (s.open ? ' (taking orders online)' : ' (not taking orders online)') : '') + '.' });
  }
  var co = (await pool.query('SELECT code, name FROM companies WHERE id = $1', [company])).rows[0];
  return { settings: await settingsOf(company), managerName: m.manager.first_name + ' ' + m.manager.last_name, company: { code: co.code, name: co.name },
    siteUrl: config.onlineSiteUrl };
}
// Anyone on the delivery screen turns taking orders online on or off.
async function setOpen(token, open) {
  var session = await access.need(token, 'delivery');
  var row = await settingsRow(session.posCompanyId);
  var next = merged(Object.assign({}, (row && row.settings) || {}, { open: !!open }));
  if (next.open && !next.delivery && !next.pickup) fail('invalid', 'Offer delivery, pickup or both to take orders online.');
  await pool.query(
    'INSERT INTO restaurant_delivery_settings (company_id, settings, updated_by, updated_at) VALUES ($1,$2,$3,now()) ' +
    'ON CONFLICT (company_id) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()',
    [session.posCompanyId, JSON.stringify(next), session.posEmployeeId]);
  await activity.log(pool, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'delivery', action: 'delivery.open',
    summary: next.open ? 'Started taking orders online.' : 'Stopped taking orders online.' });
  return { open: next.open };
}

// ── riders ──

function riderOut(r, busy) {
  return { id: r.id, name: r.name, phone: r.phone, vehicle: r.vehicle, plate: r.plate, active: r.active, busy: busy || null };
}
function riderFields(p) {
  return {
    name: V.text(p.name, 'The rider\'s name', 80),
    phone: V.text(p.phone, 'The rider\'s phone', 40),
    vehicle: V.oneOf(p.vehicle || 'motorbike', VEHICLES, 'Vehicle'),
    plate: cleanText(p.plate, 20).toUpperCase()
  };
}
async function riderList(companyId) {
  var rows = (await pool.query('SELECT * FROM restaurant_riders WHERE company_id = $1 ORDER BY active DESC, name', [companyId])).rows;
  var busy = (await pool.query(
    "SELECT rider_id, number, status FROM restaurant_deliveries WHERE company_id = $1 AND rider_id IS NOT NULL AND status IN ('assigned', 'picked_up', 'arrived') ORDER BY created_at", [companyId])).rows;
  var by = new Map();
  busy.forEach(function (b) { if (!by.has(b.rider_id)) by.set(b.rider_id, []); by.get(b.rider_id).push({ number: b.number, status: b.status }); });
  return rows.map(function (r) { return riderOut(r, by.get(r.id) || null); });
}
// POST /api/pos/delivery/riders { action: list|save|remove, rider, id }
async function riders(token, p) {
  var session = await access.need(token, 'delivery');
  var company = session.posCompanyId;
  p = p || {};
  if (p.action === 'save') {
    var f = riderFields(p.rider || {});
    var active = !(p.rider && p.rider.active === false);
    if (p.rider && p.rider.id) {
      var up = await pool.query('UPDATE restaurant_riders SET name = $3, phone = $4, vehicle = $5, plate = $6, active = $7 WHERE id = $1 AND company_id = $2 RETURNING id',
        [p.rider.id, company, f.name, f.phone, f.vehicle, f.plate, active]);
      if (!up.rows[0]) fail('notfound', 'That rider is not this restaurant\'s.');
    } else {
      await pool.query('INSERT INTO restaurant_riders (company_id, name, phone, vehicle, plate, active) VALUES ($1,$2,$3,$4,$5,$6)', [company, f.name, f.phone, f.vehicle, f.plate, active]);
    }
    await activity.log(pool, { companyId: company, employeeId: session.posEmployeeId, app: 'delivery', action: 'delivery.rider',
      summary: (p.rider && p.rider.id ? 'Changed the rider ' : 'Added the rider ') + f.name + (active ? '' : ' (not working now)') + '.' });
  } else if (p.action === 'remove') {
    var gone = await pool.query('DELETE FROM restaurant_riders WHERE id = $1 AND company_id = $2 RETURNING name', [p.id, company]);
    if (!gone.rows[0]) fail('notfound', 'That rider is not this restaurant\'s.');
    await activity.log(pool, { companyId: company, employeeId: session.posEmployeeId, app: 'delivery', action: 'delivery.rider', summary: 'Removed the rider ' + gone.rows[0].name + '.' });
  }
  return { riders: await riderList(company) };
}

// ── deliveries ──

// A website order's till tab carries "address · landmark" for the
// cashier; the delivery keeps them apart, so the landmark is not said twice.
function addressOf(tabAddress, online) {
  var a = String(tabAddress || '');
  var tail = online && online.landmark ? ' · ' + online.landmark : '';
  return tail && a.slice(-tail.length) === tail ? a.slice(0, -tail.length) : a;
}
function minutesSince(ts) { return ts ? Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60000)) : null; }
function deliveryOut(d, opts) {
  opts = opts || {};
  var out = {
    id: d.id, number: d.number, ref: 'D-' + String(d.number).padStart(3, '0'), status: d.status, statusName: STATUS_NAME[d.status], source: d.source,
    tabId: d.tab_id, orderId: d.order_id, ticketId: d.ticket_id, onlineOrderId: d.online_order_id, onlineRef: d.online_number ? 'W-' + String(d.online_number).padStart(4, '0') : null,
    label: d.label, customer: { name: d.customer_name, phone: d.customer_phone, address: d.address, landmark: d.landmark, lat: d.lat, lng: d.lng },
    items: d.items || [], toCollect: round2(d.to_collect), collectMethod: d.collect_method,
    rider: { id: d.rider_id, name: d.rider_name, phone: d.rider_phone, vehicle: d.rider_vehicle, plate: d.rider_plate },
    riderAt: d.rider_lat != null ? { lat: d.rider_lat, lng: d.rider_lng, at: d.rider_seen_at, ageSeconds: Math.max(0, Math.round((Date.now() - new Date(d.rider_seen_at).getTime()) / 1000)) } : null,
    distanceKm: d.distance_km == null ? null : Number(d.distance_km), etaMinutes: d.eta_minutes,
    note: d.note, sentBy: d.sent_by_name || null,
    createdAt: d.created_at, pickedUpAt: d.picked_up_at, arrivedAt: d.arrived_at, endedAt: d.ended_at, minutes: minutesSince(d.created_at)
  };
  if (opts.link) {
    var raw = secretBox.open('rider-link', d.rider_token_sealed);
    out.riderLink = raw ? SITE.delivery() + '/r/' + raw : null;
  }
  return out;
}
var DELIVERY_SELECT = "SELECT d.*, e.first_name || ' ' || e.last_name AS sent_by_name, oo.number AS online_number FROM restaurant_deliveries d " +
  'LEFT JOIN employees e ON e.id = d.sent_by LEFT JOIN restaurant_online_orders oo ON oo.id = d.online_order_id ';

// What is waiting to go out: open delivery orders (and website pickups),
// and delivery sales paid at the till, with no delivery yet — each with
// where its food stands in the kitchen.
async function waitingToGo(companyId) {
  var tabs = await pos().tabRows(companyId,
    " AND (t.fulfillment = 'delivery' OR EXISTS (SELECT 1 FROM restaurant_online_orders o WHERE o.tab_id = t.id))" +
    " AND NOT EXISTS (SELECT 1 FROM restaurant_deliveries d WHERE d.tab_id = t.id AND d.status <> 'cancelled')", []);
  var online = tabs.length ? (await pool.query('SELECT * FROM restaurant_online_orders WHERE tab_id = ANY($1::uuid[])', [tabs.map(function (t) { return t.id; })])).rows : [];
  var byTab = new Map(online.map(function (o) { return [o.tab_id, o]; }));
  var out = tabs.map(function (t) {
    var o = byTab.get(t.id) || null;
    return {
      key: 'tab:' + t.id, tabId: t.id, orderId: null, paid: false, fulfillment: t.fulfillment,
      label: t.label || t.customerName, customer: { name: t.customerName || t.guestName || '', phone: t.customerPhone || t.guestPhone || '', address: addressOf(t.deliveryAddress, o),
        landmark: o ? o.landmark : '', lat: o ? o.lat : null, lng: o ? o.lng : null },
      items: t.lines.filter(function (l) { return !l.fee; }).map(function (l) { return l.qty + '× ' + l.name; }),
      total: t.total, payMethod: o ? o.pay_method : null, onlineRef: o ? 'W-' + String(o.number).padStart(4, '0') : null, onlineId: o ? o.id : null,
      kitchen: t.kitchen ? t.kitchen.state : null, since: t.createdAt, readyMinutes: o ? o.ready_minutes : null, decidedAt: o ? o.decided_at : null
    };
  });
  var paid = (await pool.query(
    "SELECT o.id, o.order_no, o.total, o.customer_name, o.customer_phone, o.delivery_address, o.created_at FROM restaurant_orders o " +
    "WHERE o.company_id = $1 AND o.status = 'completed' AND o.fulfillment = 'delivery' AND o.created_at > now() - interval '12 hours' " +
    "AND NOT EXISTS (SELECT 1 FROM restaurant_deliveries d WHERE d.order_id = o.id AND d.status <> 'cancelled') ORDER BY o.created_at", [companyId])).rows;
  if (paid.length) {
    var st = await kitchen.statusOf(pool, companyId, 'order_id', paid.map(function (o) { return o.id; }));
    var lines = (await pool.query('SELECT order_id, name, qty FROM restaurant_order_items WHERE order_id = ANY($1::uuid[]) AND name <> $2 ORDER BY sort_order',
      [paid.map(function (o) { return o.id; }), pos().FEE_NAME])).rows;
    paid.forEach(function (o) {
      var k = st[o.id] || null;
      // Served (taken out some other way), or long gone without the kitchen screen: not waiting.
      if ((k && k.state === 'served') || (!k && Date.now() - new Date(o.created_at).getTime() > 3 * 3600000)) return;
      out.push({
        key: 'order:' + o.id, tabId: null, orderId: o.id, paid: true, fulfillment: 'delivery', label: o.customer_name || o.order_no,
        customer: { name: o.customer_name || '', phone: o.customer_phone || '', address: o.delivery_address || '', landmark: '', lat: null, lng: null },
        items: lines.filter(function (l) { return l.order_id === o.id; }).map(function (l) { return Number(l.qty) + '× ' + l.name; }),
        total: round2(o.total), payMethod: null, onlineRef: null, onlineId: null, kitchen: k ? k.state : null, since: o.created_at, readyMinutes: null, decidedAt: null
      });
    });
  }
  // Ready: the kitchen says so, or there is no kitchen screen to say.
  out.forEach(function (w) { w.stage = w.kitchen === 'cooking' ? 'cooking' : 'ready'; });
  return out;
}

// GET /api/pos/delivery/board — the delivery screen: website orders waiting
// for an answer, orders being made and ready to go, deliveries on their
// way, today's done, the riders, the settings the map needs.
async function board(token) {
  var session = await access.need(token, 'delivery');
  var company = session.posCompanyId;
  var settings = await settingsOf(company);
  var online = require('./restaurantOnline.service');
  var pending = (await pool.query("SELECT * FROM restaurant_online_orders WHERE company_id = $1 AND status = 'pending' ORDER BY created_at", [company])).rows.map(online.staffOut);
  var active = (await pool.query(DELIVERY_SELECT + "WHERE d.company_id = $1 AND d.status IN ('assigned', 'picked_up', 'arrived') ORDER BY d.created_at", [company])).rows
    .map(function (d) { return deliveryOut(d, { link: true }); });
  var done = (await pool.query(DELIVERY_SELECT + "WHERE d.company_id = $1 AND d.status IN ('delivered', 'failed', 'cancelled') AND d.ended_at >= date_trunc('day', now()) ORDER BY d.ended_at DESC LIMIT 60", [company])).rows
    .map(function (d) { return deliveryOut(d); });
  var turnedDown = (await pool.query("SELECT * FROM restaurant_online_orders WHERE company_id = $1 AND status IN ('rejected', 'cancelled') AND updated_at >= date_trunc('day', now()) ORDER BY updated_at DESC LIMIT 40", [company])).rows
    .map(online.staffOut);
  var waiting = await waitingToGo(company);
  var co = (await pool.query('SELECT code, name FROM companies WHERE id = $1', [company])).rows[0];
  var delivered = done.filter(function (d) { return d.status === 'delivered'; });
  var avg = delivered.length ? Math.round(delivered.reduce(function (a, d) { return a + Math.max(0, (new Date(d.endedAt) - new Date(d.createdAt)) / 60000); }, 0) / delivered.length) : null;
  return {
    company: { code: co.code, name: co.name }, settings: settings, siteUrl: config.onlineSiteUrl,
    pending: pending, cooking: waiting.filter(function (w) { return w.stage === 'cooking'; }), ready: waiting.filter(function (w) { return w.stage === 'ready'; }),
    active: active, done: done, turnedDown: turnedDown, riders: await riderList(company),
    totals: { delivered: delivered.length, failed: done.filter(function (d) { return d.status === 'failed'; }).length, averageMinutes: avg,
      collected: round2(delivered.reduce(function (a, d) { return a + d.toCollect; }, 0)) },
    can: { settings: session.access.role === 'manager' }
  };
}

// POST /api/pos/delivery/send — an order goes out: { tabId | orderId |
// ticketId, riderId | rider: { name, phone, vehicle, plate }, collect,
// collectMethod, lat, lng, landmark }. An open order's rider collects what it
// comes to (unless said otherwise); a paid one, nothing. Its ready kitchen
// tickets count as taken out. Returns the delivery and the rider's link.
async function send(token, p) {
  var session = await access.need(token, 'delivery');
  var company = session.posCompanyId;
  p = p || {};
  var settings = await settingsOf(company);
  var tabId = p.tabId || null, orderId = p.orderId || null;
  if (p.ticketId) {
    var t = (await pool.query('SELECT tab_id, order_id FROM restaurant_kitchen_tickets WHERE id = $1 AND company_id = $2', [p.ticketId, company])).rows[0];
    if (!t) fail('notfound', 'That kitchen ticket is not this restaurant\'s.');
    tabId = t.tab_id; orderId = t.order_id;
    if (orderId) tabId = null;
  }
  if (!tabId && !orderId) fail('invalid', 'Pick the order to send.');
  var src;
  if (tabId) {
    var tab = (await pos().tabRows(company, ' AND t.id = $2', [tabId]))[0];
    if (!tab) fail('notfound', 'That order has already been paid or removed.');
    var oo = (await pool.query('SELECT * FROM restaurant_online_orders WHERE tab_id = $1', [tabId])).rows[0] || null;
    if (tab.fulfillment !== 'delivery') fail('invalid', 'That order is not a delivery.');
    src = { tabId: tabId, orderId: null, onlineId: oo ? oo.id : null, label: tab.label || tab.customerName, name: tab.customerName || tab.guestName || '', phone: tab.customerPhone || tab.guestPhone || '',
      address: addressOf(tab.deliveryAddress, oo), landmark: oo ? oo.landmark : '', lat: oo ? oo.lat : null, lng: oo ? oo.lng : null,
      items: tab.lines.filter(function (l) { return !l.fee; }).map(function (l) { return l.qty + '× ' + l.name; }), owed: tab.total, payMethod: oo ? oo.pay_method : null };
  } else {
    var o = (await pool.query("SELECT * FROM restaurant_orders WHERE id = $1 AND company_id = $2 AND status = 'completed'", [orderId, company])).rows[0];
    if (!o) fail('notfound', 'That sale is not this restaurant\'s.');
    if (o.fulfillment !== 'delivery') fail('invalid', 'That sale is not a delivery.');
    var its = (await pool.query('SELECT name, qty FROM restaurant_order_items WHERE order_id = $1 AND name <> $2 ORDER BY sort_order', [orderId, pos().FEE_NAME])).rows;
    src = { tabId: null, orderId: orderId, onlineId: null, label: o.customer_name || o.order_no, name: o.customer_name || '', phone: o.customer_phone || '', address: o.delivery_address || '',
      landmark: '', lat: null, lng: null, items: its.map(function (l) { return Number(l.qty) + '× ' + l.name; }), owed: 0, payMethod: null };
  }
  // A pin dropped on the delivery screen, when the order has none.
  var pin = pointOf(p.lat, p.lng);
  if (pin) { src.lat = pin.lat; src.lng = pin.lng; }
  if (p.landmark !== undefined) src.landmark = cleanText(p.landmark, 200) || src.landmark;

  var rider;
  if (p.riderId) {
    var r = (await pool.query('SELECT * FROM restaurant_riders WHERE id = $1 AND company_id = $2', [p.riderId, company])).rows[0];
    if (!r) fail('notfound', 'That rider is not this restaurant\'s.');
    rider = { id: r.id, name: r.name, phone: r.phone, vehicle: r.vehicle, plate: r.plate };
  } else {
    rider = Object.assign({ id: null }, riderFields(p.rider || {}));
  }
  var collect = p.collect === undefined || p.collect === null || p.collect === '' ? src.owed : round2(p.collect);
  if (!(collect >= 0 && collect < 1000000)) fail('invalid', 'What the rider collects is not right.');
  var method = collect > 0 ? V.oneOf(p.collectMethod || src.payMethod || 'cash', ['cash', 'mobile_money'], 'How the customer pays') : null;
  var point = src.lat != null ? { lat: src.lat, lng: src.lng } : null;
  var distance = roadKm(settings.location, point);
  var token_ = newToken();

  var row = await withTransaction(async function (client) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('delivery:' || $1))", [company]);
    var clash = (await client.query("SELECT number FROM restaurant_deliveries WHERE company_id = $1 AND status <> 'cancelled' AND " + (src.tabId ? 'tab_id = $2' : 'order_id = $2'),
      [company, src.tabId || src.orderId])).rows[0];
    if (clash) fail('conflict', 'That order went out already (D-' + String(clash.number).padStart(3, '0') + ').');
    var number = (await client.query("SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_deliveries WHERE company_id = $1 AND created_at >= date_trunc('day', now())", [company])).rows[0].n;
    var ins = (await client.query(
      'INSERT INTO restaurant_deliveries (company_id, number, source, tab_id, order_id, ticket_id, online_order_id, label, customer_name, customer_phone, address, landmark, lat, lng, items, ' +
      ' to_collect, collect_method, rider_id, rider_name, rider_phone, rider_vehicle, rider_plate, rider_token_hash, rider_token_sealed, distance_km, eta_minutes, sent_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING id',
      [company, number, src.onlineId ? 'online' : 'till', src.tabId, src.orderId, p.ticketId || null, src.onlineId, cleanText(src.label, 80), src.name, src.phone, src.address, src.landmark,
        src.lat, src.lng, JSON.stringify(src.items), collect, method, rider.id, rider.name, rider.phone, rider.vehicle, rider.plate, hash(token_), secretBox.seal('rider-link', token_),
        distance, travelMinutes(distance, rider.vehicle), session.posEmployeeId])).rows[0];
    // Its food is taken out of the kitchen's ready list.
    await client.query("UPDATE restaurant_kitchen_tickets SET status = 'served', served_at = now() WHERE company_id = $1 AND status = 'ready' AND served_at IS NULL AND " +
      (src.tabId ? 'tab_id = $2' : 'order_id = $2'), [company, src.tabId || src.orderId]);
    await activity.log(client, { companyId: company, employeeId: session.posEmployeeId, app: session.app === 'delivery' ? 'delivery' : 'till', action: 'delivery.sent',
      summary: 'Sent D-' + String(number).padStart(3, '0') + ' (' + (src.label || src.name) + ') with ' + rider.name + (collect > 0 ? ', to collect ' + collect.toFixed(2) + (method === 'mobile_money' ? ' by Mobile Money' : ' in cash') : ', paid') + '.',
      amount: collect || null, refType: 'delivery', refId: ins.id });
    return (await client.query(DELIVERY_SELECT + 'WHERE d.id = $1', [ins.id])).rows[0];
  });
  return { delivery: deliveryOut(row, { link: true }) };
}

async function deliveryOfCompany(client, company, id) {
  var d = (await client.query(DELIVERY_SELECT + 'WHERE d.id = $1 AND d.company_id = $2 FOR UPDATE OF d', [id, company])).rows[0];
  if (!d) fail('notfound', 'That delivery is not this restaurant\'s.');
  return d;
}
// The next step: forward only, and an ended delivery stays ended.
async function moveTo(client, d, status, note, by) {
  if (ENDED.indexOf(d.status) >= 0) fail('conflict', 'D-' + String(d.number).padStart(3, '0') + ' is ' + STATUS_NAME[d.status].toLowerCase() + ' already.');
  if (STEP[status] <= STEP[d.status] && status !== 'failed' && status !== 'cancelled') return d;
  if ((status === 'failed' || status === 'cancelled') && !cleanText(note, 300)) fail('invalid', status === 'failed' ? 'Say why it could not be delivered.' : 'Say why it is cancelled.');
  var sets = ['status = $2'];
  if (status === 'picked_up' || (STEP[status] >= 1 && !d.picked_up_at && status !== 'cancelled' && status !== 'failed')) sets.push('picked_up_at = coalesce(picked_up_at, now())');
  if (status === 'arrived' || (status === 'delivered' && !d.arrived_at)) sets.push('arrived_at = coalesce(arrived_at, now())');
  if (ENDED.indexOf(status) >= 0) sets.push('ended_at = now()');
  if (note) sets.push('note = $3');
  var row = (await client.query('UPDATE restaurant_deliveries SET ' + sets.join(', ') + ' WHERE id = $1 RETURNING *', note ? [d.id, status, cleanText(note, 300)] : [d.id, status])).rows[0];
  await activity.log(client, { companyId: d.company_id, employeeId: by.employeeId || null, app: by.app, action: 'delivery.' + status,
    summary: 'D-' + String(d.number).padStart(3, '0') + ' (' + (d.label || d.customer_name) + '): ' + STATUS_NAME[status].toLowerCase() + (by.rider ? ', said ' + d.rider_name : '') + (note ? ': ' + cleanText(note, 120) : '') + '.',
    refType: 'delivery', refId: d.id });
  return row;
}
// POST /api/pos/delivery/:id/status { status, note } — from the delivery screen.
async function setStatus(token, id, p) {
  var session = await access.need(token, 'delivery');
  p = p || {};
  var status = V.oneOf(p.status, ['picked_up', 'arrived', 'delivered', 'failed', 'cancelled'], 'Status');
  await withTransaction(async function (client) {
    var d = await deliveryOfCompany(client, session.posCompanyId, id);
    await moveTo(client, d, status, p.note, { employeeId: session.posEmployeeId, app: 'delivery' });
  });
  return { delivery: deliveryOut((await pool.query(DELIVERY_SELECT + 'WHERE d.id = $1', [id])).rows[0], { link: true }) };
}
// POST /api/pos/delivery/:id/rider { riderId | rider } — another rider takes
// it; the old link stops working and the new rider gets one of their own.
async function reassign(token, id, p) {
  var session = await access.need(token, 'delivery');
  p = p || {};
  var rider;
  if (p.riderId) {
    var r = (await pool.query('SELECT * FROM restaurant_riders WHERE id = $1 AND company_id = $2', [p.riderId, session.posCompanyId])).rows[0];
    if (!r) fail('notfound', 'That rider is not this restaurant\'s.');
    rider = { id: r.id, name: r.name, phone: r.phone, vehicle: r.vehicle, plate: r.plate };
  } else rider = Object.assign({ id: null }, riderFields(p.rider || {}));
  var token_ = newToken();
  await withTransaction(async function (client) {
    var d = await deliveryOfCompany(client, session.posCompanyId, id);
    if (ENDED.indexOf(d.status) >= 0) fail('conflict', 'That delivery has ended.');
    await client.query('UPDATE restaurant_deliveries SET rider_id = $2, rider_name = $3, rider_phone = $4, rider_vehicle = $5, rider_plate = $6, rider_token_hash = $7, rider_token_sealed = $8, ' +
      'rider_lat = NULL, rider_lng = NULL, rider_seen_at = NULL, eta_minutes = $9 WHERE id = $1',
      [d.id, rider.id, rider.name, rider.phone, rider.vehicle, rider.plate, hash(token_), secretBox.seal('rider-link', token_), travelMinutes(d.distance_km == null ? null : Number(d.distance_km), rider.vehicle)]);
    await activity.log(client, { companyId: d.company_id, employeeId: session.posEmployeeId, app: 'delivery', action: 'delivery.rider',
      summary: 'D-' + String(d.number).padStart(3, '0') + ' handed from ' + d.rider_name + ' to ' + rider.name + '.', refType: 'delivery', refId: d.id });
  });
  return { delivery: deliveryOut((await pool.query(DELIVERY_SELECT + 'WHERE d.id = $1', [id])).rows[0], { link: true }) };
}

// ── the rider's link (no sign-in: the link is the key) ──

async function byRiderToken(client, raw, lock) {
  var d = (await client.query(DELIVERY_SELECT + 'WHERE d.rider_token_hash = $1' + (lock ? ' FOR UPDATE OF d' : ''), [hash(String(raw || ''))])).rows[0];
  if (!d) fail('notfound', 'This delivery link is not working: it was replaced, or is wrong. Ask the restaurant for the link.');
  if (d.ended_at && Date.now() - new Date(d.ended_at).getTime() > LINK_HOURS * 3600000) fail('notfound', 'This delivery ended a while ago.');
  return d;
}
async function restaurantOf(companyId) {
  var co = (await pool.query('SELECT code, name FROM companies WHERE id = $1', [companyId])).rows[0];
  var s = await settingsOf(companyId);
  return { code: co.code, name: co.name, phone: s.phone, location: s.location };
}
// GET /api/pos/rider/:token — what the rider needs: who, where, what to collect.
async function riderView(raw) {
  var d = await byRiderToken(pool, raw);
  var out = deliveryOut(d);
  out.restaurant = await restaurantOf(d.company_id);
  return out;
}
// POST /api/pos/rider/:token/location { lat, lng } — where the rider is, every few seconds while their page is open.
async function riderLocation(raw, p) {
  p = p || {};
  var point = pointOf(p.lat, p.lng);
  if (!point) fail('invalid', 'Where are you? Turn on location for this page.');
  var d = await byRiderToken(pool, raw);
  if (ACTIVE.indexOf(d.status) < 0) return { status: d.status };
  if (d.rider_seen_at && Date.now() - new Date(d.rider_seen_at).getTime() < 2500) return { status: d.status };
  await pool.query('UPDATE restaurant_deliveries SET rider_lat = $2, rider_lng = $3, rider_seen_at = now() WHERE id = $1', [d.id, point.lat, point.lng]);
  return { status: d.status };
}
// POST /api/pos/rider/:token/status { status, note } — picked up, arrived, delivered, or could not deliver.
async function riderStatus(raw, p) {
  p = p || {};
  var status = V.oneOf(p.status, ['picked_up', 'arrived', 'delivered', 'failed'], 'Status');
  await withTransaction(async function (client) {
    var d = await byRiderToken(client, raw, true);
    await moveTo(client, d, status, p.note, { app: 'delivery', rider: true });
  });
  return riderView(raw);
}

// For the website's tracking page (restaurantOnline track): the delivery of an order, without the rider's link.
async function forOnline(onlineId) {
  var d = (await pool.query(DELIVERY_SELECT + "WHERE d.online_order_id = $1 AND d.status <> 'cancelled' ORDER BY d.created_at DESC LIMIT 1", [onlineId])).rows[0];
  return d ? deliveryOut(d) : null;
}

module.exports = {
  VEHICLES: VEHICLES, settingsOf: settingsOf, quote: quote, pointOf: pointOf, roadKm: roadKm, travelMinutes: travelMinutes,
  settings: settings, setOpen: setOpen, riders: riders, board: board, send: send, setStatus: setStatus, reassign: reassign,
  riderView: riderView, riderLocation: riderLocation, riderStatus: riderStatus, forOnline: forOnline, restaurantOf: restaurantOf, deliveryOut: deliveryOut
};
