// The fourteenth batch on the restaurant side (migration 0195): the cash
// office (cash into the safe and petty cash out of the drawer, the safe
// banked and counted, the day's close); private events (asked for on the
// website, planned with a menu a head, a deposit, the guest's page, the
// prep list); menu boards (paired by a code, showing the categories chosen).
// Fake Zqft data.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var cash = require('../src/services/restaurantCashOffice.service');
var events = require('../src/services/restaurantEvents.service');
var boards = require('../src/services/restaurantMenuBoards.service');
var prep = require('../src/services/restaurantPrep.service');
var closeDay = require('../src/services/restaurantCloseDay.service');
var displays = require('../src/services/restaurantDisplays.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7781', kojo: '7782' };
var IP = '10.14.0.';
var co = {}, dept = null, people = {}, tok = {}, dish = {};
// A tiny real PNG (1×1), as the till sends a photo.
var PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQFT'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    await pool.query("DELETE FROM restaurant_displays WHERE company_id = ANY($1) OR (kind = 'menu' AND ip LIKE '10.14.%')", [cos]);
    for (var q of ['DELETE FROM restaurant_paystack_payments WHERE company_id = ANY($1)', 'DELETE FROM restaurant_events WHERE company_id = ANY($1)', 'DELETE FROM restaurant_safe_moves WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_more_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_close_days WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_delivery_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', 'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]).catch(function (e) { if (e.code !== '42P01') throw e; });
  }
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQFT-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQFT-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, role) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqft', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
  await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [co.id, people[key], role]);
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  co = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQFT', 'Zqft Terrace') RETURNING *")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQFTF', 'Zqft Floor', $1) RETURNING id", [co.id])).rows[0].id;
  await person('ama', 'ZQFT-1', 'Ama', 'cashier');
  await person('kojo', 'ZQFT-2', 'Kojo', 'manager');
  for (var d of [['jollof', 'Zqft jollof', 'Zqft Mains', 60], ['wings', 'Zqft wings', 'Zqft Grill', 45], ['juice', 'Zqft juice', 'Zqft Drinks', 20]]) {
    dish[d[0]] = (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active, online) VALUES ($1, $2, $3, $4, true, true) RETURNING id', [co.id, d[1], d[2], d[3]])).rows[0].id;
  }
  await pool.query('INSERT INTO restaurant_delivery_settings (company_id, settings) VALUES ($1, $2)', [co.id, JSON.stringify({ open: true, delivery: false, pickup: true, phone: '0200000777',
    location: { lat: 5.6, lng: -0.18, address: 'Zqft road' }, fee: { base: 0, perKm: 0, freeOver: 0 }, maxKm: 10 })]);
  for (var k of ['ama', 'kojo']) tok[k] = (await pos.login(PINS[k], IP + '1', 'till')).token;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the cash office: cash into the safe with a manager watching, petty cash with a receipt, the safe banked and counted, the day closed', async function () {
  await pos.openDrawerSession(tok.ama, 500);
  // Into the safe: a manager's PIN, and no more than the drawer holds.
  await assert.rejects(cash.drop(tok.ama, { amount: 300 }, IP + '2'), /manager watches cash go in the safe/);
  await assert.rejects(cash.drop(tok.ama, { amount: 600, managerPin: PINS.kojo }, IP + '2'), /should hold only 500\.00/);
  var r = await cash.drop(tok.ama, { amount: 300, managerPin: PINS.kojo, note: 'Zqft: evening drop' }, IP + '2');
  assert.deepEqual([r.drawer.safeDrops, r.drawer.expected, r.safe.balance], [300, 200, 300]);
  // Petty cash: what for and to whom; over the limit (100), a manager's PIN.
  await assert.rejects(cash.petty(tok.ama, { amount: 40, category: 'market', paidTo: '' }, IP + '2'), /Who was it paid to/);
  await assert.rejects(cash.petty(tok.ama, { amount: 40, category: 'shoes', paidTo: 'Zqft market' }, IP + '2'), /Pick what it was for/);
  r = await cash.petty(tok.ama, { amount: 40, category: 'market', paidTo: 'Zqft market', note: 'Zqft: tomatoes', photo: PNG }, IP + '2');
  assert.deepEqual([r.drawer.pettyCash, r.drawer.expected], [40, 160]);
  var mv = r.drawer.movements.find(function (m) { return m.kind === 'petty'; });
  assert.deepEqual([mv.category, mv.paidTo, mv.hasPhoto], ['market', 'Zqft market', true]);
  await assert.rejects(cash.petty(tok.ama, { amount: 120, category: 'gas', paidTo: 'Zqft gas man' }, IP + '2'), /a manager agrees to petty cash/);
  r = await cash.petty(tok.ama, { amount: 120, category: 'gas', paidTo: 'Zqft gas man', managerPin: PINS.kojo }, IP + '2');
  assert.deepEqual([r.drawer.pettyCash, r.drawer.expected, r.drawer.paidOut], [160, 40, 0]);
  await assert.rejects(cash.photoFrom('data:image/png;base64,aGVsbG8=', 'x'), /JPG, PNG or WebP/);
  var ph = await cash.photoOf(tok.ama, 'drawer', mv.id);
  assert.match(ph.name, /^receipt\.png$/);

  // The back office: the safe banked (no more than it holds), counted.
  var o = await cash.office(tok.kojo, { action: 'view' }, IP + '3');
  assert.deepEqual([o.safe.balance, o.petty.total, o.petty.noReceipt], [300, 160, 1]);
  assert.deepEqual(o.petty.byCategory, [{ category: 'market', amount: 40 }, { category: 'gas', amount: 120 }]);
  await assert.rejects(cash.office(tok.ama, { action: 'view' }, IP + '3'), /manager/);
  await assert.rejects(cash.office(tok.kojo, { action: 'deposit', amount: 400, bank: 'Zqft Bank' }, IP + '3'), /should hold only 300\.00/);
  await assert.rejects(cash.office(tok.kojo, { action: 'deposit', amount: 100, bank: '' }, IP + '3'), /Which bank/);
  o = await cash.office(tok.kojo, { action: 'deposit', amount: 250, bank: 'Zqft Bank', reference: 'ZQ-SLIP-1', photo: PNG }, IP + '3');
  assert.equal(o.safe.balance, 50);
  var dep = o.moves.find(function (m) { return m.kind === 'deposit'; });
  assert.deepEqual([dep.bank, dep.reference, dep.hasPhoto, dep.by], ['Zqft Bank', 'ZQ-SLIP-1', true, 'Kojo Zqft']);
  o = await cash.office(tok.kojo, { action: 'count', amount: 45 }, IP + '3');
  var count = o.moves.find(function (m) { return m.kind === 'count'; });
  assert.deepEqual([count.amount, count.expected, count.difference, o.safe.balance], [45, 50, -5, 45]);
  o = await cash.office(tok.kojo, { action: 'settings', pettyLimit: 200, safeLimit: 30, banks: ['Zqft Bank'] }, IP + '3');
  assert.deepEqual([o.settings.pettyLimit, o.settings.safeLimit, o.safe.over], [200, 30, true]);

  // The day's close says it.
  var s = await closeDay.summary(co.id, day(0));
  assert.deepEqual([s.cash.drops.amount, s.cash.petty.amount, s.cash.petty.noReceipt, s.cash.banked.amount, s.cash.safe], [300, 160, 1, 250, 45]);
  assert.match(closeDay._words(s, 'Kojo'), /Into the safe: GHS 300\.00[\s\S]*Petty cash: GHS 160\.00 \(1 without a receipt\)[\s\S]*Banked: GHS 250\.00[\s\S]*The safe should hold: GHS 45\.00/);
  // Counted at closing: what is left.
  var closed = await pos.closeDrawerSession(tok.ama, { actualCash: 40 });
  assert.deepEqual([closed.expected, closed.difference, closed.safeDrops, closed.pettyCash], [40, 0, 300, 160]);
});

