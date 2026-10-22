// The till's bill (migration 0168, restaurantTillCheck): add-ons on dishes,
// discounts and dishes on the house (a manager's approval), the service
// charge and taxes, a bill paid dish by dish, dishes moved and orders
// joined or moved, and the receipt sent by WhatsApp or text message.
// Fake Zqx data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var kitchen = require('../src/services/restaurantKitchen.service');
var money = require('../src/services/restaurantTillMoney.service');
var check = require('../src/services/restaurantTillCheck.service');
var sms = require('../src/services/sms.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7551', kojo: '7552', yaw: '7553' };
var IP = '10.9.7.1';
var company, people = {}, tok = {}, rice, juice, stew, t1, t2, t3, sides, extras;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQX'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_refund_items WHERE refund_id IN (SELECT id FROM restaurant_refunds WHERE company_id = ANY($1))', 'DELETE FROM restaurant_refunds WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_payments WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_stock_moves WHERE company_id = ANY($1)', 'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_modifier_groups WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_tables WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) {
      try { await pool.query(q, [cos]); } catch (e) { if (e.code !== '42P01') throw e; }
    }
  }
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQX-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqx', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
async function settings(s) { await access.saveSettings(tok.kojo, { settings: s }, IP); }
function cash(total) { return [{ method: 'cash', currency: 'GHS', tendered: total }]; }
function opt(group, name) { return group.options.find(function (o) { return o.name === name; }); }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQX', 'Zqx Grill') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQXF', 'Zqx Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQX-1', 'Ama', dept);
  await person('kojo', 'ZQX-2', 'Kojo', dept);
  await person('yaw', 'ZQX-3', 'Yaw', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'waiter')", [company.id, people.kojo, people.yaw]);
  rice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqx jollof', 'Zqx Mains', 50, true) RETURNING id", [company.id])).rows[0].id;
  stew = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqx stew', 'Zqx Mains', 30, true) RETURNING id", [company.id])).rows[0].id;
  juice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqx sobolo', 'Zqx Drinks', 20, true) RETURNING id", [company.id])).rows[0].id;
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqx T1') RETURNING id", [company.id])).rows[0].id;
  t2 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqx T2') RETURNING id", [company.id])).rows[0].id;
  t3 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqx T3') RETURNING id", [company.id])).rows[0].id;
  await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zqx Kitchen', '{}', true)", [company.id]);
  for (var k of ['ama', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('add-ons: a manager makes the groups; the till prices what is picked; the kitchen sees it', async function () {
  await assert.rejects(access.menu(tok.ama, { action: 'saveGroup', group: { name: 'x' } }, IP), /type a manager's PIN/);
  await assert.rejects(access.menu(tok.kojo, { action: 'saveGroup', group: { name: 'Zqx side', minPick: 1, options: [] } }, IP), /add at least one choice/);
  await access.menu(tok.kojo, { action: 'saveGroup', group: { name: 'Zqx side', minPick: 1, maxPick: 1, options: [{ name: 'Zqx rice', price: 0 }, { name: 'Zqx banku', price: 5 }], itemIds: [rice, stew] } }, IP);
  var m = await access.menu(tok.kojo, { action: 'saveGroup', group: { name: 'Zqx extras', minPick: 0, maxPick: 2, options: [{ name: 'Zqx egg', price: 4 }, { name: 'Zqx pepper', price: 0 }, { name: 'Zqx fish', price: 12 }], itemIds: [rice] } }, IP);
  sides = m.groups.find(function (g) { return g.name === 'Zqx side'; });
  extras = m.groups.find(function (g) { return g.name === 'Zqx extras'; });
  assert.deepEqual(sides.itemIds.sort(), [rice, stew].sort());
  var tiles = await pos.menuForSession(tok.ama);
  var jollof = tiles.find(function (t) { return t.id === rice; });
  assert.deepEqual(jollof.addOns.map(function (g) { return g.name; }), ['Zqx side', 'Zqx extras']);
  assert.deepEqual(tiles.find(function (t) { return t.id === juice; }).addOns, []);

  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Abena', customerPhone: '0244000001', items: [{ menuItemId: rice, qty: 1 }], payments: cash(50) }), /Zqx jollof: pick one from Zqx side/);
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Abena', customerPhone: '0244000001',
    items: [{ menuItemId: rice, qty: 1, modifiers: [{ id: opt(sides, 'Zqx rice').id }, { id: opt(sides, 'Zqx banku').id }] }], payments: cash(60) }), /at most 1 from Zqx side/);
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Abena', customerPhone: '0244000001',
    items: [{ menuItemId: rice, qty: 1, modifiers: [{ id: opt(sides, 'Zqx banku').id }, { id: opt(sides, 'Zqx banku').id }, { id: '00000000-0000-0000-0000-000000000000' }] }], payments: cash(60) }), /no longer offered/);
  // Banku (+5), an egg (+4), no pepper (free), fish on the side (+12): 71 a plate.
  var sale = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Abena', customerPhone: '0244000001', payments: cash(200),
    items: [{ menuItemId: rice, qty: 2, modifiers: [{ id: opt(extras, 'Zqx pepper').id, how: 'no' }, { id: opt(sides, 'Zqx banku').id }, { id: opt(extras, 'Zqx egg').id }, { id: opt(extras, 'Zqx fish').id, how: 'side' }] }] });
  assert.equal(sale.total, 142);
  assert.deepEqual(sale.items[0].modifiers.map(function (x) { return [x.how, x.name, x.price]; }),
    [['add', 'Zqx banku', 5], ['add', 'Zqx egg', 4], ['no', 'Zqx pepper', 0], ['side', 'Zqx fish', 12]], 'in the menu\'s order, each with its price');
  assert.equal(sale.items[0].unitPrice, 71);
  var k = (await pool.query("SELECT i.mods FROM restaurant_kitchen_items i JOIN restaurant_kitchen_tickets t ON t.id = i.ticket_id WHERE t.order_id = $1", [sale.id])).rows;
  assert.equal(k.length, 1);
  var board = await kitchen.board(tok.ama, { station: 'all' });
  var dish = board.cooking.concat(board.ready || []).reduce(function (a, t) { return a.concat(t.items); }, []).find(function (i) { return i.name === 'Zqx jollof'; });
  assert.deepEqual(dish.mods, [{ how: 'add', name: 'Zqx banku' }, { how: 'add', name: 'Zqx egg' }, { how: 'no', name: 'Zqx pepper' }, { how: 'side', name: 'Zqx fish' }]);
  assert.equal(check.modsText(sale.items[0].modifiers), 'Zqx banku, Zqx egg, No Zqx pepper, Zqx fish on the side');
});

