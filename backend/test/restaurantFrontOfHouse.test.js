// The guests' side of the till (migrations 0171–0173): bookings and the
// waitlist (on the till and asked for on the website), the customer's
// screen and tips, "your food is ready" texts to pickup customers, loyalty
// points and rewards, and gift cards. Fake Zqv data only; no texts go out
// (the server has no SMS here: the till is handed WhatsApp links).
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var money = require('../src/services/restaurantTillMoney.service');
var kitchen = require('../src/services/restaurantKitchen.service');
var delivery = require('../src/services/restaurantDelivery.service');
var bookings = require('../src/services/restaurantBookings.service');
var displays = require('../src/services/restaurantDisplays.service');
var loyalty = require('../src/services/restaurantLoyalty.service');
var gifts = require('../src/services/restaurantGiftCards.service');
var accounts = require('../src/services/restaurantCustomerAccounts.service');
var sales = require('../src/services/restaurantTillSales.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7581', kojo: '7582', yaw: '7583' };
var IP = '10.9.7.1';
var DEVICE = 'zqv-till-device-0001';
var company, people = {}, tok = {}, rice, juice, t1, t2, guest, station;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQV'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_bookings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_displays WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_loyalty_entries WHERE company_id = ANY($1)', 'DELETE FROM restaurant_gift_card_entries WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_refund_items WHERE refund_id IN (SELECT id FROM restaurant_refunds WHERE company_id = ANY($1))', 'DELETE FROM restaurant_refunds WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_payments WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_gift_cards WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_tables WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_guests WHERE company_id = ANY($1)', 'DELETE FROM restaurant_delivery_settings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM restaurant_displays WHERE company_id IS NULL AND ip = '10.9.7.1'");
  await pool.query("DELETE FROM restaurant_customer_accounts WHERE phone = '233200000851'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQV-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqv', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
async function settings(s) { await access.saveSettings(tok.kojo, { settings: s }, IP); }
function cash(total) { return [{ method: 'cash', currency: 'GHS', tendered: total }]; }
function day(offset) { return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10); }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQV', 'Zqv Kitchen') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQVF', 'Zqv Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQV-1', 'Ama', dept);
  await person('kojo', 'ZQV-2', 'Kojo', dept);
  await person('yaw', 'ZQV-3', 'Yaw', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'waiter')", [company.id, people.kojo, people.yaw]);
  rice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqv jollof', 'Zqv Mains', 50, true) RETURNING id", [company.id])).rows[0].id;
  juice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqv sobolo', 'Zqv Drinks', 20, true) RETURNING id", [company.id])).rows[0].id;
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name, seats) VALUES ($1, 'Zqv T1', 4) RETURNING id", [company.id])).rows[0].id;
  t2 = (await pool.query("INSERT INTO restaurant_tables (company_id, name, seats) VALUES ($1, 'Zqv T2', 2) RETURNING id", [company.id])).rows[0].id;
  guest = (await pool.query("INSERT INTO restaurant_guests (company_id, name, phone, source) VALUES ($1, 'Zqv Abena', '0200000851', 'till') RETURNING id", [company.id])).rows[0].id;
  station = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zqv Kitchen', '{}', true) RETURNING id", [company.id])).rows[0].id;
  for (var k of ['ama', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
  await delivery.settings(tok.kojo, { settings: { open: true, location: { lat: 5.6, lng: -0.18, address: 'Zqv Road' }, phone: '0200000850', fee: { base: 10, perKm: 3 }, maxKm: 12, readyMinutes: 20 } }, IP);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('bookings on the till: a table kept for its time, the waitlist called and seated', async function () {
  var at = new Date(Date.now() + 3 * 3600000);
  var b = await bookings.save(tok.ama, { name: 'Zqv Kwame', phone: '0200000852', party: 4, at: at.toISOString(), tableId: t1, note: 'Zqv birthday' });
  assert.equal(b.status, 'booked');
  assert.equal(b.tableName, 'Zqv T1');
  assert.equal(b.minutes, 90);
  // The same table an hour later overlaps; another table does not.
  await assert.rejects(bookings.save(tok.ama, { name: 'Zqv Efua', party: 2, at: new Date(at.getTime() + 3600000).toISOString(), tableId: t1 }), /Zqv T1 is booked for Zqv Kwame/);
  var other = await bookings.save(tok.ama, { name: 'Zqv Efua', party: 2, at: new Date(at.getTime() + 3600000).toISOString(), tableId: t2 });
  await assert.rejects(bookings.save(tok.ama, { name: 'Z', party: 2, at: at.toISOString() }), /guest's name/);
  // A waiter may take bookings; nobody without the right may.
  assert.ok((await bookings.save(tok.yaw, { kind: 'waitlist', name: 'Zqv Kofi', phone: '0200000853', party: 3, quotedMinutes: 20 })).id);
  var list = await bookings.list(tok.ama, { day: at.toISOString().slice(0, 10) });
  assert.ok(list.bookings.some(function (x) { return x.id === b.id; }));
  assert.equal(list.waitlist.length, 1);
  assert.equal(list.waitlist[0].quotedMinutes, 20);
  assert.equal(list.smsOn, false);
  // Called: no SMS on this server, so the till gets a WhatsApp link with the words.
  var called = await bookings.act(tok.ama, list.waitlist[0].id, 'call', {});
  assert.equal(called.booking.status, 'called');
  assert.match(called.text.whatsapp, /^https:\/\/wa\.me\/233200000853\?text=/);
  assert.match(decodeURIComponent(called.text.whatsapp), /your table is ready/);
  var seated = await bookings.act(tok.ama, list.waitlist[0].id, 'seat', { tableId: t2 });
  assert.equal(seated.booking.status, 'seated');
  assert.equal(seated.booking.tableName, 'Zqv T2');
  await assert.rejects(bookings.act(tok.ama, list.waitlist[0].id, 'call', {}), /not waiting now/);
  var undone = await bookings.act(tok.ama, list.waitlist[0].id, 'undo', {});
  assert.equal(undone.booking.status, 'waiting');
  assert.equal((await bookings.act(tok.ama, other.id, 'noShow', {})).booking.status, 'no_show');
  // The floor map: T1 kept for Zqv Kwame later today, if it is still today.
  var soon = await bookings.soon(tok.ama);
  assert.equal(soon.waiting, 1);
  if (at.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) assert.equal(soon.tables[t1].name, 'Zqv Kwame');
  // The activity report says who did it.
  var acts = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action LIKE 'till.booking%' ORDER BY at", [company.id])).rows.map(function (r) { return r.summary; });
  assert.ok(acts.some(function (s) { return /Booked a table for Zqv Kwame \(4\)/.test(s); }));
});

test('bookings on the website: asked for, confirmed on the till, seen and cancelled by the guest', async function () {
  bookings._askedBy.clear();
  assert.equal((await bookings.onlineOptions('ZQV', {})).on, false);
  await assert.rejects(bookings.onlineBook('ZQV', { name: 'Zqv Ama', phone: '0200000854', party: 2, date: day(1), time: '19:00' }, IP), /does not take bookings on the website/);
  await assert.rejects(settings({ bookings: { online: true, from: '21:00', to: '12:00', step: 30, perSlot: 1, maxParty: 6, daysAhead: 14, minutes: 90 } }), /first before the last/);
  await settings({ bookings: { online: true, autoConfirm: false, from: '12:00', to: '21:00', days: [], step: 30, perSlot: 1, maxParty: 6, daysAhead: 14, minutes: 90 } });
  var opts = await bookings.onlineOptions('ZQV', { date: day(2) });
  assert.equal(opts.on, true);
  assert.equal(opts.date, day(2));
  assert.equal(opts.slots[0].time, '12:00');
  assert.equal(opts.slots[opts.slots.length - 1].time, '21:00');
  await assert.rejects(bookings.onlineBook('ZQV', { name: 'Zqv Ama', phone: '0200000854', party: 8, date: day(2), time: '19:00' }, IP), /1 to 6 people/);
  await assert.rejects(bookings.onlineBook('ZQV', { name: 'Zqv Ama', phone: '0200000854', party: 2, date: day(2), time: '19:10' }, IP), /not one the restaurant offers/);
  var asked = await bookings.onlineBook('ZQV', { name: 'Zqv Ama', phone: '0200000854', party: 2, date: day(2), time: '19:00', note: 'Zqv window' }, IP);
  assert.equal(asked.status, 'requested');
  assert.ok(asked.token);
  assert.match(asked.link, /\/b\//);
  // One a time (perSlot 1): that time is full now.
  assert.equal((await bookings.onlineOptions('ZQV', { date: day(2) })).slots.find(function (s) { return s.time === '19:00'; }).full, true);
  await assert.rejects(bookings.onlineBook('ZQV', { name: 'Zqv Esi', phone: '0200000855', party: 2, date: day(2), time: '19:00' }, IP), /fully booked/);
  // The till answers.
  var reqs = (await bookings.list(tok.ama, {})).requests;
  assert.equal(reqs.length, 1);
  var ok = await bookings.act(tok.ama, reqs[0].id, 'confirm', { tableId: t2 });
  assert.equal(ok.booking.status, 'booked');
  assert.match(decodeURIComponent(ok.text.whatsapp), /is booked\. See or cancel it: .*\/b\//);
  var mine = await bookings.onlineMine(asked.token);
  assert.equal(mine.status, 'booked');
  assert.equal(mine.canCancel, true);
  assert.equal((await bookings.onlineCancel(asked.token)).status, 'cancelled');
  await assert.rejects(bookings.onlineCancel(asked.token), /can no longer be cancelled/);
  await assert.rejects(bookings.onlineMine('not-a-real-token-at-all'), /not right/);
});

test('the customer screen: paired with its code, shows the order, takes the tip the till reads', async function () {
  displays._made.clear();
  var hi = await displays.hello(null, IP, 'zqv test');
  assert.equal(hi.paired, false);
  assert.match(hi.code, /^\d{6}$/);
  assert.equal((await displays.hello(hi.key, IP)).code, hi.code);
  await assert.rejects(displays.pair(tok.ama, { code: '000000', device: DEVICE }), /No customer screen shows that code/);
  var paired = await displays.pair(tok.ama, { code: hi.code, device: DEVICE, name: 'Zqv counter' });
  assert.equal(paired.displays.length, 1);
  assert.equal(paired.displays[0].name, 'Zqv counter');
  var v = await displays.view(hi.key);
  assert.equal(v.paired, true);
  assert.equal(v.restaurant.name, 'Zqv Kitchen');
  assert.equal(v.state.phase, 'idle');
  // The order as it is rung up.
  await displays.push(tok.ama, { device: DEVICE, state: { phase: 'order', ref: 'r1', lines: [{ name: 'Zqv jollof', qty: 2, amount: 100 }], totals: { items: 100, total: 100, taxes: [] } } });
  v = await displays.view(hi.key);
  assert.equal(v.state.lines[0].name, 'Zqv jollof');
  assert.equal(v.state.totals.total, 100);
  // Tips: off, the customer cannot choose one.
  await displays.push(tok.ama, { device: DEVICE, state: { phase: 'pay', ref: 'r1', totals: { total: 100 }, tip: { ask: true, base: 100, percents: [10] } } });
  await assert.rejects(displays.chooseTip(hi.key, { ref: 'r1', percent: 10 }), /Tips are not taken here/);
  await settings({ tips: { on: true, percents: [5, 10, 15] } });
  await assert.rejects(displays.chooseTip(hi.key, { ref: 'r0', percent: 10 }), /The bill has changed/);
  await assert.rejects(displays.chooseTip(hi.key, { ref: 'r1', percent: 12 }), /one of the tips shown/);
  var chose = await displays.chooseTip(hi.key, { ref: 'r1', percent: 10 });
  assert.equal(chose.tipChosen.amount, 10);
  assert.equal((await displays.tipFor(tok.ama, DEVICE, 'r1')).tip.amount, 10);
  // Still paying for r1: the tip stays; a new order forgets it.
  assert.equal((await displays.push(tok.ama, { device: DEVICE, state: { phase: 'pay', ref: 'r1', tip: { ask: true, base: 100, percents: [10] } } })).tip.amount, 10);
  await displays.push(tok.ama, { device: DEVICE, state: { phase: 'order', ref: 'r2' } });
  assert.equal((await displays.tipFor(tok.ama, DEVICE, 'r1')).tip, null);
  // Taken off: the screen asks again for a code.
  await displays.unpair(tok.ama, paired.displays[0].id);
  await assert.rejects(displays.view(hi.key), /taken off the till/);
  await assert.rejects(displays.mine(tok.ama, 'x'), /no device id/);
});

test('tips: on top of the bill, in the drawer, not in the sales; never on an IOU', async function () {
  await settings({ tips: { on: true, percents: [5, 10, 15] } });
  // The till is told, to ask for one.
  assert.deepEqual((await access.profile(tok.ama)).settings.tips, { on: true, percents: [5, 10, 15] });
  var before = (await pos.getOpenDrawerSession(tok.ama)).expected;
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqv Esi', customerPhone: '0200000856', items: [{ menuItemId: rice, qty: 1 }], tip: 5, payments: cash(50) }),
    /cash received is less than the total/);
  var s = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', waiterId: people.yaw, items: [{ menuItemId: rice, qty: 2 }], tip: 10, payments: cash(120) });
  assert.equal(s.total, 100);
  assert.equal(s.tip, 10);
  assert.equal(s.change, 10);
  assert.equal(round2((await pos.getOpenDrawerSession(tok.ama)).expected - before), 110);
  var r = await sales.report(company.id, { range: 'today' });
  assert.equal(r.totals.tips, 10);
  assert.equal(r.tipsBy[0].name, 'Yaw Zqv');
  assert.equal(r.byMethod.find(function (m) { return m.method === 'cash'; }).amount, 100);
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqv Esi', customerPhone: '0200000856', items: [{ menuItemId: rice, qty: 1 }], tip: 500, payments: cash(550) }), /up to the bill/);
  await settings({ tips: { on: false, percents: [10] } });
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqv Esi', customerPhone: '0200000856', items: [{ menuItemId: rice, qty: 1 }], tip: 5, payments: cash(55) }), /Tips are turned off/);
});
function round2(n) { return Math.round(n * 100) / 100; }

test('ready texts: a pickup customer is told once, when all of their order is ready', async function () {
  await settings({ readyText: { on: true, message: 'Hi {name}, your order {number} at {restaurant} is ready.' } });
  var s = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Esi Zqv Mensah', customerPhone: '0200000856', items: [{ menuItemId: rice, qty: 1 }], payments: cash(50) });
  var t = (await pool.query('SELECT * FROM restaurant_kitchen_tickets WHERE order_id = $1', [s.id])).rows[0];
  var kds = tok.kojo; // a manager may use the kitchen's side too
  var done = await kitchen.finishTicket(kds, t.id, 'all');
  assert.equal(done.status, 'ready');
  assert.equal(done.readyText.channel, 'whatsapp');
  assert.match(decodeURIComponent(done.readyText.url), /Hi Esi, your order #\d+ at Zqv Kitchen is ready\./);
  // Once: back to cooking and ready again sends nothing more.
  var item = (await pool.query('SELECT id FROM restaurant_kitchen_items WHERE ticket_id = $1', [t.id])).rows[0];
  await kitchen.setItemDone(kds, item.id, false);
  var again = await kitchen.setItemDone(kds, item.id, true);
  assert.equal(again.readyText, null);
  // The till shows it beside the ready ticket.
  var board = await kitchen.tillSummary(tok.ama);
  assert.equal(board.ready.find(function (x) { return x.id === t.id; }).readyText.channel, 'whatsapp');
  // A table's order is not texted.
  var d = await pos.createOrder(tok.ama, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1 }], payments: cash(50) });
  var dt = (await pool.query('SELECT id FROM restaurant_kitchen_tickets WHERE order_id = $1', [d.id])).rows[0];
  assert.equal((await kitchen.finishTicket(kds, dt.id, 'all')).readyText, null);
});

test('loyalty: points earned on what is paid, spent on a reward, taken back on a refund', async function () {
  await assert.rejects(settings({ loyalty: { on: true, spend: 10, rewards: [] } }), /at least one reward/);
  await settings({ loyalty: { on: true, spend: 10, rewards: [{ name: 'Zqv GHS 10 off', points: 15, kind: 'amount', value: 10 }, { name: 'Zqv free drink', points: 100, kind: 'amount', value: 20 }] } });
  assert.equal((await access.profile(tok.ama)).settings.loyalty.rewards.length, 2);
  var s1 = await pos.createOrder(tok.ama, { tableId: t1, guestId: guest, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 2 }], payments: cash(100) });
  assert.equal(s1.points.earned, 10);
  assert.equal(s1.points.balance, 10);
  // A pickup with the customer's phone earns too, without picking them.
  var s2 = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqv Abena', customerPhone: '+233 20 000 0851', items: [{ menuItemId: rice, qty: 1 }, { menuItemId: juice, qty: 1 }], payments: cash(70) });
  assert.equal(s2.points.earned, 7);
  var mine = await loyalty.ofGuest(tok.ama, guest);
  assert.equal(mine.balance, 17);
  var reward = mine.rewards.find(function (r) { return r.name === 'Zqv GHS 10 off'; });
  assert.equal(reward.can, true);
  assert.equal(mine.rewards.find(function (r) { return r.name === 'Zqv free drink'; }).can, false);
  // The reward on the bill: 10 off, 15 points taken, points earned on what is paid.
  await assert.rejects(pos.createOrder(tok.ama, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1 }], adjust: { discount: { presetId: reward.presetId } }, payments: cash(40) }), /pick the customer first/);
  var s3 = await pos.createOrder(tok.ama, { tableId: t2, guestId: guest, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1 }], adjust: { discount: { presetId: reward.presetId } }, payments: cash(40) });
  assert.equal(s3.total, 40);
  assert.equal(s3.points.used, 15);
  assert.equal(s3.points.earned, 4);
  assert.equal(s3.points.balance, 6);
  await assert.rejects(pos.createOrder(tok.ama, { tableId: t2, guestId: guest, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1 }], adjust: { discount: { presetId: reward.presetId } }, payments: cash(40) }),
    /has 6 points; Zqv GHS 10 off takes 15/);
  // Not on one dish.
  await assert.rejects(pos.createOrder(tok.ama, { tableId: t2, guestId: guest, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1, discount: { presetId: reward.presetId } }], payments: cash(40) }), /goes on the whole bill/);
  // A refund of half of the first sale takes back half its points.
  var line = (await money.saleForRefund(tok.ama, s1.id)).items[0];
  await money.refundSale(tok.ama, s1.id, { items: [{ id: line.id, qty: 1 }], reason: 'Zqv cold', method: 'cash', managerPin: PINS.kojo }, IP);
  assert.equal((await loyalty.ofGuest(tok.ama, guest)).balance, 1);
  // The back office, and the customer's own website account (by their phone).
  var rep = await loyalty.report(company.id, {});
  assert.equal(rep.totals.members, 1);
  assert.equal(rep.totals.given, 21);
  assert.equal(rep.totals.spent, 15);
  assert.equal(rep.rewards[0].name, 'Zqv GHS 10 off');
  accounts._tries.clear();
  var acct = await accounts.signup({ name: 'Zqv Abena', phone: '020 000 0851', password: 'zqv-points-1' }, '10.9.7.2');
  var me = await accounts.me(acct.token);
  assert.equal(me.points.find(function (p) { return p.restaurant.code === 'ZQV'; }).points, 1);
  await assert.rejects(loyalty.adjust(company.id, people.kojo, guest, { points: -5, note: 'Zqv test' }), /has 1 points/);
  assert.equal((await loyalty.adjust(company.id, people.kojo, guest, { points: 50, note: 'Zqv welcome' })).balance, 51);
});

