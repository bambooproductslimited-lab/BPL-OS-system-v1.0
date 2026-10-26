// The twelfth batch on the restaurant side (migration 0193): order limits
// on the website by the 15 minutes an order is due in; "goes well with"
// suggestions (picked or the till's own) and their report; waste with a
// reason off the stock and a stock take; notes for the team with who has
// read them. Fake Zqtw data.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var online = require('../src/services/restaurantOnline.service');
var delivery = require('../src/services/restaurantDelivery.service');
var tillMenu = require('../src/services/restaurantTillMenu.service');
var waste = require('../src/services/restaurantWaste.service');
var notes = require('../src/services/restaurantTeamNotes.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7781', kojo: '7782', yaw: '7783' };
var IP = '10.12.0.1';
var company, dept, people = {}, tok = {}, dish = {}, rice;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQTW'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_team_notes WHERE company_id = ANY($1)', 'DELETE FROM restaurant_waste WHERE company_id = ANY($1)', 'DELETE FROM restaurant_stock_takes WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_stock_moves WHERE company_id = ANY($1)', 'DELETE FROM restaurant_recipes WHERE company_id = ANY($1)', 'DELETE FROM restaurant_ingredients WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_supplies WHERE company_id = ANY($1)', 'DELETE FROM restaurant_online_orders WHERE company_id = ANY($1)', 'DELETE FROM restaurant_table_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))', 'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_delivery_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', 'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQTW-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQTW-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, role) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqtw', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
  await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [company.id, people[key], role]);
}
async function addDish(name, category, price) {
  return (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, $2, $3, $4, true) RETURNING id', [company.id, name, category, price])).rows[0].id;
}
// A completed sale with these dishes (for what is ordered together).
var saleNo = 0;
async function sale(ids) {
  saleNo++;
  var o = (await pool.query("INSERT INTO restaurant_orders (company_id, order_no, cashier_id, status, total) VALUES ($1, $2, $3, 'completed', 10) RETURNING id", [company.id, 'ZQTW-' + saleNo, people.ama])).rows[0].id;
  for (var id of ids) await pool.query('INSERT INTO restaurant_order_items (order_id, menu_item_id, name, qty, unit_price, line_total) VALUES ($1, $2, $3, 1, 10, 10)', [o, id, 'Zqtw dish']);
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTW', 'Zqtw Kitchen') RETURNING *")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTWF', 'Zqtw Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQTW-1', 'Ama', 'cashier');
  await person('kojo', 'ZQTW-2', 'Kojo', 'manager');
  await person('yaw', 'ZQTW-3', 'Yaw', 'cashier');
  rice = await addDish('Zqtw jollof', 'Zqtw Mains', 60);
  dish.chicken = await addDish('Zqtw grilled chicken', 'Zqtw Mains', 80);
  dish.coke = await addDish('Zqtw cola', 'Zqtw Drinks', 10);
  dish.juice = await addDish('Zqtw sobolo', 'Zqtw Drinks', 12);
  dish.plantain = await addDish('Zqtw kelewele', 'Zqtw Sides', 20);
  await pool.query('UPDATE restaurant_menu_items SET online = true WHERE company_id = $1', [company.id]);
  await pool.query('INSERT INTO restaurant_delivery_settings (company_id, settings) VALUES ($1, $2)', [company.id, JSON.stringify({ open: true, delivery: true, pickup: true, readyMinutes: 20,
    location: { lat: 5.6, lng: -0.18, address: 'Zqtw road' }, fee: { base: 10, perKm: 0, freeOver: 0 }, maxKm: 30, later: { on: true, days: 2, from: '00:00', to: '23:59', whenClosed: true } })]);
  for (var k of ['ama', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('order limits: a full 15 minutes takes no more website orders; full times are not offered; the next time with room is', async function () {
  var order = function (n, extra) {
    return online.place('ZQTW', Object.assign({ name: 'Zqtw Guest ' + n, phone: '02000012' + String(n).padStart(2, '0'), fulfillment: 'pickup', payMethod: 'cash', items: [{ menuItemId: rice, qty: 1 }] }, extra || {}), '10.12.1.' + n);
  };
  var menu = await online.menu('ZQTW');
  assert.deepEqual(menu.restaurant.limits, { on: false });
  await pool.query("UPDATE restaurant_delivery_settings SET settings = settings || '{\"limits\": {\"on\": true, \"orders\": 2, \"dishes\": 0}}' WHERE company_id = $1", [company.id]);
  assert.deepEqual((await delivery.settingsOf(company.id)).limits, { on: true, orders: 2, dishes: 0 });
  await order(1); await order(2);
  var row = (await pool.query("SELECT slot_at, dish_count, created_at FROM restaurant_online_orders WHERE company_id = $1 ORDER BY number LIMIT 1", [company.id])).rows[0];
  assert.equal(new Date(row.slot_at).getTime() % (15 * 60000), 0, 'counted in a 15-minute slot');
  assert.equal(row.dish_count, 1);
  // Full now (unless the slot turned over between the orders: then once more).
  var third = await order(3).then(function () { return null; }, function (e) { return e; });
  if (!third) third = await order(4).then(function () { return null; }, function (e) { return e; });
  assert.ok(third, 'a third order in the same 15 minutes is refused');
  assert.match(third.message, /all the website orders it can make for now\. The next time with room is .*: order for then\./);
  menu = await online.menu('ZQTW');
  assert.equal(menu.restaurant.limits.on, true);
  assert.equal(menu.restaurant.limits.nowFull, true);
  assert.ok(menu.restaurant.limits.next.pickup);
  // For later: a time filled up is not offered, the next is.
  var at = day(1) + 'T12:00:00.000Z';
  await order(11, { scheduledFor: at }); await order(12, { scheduledFor: at });
  await assert.rejects(order(13, { scheduledFor: at }), /That time is full now: choose another one\. The next time with room is .*12:15\./);
  menu = await online.menu('ZQTW');
  assert.ok((menu.restaurant.limits.full[day(1)] || []).indexOf('12:00') >= 0);
  await order(14, { scheduledFor: day(1) + 'T12:15:00.000Z' });
  // Dishes too: a slot with 2 dishes takes no order of 2 more.
  await pool.query("UPDATE restaurant_delivery_settings SET settings = settings || '{\"limits\": {\"on\": true, \"orders\": 9, \"dishes\": 3}}' WHERE company_id = $1", [company.id]);
  await order(15, { scheduledFor: day(1) + 'T13:00:00.000Z', items: [{ menuItemId: rice, qty: 2 }] });
  await assert.rejects(order(16, { scheduledFor: day(1) + 'T13:00:00.000Z', items: [{ menuItemId: rice, qty: 2 }] }), /full/);
  await order(17, { scheduledFor: day(1) + 'T13:00:00.000Z', items: [{ menuItemId: rice, qty: 1 }] });
  // The delivery screen: the next two hours.
  var board = await delivery.board(tok.kojo);
  assert.equal(board.slots.length, 8);
  assert.ok(board.slots.some(function (s) { return s.orders >= 2; }));
  // Turned down, an order leaves its slot.
  await pool.query("UPDATE restaurant_delivery_settings SET settings = settings || '{\"limits\": {\"on\": true, \"orders\": 2, \"dishes\": 0}}' WHERE company_id = $1", [company.id]);
  var first = (await pool.query("SELECT id FROM restaurant_online_orders WHERE company_id = $1 AND scheduled_for = $2 ORDER BY number LIMIT 1", [company.id, at])).rows[0].id;
  await online.reject(tok.kojo, first, { reason: 'Zqtw: out of rice' });
  await order(18, { scheduledFor: at });
});

test('goes well with: the manager\'s picks, else what is ordered together; taken, they show in the report', async function () {
  await pool.query('DELETE FROM restaurant_online_orders WHERE company_id = $1', [company.id]);
  await pool.query("UPDATE restaurant_delivery_settings SET settings = settings || '{\"limits\": {\"on\": false, \"orders\": 6, \"dishes\": 0}}' WHERE company_id = $1", [company.id]);
  // Jollof is sold with cola three times, with kelewele twice, with chicken (same section) often.
  for (var i = 0; i < 3; i++) await sale([rice, dish.coke]);
  for (i = 0; i < 2; i++) await sale([rice, dish.plantain]);
  for (i = 0; i < 4; i++) await sale([rice, dish.chicken]);
  await sale([rice, dish.juice]);
  require('../src/services/restaurantSuggestions.service').forget(company.id);
  var menu = await online.menu('ZQTW');
  var jollof = menu.items.find(function (i) { return i.id === rice; });
  assert.deepEqual(jollof.goesWith, [dish.coke, dish.plantain], 'the till\'s own: most together, other sections, twice or more');
  assert.equal(jollof.goesWithPicked, false);
  // The manager picks; the website follows.
  var m = await access.menu(tok.kojo, { action: 'list' }, IP);
  var item = m.items.find(function (i) { return i.id === rice; });
  assert.deepEqual(item.goesWithAuto, [dish.coke, dish.plantain]);
  await tillMenu.saveItem(company.id, { id: people.kojo, first_name: 'Kojo', last_name: 'Zqtw' }, { id: rice, name: 'Zqtw jollof', category: 'Zqtw Mains', price: 60, goesWith: [dish.juice, rice, dish.plantain, 'nope'] });
  menu = await online.menu('ZQTW');
  jollof = menu.items.find(function (i) { return i.id === rice; });
  assert.deepEqual([jollof.goesWith, jollof.goesWithPicked], [[dish.juice, dish.plantain], true], 'its own picks, not itself');
  // Taken on the website: marked, and counted.
  await online.place('ZQTW', { name: 'Zqtw Taker', phone: '0200001299', fulfillment: 'pickup', payMethod: 'cash', items: [{ menuItemId: rice, qty: 1 }, { menuItemId: dish.juice, qty: 2, suggested: true }] }, '10.12.2.1');
  var lines = (await pool.query("SELECT items FROM restaurant_online_orders WHERE company_id = $1 AND customer_name = 'Zqtw Taker'", [company.id])).rows[0].items;
  assert.deepEqual(lines.map(function (l) { return !!l.suggested; }), [false, true]);
  m = await access.menu(tok.kojo, { action: 'list' }, IP);
  assert.equal(m.suggestions.taken, 2);
  assert.equal(m.suggestions.added, 24);
  assert.equal(m.suggestions.byChannel.online.taken, 2);
  assert.equal(m.suggestions.top[0].name, 'Zqtw sobolo');
});

test('waste: off the stock with a reason and a cost (a dish by its recipe); taken back; the report; a stock take', async function () {
  var by = { id: people.ama, first_name: 'Ama', last_name: 'Zqtw' };
  var oil = (await pool.query("INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, reorder_level, unit_cost, active) VALUES ($1, 'Zqtw palm oil', 'l', 10, 1, 20, true) RETURNING id", [company.id])).rows[0].id;
  var flour = (await pool.query("INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, reorder_level, unit_cost, active) VALUES ($1, 'Zqtw flour', 'kg', 5, 1, 8, true) RETURNING id", [company.id])).rows[0].id;
  var cups = (await pool.query("INSERT INTO restaurant_supplies (company_id, name, category, unit, stock_qty, reorder_level, unit_cost, active) VALUES ($1, 'Zqtw cups', 'Zqtw', 'each', 100, 10, 0.5, true) RETURNING id", [company.id])).rows[0].id;
  await pool.query('INSERT INTO restaurant_recipes (company_id, menu_item_id, ingredient_id, qty) VALUES ($1, $2, $3, 0.25)', [company.id, dish.plantain, oil]);
  await pool.query('UPDATE restaurant_menu_items SET track_stock = true, stock_qty = 30 WHERE id = $1', [dish.plantain]);

  // Anyone on the till: kelewele dropped (2), cups gone off (makes no sense, but counted), flour gone past its date.
  var r = await waste.till(tok.ama, { action: 'log', type: 'menu', id: dish.plantain, qty: 2, reason: 'dropped', note: 'Zqtw: tray slipped' });
  assert.deepEqual([r.logged.name, r.logged.qty, r.logged.cost, r.logged.reason, r.logged.canUndo], ['Zqtw kelewele', 2, 10, 'dropped', true]);
  assert.equal(Number((await pool.query('SELECT stock_qty FROM restaurant_ingredients WHERE id = $1', [oil])).rows[0].stock_qty), 9.5, 'its recipe off the ingredients');
  assert.equal(Number((await pool.query('SELECT stock_qty FROM restaurant_menu_items WHERE id = $1', [dish.plantain])).rows[0].stock_qty), 28, 'a counted dish off its own stock');
  await waste.till(tok.ama, { action: 'log', type: 'supply', id: cups, qty: 10, reason: 'spoiled' });
  r = await waste.till(tok.yaw, { action: 'log', type: 'ingredient', id: flour, qty: 1.5, reason: 'expired' });
  assert.equal(r.cost, 10 + 5 + 12);
  await assert.rejects(waste.till(tok.yaw, { action: 'log', type: 'ingredient', id: flour, qty: 50, reason: 'expired' }), /Only 3\.5 kg of Zqtw flour in stock/);
  await assert.rejects(waste.till(tok.yaw, { action: 'log', type: 'ingredient', id: flour, qty: 1, reason: 'lost' }), /Say why/);
  // Taken back: only by whoever wrote it (or a manager).
  var cupsLog = r.list.find(function (x) { return x.name === 'Zqtw cups'; });
  await assert.rejects(waste.till(tok.yaw, { action: 'undo', id: cupsLog.id }), /Only whoever wrote it/);
  r = await waste.till(tok.ama, { action: 'undo', id: cupsLog.id });
  assert.equal(r.cost, 22);
  assert.equal(Number((await pool.query('SELECT stock_qty FROM restaurant_supplies WHERE id = $1', [cups])).rows[0].stock_qty), 100);
  // The report: by reason, by item, against the sales.
  var rep = await waste.report(company.id, {});
  assert.equal(rep.cost, 22);
  assert.deepEqual(rep.byReason.map(function (x) { return [x.reason, x.cost]; }), [['expired', 12], ['dropped', 10]]);
  assert.equal(rep.byItem[0].name, 'Zqtw flour');
  assert.ok(rep.sales > 0 && rep.ofSales > 0);
  void by;

  // A stock take: count, then finish — the difference kept with its value.
  var t = await waste.stockTake(tok.kojo, { action: 'start' }, IP);
  assert.ok(t.open && t.open.total >= 3);
  await assert.rejects(waste.stockTake(tok.kojo, { action: 'start' }, IP), /open already/);
  var line = function (id) { return t.open.lines.find(function (l) { return l.id === id; }); };
  assert.equal(line(oil).expected, 9.5);
  t = await waste.stockTake(tok.kojo, { action: 'save', lines: [{ type: 'ingredient', id: oil, counted: 8.5 }, { type: 'supply', id: cups, counted: 104 }] }, IP);
  assert.equal(t.open.counted, 2);
  // A cashier cannot without a manager's PIN.
  await assert.rejects(waste.stockTake(tok.ama, { action: 'finish' }, IP), /manager/);
  t = await waste.stockTake(tok.ama, { action: 'finish', managerPin: PINS.kojo, note: 'Zqtw: Sunday count' }, IP);
  assert.equal(t.open, null);
  assert.deepEqual([t.past[0].status, t.past[0].counted, t.past[0].missing, t.past[0].found], ['done', 2, 20, 2]);
  assert.equal(Number((await pool.query('SELECT stock_qty FROM restaurant_ingredients WHERE id = $1', [oil])).rows[0].stock_qty), 8.5);
  assert.equal(Number((await pool.query('SELECT stock_qty FROM restaurant_supplies WHERE id = $1', [cups])).rows[0].stock_qty), 104);
});

test('notes for the team: written by a manager, seen at sign-in until "Got it", who has read them', async function () {
  await assert.rejects(notes.manage(tok.ama, { action: 'add', body: 'Zqtw: hi' }, IP), /manager/);
  var m = await notes.manage(tok.kojo, { action: 'add', body: 'Zqtw: no tilapia today. Push the chicken.', tone: 'urgent', days: 1 }, IP);
  assert.equal(m.notes.length, 1);
  assert.deepEqual(m.notes[0].readBy.map(function (x) { return x.name; }), ['Kojo Zqtw'], 'whoever wrote it has read it');
  assert.deepEqual(m.notes[0].notYet.sort(), ['Ama Zqtw', 'Yaw Zqtw']);
  await notes.manage(tok.kojo, { action: 'add', body: 'Zqtw: party of 20 at 8, tables 4 to 7.', days: 3, pinned: true }, IP);
  var mine = await notes.mine(tok.ama);
  assert.equal(mine.unread, 2);
  assert.equal(mine.notes[0].pinned, true, 'pinned first');
  assert.equal(mine.canWrite, false);
  mine = await notes.read(tok.ama, mine.notes.map(function (n) { return n.id; }));
  assert.equal(mine.unread, 0);
  m = await notes.manage(tok.kojo, { action: 'list' }, IP);
  var tilapia = m.notes.find(function (n) { return /tilapia/.test(n.body); });
  assert.deepEqual(tilapia.notYet, ['Yaw Zqtw']);
  await notes.manage(tok.kojo, { action: 'remove', id: tilapia.id }, IP);
  assert.equal((await notes.mine(tok.yaw)).unread, 1);
  await assert.rejects(notes.manage(tok.kojo, { action: 'add', body: 'Zqtw: x', days: 30 }, IP), /Write the note|1 to 14 days/);
});