test('discounts and dishes on the house: allowed by role, by a manager\'s PIN, or ready-made for anyone', async function () {
  var line = { menuItemId: juice, qty: 2, discount: { kind: 'percent', value: 10 } };
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Kofi', customerPhone: '0244000002', items: [line], payments: cash(40) }), /needs a manager/);
  await assert.rejects(pos.approve(tok.ama, { managerPin: PINS.yaw, what: 'discount', discount: { kind: 'percent', value: 10 } }, IP), /cannot give discounts/);
  var ok = await pos.approve(tok.ama, { managerPin: PINS.kojo, what: 'discount', discount: { kind: 'percent', value: 10 } }, IP);
  assert.equal(ok.by, 'Kojo Zqx');
  // Another size of discount: that approval does not cover it.
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Kofi', customerPhone: '0244000002', payments: cash(40),
    items: [{ menuItemId: juice, qty: 2, discount: { kind: 'percent', value: 50, approval: ok.approval } }] }), /needs a manager/);
  var sale = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Kofi', customerPhone: '0244000002', payments: cash(100),
    items: [{ menuItemId: juice, qty: 2, discount: { kind: 'percent', value: 10, approval: ok.approval } }, { menuItemId: stew, qty: 1, modifiers: [{ id: opt(sides, 'Zqx rice').id }],
      comp: { reason: 'Zqx took too long', approval: (await pos.approve(tok.ama, { managerPin: PINS.kojo, what: 'comp', line: { menuItemId: stew, modifiers: [{ id: opt(sides, 'Zqx rice').id }] } }, IP)).approval } }] });
  assert.deepEqual([sale.itemsGross, sale.discountTotal, sale.subtotal, sale.total], [70, 34, 36, 36]);
  assert.deepEqual(sale.items.map(function (i) { return [i.name, i.gross, i.discount, i.lineTotal, i.discountName, i.compReason]; }),
    [['Zqx sobolo', 40, 4, 36, '10% off', null], ['Zqx stew', 30, 30, 0, 'On the house', 'Zqx took too long']]);
  var logged = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND ref_id = $2", [company.id, sale.id])).rows[0].summary;
  assert.match(logged, /10% off on Zqx sobolo \(Kojo Zqx\); Zqx stew on the house \(Zqx took too long, Kojo Zqx\)\./);
  // The manager may on their own; a ready-made discount open to anyone needs nobody.
  var mgr = await pos.createOrder(tok.kojo, { fulfillment: 'pickup', customerName: 'Zqx Kofi', customerPhone: '0244000002', payments: cash(100),
    items: [{ menuItemId: juice, qty: 1 }], adjust: { discount: { kind: 'amount', value: 5, name: 'Zqx regular' } } }).catch(function (e) { return e; });
  assert.match(String(mgr.message || ''), /drawer/i, 'a manager charges on their own drawer');
  await settings({ discounts: [{ name: 'Zqx happy hour', kind: 'percent', value: 20, open: true }, { name: 'Zqx staff meal', kind: 'percent', value: 50 }] });
  var presets = (await access.profile(tok.ama)).settings.discounts;
  var happy = presets.find(function (d) { return d.name === 'Zqx happy hour'; });
  var staffMeal = presets.find(function (d) { return d.name === 'Zqx staff meal'; });
  var hh = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Kofi', customerPhone: '0244000002', payments: cash(100),
    items: [{ menuItemId: juice, qty: 1 }, { menuItemId: stew, qty: 1, modifiers: [{ id: opt(sides, 'Zqx banku').id }] }], adjust: { discount: { presetId: happy.id } } });
  assert.deepEqual([hh.itemsGross, hh.discountTotal, hh.total, hh.billDiscount.name, hh.billDiscount.amount], [55, 11, 44, 'Zqx happy hour', 11]);
  assert.deepEqual(hh.items.map(function (i) { return i.lineTotal; }), [16, 28], 'shared over the dishes');
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Kofi', customerPhone: '0244000002', payments: cash(100),
    items: [{ menuItemId: juice, qty: 1 }], adjust: { discount: { presetId: staffMeal.id } } }), /needs a manager/);
});

