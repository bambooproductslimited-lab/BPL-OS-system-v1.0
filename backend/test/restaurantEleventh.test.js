// The eleventh batch on the restaurant side (migration 0192): website
// orders paid online in advance (given back when turned down or cancelled)
// and deposits for big bookings (taken off the bill, kept on a no-show,
// given back in time). Fake Zqel data; Paystack stubbed, nothing goes out.
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var online = require('../src/services/restaurantOnline.service');
var bookings = require('../src/services/restaurantBookings.service');
var delivery = require('../src/services/restaurantDelivery.service');
var paystack = require('../src/services/restaurantPaystack.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7691', kojo: '7692' };
var IP = '10.9.8.61';
var company, dept, people = {}, tok = {}, rice, t1;
var realKey = config.paystack.secretKey;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQEL'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_deliveries WHERE company_id = ANY($1)', 'DELETE FROM restaurant_paystack_payments WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_online_orders WHERE company_id = ANY($1)', 'DELETE FROM restaurant_bookings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_payments WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_riders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_delivery_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_tables WHERE company_id = ANY($1)', 'DELETE FROM restaurant_guests WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQEL-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQEL-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, role) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqel', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
  await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [company.id, people[key], role]);
}
async function settings(s) { await access.saveSettings(tok.kojo, { settings: s }, IP); }
function chargeOf(tab) {
  return { tabId: tab.id, fulfillment: tab.fulfillment, tableId: tab.tableId || undefined, items: tab.lines.filter(function (l) { return !l.fee; }).map(function (l) { return { menuItemId: l.menuItemId, variationId: l.variationId || undefined, qty: l.qty }; }) };
}

// Paystack, as its API answers (no request leaves the machine): pay pages,
// checks, and refunds (pending; failing for one reference on purpose).
var state = {}, refunds = [], refuseRefund = {};
function stubPaystack() {
  config.paystack.secretKey = 'zqel-fake-paystack-key-for-tests';
  paystack.setFetchForTests(async function (url, opts) {
    var body = opts.body ? JSON.parse(opts.body) : null;
    var data;
    if (/\/transaction\/initialize$/.test(url)) {
      state[body.reference] = { status: 'ongoing', amount: body.amount, sent: body };
      data = { authorization_url: 'https://checkout.paystack.com/zqel' + body.reference.slice(-6).toLowerCase(), reference: body.reference };
    } else if (/\/refund$/.test(url)) {
      refunds.push(body);
      if (refuseRefund[body.transaction]) return { ok: false, status: 400, json: async function () { return { status: false, message: 'Transaction has been fully reversed' }; } };
      data = { status: 'pending', transaction: { reference: body.transaction } };
    } else {
      var ref = decodeURIComponent(url.split('/').pop());
      var st = state[ref] || { status: 'ongoing', amount: 0 };
      data = { reference: ref, status: st.status, amount: st.amount, channel: st.channel || 'card', fees: st.status === 'success' ? 100 : null, authorization: {} };
    }
    return { ok: true, status: 200, json: async function () { return { status: true, message: 'ok', data: data }; } };
  });
}
async function paid(ref) {
  state[ref].status = 'success';
  await pool.query('UPDATE restaurant_paystack_payments SET checked_at = NULL WHERE reference = $1', [ref]);
}
function refOf(url) { return Object.keys(state).find(function (r) { return url.indexOf(r.slice(-6).toLowerCase()) >= 0; }); }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQEL', 'Zqel Grill') RETURNING *")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQELF', 'Zqel Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQEL-1', 'Ama', 'cashier');
  await person('kojo', 'ZQEL-2', 'Kojo', 'manager');
  rice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqel jollof', 'Zqel Mains', 60, true) RETURNING id", [company.id])).rows[0].id;
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name, seats, area) VALUES ($1, 'Zqel T1', 10, 'Zqel Hall') RETURNING id", [company.id])).rows[0].id;
  await pool.query('INSERT INTO restaurant_delivery_settings (company_id, settings) VALUES ($1, $2)', [company.id, JSON.stringify({ open: true, delivery: true, pickup: true, readyMinutes: 20,
    location: { lat: 5.6, lng: -0.18, address: 'Zqel road' }, fee: { base: 10, perKm: 0, freeOver: 0 }, maxKm: 30 })]);
  for (var k of ['ama', 'kojo']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
  stubPaystack();
});
test.after(async function () {
  paystack.setFetchForTests(null);
  config.paystack.secretKey = realKey;
  await cleanup(); await pool.end();
});

