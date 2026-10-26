// The thirteenth batch on the restaurant side (migration 0194): catering on
// the website (trays for a number of guests, days ahead, outside the order
// limits, started early by the kitchen); the kitchen's prep list (the usual
// for that weekday, what is ordered ahead, the ingredients against stock);
// opening and closing checklists with readings; stock sent from one
// restaurant to another and counted in. Fake Zqth data.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var online = require('../src/services/restaurantOnline.service');
var prep = require('../src/services/restaurantPrep.service');
var checklists = require('../src/services/restaurantChecklists.service');
var transfers = require('../src/services/restaurantTransfers.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7791', kojo: '7792', esi: '7793' };
var IP = '10.13.0.1';
var co = {}, dept = {}, people = {}, tok = {}, dish = {}, ing = {};
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code IN ('ZQTH', 'ZQTB')")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    await pool.query('DELETE FROM restaurant_stock_transfers WHERE from_company = ANY($1) OR to_company = ANY($1)', [cos]);
    for (var q of ['DELETE FROM restaurant_checklists WHERE company_id = ANY($1)', 'DELETE FROM restaurant_prep_ticks WHERE company_id = ANY($1)', 'DELETE FROM restaurant_prep_settings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_stock_moves WHERE company_id = ANY($1)', 'DELETE FROM restaurant_recipes WHERE company_id = ANY($1)', 'DELETE FROM restaurant_ingredients WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_supplies WHERE company_id = ANY($1)', 'DELETE FROM restaurant_online_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))', 'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_delivery_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', 'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQTH-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQTH-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, company, role) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqth', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept[company], pinAuth.hashPin(PINS[key])])).rows[0].id;
  await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [co[company].id, people[key], role]);
}
async function addDish(company, name, category, price, serves) {
  return (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active, online, serves) VALUES ($1, $2, $3, $4, true, true, $5) RETURNING id', [co[company].id, name, category, price, serves || 0])).rows[0].id;
}
var saleNo = 0;
async function sale(onDay, id, qty) {
  saleNo++;
  var o = (await pool.query("INSERT INTO restaurant_orders (company_id, order_no, cashier_id, status, total, created_at) VALUES ($1, $2, $3, 'completed', 10, $4::date + time '13:00') RETURNING id",
    [co.a.id, 'ZQTH-' + saleNo, people.ama, onDay])).rows[0].id;
  await pool.query('INSERT INTO restaurant_order_items (order_id, menu_item_id, name, qty, unit_price, line_total) VALUES ($1, $2, $3, $4, 10, 10)', [o, id, 'Zqth dish', qty]);
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  co.a = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTH', 'Zqth Kitchen') RETURNING *")).rows[0];
  co.b = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTB', 'Zqth Garden') RETURNING *")).rows[0];
  dept.a = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTHF', 'Zqth Floor', $1) RETURNING id", [co.a.id])).rows[0].id;
  dept.b = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTBF', 'Zqth Garden Floor', $1) RETURNING id", [co.b.id])).rows[0].id;
  await person('ama', 'ZQTH-1', 'Ama', 'a', 'cashier');
  await person('kojo', 'ZQTH-2', 'Kojo', 'a', 'manager');
  await person('esi', 'ZQTH-3', 'Esi', 'b', 'manager');
  dish.jollof = await addDish('a', 'Zqth jollof', 'Zqth Mains', 60);
  dish.tray = await addDish('a', 'Zqth jollof party tray', 'Zqth Catering', 400, 10);
  dish.chops = await addDish('a', 'Zqth small chops tray', 'Zqth Catering', 300, 15);
  await addDish('b', 'Zqth garden rice', 'Zqth Mains', 50);
  ing.rice = (await pool.query("INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, reorder_level, unit_cost, active) VALUES ($1, 'Zqth rice', 'kg', 10, 2, 12, true) RETURNING id", [co.a.id])).rows[0].id;
  ing.cups = (await pool.query("INSERT INTO restaurant_supplies (company_id, name, category, unit, stock_qty, reorder_level, unit_cost, active) VALUES ($1, 'Zqth cups', 'Zqth', 'each', 100, 10, 0.5, true) RETURNING id", [co.a.id])).rows[0].id;
  ing.riceB = (await pool.query("INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, reorder_level, unit_cost, active) VALUES ($1, 'zqth RICE', 'kg', 1, 2, 11, true) RETURNING id", [co.b.id])).rows[0].id;
  await pool.query('INSERT INTO restaurant_recipes (company_id, menu_item_id, ingredient_id, qty) VALUES ($1, $2, $3, 0.2), ($1, $4, $3, 2)', [co.a.id, dish.jollof, ing.rice, dish.tray]);
  await pool.query('INSERT INTO restaurant_delivery_settings (company_id, settings) VALUES ($1, $2)', [co.a.id, JSON.stringify({ open: true, delivery: true, pickup: true, readyMinutes: 20,
    location: { lat: 5.6, lng: -0.18, address: 'Zqth road' }, fee: { base: 10, perKm: 0, freeOver: 0 }, maxKm: 30, later: { on: true, days: 2, from: '00:00', to: '23:59', whenClosed: true },
    limits: { on: true, orders: 1, dishes: 0 },
    catering: { on: true, leadDays: 2, maxDays: 20, from: '10:00', to: '18:00', minGuests: 10, minOrder: 500, prepMinutes: 180, note: 'Zqth: trays for parties' } })]);
  for (var k of ['ama', 'kojo', 'esi']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
});
test.after(async function () { await cleanup(); await pool.end(); });