test('an open order keeps its discounts with who allowed them; added to and paid without asking again', async function () {
  var ok = await pos.approve(tok.yaw, { managerPin: PINS.kojo, what: 'discount', discount: { kind: 'amount', value: 6 } }, IP);
  var tab = await pos.saveTab(tok.yaw, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: juice, qty: 1, discount: { kind: 'amount', value: 6, approval: ok.approval } }] });
  assert.equal(tab.total, 14);
  assert.deepEqual(tab.lines[0].discountSpec, { kind: 'amount', value: 6, name: 'Discount', by: 'Kojo Zqx' });
  // A new round: the discount stays (it was approved), the new dish is full price.
  tab = await pos.saveTab(tok.yaw, { id: tab.id, tableId: t1, fulfillment: 'dine_in',
    items: [{ menuItemId: juice, qty: 1, discount: tab.lines[0].discountSpec }, { menuItemId: stew, qty: 1, modifiers: [{ id: opt(sides, 'Zqx rice').id }] }] });
  assert.equal(tab.total, 44);
  var sale = await pos.createOrder(tok.ama, { tabId: tab.id, tableId: t1, fulfillment: 'dine_in', payments: cash(44),
    items: tab.lines.map(function (l) { return { menuItemId: l.menuItemId, qty: l.qty, modifiers: l.modifiers, discount: l.discountSpec }; }) });
  assert.deepEqual([sale.total, sale.discountTotal], [44, 6]);
});