test('website orders paid online: unpaid until paid, then to the restaurant; on the till\'s bill; nothing to collect; given back when turned down or cancelled', async function () {
  var order = function (extra, ip) { return online.place('ZQEL', Object.assign({ name: 'Zqel Abena', phone: '0200000981', fulfillment: 'pickup', payMethod: 'online', items: [{ menuItemId: rice, qty: 2 }] }, extra), ip || IP); };
  // Off until the website's settings and Paystack say so.
  assert.equal((await online.shopOf('ZQEL')).payOnline, false);
  await assert.rejects(order({}), /How you pay/);
  await settings({ card: { paystack: true } });
  await pool.query("UPDATE restaurant_delivery_settings SET settings = settings || '{\"payOnline\": true}' WHERE company_id = $1", [company.id]);
  assert.equal((await online.shopOf('ZQEL')).payOnline, true);

  var a = await order({});
  assert.match(a.payUrl, /^https:\/\/checkout\.paystack\.com\/zqel/);
  var ref = refOf(a.payUrl);
  assert.equal(state[ref].amount, 12000, 'the order\'s total, in pesewas');
  assert.equal(state[ref].sent.callback_url, a.trackUrl, 'back to the order\'s own page');
  var t = await online.track(a.token);
  assert.deepEqual([t.status, t.stage, t.paid.status], ['unpaid', 'unpaid', 'pending']);
  assert.ok(t.payBy);
  var board = await delivery.board(tok.kojo);
  assert.ok(!board.pending.some(function (o) { return o.ref === a.ref; }), 'the restaurant does not see it until paid');

  // Paid: back on its page, it goes to the restaurant.
  await paid(ref);
  t = await online.track(a.token);
  assert.deepEqual([t.status, t.stage, t.paid.status], ['pending', 'waiting', 'success']);
  board = await delivery.board(tok.kojo);
  var mine = board.pending.find(function (o) { return o.ref === a.ref; });
  assert.deepEqual([mine.payMethod, mine.paid.status, mine.paid.amount], ['online', 'success', 120]);
  // Accepted: on the till's bill as paid; the cashier closes it with it.
  var acc = await online.accept(tok.kojo, mine.id, {});
  var tab = (await pos.tabRows(company.id, ' AND t.id = $2', [acc.tab.id]))[0];
  assert.deepEqual(tab.paidAtTable.map(function (p) { return [p.kind, p.amount, p.payer]; }), [['online', 120, 'Zqel Abena']]);
  var sale = await pos.createOrder(tok.ama, Object.assign(chargeOf(tab), { payments: [{ paystackRef: ref }] }));
  assert.ok(sale.order || sale.id || sale.orderNo);
  assert.equal((await pool.query('SELECT status FROM restaurant_online_orders WHERE id = $1', [mine.id])).rows[0].status, 'done');

  // Paid by Paystack's webhook (the customer did not come back to the page).
  var w = await order({ name: 'Zqel Kofi', phone: '0200000982' }, '10.9.8.62');
  var wref = refOf(w.payUrl);
  state[wref].status = 'success';
  var raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: wref, status: 'success', amount: state[wref].amount, channel: 'mobile_money' } }));
  await paystack.webhook(raw, crypto.createHmac('sha512', config.paystack.secretKey).update(raw).digest('hex'));
  t = await online.track(w.token);
  assert.equal(t.status, 'pending');
  // Turned down: given back.
  var wid = (await pool.query("SELECT id FROM restaurant_online_orders WHERE company_id = $1 AND customer_name = 'Zqel Kofi'", [company.id])).rows[0].id;
  var r = await online.reject(tok.kojo, wid, { reason: 'Zqel: out of jollof' });
  assert.deepEqual([r.refund.status, r.order.paid.refund.status], ['pending', 'pending']);
  assert.equal(refunds.filter(function (x) { return x.transaction === wref; }).length, 1);
  t = await online.track(w.token);
  assert.deepEqual([t.status, t.paid.refund.status], ['rejected', 'pending']);

  // Cancelled by the customer once paid: given back; Paystack refusing: for a manager, by hand.
  var c = await order({ name: 'Zqel Yaa', phone: '0200000983' }, '10.9.8.63');
  var cref = refOf(c.payUrl);
  await paid(cref);
  refuseRefund[cref] = true;
  t = await online.cancel(c.token);
  assert.equal(t.status, 'cancelled');
  assert.equal(t.paid.refund.status, 'failed');
  board = await delivery.board(tok.kojo);
  var gone = board.turnedDown.find(function (o) { return o.ref === c.ref; });
  assert.match(gone.paid.refund.note, /Give it back by hand/);

  // Never paid: another try, then cancelled after half an hour; not in the turned-down list.
  var n = await order({ name: 'Zqel Esi', phone: '0200000984' }, '10.9.8.64');
  var again = await online.payAgain(n.token);
  assert.notEqual(again.url, n.payUrl);
  await pool.query("UPDATE restaurant_online_orders SET updated_at = now() - interval '31 minutes' WHERE company_id = $1 AND customer_name = 'Zqel Esi'", [company.id]);
  assert.ok(await online.sweepUnpaid() >= 1);
  t = await online.track(n.token);
  assert.equal(t.status, 'cancelled');
  board = await delivery.board(tok.kojo);
  assert.ok(!board.turnedDown.some(function (o) { return o.ref === n.ref; }), 'never paid: not the restaurant\'s to see');
  await assert.rejects(online.payAgain(n.token), /cancelled/);

  // A delivery paid online: the rider collects nothing.
  var d = await order({ name: 'Zqel Kwame', phone: '0200000985', fulfillment: 'delivery', address: 'Zqel lane 4', lat: 5.61, lng: -0.19 }, '10.9.8.65');
  await paid(refOf(d.payUrl));
  await online.track(d.token);
  var did = (await pool.query("SELECT id FROM restaurant_online_orders WHERE company_id = $1 AND customer_name = 'Zqel Kwame'", [company.id])).rows[0].id;
  var dacc = await online.accept(tok.kojo, did, {});
  var sentOut = await delivery.send(tok.kojo, { tabId: dacc.tab.id, rider: { name: 'Zqel Rider', phone: '0200000989', vehicle: 'motorbike' } });
  assert.equal((sentOut.delivery || sentOut).toCollect, 0);
});