var cater;
test('catering: trays on their own menu, days ahead, for enough guests and a least amount; outside the order limits; the kitchen starts its prep time before', async function () {
  var menu = await online.menu('ZQTH');
  assert.ok(menu.items.every(function (i) { return i.id !== dish.tray; }), 'trays not on the usual menu');
  var c = menu.restaurant.catering;
  assert.deepEqual([c.on, c.firstDay, c.lastDay, c.from, c.to, c.minGuests, c.minOrder], [true, day(2), day(20), '10:00', '18:00', 10, 500]);
  assert.deepEqual(c.items.map(function (i) { return [i.name, i.serves]; }).sort(), [['Zqth jollof party tray', 10], ['Zqth small chops tray', 15]]);
  var order = function (n, extra) {
    return online.place('ZQTH', Object.assign({ catering: true, guests: 30, name: 'Zqth Party ' + n, phone: '02000013' + String(n).padStart(2, '0'), fulfillment: 'pickup', payMethod: 'cash',
      scheduledFor: day(3) + 'T12:00:00.000Z', items: [{ menuItemId: dish.tray, qty: 2 }] }, extra || {}), '10.13.1.' + n);
  };
  await assert.rejects(order(1, { items: [{ menuItemId: dish.jollof, qty: 10 }] }), /not on the catering menu/);
  await assert.rejects(online.place('ZQTH', { name: 'Zqth X', phone: '0200001399', fulfillment: 'pickup', payMethod: 'cash', items: [{ menuItemId: dish.tray, qty: 1 }] }, '10.13.1.99'), /ordered as catering/);
  await assert.rejects(order(2, { scheduledFor: day(1) + 'T12:00:00.000Z' }), /at least 2 days ahead/);
  await assert.rejects(order(3, { scheduledFor: day(25) + 'T12:00:00.000Z' }), /up to 20 days ahead/);
  await assert.rejects(order(4, { scheduledFor: day(3) + 'T19:00:00.000Z' }), /from 10:00 to 18:00/);
  await assert.rejects(order(5, { guests: 4 }), /10 guests or more/);
  await assert.rejects(order(6, { items: [{ menuItemId: dish.tray, qty: 1 }] }), /smallest catering order is 500/);
  // Two at the same time: the order limits (1 every 15 minutes) do not count catering.
  cater = await order(7);
  await order(8);
  var row = (await pool.query('SELECT * FROM restaurant_online_orders WHERE id IN (SELECT id FROM restaurant_online_orders WHERE company_id = $1) AND customer_name = $2', [co.a.id, 'Zqth Party 7'])).rows[0];
  assert.deepEqual([row.catering, row.guests, row.status, row.slot_at, Number(row.subtotal)], [true, 30, 'pending', null, 800]);
  assert.deepEqual(cater.order.catering, { guests: 30 });
  // Confirmed: to the kitchen 3 hours (and 5 minutes to spare) before.
  var acc = await online.accept(tok.kojo, row.id, { readyMinutes: 20 });
  assert.equal(acc.order.status, 'accepted');
  assert.deepEqual(acc.order.catering, { guests: 30 });
  assert.equal(new Date(acc.order.startAt).toISOString(), day(3) + 'T08:55:00.000Z');
  // Off: not on the website, and not taken.
  await pool.query("UPDATE restaurant_delivery_settings SET settings = jsonb_set(settings, '{catering,on}', 'false') WHERE company_id = $1", [co.a.id]);
  assert.equal((await online.menu('ZQTH')).restaurant.catering.on, false);
  await assert.rejects(order(9), /not taking catering orders/);
  await pool.query("UPDATE restaurant_delivery_settings SET settings = jsonb_set(settings, '{catering,on}', 'true') WHERE company_id = $1", [co.a.id]);
});