test('gift cards: sold into the drawer, spent as a way of paying, refunded and cancelled', async function () {
  await assert.rejects(gifts.sell(tok.ama, { amount: 100, method: 'cash' }), /turned off/);
  await settings({ giftCards: { on: true, amounts: [50, 100] } });
  assert.equal((await access.profile(tok.ama)).settings.giftCards.on, true);
  await assert.rejects(gifts.sell(tok.yaw, { amount: 100, method: 'cash' }), /cannot sell gift cards/);
  var before = (await pos.getOpenDrawerSession(tok.ama)).expected;
  var card = await gifts.sell(tok.ama, { amount: 100, method: 'cash', toName: 'Zqv Akosua', toPhone: '0200000857', fromName: 'Zqv Kofi', message: 'Zqv happy birthday' });
  assert.match(card.code, /^[1-9]\d{15}$/);
  assert.equal(card.balance, 100);
  assert.match(card.link, /\/g\//);
  var drawer = await pos.getOpenDrawerSession(tok.ama);
  assert.equal(round2(drawer.expected - before), 100);
  assert.equal(drawer.giftSoldCash, 100);
  assert.ok(drawer.movements.some(function (m) { return m.account === 'gift' && m.amount === 100; }));
  // Its page, for whoever has the link; and the till finds it by its number.
  var page = await gifts.publicCard(card.link.split('/g/')[1]);
  assert.equal(page.balance, 100);
  assert.equal(page.fromName, 'Zqv Kofi');
  assert.equal((await gifts.lookup(tok.ama, card.codeWords)).id, card.id);
  var sent = await gifts.send(tok.ama, card.id, { channel: 'whatsapp' });
  assert.match(sent.url, /^https:\/\/wa\.me\/233200000857/);
  // Paid with the card and cash; the card cannot pay more than it has.
  var sale = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 3 }],
    payments: [{ method: 'gift_card', code: card.code, amount: 100 }, { method: 'cash', currency: 'GHS', amount: 50, tendered: 50 }] });
  assert.equal(sale.total, 150);
  assert.equal(sale.giftCards[0].left, 0);
  assert.equal(sale.payments[0].giftCard, card.code.slice(-4));
  await assert.rejects(pos.createOrder(tok.ama, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1 }], payments: [{ method: 'gift_card', code: card.code, amount: 50 }] }), /has 0\.00 left/);
  await assert.rejects(pos.createOrder(tok.ama, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1 }], payments: [{ method: 'gift_card', code: '1234', amount: 50 }] }), /16-digit number/);
  // A refund goes back on the card.
  var line = (await money.saleForRefund(tok.ama, sale.id)).items[0];
  assert.ok((await money.saleForRefund(tok.ama, sale.id)).methods.indexOf('gift_card') >= 0);
  await money.refundSale(tok.ama, sale.id, { items: [{ id: line.id, qty: 1 }], reason: 'Zqv spilt', method: 'gift_card', managerPin: PINS.kojo }, IP);
  assert.equal((await gifts.lookup(tok.ama, card.code)).balance, 50);
  // Cancelled by a manager: what is left given back in cash.
  await assert.rejects(gifts.voidCard(tok.ama, card.id, { reason: 'Zqv wrong amount', managerPin: PINS.yaw }, IP), /cannot approve/);
  var gone = await gifts.voidCard(tok.ama, card.id, { reason: 'Zqv wrong amount', managerPin: PINS.kojo }, IP);
  assert.equal(gone.status, 'void');
  assert.equal(gone.balance, 0);
  assert.equal((await pos.getOpenDrawerSession(tok.ama)).giftVoidedCash, 50);
  var rep = await gifts.report(company.id, {});
  assert.equal(rep.totals.sold, 100);
  assert.equal(rep.totals.spent, 50);
  assert.equal(rep.totals.voided, 50);
  assert.equal(rep.totals.outstanding, 0);
});