test('booking deposits: big parties pay on the website; taken off the bill at their table; kept on a no-show; given back when cancelled in time', async function () {
  bookings._askedBy.clear();
  await settings({ card: { paystack: true }, bookings: { online: true, autoConfirm: true, from: '12:00', to: '21:00', days: [], step: 30, perSlot: 6, maxParty: 20, daysAhead: 30, minutes: 120,
    deposit: { on: true, fromParty: 6, perGuest: 50, refundHours: 24 } } });
  var opts = await bookings.onlineOptions('ZQEL', { date: day(3) });
  assert.deepEqual(opts.deposit, { fromParty: 6, perGuest: 50, refundHours: 24 });
  var book = function (party, date, time, name, phone, ip) { return bookings.onlineBook('ZQEL', { name: name, phone: phone, party: party, date: date, time: time }, ip || IP); };

  // Small: no deposit, booked and texted at once.
  var small = await book(4, day(3), '13:00', 'Zqel Small Party', '0200000991');
  assert.equal(small.deposit, null);
  assert.equal(small.payUrl, undefined);
  // Big: a deposit to pay, nothing texted until it is.
  var big = await book(8, day(3), '19:00', 'Zqel Big Party', '0200000992');
  assert.deepEqual([big.deposit.amount, big.deposit.status], [400, 'due']);
  assert.ok(big.payUrl && big.deposit.payBy && big.deposit.refundUntil);
  var row = (await pool.query("SELECT * FROM restaurant_bookings WHERE token = $1", [big.token])).rows[0];
  assert.deepEqual(row.texted, []);
  await paid(refOf(big.payUrl));
  var mine = await bookings.onlineMine(big.token);
  assert.equal(mine.deposit.status, 'paid');
  row = (await pool.query("SELECT * FROM restaurant_bookings WHERE token = $1", [big.token])).rows[0];
  assert.equal(row.texted[0].what, 'confirmed', 'texted once paid');

  // Seated at their table: the deposit is on the bill; used, it is applied.
  await bookings.act(tok.kojo, row.id, 'seat', { tableId: t1 });
  var tab = await pos.saveTab(tok.ama, { tableId: t1, items: [{ menuItemId: rice, qty: 8 }] });
  tab = (await pos.tabRows(company.id, ' AND t.id = $2', [tab.id]))[0];
  var dep = tab.paidAtTable.find(function (p) { return p.kind === 'deposit'; });
  assert.deepEqual([dep.amount, dep.payer], [400, 'Zqel Big Party']);
  await pos.createOrder(tok.ama, Object.assign(chargeOf(tab), { payments: [{ paystackRef: dep.ref, amount: 400 }, { method: 'cash', amount: 80 }] }));
  assert.equal((await pool.query('SELECT deposit_status FROM restaurant_bookings WHERE id = $1', [row.id])).rows[0].deposit_status, 'applied');

  // A no-show keeps it (undone, it is theirs again); cancelled by the restaurant, given back.
  var ns = await book(6, day(4), '19:00', 'Zqel No Show', '0200000993', '10.9.8.66');
  await paid(refOf(ns.payUrl));
  await bookings.onlineMine(ns.token);
  var nsId = (await pool.query('SELECT id FROM restaurant_bookings WHERE token = $1', [ns.token])).rows[0].id;
  var r = await bookings.act(tok.kojo, nsId, 'noShow', {});
  assert.equal(r.booking.deposit.status, 'kept');
  r = await bookings.act(tok.kojo, nsId, 'undo', {});
  assert.equal(r.booking.deposit.status, 'paid');
  r = await bookings.act(tok.kojo, nsId, 'cancel', {});
  assert.deepEqual([r.booking.deposit.status, r.refund.status], ['refunded', 'pending']);

  // The guest cancels in time: given back; too late: kept.
  var early = await book(7, day(5), '19:00', 'Zqel Early Cancel', '0200000994', '10.9.8.67');
  await paid(refOf(early.payUrl));
  await bookings.onlineMine(early.token);
  var out = await bookings.onlineCancel(early.token);
  assert.deepEqual([out.status, out.deposit.status], ['cancelled', 'refunded']);
  var late = await book(6, day(1), '20:00', 'Zqel Late Cancel', '0200000995', '10.9.8.68');
  await paid(refOf(late.payUrl));
  await bookings.onlineMine(late.token);
  await pool.query("UPDATE restaurant_till_settings SET settings = jsonb_set(settings, '{bookings,deposit,refundHours}', '48') WHERE company_id = $1", [company.id]);
  out = await bookings.onlineCancel(late.token);
  assert.deepEqual([out.status, out.deposit.status], ['cancelled', 'kept']);

  // Never paid: cancelled after half an hour, its time free again.
  var never = await book(9, day(6), '19:00', 'Zqel Never Paid', '0200000996', '10.9.8.69');
  var again = await bookings.payDeposit(never.token);
  assert.ok(again.url);
  await pool.query("UPDATE restaurant_bookings SET updated_at = now() - interval '31 minutes' WHERE token = $1", [never.token]);
  assert.ok(await bookings.sweepDeposits() >= 1);
  out = await bookings.onlineMine(never.token);
  assert.deepEqual([out.status, out.deposit], ['cancelled', null]);
  await assert.rejects(bookings.payDeposit(never.token), /no deposit to pay|cancelled/);
});