test('prep list: the usual for that weekday with some extra, what is ordered ahead and catering; the ingredients against the stock; ticked off', async function () {
  var target = day(3);
  // The same weekday the last weeks: 10 and 6 jollof.
  await sale(day(-4), dish.jollof, 10);
  await sale(day(-11), dish.jollof, 6);
  await sale(day(-5), dish.jollof, 50); // another weekday: not counted
  var p = await prep.prep(tok.ama, { day: target }, IP);
  assert.deepEqual([p.weeks, p.buffer], [4, 10]);
  var jollof = p.dishes.find(function (d) { return d.id === dish.jollof; });
  var tray = p.dishes.find(function (d) { return d.id === dish.tray; });
  assert.deepEqual([jollof.usual, jollof.fromUsual, jollof.total], [4, 5, 5], '16 over 4 weeks, 10% more, rounded up');
  assert.deepEqual([tray.catering, tray.total], [4, 4], 'two catering orders of two trays');
  assert.equal(p.dishes[0].id, dish.tray, 'catering first');
  var rice = p.ingredients.find(function (g) { return g.id === ing.rice; });
  assert.deepEqual([rice.need, rice.stock, rice.short], [9, 10, 0], '4 trays × 2 kg + 5 × 0.2 kg');
  assert.equal(p.ahead.length, 2);
  assert.ok(p.ahead.every(function (o) { return o.catering && o.catering.guests === 30; }));
  // A manager: the last two weeks, 50% more.
  await assert.rejects(prep.prep(tok.ama, { day: target, action: 'settings', weeks: 2, buffer: 50 }, IP), /manager/);
  p = await prep.prep(tok.kojo, { day: target, action: 'settings', weeks: 2, buffer: 50 }, IP);
  jollof = p.dishes.find(function (d) { return d.id === dish.jollof; });
  assert.deepEqual([jollof.usual, jollof.fromUsual], [8, 12]);
  rice = p.ingredients.find(function (g) { return g.id === ing.rice; });
  assert.deepEqual([rice.need, rice.short], [10.4, 0.4]);
  assert.equal(p.short, 1);
  // Ticked off by the cook, and back.
  p = await prep.prep(tok.ama, { day: target, action: 'tick', key: 'menu:' + dish.tray, qty: 4 }, IP);
  tray = p.dishes.find(function (d) { return d.id === dish.tray; });
  assert.deepEqual([tray.done.qty, tray.done.by, p.done], [4, 'Ama Zqth', 1]);
  p = await prep.prep(tok.ama, { day: target, action: 'tick', key: 'menu:' + dish.tray, done: false }, IP);
  assert.equal(p.done, 0);
  await assert.rejects(prep.prep(tok.ama, { day: day(9) }, IP), /a week ahead/);
  assert.ok((await prep.prep(tok.ama, { day: 'tomorrow' }, IP)).day === day(1));
});