var ev;
test('private events: asked for on the website, planned with a menu a head and a deposit, the guest\'s page, paid at the till, on the prep list', async function () {
  events._asked.clear();
  var m = await events.manage(tok.kojo, { action: 'settings', settings: { on: true, spaces: [{ name: 'Zqft garden', seats: 60 }, { name: 'Zqft room', seats: 25 }], minGuests: 15, leadDays: 3, depositPercent: 30 } }, IP + '4');
  assert.deepEqual([m.settings.on, m.settings.spaces.length, m.settings.minGuests], [true, 2, 15]);
  var pub = await events.publicOf(co.id);
  assert.deepEqual([pub.on, pub.firstDay, pub.minGuests], [true, day(3), 15]);
  var ask = { name: 'Zqft Akosua Mensah', phone: '0240000771', occasion: 'Zqft birthday', space: 'Zqft garden', day: day(4), from: '18:00', to: '23:00', guests: 40, note: 'Zqft: a cake at 20:00' };
  await assert.rejects(events.ask('ZQFT', Object.assign({}, ask, { day: day(1) }), IP + '5'), /at least 3 days ahead/);
  await assert.rejects(events.ask('ZQFT', Object.assign({}, ask, { guests: 8 }), IP + '5'), /15 guests or more/);
  await assert.rejects(events.ask('ZQFT', Object.assign({}, ask, { space: 'Zqft roof' }), IP + '5'), /Pick one of the spaces/);
  var a = await events.ask('ZQFT', ask, IP + '5');
  assert.equal(a.ref, 'E-0001');
  var g = await events.guestView(a.token);
  assert.deepEqual([g.status, g.name, g.guests, g.space, g.phone, g.canPay], ['enquiry', 'Zqft', 40, 'Zqft garden', undefined, false]);

  // Planned: a menu (a portion of jollof each, half of wings), the price a head, the room, a deposit.
  m = await events.manage(tok.kojo, { action: 'list' }, IP + '4');
  ev = m.events.find(function (e) { return e.ref === 'E-0001'; });
  var x = { id: ev.id, name: ev.name, phone: ev.phone, occasion: ev.occasion, space: ev.space, day: day(4), from: '18:00', to: '01:00', guests: 40,
    menu: [{ menuItemId: dish.jollof, perGuest: 1 }, { menuItemId: dish.wings, perGuest: 0.5 }], perHead: 150, extras: [{ text: 'Zqft garden hire', amount: 500 }],
    deposit: 2000, plan: [{ time: '20:00', text: 'Zqft: the cake', who: 'floor' }, { time: '18:30', text: 'Zqft: starters out', who: 'kitchen' }] };
  await assert.rejects(events.manage(tok.kojo, { action: 'save', event: Object.assign({}, x, { deposit: 9000 }) }, IP + '4'), /more than the event costs \(6500\.00\)/);
  m = await events.manage(tok.kojo, { action: 'save', event: x }, IP + '4');
  ev = m.events.find(function (e) { return e.id === ev.id; });
  assert.deepEqual([ev.total, ev.deposit.amount, ev.deposit.status, ev.plan[0].time, new Date(ev.endsAt).toISOString().slice(0, 16)], [6500, 2000, 'due', '18:30', day(5) + 'T01:00']);
  m = await events.manage(tok.kojo, { action: 'status', id: ev.id, status: 'quoted' }, IP + '4');
  assert.equal(m.told.what, 'quoted');
  assert.match(m.told.whatsapp, /^https:\/\/wa\.me\/233240000771\?text=.*%2Fe%2F/);
  g = await events.guestView(a.token);
  assert.deepEqual([g.status, g.total, g.menu.length, g.deposit.status], ['quoted', 6500, 2, 'due']);

  // The deposit in cash: into the drawer of the manager taking it.
  await assert.rejects(events.manage(tok.kojo, { action: 'deposit', id: ev.id, method: 'cash' }, IP + '4'), /open it first/);
  await pos.openDrawerSession(tok.kojo, 0);
  m = await events.manage(tok.kojo, { action: 'deposit', id: ev.id, method: 'cash' }, IP + '4');
  ev = m.events.find(function (e) { return e.id === ev.id; });
  assert.deepEqual([ev.status, ev.deposit.status, ev.deposit.method], ['confirmed', 'paid', 'cash']);
  var drawer = await pos.getOpenDrawerSession(tok.kojo);
  assert.deepEqual([drawer.paidIn, drawer.expected], [2000, 2000]);
  await assert.rejects(events.manage(tok.kojo, { action: 'deposit', id: ev.id, method: 'cash' }, IP + '4'), /paid already/);

  // On the till's week, and the kitchen's prep list that day.
  var soon = await events.soon(tok.ama);
  assert.equal(soon.events.length, 1);
  assert.equal(soon.events[0].phone, undefined);
  var plan = await prep.plan(co.id, day(4));
  var jollof = plan.dishes.find(function (d) { return d.id === dish.jollof; });
  var wings = plan.dishes.find(function (d) { return d.id === dish.wings; });
  assert.deepEqual([jollof.event, wings.event, plan.events[0].guests], [40, 20, 40]);

  // Cancelled: off the prep list.
  m = await events.manage(tok.kojo, { action: 'status', id: ev.id, status: 'cancelled' }, IP + '4');
  assert.equal(m.events.find(function (e) { return e.id === ev.id; }).status, 'cancelled');
  assert.equal((await prep.plan(co.id, day(4))).events.length, 0);
  await assert.rejects(events.manage(tok.kojo, { action: 'status', id: ev.id, status: 'confirmed' }, IP + '4'), /cannot be made confirmed/);
});