test('downloads in Square\'s layouts: the item library and the item sales', async function () {
  var exp = require('../src/services/restaurantSquareExport.service');
  var ExcelJS = require('exceljs');
  await pool.query("UPDATE restaurant_menu_items SET sku = 'ZQV-001', description = 'Zqv smoky rice', item_type = 'Prepared food and beverage', contains_alcohol = false WHERE id = $1", [rice]);
  await pool.query("INSERT INTO restaurant_menu_item_variations (menu_item_id, name, price, sort_order, sku) VALUES ($1, 'Zqv small', 15, 0, 'ZQV-S'), ($1, 'Zqv large', 25, 1, 'ZQV-L')", [juice]);
  var rows = await exp.catalogRows([company.id]);
  var head = rows[0];
  assert.deepEqual(head.slice(0, 29), exp.CATALOG_HEAD);
  assert.deepEqual(head.slice(29, 35), ['Enabled Zqv Kitchen', 'Current Quantity Zqv Kitchen', 'New Quantity Zqv Kitchen', 'Stock Alert Enabled Zqv Kitchen', 'Stock Alert Count Zqv Kitchen', 'Price Zqv Kitchen']);
  var riceRow = rows.find(function (r) { return r[2] === 'Zqv jollof'; });
  assert.equal(riceRow[0], '#zqv-jollof');
  assert.equal(riceRow[4], 'Regular');
  assert.equal(riceRow[6], 'ZQV-001');
  assert.equal(riceRow[11], 'Prepared food and beverage');
  assert.equal(riceRow[15], 50);
  assert.equal(riceRow[19], 'N');
  assert.equal(riceRow[29], 'Y');
  var sizes = rows.filter(function (r) { return r[2] === 'Zqv sobolo'; });
  assert.deepEqual(sizes.map(function (r) { return [r[0], r[4], r[6], r[15], r[22]]; }), [['#zqv-sobolo-zqv-small', 'Zqv small', 'ZQV-S', 15, 'N'], ['#zqv-sobolo-zqv-large', 'Zqv large', 'ZQV-L', 25, 'N']]);
  // The .xlsx: Square's three sheets, the header on the second row of Items.
  var file = await exp.catalogFile([company.id]);
  assert.match(file.filename, /^ZQV_catalog-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/);
  var wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(file.data, 'base64'));
  assert.deepEqual(wb.worksheets.map(function (w) { return w.name; }), ['Items', 'Unit and Precision', 'Component Inventory']);
  assert.equal(wb.getWorksheet('Items').getRow(2).getCell(1).value, 'Reference Handle');
  assert.equal(wb.getWorksheet('Items').getRow(1).getCell(1).value, null);
  // The item sales: Square's 29 columns, a row a dish sold, a refund in minus.
  var sales = await exp.itemSalesRows([company.id], { from: day(-1), to: day(0) });
  assert.deepEqual(sales.rows[0], ['Date', 'Time', 'Time Zone', 'Category', 'Item', 'Qty', 'Price Point Name', 'SKU', 'Modifiers Applied', 'Gross Sales', 'Discounts', 'Net Sales', 'Tax',
    'Transaction ID', 'Payment ID', 'Device Name', 'Notes', 'Details', 'Event Type', 'Location', 'Dining Option', 'Unit', 'Count', 'Itemization Type',
    'Fulfillment Note', 'Channel', 'Token', 'Card Brand', 'PAN Suffix']);
  var pay = sales.rows.find(function (r) { return r[18] === 'Payment' && r[4] === 'Zqv jollof' && r[5] === '2.0'; });
  assert.ok(pay);
  assert.equal(pay[2], 'UTC');
  assert.equal(pay[3], 'Zqv Mains');
  assert.equal(pay[9], '₵100.00');
  assert.equal(pay[19], 'Zqv Kitchen');
  assert.equal(pay[21], 'ea');
  assert.equal(pay[23], 'Prepared Food and Beverage');
  assert.match(pay[17], /\/receipt\//);
  var refund = sales.rows.find(function (r) { return r[18] === 'Refund'; });
  assert.equal(refund[5], '-1.0');
  assert.match(refund[11], /^-₵/);
  // Newest first.
  assert.ok(sales.rows[1][0] + sales.rows[1][1] >= sales.rows[sales.rows.length - 1][0] + sales.rows[sales.rows.length - 1][1]);
  // The .csv: UTF-16 with its byte-order mark, tab-separated, empty text as "".
  var csvFile = await exp.itemSalesFile([company.id], { from: day(-1), to: day(0) });
  var buf = Buffer.from(csvFile.data, 'base64');
  assert.deepEqual([buf[0], buf[1]], [0xff, 0xfe]);
  var lines = buf.slice(2).toString('utf16le').split('\n');
  assert.equal(lines[0].split('\t').length, 29);
  assert.match(lines[1], /\t""\t/);
  assert.equal(csvFile.filename, 'ZQV-items-' + day(-1) + '-' + day(1) + '.csv');
  await assert.rejects(exp.itemSalesRows([company.id], { from: '2024-01-01', to: '2026-01-01' }), /at most a year/);
});