test('checklists: a manager writes them; staff tick and read; a reading out of range is flagged; done when all are; two weeks of history', async function () {
  await assert.rejects(checklists.manage(tok.ama, { action: 'save', list: { name: 'Zqth Opening', items: [{ text: 'Gas on' }] } }, IP), /manager/);
  await assert.rejects(checklists.manage(tok.kojo, { action: 'save', list: { name: 'Zqth Opening', items: [] } }, IP), /at least one thing/);
  await assert.rejects(checklists.manage(tok.kojo, { action: 'save', list: { name: 'Zqth Opening', items: [{ text: 'Fridge', kind: 'reading', min: 5, max: 0 }] } }, IP), /below the lowest/);
  var m = await checklists.manage(tok.kojo, { action: 'save', list: { name: 'Zqth Opening', at: 'open', items: [{ text: 'Gas on, no smell' }, { text: 'Fridge 1', kind: 'reading', unit: '°C', min: 0, max: 5 }, { text: '' }] } }, IP);
  assert.equal(m.lists.length, 1);
  var list = m.lists[0];
  assert.deepEqual(list.items.map(function (i) { return i.kind; }), ['tick', 'reading']);
  var mine = await checklists.mine(tok.ama);
  assert.deepEqual([mine.lists.length, mine.open, mine.lists[0].done, mine.lists[0].total], [1, 1, 0, 2]);
  await assert.rejects(checklists.mark(tok.ama, { checklistId: list.id, key: list.items[1].key }), /Type the reading/);
  mine = await checklists.mark(tok.ama, { checklistId: list.id, key: list.items[1].key, value: 9 });
  var fridge = mine.lists[0].items[1];
  assert.deepEqual([fridge.done, fridge.value, fridge.bad, fridge.by], [true, 9, true, 'Ama Zqth']);
  var flagged = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'till.checklist_bad'", [co.a.id])).rows;
  assert.match(flagged[0].summary, /Fridge 1 read 9 °C, out of range \(0 to 5 °C\)/);
  mine = await checklists.mark(tok.ama, { checklistId: list.id, key: list.items[0].key });
  assert.deepEqual([mine.open, mine.lists[0].finished.by], [0, 'Ama Zqth']);
  // Undone: not finished any more.
  mine = await checklists.mark(tok.ama, { checklistId: list.id, key: list.items[0].key, done: false });
  assert.equal(mine.lists[0].finished, null);
  await checklists.mark(tok.ama, { checklistId: list.id, key: list.items[0].key });
  m = await checklists.manage(tok.kojo, { action: 'list' }, IP);
  var todayRow = m.history[0].lists[0];
  assert.deepEqual([m.history.length, todayRow.done, todayRow.total, todayRow.bad[0].value, todayRow.bad[0].range], [14, 2, 2, 9, '0 to 5 °C']);
  m = await checklists.manage(tok.kojo, { action: 'remove', id: list.id }, IP);
  assert.equal(m.lists.length, 0);
});