test('menu boards: a TV paired by its code shows the categories chosen with today\'s prices; taken off, it shows a new code', async function () {
  displays._made.clear();
  var h = await boards.hello(null, IP + '9', 'Zqft TV');
  var v = await boards.view(h.key);
  assert.equal(v.paired, false);
  assert.match(v.code, /^\d{6}$/);
  await assert.rejects(boards.manage(tok.kojo, { action: 'pair', code: '000000' }, IP + '4'), /No menu board shows that code/);
  var m = await boards.manage(tok.kojo, { action: 'pair', code: v.code, name: 'Zqft bar TV', options: { categories: ['Zqft Grill', 'Zqft Mains'], layout: 'list', rotate: 3, ready: true } }, IP + '4');
  assert.deepEqual([m.boards.length, m.boards[0].options.layout, m.boards[0].options.rotate], [1, 'list', 6]);
  assert.deepEqual(m.categories, ['Zqft Drinks', 'Zqft Grill', 'Zqft Mains']);
  await pool.query('UPDATE restaurant_menu_items SET track_stock = true, stock_qty = 0 WHERE id = $1', [dish.wings]);
  v = await boards.view(h.key);
  assert.deepEqual(v.sections.map(function (s) { return s.category; }), ['Zqft Grill', 'Zqft Mains']);
  assert.equal(v.sections[0].items[0].soldOut, true);
  assert.equal(v.sections[1].items[0].price, 60);
  assert.ok(v.ready && Array.isArray(v.ready.preparing));
  m = await boards.manage(tok.kojo, { action: 'remove', id: m.boards[0].id }, IP + '4');
  assert.equal(m.boards.length, 0);
  await assert.rejects(boards.view(h.key), /taken off the till/);
});