test('the menu keeps Square\'s catalog fields; the website says when it takes bookings', async function () {
  var list = await access.menu(tok.kojo, { action: 'list' }, IP);
  var item = list.items.find(function (i) { return i.id === juice; });
  assert.deepEqual(item.variations.map(function (v) { return v.sku; }), ['ZQV-S', 'ZQV-L']);
  // A size's SKU changed, another left as it was (not sent), a new size without one.
  var vars = [Object.assign({}, item.variations[0], { sku: 'ZQV-S2' }), { id: item.variations[1].id, name: item.variations[1].name, price: item.variations[1].price }, { name: 'Zqv jug', price: 60 }];
  var after = await access.menu(tok.kojo, { action: 'save', item: Object.assign({}, item, { sku: 'ZQV-002', description: 'Zqv hibiscus', itemType: 'Prepared food and beverage', containsAlcohol: false, variations: vars }) }, IP);
  var saved = after.items.find(function (i) { return i.id === juice; });
  assert.equal(saved.sku, 'ZQV-002');
  assert.equal(saved.description, 'Zqv hibiscus');
  assert.equal(saved.containsAlcohol, false);
  assert.deepEqual(saved.variations.map(function (v) { return [v.name, v.sku]; }), [['Zqv small', 'ZQV-S2'], ['Zqv large', 'ZQV-L'], ['Zqv jug', '']]);
  await assert.rejects(access.menu(tok.kojo, { action: 'save', item: Object.assign({}, saved, { itemType: 'Zqv thing' }) }, IP), /item type from the list/);
  // The website's menu: tables are booked there (turned on above).
  var online = require('../src/services/restaurantOnline.service');
  assert.equal((await online.menu('ZQV')).restaurant.book, true);
  await settings({ bookings: { online: false, from: '12:00', to: '21:00', step: 30, perSlot: 1, maxParty: 6, daysAhead: 14, minutes: 90 } });
  assert.equal((await online.menu('ZQV')).restaurant.book, false);
});