test('stock transfers: sent off one restaurant\'s stock at its cost; counted in by the other (matched by name, or added); short noted; taken back while on its way', async function () {
  // A cashier needs the stock permission or a manager's PIN.
  await assert.rejects(transfers.transfers(tok.ama, { action: 'view' }, IP), /manager/);
  var v = await transfers.transfers(tok.ama, { action: 'view', managerPin: PINS.kojo }, IP);
  assert.ok(v.restaurants.some(function (r) { return r.id === co.b.id; }));
  assert.ok(!v.restaurants.some(function (r) { return r.id === co.a.id; }));
  await assert.rejects(transfers.transfers(tok.kojo, { action: 'send', to: co.b.id, lines: [{ type: 'ingredient', id: ing.rice, qty: 40 }] }, IP), /Only 10 kg of Zqth rice/);
  await assert.rejects(transfers.transfers(tok.kojo, { action: 'send', to: co.a.id, lines: [{ type: 'ingredient', id: ing.rice, qty: 1 }] }, IP), /Pick the restaurant/);
  v = await transfers.transfers(tok.kojo, { action: 'send', to: co.b.id, note: 'Zqth: for the weekend', lines: [{ type: 'ingredient', id: ing.rice, qty: 4 }, { type: 'supply', id: ing.cups, qty: 30 }] }, IP);
  var t = v.list[0];
  assert.deepEqual([t.ref, t.status, t.direction, t.value, t.lines.length], ['T-0001', 'sent', 'out', 63, 2]);
  var stock = (await pool.query('SELECT (SELECT stock_qty FROM restaurant_ingredients WHERE id = $1) AS rice, (SELECT stock_qty FROM restaurant_supplies WHERE id = $2) AS cups', [ing.rice, ing.cups])).rows[0];
  assert.deepEqual([Number(stock.rice), Number(stock.cups)], [6, 70]);
  // The other restaurant: on its way, rice matched by name, cups new to them.
  assert.deepEqual(await transfers.waiting(tok.esi), { waiting: 1, can: true });
  var b = await transfers.transfers(tok.esi, { action: 'view' }, IP);
  var inc = b.incoming[0];
  assert.deepEqual([inc.direction, inc.lines[0].match && inc.lines[0].match.id, inc.lines[1].match], ['in', ing.riceB, null]);
  await assert.rejects(transfers.transfers(tok.esi, { action: 'receive', id: inc.id, lines: [{ qty: 3.5 }] }, IP), /each thing sent/);
  b = await transfers.transfers(tok.esi, { action: 'receive', id: inc.id, note: 'Zqth: one bag torn', lines: [{ qty: 3.5, toId: ing.riceB }, { qty: 30, toId: 'new' }] }, IP);
  var got = b.list.find(function (x) { return x.id === inc.id; });
  assert.deepEqual([got.status, got.short, got.receivedBy], ['received', 1, 'Esi Zqth']);
  var riceB = (await pool.query('SELECT stock_qty FROM restaurant_ingredients WHERE id = $1', [ing.riceB])).rows[0];
  assert.equal(Number(riceB.stock_qty), 4.5);
  var cupsB = (await pool.query('SELECT stock_qty, unit_cost FROM restaurant_supplies WHERE company_id = $1 AND name = $2', [co.b.id, 'Zqth cups'])).rows[0];
  assert.deepEqual([Number(cupsB.stock_qty), Number(cupsB.unit_cost)], [30, 0.5]);
  var moves = (await pool.query("SELECT kind, count(*)::int AS n FROM restaurant_stock_moves WHERE company_id = ANY($1) AND kind LIKE 'transfer_%' GROUP BY kind ORDER BY kind", [[co.a.id, co.b.id]])).rows;
  assert.deepEqual(moves.map(function (m) { return [m.kind, m.n]; }), [['transfer_in', 2], ['transfer_out', 2]]);
  var told = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'stock.transfer_received'", [co.a.id])).rows[0];
  assert.match(told.summary, /short: 0.5 kg Zqth rice/);
  await assert.rejects(transfers.transfers(tok.esi, { action: 'receive', id: inc.id, lines: [{ qty: 1 }, { qty: 1 }] }, IP), /counted in already/);
  // Another one, taken back: onto the stock again.
  v = await transfers.transfers(tok.kojo, { action: 'send', to: co.b.id, lines: [{ type: 'ingredient', id: ing.rice, qty: 2 }] }, IP);
  var t2 = v.list.find(function (x) { return x.status === 'sent'; });
  await assert.rejects(transfers.transfers(tok.esi, { action: 'cancel', id: t2.id }, IP), /not this restaurant/);
  v = await transfers.transfers(tok.kojo, { action: 'cancel', id: t2.id }, IP);
  assert.equal(v.list.find(function (x) { return x.id === t2.id; }).status, 'cancelled');
  assert.equal(Number((await pool.query('SELECT stock_qty FROM restaurant_ingredients WHERE id = $1', [ing.rice])).rows[0].stock_qty), 6);
  assert.equal((await transfers.waiting(tok.esi)).waiting, 0);
});