test('service charge and taxes: on the order types picked, included or added, taken off with a manager', async function () {
  await assert.rejects(settings({ serviceCharge: { on: true, rate: 60, types: { dine_in: true } } }), /0.5 to 50/);
  await settings({ serviceCharge: { on: true, name: 'Zqx service', rate: 10, types: { dine_in: true }, taxed: true },
    tax: { included: true, list: [{ name: 'Zqx NHIL', rate: 2.5 }, { name: 'Zqx GETFund', rate: 2.5 }, { name: 'Zqx VAT', rate: 15, compound: true }] } });
  var dine = await pos.createOrder(tok.ama, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 2, modifiers: [{ id: opt(sides, 'Zqx rice').id }] }], payments: cash(110) });
  assert.deepEqual([dine.subtotal, dine.serviceCharge, dine.serviceName, dine.total, dine.taxTotal], [100, 10, 'Zqx service', 110, 0]);
  // Included: 110 holds 2.5% + 2.5% on the price before tax, and 15% on that and the levies.
  var base = 110 / (1.05 * 1.15);
  assert.deepEqual(dine.taxes.map(function (t) { return [t.name, t.amount, t.included]; }),
    [['Zqx NHIL', Math.round(base * 2.5) / 100, true], ['Zqx GETFund', Math.round(base * 2.5) / 100, true], ['Zqx VAT', Math.round(base * 1.05 * 15) / 100, true]]);
  assert.equal(dine.taxIncluded, Math.round(dine.taxes.reduce(function (a, t) { return a + t.amount; }, 0) * 100) / 100);
  var pick = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Esi', customerPhone: '0244000003', items: [{ menuItemId: juice, qty: 1 }], payments: cash(20) });
  assert.deepEqual([pick.serviceCharge, pick.total], [0, 20], 'no service charge on a pickup');
  // Added on top: the customer pays the taxes too.
  await settings({ tax: { included: false, list: [{ name: 'Zqx VAT', rate: 15 }] } });
  var added = await pos.createOrder(tok.ama, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: juice, qty: 2 }], payments: cash(100) });
  assert.deepEqual([added.subtotal, added.serviceCharge, added.taxTotal, added.total], [40, 4, 6.6, 50.6]);
  // Taken off: the cashier asks a manager.
  await assert.rejects(pos.createOrder(tok.ama, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: juice, qty: 2 }], adjust: { serviceOff: {} }, payments: cash(100) }), /service charge off needs a manager/);
  var off = await pos.approve(tok.ama, { managerPin: PINS.kojo, what: 'service' }, IP);
  var noService = await pos.createOrder(tok.ama, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: juice, qty: 2 }], adjust: { serviceOff: { approval: off.approval } }, payments: cash(100) });
  assert.deepEqual([noService.serviceCharge, noService.serviceOff, noService.total], [0, true, 46]);
  // A dish refunded gives back its share of the service charge and tax.
  var r = await money.refundSale(tok.ama, added.id, { reason: 'Zqx spilt', managerPin: PINS.kojo, method: 'cash', items: [{ id: (await money.saleForRefund(tok.ama, added.id)).items[0].id, qty: 1 }] }, IP);
  assert.equal(r.refund.amount, 25.3);
  // The sales report counts them.
  var rep = await access.salesReport(tok.kojo, {}, IP);
  assert.ok(rep.totals.serviceCharge >= 14 && rep.totals.taxAdded >= 6.6 && rep.totals.discounts >= 34, JSON.stringify(rep.totals));
  assert.ok(rep.comps.some(function (c) { return c.reason === 'Zqx took too long' && c.amount === 30; }));
  assert.ok(rep.addOns.some(function (a) { return a.name === 'Zqx banku' && a.qty >= 2; }));
  assert.ok(rep.taxes.some(function (t) { return t.name === 'Zqx VAT'; }));
  await settings({ serviceCharge: { on: false, rate: 10, types: { dine_in: true } }, tax: { included: true, list: [] } });
});

