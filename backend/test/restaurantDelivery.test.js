// Deliveries and the website's orders (migration 0159): a manager sets where
// the restaurant is, the fee and how far it delivers; a customer orders on
// the website and follows it; the delivery screen accepts it (an open order
// on the till, sent to the kitchen) or turns it down; when the food is ready
// it goes out with a rider, who moves it on from their own link while the
// customer watches; paid at the till, it is done. Test data uses the ZQD
// company code; no real addresses or people.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var kitchen = require('../src/services/restaurantKitchen.service');
var access = require('../src/services/restaurantTillAccess.service');
var delivery = require('../src/services/restaurantDelivery.service');
var online = require('../src/services/restaurantOnline.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7471', kojo: '7472', yaw: '7473', esi: '7474' };
var IP = '10.9.7.1';
var HERE = { lat: 5.6037, lng: -0.187 };       // the restaurant, made up
var NEAR = { lat: 5.62, lng: -0.17 };          // a customer a few km off
var FAR = { lat: 5.9, lng: -0.18 };            // too far
var company, people = {}, rice, juice, tok = {};

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQD'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_deliveries WHERE company_id = ANY($1)', 'DELETE FROM restaurant_online_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_riders WHERE company_id = ANY($1)', 'DELETE FROM restaurant_delivery_settings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_payments WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))', 'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQD-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqd', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
async function cooked(tabId) {
  var t = (await pool.query("SELECT id FROM restaurant_kitchen_tickets WHERE tab_id = $1 AND status = 'cooking'", [tabId])).rows;
  for (var x of t) {
    await pool.query("UPDATE restaurant_kitchen_items SET status = 'done' WHERE ticket_id = $1 AND status <> 'cancelled'", [x.id]);
    await pool.query("UPDATE restaurant_kitchen_tickets SET status = 'ready', ready_at = now() WHERE id = $1", [x.id]);
  }
  return t.map(function (r) { return r.id; });
}
function order(extra) {
  return Object.assign({ name: 'Zqd Akosua', phone: '0200000711', fulfillment: 'delivery', address: 'Zqd Street 4', landmark: 'Blue gate', lat: NEAR.lat, lng: NEAR.lng,
    payMethod: 'cash', items: [{ menuItemId: rice, qty: 2 }, { menuItemId: juice, qty: 1, note: 'cold' }] }, extra || {});
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQD', 'Zqd Kitchen') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQDF', 'Zqd Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQD-1', 'Ama', dept);
  await person('kojo', 'ZQD-2', 'Kojo', dept);
  await person('yaw', 'ZQD-3', 'Yaw', dept);
  await person('esi', 'ZQD-4', 'Esi', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'waiter'), ($1, $4, 'kitchen')",
    [company.id, people.kojo, people.yaw, people.esi]);
  rice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqd jollof', 'Zqd Mains', 50, true) RETURNING id", [company.id])).rows[0].id;
  juice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqd sobolo', 'Zqd Drinks', 15, true) RETURNING id", [company.id])).rows[0].id;
  await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zqd Kitchen', '{}', true)", [company.id]);
  for (var k of ['ama', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  tok.desk = (await pos.login(PINS.ama, IP, 'delivery')).token;
  await pos.openDrawerSession(tok.ama, 100);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('a manager sets the delivery settings; who may use the delivery screen', async function () {
  await assert.rejects(online.menu('ZQD'), /does not take orders online/);
  await assert.rejects(delivery.settings(tok.ama, { settings: { open: true } }, IP), /type a manager's PIN/);
  await assert.rejects(delivery.settings(tok.kojo, { settings: { location: { lat: 95, lng: 0 } } }, IP), /place on the map is not right/);
  var s = await delivery.settings(tok.kojo, { settings: { location: { lat: HERE.lat, lng: HERE.lng, address: 'Zqd Road' }, phone: '0200000700', fee: { base: 10, perKm: 3 }, maxKm: 12, readyMinutes: 20 } }, IP);
  assert.deepEqual([s.settings.open, s.settings.location.lat, s.settings.fee.perKm, s.settings.maxKm], [false, HERE.lat, 3, 12]);
  // The cashier may use the delivery screen; a waiter, a cook may not.
  assert.ok((await delivery.board(tok.desk)).riders);
  await assert.rejects(delivery.board(tok.yaw), /does not send deliveries/);
  await assert.rejects(pos.login(PINS.yaw, IP, 'delivery'), /does not send deliveries/);
  await assert.rejects(pos.login(PINS.esi, IP, 'delivery'), /does not send deliveries/);
});

test('the website: the menu, closed or open; an order priced from the menu, the fee by distance; what is refused', async function () {
  var m = await online.menu('zqd');
  assert.deepEqual([m.restaurant.name, m.restaurant.open, m.items.length, m.categories], ['Zqd Kitchen', false, 2, ['Zqd Drinks', 'Zqd Mains']]);
  await assert.rejects(online.place('ZQD', order(), IP), /not taking orders online right now/);
  await delivery.setOpen(tok.desk, true);
  await assert.rejects(online.place('ZQD', order({ website: 'http://spam' }), IP), /Something went wrong/);
  await assert.rejects(online.place('ZQD', order({ lat: null, lng: null }), IP), /drop the pin on the map/);
  await assert.rejects(online.place('ZQD', order({ phone: '12' }), IP), /phone number/);
  await assert.rejects(online.place('ZQD', order({ lat: FAR.lat, lng: FAR.lng }), IP), /delivers up to 12 km/);
  await assert.rejects(online.place('ZQD', order({ items: [{ menuItemId: rice, qty: 0 }] }), IP), /between 1 and 50/);
  var placed = await online.place('ZQD', order(), IP);
  var d = delivery.roadKm(HERE, NEAR);
  assert.match(placed.ref, /^W-\d{4}$/);
  assert.equal(placed.order.subtotal, 115);
  assert.equal(placed.order.deliveryFee, Math.round(10 + 3 * d));
  assert.equal(placed.order.total, 115 + Math.round(10 + 3 * d));
  assert.deepEqual([placed.order.stage, placed.order.distanceKm], ['waiting', d]);
  assert.match(placed.trackUrl, /\/t\/[A-Za-z0-9_-]{20,}$/);
  // Followed by its link; cancelled by the customer while it waits.
  assert.equal((await online.track(placed.token)).ref, placed.ref);
  await assert.rejects(online.track('not-a-token'), /cannot find that order/);
  var again = await online.place('ZQD', order({ fulfillment: 'pickup', lat: null, lng: null, address: '' }), IP);
  assert.equal(again.order.deliveryFee, 0);
  assert.equal((await online.cancel(again.token)).stage, 'cancelled');
  await assert.rejects(online.cancel(again.token), /not waiting any more/);
  await pool.query("DELETE FROM restaurant_online_orders WHERE company_id = $1 AND status = 'cancelled'", [company.id]);
});

test('accepted, it is an open order on the till and in the kitchen; turned down, the customer sees why; the rider takes it and moves it on', async function () {
  var a = await online.place('ZQD', order(), IP);
  var b = await online.place('ZQD', order({ name: 'Zqd Kwame', phone: '0200000712' }), IP);
  var board = await delivery.board(tok.desk);
  assert.ok(board.pending.some(function (o) { return o.ref === a.ref; }) && board.pending.some(function (o) { return o.ref === b.ref; }));
  var aId = board.pending.find(function (o) { return o.ref === a.ref; }).id;
  var bId = board.pending.find(function (o) { return o.ref === b.ref; }).id;

  await assert.rejects(online.reject(tok.desk, bId, {}), /Why it is turned down is required/);
  await online.reject(tok.desk, bId, { reason: 'Zqd sorry, the kitchen is closing' });
  var tb = await online.track(b.token);
  assert.deepEqual([tb.stage, tb.rejectReason], ['rejected', 'Zqd sorry, the kitchen is closing']);
  await assert.rejects(online.accept(tok.desk, bId, {}), /customer cancelled|answered that order already/);

  var acc = await online.accept(tok.desk, aId, { readyMinutes: 30 });
  await assert.rejects(online.accept(tok.desk, aId, {}), /answered that order already/);
  assert.equal(acc.tab.total, a.order.total, 'the dishes and the delivery fee');
  var tab = (await pos.listTabs(tok.ama)).find(function (t) { return t.id === acc.tab.id; });
  assert.deepEqual([tab.fulfillment, tab.customerName, tab.lines.length], ['delivery', 'Zqd Akosua', 3]);
  assert.ok(tab.lines.some(function (l) { return l.fee && l.name === 'Delivery fee'; }));
  var dishes = (await pool.query('SELECT i.name FROM restaurant_kitchen_items i JOIN restaurant_kitchen_tickets t ON t.id = i.ticket_id WHERE t.tab_id = $1', [tab.id])).rows.map(function (r) { return r.name; }).sort();
  assert.deepEqual(dishes, ['Zqd jollof', 'Zqd sobolo'], 'the fee is not cooked');
  assert.equal((await online.track(a.token)).stage, 'preparing');
  board = await delivery.board(tok.desk);
  assert.ok(board.cooking.some(function (w) { return w.tabId === tab.id && w.onlineRef === a.ref; }));

  // Ready: the till sees it is a delivery not sent yet, from the website.
  var tickets = await cooked(tab.id);
  var ready = (await kitchen.tillSummary(tok.ama)).ready.find(function (r) { return r.id === tickets[0]; });
  assert.deepEqual([ready.fulfillment, ready.deliveryId, ready.onlineRef], ['delivery', null, a.ref]);
  assert.equal((await online.track(a.token)).stage, 'ready');
  board = await delivery.board(tok.desk);
  assert.ok(board.ready.some(function (w) { return w.tabId === tab.id && w.customer.lat === NEAR.lat; }));

  // Sent with a rider whose name and phone are typed: they collect the bill in cash.
  await assert.rejects(delivery.send(tok.desk, { ticketId: tickets[0], rider: { name: 'Zqd Kofi' } }), /rider's phone is required/);
  var sent = (await delivery.send(tok.ama, { ticketId: tickets[0], rider: { name: 'Zqd Kofi', phone: '0200000720', vehicle: 'motorbike', plate: 'gr 1-zq' } })).delivery;
  assert.deepEqual([sent.status, sent.toCollect, sent.collectMethod, sent.rider.plate, sent.source], ['assigned', a.order.total, 'cash', 'GR 1-ZQ', 'online']);
  assert.ok(sent.etaMinutes > 0 && sent.distanceKm === delivery.roadKm(HERE, NEAR));
  assert.match(sent.riderLink, /\/r\/[A-Za-z0-9_-]{20,}$/);
  await assert.rejects(delivery.send(tok.desk, { tabId: tab.id, rider: { name: 'Zqd Yaa', phone: '0200000721' } }), /went out already/);
  assert.ok(!(await kitchen.tillSummary(tok.ama)).ready.some(function (r) { return r.id === tickets[0]; }), 'taken out of the ready list');
  assert.equal((await online.track(a.token)).stage, 'rider');

  // The rider's link: what to bring where; where they are; each step.
  var link = sent.riderLink.split('/r/')[1];
  var view = await delivery.riderView(link);
  assert.deepEqual([view.customer.name, view.customer.address, view.customer.landmark, view.toCollect, view.restaurant.name, view.items], ['Zqd Akosua', 'Zqd Street 4', 'Blue gate', a.order.total, 'Zqd Kitchen', ['2× Zqd jollof', '1× Zqd sobolo']]);
  await assert.rejects(delivery.riderView('wrong'), /link is not working/);
  await delivery.riderStatus(link, { status: 'picked_up' });
  await delivery.riderLocation(link, { lat: 5.61, lng: -0.18 });
  var t = await online.track(a.token);
  assert.deepEqual([t.stage, t.delivery.rider.name, t.delivery.riderAt.lat], ['on_the_way', 'Zqd Kofi', 5.61]);
  // The way they went: a point each time they have moved on, not while they stand still.
  var again = async function (lat, lng) {
    await pool.query("UPDATE restaurant_deliveries SET rider_seen_at = now() - interval '10 seconds' WHERE id = $1", [sent.id]);
    await delivery.riderLocation(link, { lat: lat, lng: lng });
  };
  await again(5.61005, -0.18); // about 6 m: the phone wavering
  await again(5.6110, -0.1795);
  assert.deepEqual((await online.track(a.token)).delivery.trail, [[5.61, -0.18], [5.611, -0.1795]]);
  assert.equal((await delivery.board(tok.desk)).active.find(function (x) { return x.id === sent.id; }).trail.length, 2);
  await assert.rejects(delivery.riderStatus(link, { status: 'failed' }), /Say why it could not be delivered/);
  await delivery.riderStatus(link, { status: 'arrived' });
  var done = await delivery.riderStatus(link, { status: 'delivered' });
  assert.ok(done.endedAt && done.arrivedAt && done.pickedUpAt);
  assert.equal((await online.track(a.token)).stage, 'delivered');
  await assert.rejects(delivery.riderStatus(link, { status: 'arrived' }), /delivered already/);

  // The rider is back with the cash: paid at the till, the website order is done.
  var paid = await pos.createOrder(tok.ama, { tabId: tab.id, fulfillment: 'delivery', customerName: tab.customerName, customerPhone: tab.customerPhone, deliveryAddress: tab.deliveryAddress,
    items: tab.lines.map(function (l) { return l.custom ? { custom: { name: l.name, price: l.unitPrice, fee: l.fee }, qty: l.qty } : { menuItemId: l.menuItemId, qty: l.qty, note: l.note }; }),
    payments: [{ method: 'cash' }] });
  assert.equal(paid.total, a.order.total);
  var oo = (await pool.query('SELECT status, order_id FROM restaurant_online_orders WHERE id = $1', [aId])).rows[0];
  assert.deepEqual([oo.status, oo.order_id], ['done', paid.id]);
  assert.equal((await pool.query('SELECT order_id FROM restaurant_deliveries WHERE id = $1', [sent.id])).rows[0].order_id, paid.id);
  board = await delivery.board(tok.desk);
  assert.ok(!board.ready.some(function (w) { return w.orderId === paid.id; }), 'delivered, so not waiting to go');
  assert.ok(board.done.some(function (x) { return x.id === sent.id && x.status === 'delivered'; }));
  assert.equal(board.totals.delivered, 1);
});

test('the restaurant\'s riders; a till sale sent out paid; handed to another rider; could not deliver; cancelled', async function () {
  await assert.rejects(delivery.riders(tok.desk, { action: 'save', rider: { name: 'Zqd Abena', phone: '0200000730', vehicle: 'rocket' } }), /Vehicle is not a valid option/);
  var r = await delivery.riders(tok.desk, { action: 'save', rider: { name: 'Zqd Abena', phone: '0200000730', vehicle: 'bicycle' } });
  r = await delivery.riders(tok.desk, { action: 'save', rider: { name: 'Zqd Yaw', phone: '0200000731', vehicle: 'motorbike', plate: 'zq 22' } });
  var abena = r.riders.find(function (x) { return x.name === 'Zqd Abena'; });
  var yawR = r.riders.find(function (x) { return x.name === 'Zqd Yaw'; });
  assert.equal(abena.busy, null);

  // A delivery paid at the till: nothing to collect.
  var sale = await pos.createOrder(tok.ama, { fulfillment: 'delivery', customerName: 'Zqd Esi', customerPhone: '0200000740', deliveryAddress: 'Zqd Close 9',
    items: [{ menuItemId: rice, qty: 1 }, { custom: { name: 'ignored', price: 12, fee: true }, qty: 3 }], payments: [{ method: 'mobile_money' }] });
  assert.equal(sale.total, 62, 'a fee line is one, named by the till');
  var board = await delivery.board(tok.desk);
  var waiting = board.cooking.concat(board.ready).find(function (w) { return w.orderId === sale.id; });
  assert.deepEqual([waiting.paid, waiting.items], [true, ['1× Zqd jollof']]);
  var d = (await delivery.send(tok.desk, { orderId: sale.id, riderId: abena.id, lat: NEAR.lat, lng: NEAR.lng })).delivery;
  assert.deepEqual([d.toCollect, d.collectMethod, d.rider.vehicle, d.customer.lat], [0, null, 'bicycle', NEAR.lat]);
  assert.deepEqual((await delivery.riders(tok.desk, {})).riders.find(function (x) { return x.id === abena.id; }).busy, [{ number: d.number, status: 'assigned' }]);

  // Handed to another rider: the first link stops working, and the way the first one went is not theirs.
  var oldLink = d.riderLink.split('/r/')[1];
  await delivery.riderLocation(oldLink, { lat: 5.62, lng: -0.17 });
  var moved = (await delivery.reassign(tok.desk, d.id, { riderId: yawR.id })).delivery;
  assert.deepEqual([moved.rider.name, moved.trail, moved.riderAt], ['Zqd Yaw', [], null]);
  assert.ok(moved.etaMinutes < d.etaMinutes, 'a motorbike is quicker than a bicycle');
  await assert.rejects(delivery.riderView(oldLink), /link is not working/);
  await assert.rejects(delivery.setStatus(tok.desk, d.id, { status: 'failed' }), /Say why/);
  var failed = (await delivery.setStatus(tok.desk, d.id, { status: 'failed', note: 'Zqd nobody answered' })).delivery;
  assert.deepEqual([failed.status, failed.note], ['failed', 'Zqd nobody answered']);
  await assert.rejects(delivery.setStatus(tok.desk, d.id, { status: 'delivered' }), /could not deliver already/);

  // An open delivery order with no website behind it, sent and then cancelled.
  var tab = await pos.saveTab(tok.ama, { fulfillment: 'delivery', customerName: 'Zqd Adwoa', customerPhone: '0200000741', deliveryAddress: 'Zqd Lane 2', items: [{ menuItemId: juice, qty: 2 }] });
  var d2 = (await delivery.send(tok.desk, { tabId: tab.id, riderId: yawR.id, collectMethod: 'mobile_money' })).delivery;
  assert.deepEqual([d2.toCollect, d2.collectMethod, d2.source], [30, 'mobile_money', 'till']);
  var c = (await delivery.setStatus(tok.desk, d2.id, { status: 'cancelled', note: 'Zqd customer will come' })).delivery;
  assert.equal(c.status, 'cancelled');
  // Cancelled, it can go out again; removed at the till, its delivery stops.
  var d3 = (await delivery.send(tok.desk, { tabId: tab.id, riderId: yawR.id })).delivery;
  await pos.removeTab(tok.kojo, tab.id);
  assert.equal((await pool.query('SELECT status FROM restaurant_deliveries WHERE id = $1', [d3.id])).rows[0].status, 'cancelled');

  await delivery.riders(tok.desk, { action: 'remove', id: abena.id });
  assert.ok(!(await delivery.riders(tok.desk, {})).riders.some(function (x) { return x.id === abena.id; }));
  // Each step is in the activity log.
  var log = (await pool.query("SELECT action FROM restaurant_activity WHERE company_id = $1 AND action LIKE 'delivery.%'", [company.id])).rows.map(function (x) { return x.action; });
  ['delivery.sent', 'delivery.picked_up', 'delivery.delivered', 'delivery.failed', 'delivery.cancelled', 'delivery.rider', 'delivery.open'].forEach(function (k) { assert.ok(log.indexOf(k) >= 0, k); });
});

test('the maps: Google\'s with the server\'s key, else OpenStreetMap; a long way thinned, not cut', function () {
  var config = require('../src/config');
  var was = config.googleMapsKey;
  try {
    config.googleMapsKey = '';
    assert.deepEqual(delivery.mapConfig(), { google: null, region: 'GH' });
    config.googleMapsKey = 'zq-browser-key';
    assert.deepEqual(delivery.mapConfig(), { google: { key: 'zq-browser-key' }, region: 'GH' });
  } finally { config.googleMapsKey = was; }
  var trail = [];
  for (var i = 0; i < 700; i++) trail = delivery.trailWith(trail, { lat: 5.6 + i * 0.0003, lng: -0.18 });
  assert.ok(trail.length <= 600 && trail.length > 400, 'kept to 600 points: ' + trail.length);
  assert.deepEqual([trail[0], trail[trail.length - 1]], [[5.6, -0.18], [Math.round((5.6 + 699 * 0.0003) * 1e6) / 1e6, -0.18]]);
  assert.equal(delivery.trailWith(trail, { lat: trail[trail.length - 1][0], lng: -0.18 }).length, trail.length);
});

// Google's Routes API stood in for: a road from where it is asked, with a
// slow and a jammed stretch, two-wheeler roads or not; every ask kept.
function fakeRoads(opts) {
  opts = opts || {};
  var calls = [];
  roadsSvc.setFetchForTests(async function (url, req) {
    var body = JSON.parse(req.body);
    calls.push({ url: url, headers: req.headers, body: body });
    if (opts.noTwoWheeler && body.travelMode === 'TWO_WHEELER') return { ok: false, status: 400, json: async function () { return {}; } };
    var o = body.origin.location.latLng, t = body.destination.location.latLng;
    var pts = [[o.latitude, o.longitude], [o.latitude, t.longitude], [(o.latitude + t.latitude) / 2, t.longitude], [t.latitude, t.longitude]];
    return { ok: true, status: 200, json: async function () {
      return { routes: [{ distanceMeters: 3400, duration: '840s', staticDuration: '600s', polyline: { encodedPolyline: encode(pts) },
        travelAdvisory: { speedReadingIntervals: [{ endPolylinePointIndex: 1, speed: 'NORMAL' }, { startPolylinePointIndex: 1, endPolylinePointIndex: 2, speed: 'SLOW' }, { startPolylinePointIndex: 2, endPolylinePointIndex: 3, speed: 'TRAFFIC_JAM' }] } }] };
    } };
  });
  return calls;
}
// Google's polyline encoding, for the stand-in.
function encode(points) {
  var out = '', plat = 0, plng = 0;
  function one(v) { v = v < 0 ? ~(v << 1) : v << 1; var s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); }
  points.forEach(function (p) { var la = Math.round(p[0] * 1e5), ln = Math.round(p[1] * 1e5); out += one(la - plat) + one(ln - plng); plat = la; plng = ln; });
  return out;
}
var roadsSvc = require('../src/services/restaurantRoutes.service');

test('the road with its traffic: asked when sent and when picked up, again when the rider leaves it; none without a key', async function () {
  var config = require('../src/config');
  var was = config.googleRoutesKey;
  try {
    assert.deepEqual(roadsSvc.decode('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
    var kwesi = (await delivery.riders(tok.desk, { action: 'save', rider: { name: 'Zqd Kwesi', phone: '0200000750', vehicle: 'motorbike' } })).riders.find(function (r) { return r.name === 'Zqd Kwesi'; });
    var sendOne = async function (name) {
      var tab = await pos.saveTab(tok.ama, { fulfillment: 'delivery', customerName: name, customerPhone: '0200000751', deliveryAddress: 'Zqd Lane 9', items: [{ menuItemId: juice, qty: 1 }] });
      return (await delivery.send(tok.desk, { tabId: tab.id, riderId: kwesi.id, lat: NEAR.lat, lng: NEAR.lng })).delivery;
    };

    // No key: nothing asked, the way stays a curve.
    config.googleRoutesKey = '';
    var calls = fakeRoads();
    var plain = await sendOne('Zqd Fiifi');
    await delivery.settled();
    assert.deepEqual([calls.length, (await delivery.board(tok.desk)).active.find(function (x) { return x.id === plain.id; }).route], [0, null]);

    // With a key: the motorbike's road with the traffic, the time it takes with it.
    config.googleRoutesKey = 'zq-server-key';
    var d = await sendOne('Zqd Efua');
    await delivery.settled();
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].url, calls[0].headers['X-Goog-Api-Key'], calls[0].body.travelMode, calls[0].body.routingPreference, calls[0].body.extraComputations, calls[0].body.regionCode],
      ['https://routes.googleapis.com/directions/v2:computeRoutes', 'zq-server-key', 'TWO_WHEELER', 'TRAFFIC_AWARE', ['TRAFFIC_ON_POLYLINE'], 'GH']);
    assert.match(calls[0].headers['X-Goog-FieldMask'], /routes\.travelAdvisory\.speedReadingIntervals/);
    assert.deepEqual([calls[0].body.origin.location.latLng.latitude, calls[0].body.destination.location.latLng.latitude], [HERE.lat, NEAR.lat]);
    var b = (await delivery.board(tok.desk)).active.find(function (x) { return x.id === d.id; });
    assert.deepEqual([b.route.points.length, b.route.traffic, b.route.seconds, b.route.freeSeconds, b.route.from, b.route.arriveAt, b.distanceKm, b.etaMinutes],
      [4, [[1, 2, 'slow'], [2, 3, 'jam']], 840, 600, 'restaurant', null, 3.4, 16]);

    // Picked up: asked again from the restaurant, and when it should be at the door.
    var link = d.riderLink.split('/r/')[1];
    await delivery.riderStatus(link, { status: 'picked_up' });
    await delivery.settled();
    var up = (await delivery.riderView(link));
    assert.equal(calls.length, 2);
    assert.equal(up.route.from, 'restaurant');
    assert.ok(Math.abs(new Date(up.route.arriveAt).getTime() - (Date.now() + (840 + 120) * 1000)) < 5000, 'at the door in the ride and the handing over');
    // On the road and the road fresh: not asked again. Off it: asked from where the rider is.
    await delivery.riderLocation(link, { lat: HERE.lat, lng: (HERE.lng + NEAR.lng) / 2 });
    await delivery.settled();
    assert.equal(calls.length, 2);
    await pool.query("UPDATE restaurant_deliveries SET rider_seen_at = now() - interval '10 seconds' WHERE id = $1", [d.id]);
    await delivery.riderLocation(link, { lat: 5.64, lng: -0.2 });
    await delivery.settled();
    assert.equal(calls.length, 3);
    assert.deepEqual([calls[2].body.origin.location.latLng.latitude, (await delivery.riderView(link)).route.from], [5.64, 'rider']);

    // No two-wheeler roads: a car's, the motorbike's time still Google's.
    var noTw = fakeRoads({ noTwoWheeler: true });
    var d2 = await sendOne('Zqd Kofi');
    await delivery.settled();
    assert.deepEqual(noTw.map(function (c) { return c.body.travelMode; }), ['TWO_WHEELER', 'DRIVE']);
    assert.equal((await delivery.board(tok.desk)).active.find(function (x) { return x.id === d2.id; }).route.mode, 'DRIVE');

    // Never more than twelve asks for one delivery.
    await pool.query('UPDATE restaurant_deliveries SET route_calls = 12 WHERE id = $1', [d2.id]);
    assert.equal(await delivery.refreshRoute(d2.id, 'restaurant'), null);
    assert.equal(noTw.length, 2);
  } finally {
    config.googleRoutesKey = was;
    roadsSvc.setFetchForTests(null);
  }
});