test('a bill paid dish by dish; dishes moved to another order; orders joined and moved; the kitchen keeps up', async function () {
  var tab = await pos.saveTab(tok.yaw, { tableId: t1, fulfillment: 'dine_in', waiterId: people.yaw,
    items: [{ menuItemId: rice, qty: 2, modifiers: [{ id: opt(sides, 'Zqx rice').id }] }, { menuItemId: juice, qty: 2 }] });
  var kitchenOf = async function (where, id) {
    return (await pool.query("SELECT i.name, i.qty, i.status, t.table_name FROM restaurant_kitchen_items i JOIN restaurant_kitchen_tickets t ON t.id = i.ticket_id WHERE t." + where + " = $1 AND i.status <> 'cancelled' ORDER BY i.name", [id])).rows
      .map(function (r) { return [r.name, Number(r.qty), r.table_name]; });
  };
  assert.deepEqual(await kitchenOf('tab_id', tab.id), [['Zqx jollof', 2, 'Zqx T1'], ['Zqx sobolo', 2, 'Zqx T1']]);
  // One guest pays for a plate and a drink; the rest stays open.
  var part = await pos.createOrder(tok.ama, { tabId: tab.id, keepRest: true, tableId: t1, fulfillment: 'dine_in', payments: cash(100),
    items: [{ menuItemId: rice, qty: 1, modifiers: [{ id: opt(sides, 'Zqx rice').id }] }, { menuItemId: juice, qty: 1 }] });
  assert.equal(part.total, 70);
  assert.equal(part.restOpen, tab.id);
  var left = (await pos.listTabs(tok.ama)).find(function (t) { return t.id === tab.id; });
  assert.deepEqual(left.lines.map(function (l) { return [l.name, l.qty]; }), [['Zqx jollof', 1], ['Zqx sobolo', 1]]);
  assert.deepEqual(await kitchenOf('order_id', part.id), [['Zqx jollof', 1, 'Zqx T1'], ['Zqx sobolo', 1, 'Zqx T1']], 'their food went with the sale');
  assert.deepEqual(await kitchenOf('tab_id', tab.id), [['Zqx jollof', 1, 'Zqx T1'], ['Zqx sobolo', 1, 'Zqx T1']]);
  // Saving it again sends nothing new and takes nothing off.
  var again = await pos.saveTab(tok.yaw, { id: tab.id, tableId: t1, fulfillment: 'dine_in', waiterId: people.yaw,
    items: left.lines.map(function (l) { return { menuItemId: l.menuItemId, qty: l.qty, modifiers: l.modifiers }; }) });
  assert.equal(again.kitchenTicket, null);
  assert.deepEqual(await kitchenOf('tab_id', tab.id), [['Zqx jollof', 1, 'Zqx T1'], ['Zqx sobolo', 1, 'Zqx T1']]);
  await assert.rejects(pos.createOrder(tok.ama, { tabId: tab.id, keepRest: true, tableId: t1, fulfillment: 'dine_in', payments: cash(100), items: [{ menuItemId: juice, qty: 3 }] }), /does not have that many/);

  // The drink moves to a new order at T2.
  await assert.rejects(pos.moveDishes(tok.yaw, tab.id, { lines: [Object.assign({}, left.lines[1], { qty: 1 })] }), /free table or give the new order a name/);
  var moved = await pos.moveDishes(tok.yaw, tab.id, { lines: [Object.assign({}, left.lines[1], { qty: 1 })], toTableId: t2 });
  assert.deepEqual(moved.from.lines.map(function (l) { return l.name; }), ['Zqx jollof']);
  assert.deepEqual([moved.to.tableName, moved.to.lines.map(function (l) { return l.name; })], ['Zqx T2', ['Zqx sobolo']]);
  assert.deepEqual(await kitchenOf('tab_id', moved.to.id), [['Zqx sobolo', 1, 'Zqx T2']], 'the kitchen sends it to T2');
  assert.deepEqual(await kitchenOf('tab_id', tab.id), [['Zqx jollof', 1, 'Zqx T1']]);
  // T2 joined back to T1; then T1 moved to T3, the kitchen told.
  var joined = await pos.mergeTabs(tok.yaw, moved.to.id, { intoTabId: tab.id });
  assert.deepEqual(joined.lines.map(function (l) { return [l.name, l.qty]; }), [['Zqx jollof', 1], ['Zqx sobolo', 1]]);
  assert.equal((await pos.listTabs(tok.ama)).some(function (t) { return t.id === moved.to.id; }), false);
  var other = await pos.saveTab(tok.yaw, { tableId: t2, fulfillment: 'dine_in', items: [{ menuItemId: juice, qty: 1 }] });
  await assert.rejects(pos.moveTab(tok.yaw, tab.id, { tableId: t2 }), /join the two instead/);
  var at3 = await pos.moveTab(tok.yaw, tab.id, { tableId: t3 });
  assert.equal(at3.tableName, 'Zqx T3');
  assert.deepEqual(await kitchenOf('tab_id', tab.id), [['Zqx jollof', 1, 'Zqx T3'], ['Zqx sobolo', 1, 'Zqx T3']]);
  var logged = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action IN ('till.moved', 'till.joined') ORDER BY at", [company.id])).rows.map(function (r) { return r.summary; });
  assert.deepEqual(logged, ['Moved 1× Zqx sobolo from Zqx T1 to Zqx T2.', 'Joined Zqx T2 to Zqx T1.', 'Moved Zqx T1 to Zqx T3.']);
  await pos.removeTab(tok.kojo, other.id);
  await pos.removeTab(tok.kojo, tab.id);
});

test('the receipt: a link on the restaurant\'s website, sent by WhatsApp or text message', async function () {
  var sale = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqx Akosua', customerPhone: '0244000009', payments: cash(60),
    items: [{ menuItemId: rice, qty: 1, modifiers: [{ id: opt(sides, 'Zqx banku').id }] }] });
  assert.match(sale.receiptUrl, /^https:\/\/online\.starbartema\.com\/receipt\/[A-Za-z0-9_-]{20,}$/);
  var token = sale.receiptUrl.split('/receipt/')[1];
  var page = await pos.publicReceipt(token);
  assert.deepEqual([page.restaurant.name, page.orderNo, page.total, page.items[0].modifiers[0].name], ['Zqx Grill', sale.orderNo, 55, 'Zqx banku']);
  assert.equal(JSON.stringify(page).indexOf('0244000009'), -1, 'no phone on the public page');
  assert.equal(JSON.stringify(page).indexOf('Akosua'), -1, 'nor the customer\'s name');
  await assert.rejects(pos.publicReceipt('not-a-token'), /not right/);
  await assert.rejects(pos.publicReceipt('A'.repeat(22)), /not right/);
  await assert.rejects(pos.sendReceipt(tok.ama, sale.id, { channel: 'whatsapp', phone: '12' }, IP), /phone number/);
  var wa = await pos.sendReceipt(tok.ama, sale.id, { channel: 'whatsapp', phone: '024 400 0009', text: 'Zqx thanks' }, IP);
  assert.equal(wa.url, 'https://wa.me/233244000009?text=' + encodeURIComponent('Zqx thanks ' + sale.receiptUrl));
  var sent = [];
  var real = { configured: sms.configured, send: sms.send };
  sms.configured = function () { return true; };
  sms.send = async function (o) { sent.push(o); return { id: null, to: o.to }; };
  try {
    var t = await pos.sendReceipt(tok.ama, sale.id, { channel: 'sms', phone: '+233244000009' }, IP);
    assert.equal(t.sent, true);
  } finally { sms.configured = real.configured; sms.send = real.send; }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+233244000009');
  assert.match(sent[0].message, /^Thank you for coming to Zqx Grill\. Your receipt ZQX-\d+ \(GHS 55\.00\): https:\/\/online\.starbartema\.com\/receipt\//);
  var again = await pos.receiptForSession(tok.ama, sale.id);
  assert.deepEqual(again.receiptSends.map(function (x) { return [x.channel, x.to, x.by]; }), [['whatsapp', '+233244000009', 'Ama Zqx'], ['sms', '+233244000009', 'Ama Zqx']]);
});

test('the bill\'s arithmetic: compound taxes added, a bill discount not on a delivery fee', function () {
  var s = { discounts: [], serviceCharge: { on: false }, tax: { included: false, list: [{ name: 'A', rate: 2.5 }, { name: 'B', rate: 15, compound: true }] } };
  var b = check.compute([{ name: 'x', qty: 1, unitPrice: 100, lineTotal: 100, modifiers: [] }, { name: 'Delivery fee', qty: 1, unitPrice: 10, lineTotal: 10, custom: true, fee: true, modifiers: [] }],
    { discount: { kind: 'percent', value: 10 } }, s, 'delivery', { companyId: 'c', name: 'Zqx', can: { discount: true } });
  assert.deepEqual([b.billDiscount, b.subtotal], [10, 100], 'the fee is not discounted');
  assert.deepEqual(b.taxes.map(function (t) { return t.amount; }), [2.5, 15.38]);
  assert.equal(b.total, 117.88);
});
