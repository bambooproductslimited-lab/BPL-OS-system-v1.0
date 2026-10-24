// The sixth five from the Square list (migration 0183): combos and meal
// deals, automatic discounts and promo codes, barcodes at the till, low
// stock and purchase orders to suppliers, and closing the day. Fake Zql
// data only; nothing goes out: mail is caught.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var costs = require('../src/services/restaurantCosts.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7641', kojo: '7642', yaw: '7643' };
var IP = '10.9.8.1';
var company, dept, people = {}, tok = {}, rice, chicken, juice, regular, large, t1;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQL'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_day_closes WHERE company_id = ANY($1)', 'DELETE FROM restaurant_purchase_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_recipes WHERE company_id = ANY($1)', 'DELETE FROM restaurant_stock_moves WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_payments WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_ingredients WHERE company_id = ANY($1)', 'DELETE FROM restaurant_supplies WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_suppliers WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_tables WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM notifications WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQL-%')");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQL-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQL-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, role) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zql', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
  await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [company.id, people[key], role]);
}
async function settings(s) { await access.saveSettings(tok.kojo, { settings: s }, IP); }
function cash(total) { return [{ method: 'cash', currency: 'GHS', tendered: total }]; }
function manager(p) { return Object.assign({ managerPin: PINS.kojo }, p); }
async function dish(name, category, price, extra) {
  return (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active, track_stock, stock_qty, low_stock, unit_cost) VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8) RETURNING id',
    [company.id, name, category, price, !!(extra && extra.stock !== undefined), extra && extra.stock !== undefined ? extra.stock : 0, extra && extra.low || 0, extra && extra.cost || 0])).rows[0].id;
}
async function stockOf(id) { return Number((await pool.query('SELECT stock_qty FROM restaurant_menu_items WHERE id = $1', [id])).rows[0].stock_qty); }
async function tile(id) { return (await pos.menuForSession(tok.ama)).find(function (t) { return t.id === id; }); }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQL', 'Zql Grill') RETURNING *")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQLF', 'Zql Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQL-1', 'Ama', 'cashier');
  await person('kojo', 'ZQL-2', 'Kojo', 'manager');
  await person('yaw', 'ZQL-3', 'Yaw', 'waiter');
  rice = await dish('Zql jollof', 'Zql Mains', 50, { stock: 10, cost: 12 });
  chicken = await dish('Zql chicken', 'Zql Mains', 60, { stock: 1, cost: 20 });
  juice = await dish('Zql sobolo', 'Zql Drinks', 20, { stock: 20, low: 5, cost: 2 });
  regular = (await pool.query("INSERT INTO restaurant_menu_item_variations (menu_item_id, name, price, sort_order) VALUES ($1, 'Regular', 20, 0) RETURNING id", [juice])).rows[0].id;
  large = (await pool.query("INSERT INTO restaurant_menu_item_variations (menu_item_id, name, price, sort_order) VALUES ($1, 'Large', 30, 1) RETURNING id", [juice])).rows[0].id;
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name, seats, area) VALUES ($1, 'Zql T1', 4, 'Zql Patio') RETURNING id", [company.id])).rows[0].id;
  await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zql Kitchen', '{}', true)", [company.id]);
  for (var k of ['ama', 'kojo']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('combos: a set price for a main and a drink, each picked from the menu; the stock and the cost are the parts\'', async function () {
  var save = function (item) { return access.menu(tok.kojo, manager({ action: 'save', item: item }), IP); };
  var deal = { name: 'Zql lunch deal', category: 'Zql Deals', price: 65, combo: [
    { name: 'Main', options: [{ menuItemId: rice }, { menuItemId: chicken, extra: 8 }] },
    { name: 'Drink', options: [{ menuItemId: juice, variationId: regular }, { menuItemId: juice, variationId: large, extra: 5 }] }
  ] };
  await assert.rejects(save(Object.assign({}, deal, { combo: [{ name: 'Main', options: [] }] })), /dishes to pick from/);
  await assert.rejects(save(Object.assign({}, deal, { combo: [{ name: '', options: [{ menuItemId: rice }] }] })), /name/);
  await assert.rejects(save(Object.assign({}, deal, { combo: [{ name: 'Main', options: [{ menuItemId: '00000000-0000-0000-0000-000000000000' }] }] })), /not on this menu/);
  await assert.rejects(save(Object.assign({}, deal, { combo: [{ name: 'Drink', options: [{ menuItemId: rice, variationId: large }] }] })), /no such size/);
  var m = await save(deal);
  var combo = m.saved;
  var item = m.items.find(function (i) { return i.id === combo; });
  assert.deepEqual(item.combo.map(function (s) { return [s.name, s.minPick, s.maxPick, s.options.map(function (o) { return [o.name, o.extra]; })]; }), [
    ['Main', 1, 1, [['Zql jollof', 0], ['Zql chicken', 8]]],
    ['Drink', 1, 1, [['Zql sobolo — Regular', 0], ['Zql sobolo — Large', 5]]]
  ]);
  // A combo is made of dishes, not of combos; a dish in a combo cannot become one.
  await assert.rejects(save({ name: 'Zql big deal', category: 'Zql Deals', price: 90, combo: [{ name: 'Deal', options: [{ menuItemId: combo }] }] }), /not of combos/);
  await assert.rejects(save({ id: rice, name: 'Zql jollof', category: 'Zql Mains', price: 50, combo: [{ name: 'Side', options: [{ menuItemId: juice }] }] }), /choice in another combo/);

  // On the till: its slots are its add-ons, which must be picked.
  var t = await tile(combo);
  assert.equal(t.combo, true);
  assert.deepEqual(t.addOns.map(function (g) { return [g.name, g.combo, g.options.length]; }), [['Main', true, 2], ['Drink', true, 2]]);
  var opt = function (g, i) { return t.addOns[g].options[i].id; };
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Esi Zql', customerPhone: '0200000941', items: [{ menuItemId: combo, qty: 1, modifiers: [{ id: opt(0, 0) }] }], payments: cash(65) }), /pick one from Drink/);
  await assert.rejects(pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: combo, qty: 1, modifiers: [{ id: opt(0, 0), how: 'no' }, { id: opt(1, 0) }] }], payments: cash(65) }), /combo's choices/);
  // Chicken with a large drink: 65 + 8 + 5, twice.
  var s = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: combo, qty: 1, modifiers: [{ id: opt(0, 1) }, { id: opt(1, 1) }] }, { menuItemId: combo, qty: 1, modifiers: [{ id: opt(0, 0) }, { id: opt(1, 0) }] }], payments: cash(200) });
  assert.equal(Number(s.total), 78 + 65);
  // Its dishes come off the stock; the chicken is now sold out, also as a choice.
  assert.deepEqual([await stockOf(rice), await stockOf(chicken), await stockOf(juice)], [9, 0, 18]);
  t = await tile(combo);
  assert.deepEqual(t.addOns[0].options.map(function (o) { return !!o.soldOut; }), [false, true]);
  await assert.rejects(pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: combo, qty: 1, modifiers: [{ id: opt(0, 1) }, { id: opt(1, 0) }] }], payments: cash(73) }), /Zql chicken is sold out/);
  // What it cost: its parts', as it has none of its own.
  var lines = (await pool.query('SELECT unit_cost FROM restaurant_order_items WHERE order_id = $1 ORDER BY sort_order', [s.id])).rows;
  assert.deepEqual(lines.map(function (x) { return Number(x.unit_cost); }), [22, 14]);
  var c = await costs.tab(tok.kojo, manager({ action: 'list' }), IP);
  assert.equal(c.dishes.find(function (d) { return d.id === combo; }).cost, null);
  // Voided: its dishes go back.
  await pos.voidOrder({ can: function () { return true; } }, s.id);
  assert.deepEqual([await stockOf(rice), await stockOf(chicken), await stockOf(juice)], [10, 1, 20]);
  // No slots: a dish like any other.
  m = await save({ id: combo, name: 'Zql lunch deal', category: 'Zql Deals', price: 65, combo: [] });
  assert.deepEqual(m.items.find(function (i) { return i.id === combo; }).combo, []);
  assert.equal((await tile(combo)).combo, false);
});

test('deals: automatic discounts and promo codes on the bill, one at a time, the best; a large party\'s service charge', async function () {
  var check = require('../src/services/restaurantTillCheck.service');
  await pool.query('UPDATE restaurant_menu_items SET stock_qty = 100 WHERE id = $1', [rice]);
  var now = new Date();
  var hh = function (d) { return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
  var soon = new Date(now.getTime() + 2 * 3600000), later = new Date(now.getTime() + 3 * 3600000);
  await assert.rejects(settings({ promotions: [{ name: '', kind: 'percent', value: 10 }] }), /name/);
  await assert.rejects(settings({ promotions: [{ name: 'Zql x', kind: 'percent', value: 120 }] }), /percentage/);
  await assert.rejects(settings({ promotions: [{ name: 'Zql x', kind: 'buyget', value: 100 }] }), /buy how many/);
  await assert.rejects(settings({ promotions: [{ name: 'Zql x', kind: 'percent', value: 10, code: 'ab' }] }), /3 to 24/);
  await assert.rejects(settings({ promotions: [{ name: 'Zql x', kind: 'percent', value: 10, from: '12:00' }] }), /both times/);
  await assert.rejects(settings({ promotions: [{ name: 'Zql a', kind: 'percent', value: 5, code: 'ZQL1' }, { name: 'Zql b', kind: 'percent', value: 5, code: 'zql1' }] }), /Two deals/);
  await assert.rejects(settings({ partyService: { on: true, minGuests: 1, rate: 10 } }), /2 to 200/);
  await settings({
    promotions: [
      { id: 'zql-drinks', name: 'Zql drinks 10%', kind: 'percent', value: 10, categories: ['Zql Drinks'] },
      { id: 'zql-two-one', name: 'Zql jollof 2 + 1', kind: 'buyget', buy: 2, get: 1, value: 100, items: [rice] },
      { id: 'zql-big', name: 'Zql 30 off 200', kind: 'amount', value: 30, minSpend: 200, where: { online: false } },
      { id: 'zql-code', name: 'Zql code 25%', kind: 'percent', value: 25, code: ' zql 25 ', where: { till: true, kiosk: true, online: true } },
      { id: 'zql-later', name: 'Zql later 50%', kind: 'percent', value: 50, from: hh(soon), to: hh(later) },
      { id: 'zql-off', name: 'Zql off 90%', kind: 'percent', value: 90, on: false }
    ],
    partyService: { on: true, minGuests: 6, rate: 12.5, name: 'Zql party service' }
  });
  var s = (await access.profile(tok.ama)).settings;
  assert.equal(s.promotions.find(function (p) { return p.id === 'zql-code'; }).code, 'ZQL25');
  assert.deepEqual(s.promotions.find(function (p) { return p.id === 'zql-big'; }).where, { till: true, kiosk: true, online: false });
  // Two sobolos: 10% off them by itself.
  var a = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: juice, variationId: regular, qty: 2 }], payments: cash(36) });
  assert.equal(Number(a.total), 36);
  var line = (await pool.query('SELECT discount, discount_name FROM restaurant_order_items WHERE order_id = $1', [a.id])).rows[0];
  assert.deepEqual([Number(line.discount), line.discount_name], [4, 'Zql drinks 10%']);
  // Three jollof: the third free (50) beats 10% off the sobolo (2); one deal a bill.
  var b = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 3 }, { menuItemId: juice, variationId: regular, qty: 1 }], payments: cash(120) });
  assert.equal(Number(b.total), 120);
  // The code: 25% off, on top of nothing else; a wrong code fails.
  await assert.rejects(pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1 }], adjust: { promoCode: 'NOPE1' }, payments: cash(50) }), /NOPE1 is not right/);
  var c = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 2 }], adjust: { promoCode: 'zql25' }, payments: cash(75) });
  assert.equal(Number(c.total), 75);
  // GHS 30 off a bill of 200, on the till only.
  var lines4 = [{ menuItemId: rice, qty: 4 }];
  var d4 = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: lines4, payments: cash(150) });
  assert.equal(Number(d4.total), 150, 'buy 2 get 1 on four jollof (50 off) beats 30 off');
  var priced = (await pos.priceLines(pool, company.id, [{ menuItemId: chicken, qty: 1 }, { menuItemId: juice, variationId: large, qty: 5 }], false)).lines;
  var full = await access.settingsOf(company.id);
  var till = check.compute(priced, {}, full, 'dine_in', { can: {}, before: null });
  assert.deepEqual([till.promo.id, till.promo.amount, till.total], ['zql-big', 30, 180]);
  var web = check.compute(priced, {}, full, 'pickup', { can: {}, before: null, channel: 'online' });
  assert.deepEqual([web.promo.id, web.promo.amount, web.total], ['zql-drinks', 15, 195]);
  var app = check.compute(priced, {}, full, 'pickup', { can: {}, before: null, channel: 'app' });
  assert.deepEqual([app.promo, app.total], [null, 210]);
  // The later deal is on in its hours only; kept on an open order after them.
  var inHours = check.compute(priced, {}, full, 'dine_in', { can: {}, before: null, at: new Date(soon.getTime() + 60000) });
  assert.deepEqual([inHours.promo.id, inHours.total], ['zql-later', 105]);
  var kept = check.compute(priced, {}, full, 'dine_in', { can: {}, before: { items: [], adjust: { promo: { id: 'zql-later' } } } });
  assert.deepEqual([kept.promo.id, kept.total], ['zql-later', 105]);
  // A large party at a table: its service charge in place of none.
  var party = check.compute(priced, {}, full, 'dine_in', { can: {}, before: null, guests: 6 });
  assert.deepEqual([party.serviceCharge, party.serviceName, party.partyService, party.total], [22.5, 'Zql party service', true, 202.5]);
  assert.equal(check.compute(priced, {}, full, 'dine_in', { can: {}, before: null, guests: 5 }).serviceCharge, 0);
  assert.equal(check.compute(priced, {}, full, 'pickup', { can: {}, before: null, guests: 9 }).serviceCharge, 0);
  // An open order with 6 guests and the code, charged: kept as it was given.
  var tab = await pos.saveTab(tok.ama, { tableId: t1, fulfillment: 'dine_in', guests: 6, waiterId: people.yaw, items: [{ menuItemId: rice, qty: 2 }], adjust: { promoCode: 'ZQL25' } });
  assert.equal(tab.total, 75 + 9.38);
  var stored = (await pool.query('SELECT adjust FROM restaurant_open_tabs WHERE id = $1', [tab.id])).rows[0].adjust;
  assert.deepEqual([stored.promo.id, stored.promoCode], ['zql-code', 'ZQL25']);
  // The code taken off the deals since: the order keeps it.
  await settings({ promotions: full.promotions.map(function (p) { return p.id === 'zql-code' ? Object.assign({}, p, { on: false }) : p; }) });
  var paid = await pos.createOrder(tok.ama, { tabId: tab.id, tableId: t1, fulfillment: 'dine_in', waiterId: people.yaw, items: [{ menuItemId: rice, qty: 2 }], payments: cash(84.38) });
  assert.equal(Number(paid.total), 84.38);
  await settings({ promotions: [], partyService: { on: false } });
});

test('deals: the till\'s own sums (frontend till/promos.js) are the server\'s', async function () {
  var server = require('../src/services/restaurantPromos.service');
  var front = await import('../../frontend/src/pages/till/promos.js');
  var list = server.cleanList([
    { id: 'p1', name: 'Zql a', kind: 'percent', value: 12.5, categories: ['Zql Mains'] },
    { id: 'p2', name: 'Zql b', kind: 'buyget', buy: 1, get: 1, value: 50 },
    { id: 'p3', name: 'Zql c', kind: 'amount', value: 17, minSpend: 40, items: [rice, juice] },
    { id: 'p4', name: 'Zql d', kind: 'percent', value: 40, days: [(new Date().getUTCDay() + 1) % 7] }
  ]);
  var bills = [
    [{ menuItemId: rice, category: 'Zql Mains', qty: 3, total: 150 }, { menuItemId: juice, category: 'Zql Drinks', qty: 2, total: 40 }],
    [{ menuItemId: juice, category: 'Zql Drinks', qty: 1, total: 20 }, { menuItemId: null, category: '', qty: 1, total: 15, fee: true }],
    [{ menuItemId: chicken, category: 'Zql Mains', qty: 1, total: 60, discount: 6 }, { menuItemId: rice, category: 'Zql Mains', qty: 1, total: 50 }],
    [{ menuItemId: rice, category: 'zql mains', qty: 2, total: 99.99 }, { menuItemId: juice, category: 'Zql Drinks', qty: 3, total: 63.3 }]
  ];
  bills.forEach(function (b) {
    var sLines = b.map(function (l) { return { menuItemId: l.menuItemId, category: l.category, qty: l.qty, lineTotal: l.total - (l.discount || 0), discount: l.discount || 0, fee: !!l.fee }; });
    var fLines = b.map(function (l) { return { menuItemId: l.menuItemId, category: l.category, qty: l.qty, net: l.total - (l.discount || 0), discount: l.discount || 0, fee: !!l.fee }; });
    list.forEach(function (p) { assert.deepEqual(front.savingOf(p, fLines), server.savingOf(p, sLines), p.name); });
    var s = server.best(sLines, list, {}), f = front.bestDeal(fLines, list, {});
    assert.deepEqual(f && [f.promo.id, f.amount, f.shares], s && [s.promo.id, s.amount, s.shares]);
  });
  var full = await access.settingsOf(company.id);
  full.partyService = server.cleanParty({ on: true, minGuests: 4, rate: 9 });
  [[3, 'dine_in'], [4, 'dine_in'], [8, 'pickup']].forEach(function (x) { assert.deepEqual(front.serviceFor(full, x[1], x[0]), server.serviceFor(full, x[1], x[0])); });
});

test('barcodes: the till\'s tiles carry their codes; a new code is given to a dish by whoever counts the stock', async function () {
  await pool.query("UPDATE restaurant_menu_items SET sku = 'ZQL-6001' WHERE id = $1", [rice]);
  await pool.query("UPDATE restaurant_menu_item_variations SET sku = 'ZQL-6002' WHERE id = $1", [large]);
  var t = await tile(juice);
  assert.deepEqual(t.variations.map(function (v) { return [v.name, v.sku]; }), [['Regular', ''], ['Large', 'ZQL-6002']]);
  assert.equal((await tile(rice)).sku, 'ZQL-6001');
  // A cashier cannot; with a manager's PIN, or a role that counts the stock, yes.
  await assert.rejects(access.stock(tok.ama, { action: 'barcode', code: '4006381333931', menuItemId: juice, variationId: regular }, IP), /manager/i);
  var r = await access.stock(tok.ama, { action: 'barcode', code: '4006381333931', menuItemId: juice, variationId: regular, managerPin: PINS.kojo }, IP);
  assert.deepEqual(r.linked, { menuItemId: juice, variationId: regular, code: '4006381333931' });
  assert.equal((await tile(juice)).variations[0].sku, '4006381333931');
  await assert.rejects(access.stock(tok.kojo, { action: 'barcode', code: 'zql-6001', menuItemId: chicken }, IP), /on Zql jollof already/);
  await assert.rejects(access.stock(tok.kojo, { action: 'barcode', code: '4006381333931', menuItemId: chicken }, IP), /Zql sobolo — Regular already/);
  await assert.rejects(access.stock(tok.kojo, { action: 'barcode', code: 'a b', menuItemId: chicken }, IP), /scan it again/);
  r = await access.stock(tok.kojo, { action: 'barcode', code: '5000112637922', menuItemId: chicken }, IP);
  assert.equal((await tile(chicken)).sku, '5000112637922');
});

test('low stock and purchase orders: the managers are told, drafts per supplier, sent on WhatsApp or by email, received into the stock', async function () {
  var mail = require('../src/services/mail.service');
  var sent = [];
  mail.setTransportForTests({ sendMail: async function (m) { sent.push(m); return { messageId: 'zql' }; } });
  try {
    var tab = function (p) { return access.purchasing(tok.kojo, manager(p), IP); };
    await assert.rejects(access.purchasing(tok.ama, { managerPin: PINS.ama, action: 'list' }, IP), /manager/i);
    var oil = (await pool.query("INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, reorder_level, unit_cost) VALUES ($1, 'Zql palm oil', 'litre', 3, 5, 25) RETURNING id", [company.id])).rows[0].id;
    var cups = (await pool.query("INSERT INTO restaurant_supplies (company_id, name, unit, stock_qty, reorder_level, unit_cost) VALUES ($1, 'Zql cups', 'each', 100, 50, 0.5) RETURNING id", [company.id])).rows[0].id;
    await pool.query('UPDATE restaurant_menu_items SET stock_qty = 7, low_stock = 5 WHERE id = $1', [juice]);
    var l = await tab({ action: 'list' });
    assert.deepEqual(l.low.map(function (x) { return [x.name, x.stock, x.level, x.suggest]; }), [['Zql palm oil', 3, 5, 7]]);
    // A sale takes the sobolo under 5: the managers are told.
    await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: juice, variationId: regular, qty: 3 }], payments: cash(60) });
    var told = (await pool.query('SELECT title, body FROM notifications WHERE employee_id = $1 ORDER BY at DESC LIMIT 1', [people.kojo])).rows[0];
    assert.equal(told.title, 'Zql sobolo is running low');
    assert.match(told.body, /Zql sobolo: 4 left \(Zql Grill\)/);
    // Thrown away below its level: told again, for the cups.
    await access.stock(tok.kojo, { action: 'move', type: 'supply', id: cups, kind: 'wasted', qty: 60 }, IP);
    told = (await pool.query('SELECT title FROM notifications WHERE employee_id = $1 ORDER BY at DESC LIMIT 1', [people.kojo])).rows[0];
    assert.equal(told.title, 'Zql cups is running low');
    // Suppliers, and who each thing comes from.
    await assert.rejects(tab({ action: 'saveSupplier', supplier: { name: 'Zql Oils', email: 'not-an-email' } }), /email/);
    var oils = (await tab({ action: 'saveSupplier', supplier: { name: 'Zql Oils', phone: '0200000951', email: 'zql.oils@example.com' } })).done.supplierId;
    var packs = (await tab({ action: 'saveSupplier', supplier: { name: 'Zql Packs', phone: '0200000952' } })).done.supplierId;
    await tab({ action: 'setSupplier', type: 'ingredient', id: oil, supplierId: oils });
    l = await tab({ action: 'setSupplier', type: 'supply', id: cups, supplierId: packs });
    assert.deepEqual(l.suppliers.map(function (s) { return [s.name, s.items]; }), [['Zql Oils', 1], ['Zql Packs', 1]]);
    // Drafts from the low stock: one per supplier, one with none yet.
    var d = (await tab({ action: 'draftLow' })).done.orders;
    assert.deepEqual(d.map(function (o) { return [o.supplier.name, o.lines.map(function (x) { return [x.name, x.qty, x.unitCost]; })]; }).sort(), [
      ['', [['Zql sobolo', 6, 2]]], ['Zql Oils', [['Zql palm oil', 7, 25]]], ['Zql Packs', [['Zql cups', 60, 0.5]]]
    ]);
    var po = d.find(function (o) { return o.supplier.name === 'Zql Oils'; });
    assert.deepEqual([po.ref, po.status, po.total].slice(1), ['draft', 175]);
    // Changed, then sent by email; WhatsApp for the cups.
    po = (await tab({ action: 'draft', order: { id: po.id, supplierId: oils, expectedOn: '2026-11-02', lines: [{ type: 'ingredient', id: oil, qty: 8, unitCost: 24 }] } })).done.order;
    assert.equal(po.total, 192);
    var s1 = (await tab({ action: 'send', id: po.id, via: 'email' })).done;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'zql.oils@example.com');
    assert.match(sent[0].subject, /^Purchase order PO-\d{4} from Zql Grill$/);
    assert.match(sent[0].text, /• 8 litre Zql palm oil at GHS 24\.00 \/ litre/);
    assert.match(sent[0].text, /Needed by: 2026-11-02/);
    assert.equal(s1.order.status, 'sent');
    await assert.rejects(tab({ action: 'draft', order: { id: po.id, lines: [{ type: 'ingredient', id: oil, qty: 1 }] } }), /sent already/);
    var cupsPo = d.find(function (o) { return o.supplier.name === 'Zql Packs'; });
    var s2 = (await tab({ action: 'send', id: cupsPo.id, via: 'whatsapp' })).done;
    assert.match(s2.whatsappUrl, /^https:\/\/wa\.me\/233200000952\?text=Hello%20Zql%20Packs/);
    // On order now: not suggested again.
    l = await tab({ action: 'list' });
    assert.deepEqual(l.low.filter(function (x) { return x.type !== 'menu'; }).map(function (x) { return [x.name, x.onOrder, x.suggest]; }).sort(), [['Zql cups', 60, 0], ['Zql palm oil', 8, 0]]);
    // Received: 7 of the 8 came, at 26 each — into the stock, at that cost.
    var got = (await tab({ action: 'receive', id: po.id, lines: [{ id: po.lines[0].id, receivedQty: 7, unitCost: 26 }] })).done.order;
    assert.deepEqual([got.status, got.total, got.lines[0].receivedQty, got.receivedBy], ['received', 182, 7, 'Kojo Zql']);
    var ing = (await pool.query('SELECT stock_qty, unit_cost FROM restaurant_ingredients WHERE id = $1', [oil])).rows[0];
    assert.deepEqual([Number(ing.stock_qty), Number(ing.unit_cost)], [10, 26]);
    var move = (await pool.query("SELECT kind, delta, note FROM restaurant_stock_moves WHERE item_id = $1 ORDER BY created_at DESC LIMIT 1", [oil])).rows[0];
    assert.deepEqual([move.kind, Number(move.delta)], ['received', 7]);
    assert.match(move.note, /^PO-\d{4} · Zql Oils$/);
    await assert.rejects(tab({ action: 'receive', id: po.id }), /received already/);
    // The one with no supplier: cancelled.
    var none = d.find(function (o) { return !o.supplier.name; });
    l = await tab({ action: 'cancel', id: none.id });
    assert.equal(l.done.order.status, 'cancelled');
    await assert.rejects(tab({ action: 'removeSupplier', id: '00000000-0000-0000-0000-000000000000' }), /not this restaurant/);
    l = await tab({ action: 'removeSupplier', id: packs });
    assert.deepEqual(l.suppliers.map(function (x) { return x.name; }), ['Zql Oils']);
  } finally { mail.setTransportForTests(null); }
});

test('closing the day: the summary, closed once (again when asked), told to the managers, emailed, and by itself at the set time', async function () {
  var closeDay = require('../src/services/restaurantCloseDay.service');
  var mail = require('../src/services/mail.service');
  var sent = [];
  mail.setTransportForTests({ sendMail: async function (m) { sent.push(m); return { messageId: 'zql' }; } });
  try {
    var tab = function (p) { return access.closeDay(tok.kojo, manager(p), IP); };
    await assert.rejects(access.closeDay(tok.ama, { managerPin: PINS.ama }, IP), /manager/i);
    await assert.rejects(settings({ closeDay: { auto: true, at: '25:00' } }), /HH:MM/);
    await assert.rejects(settings({ closeDay: { emails: 'zql.owner@example.com, nope' } }), /not an email address|isn't an email/);
    await settings({ closeDay: { auto: false, at: '23:30', emails: 'zql.owner@example.com', whatsapp: '0200000961' } });
    // A day with sales a week ago, to compare with.
    var day = new Date().toISOString().slice(0, 10);
    var old = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1 }], payments: cash(50) });
    var weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    await pool.query('UPDATE restaurant_orders SET created_at = $2 WHERE id = $1', [old.id, weekAgo + 'T12:00:00Z']);
    var p = await tab({ action: 'preview' });
    assert.equal(p.day, day);
    assert.equal(p.closed, null);
    var s = p.live;
    assert.ok(s.sales.count >= 5);
    assert.equal(s.lastWeek.day, weekAgo);
    assert.ok(s.lastWeek.net >= 50);
    assert.ok(s.byMethod.some(function (m) { return m.method === 'cash' && m.name === 'Cash'; }));
    assert.ok(s.topItems.length > 0);
    assert.equal(s.drawers.length, 1);
    assert.equal(s.drawers[0].status, 'open');
    assert.ok(s.lowStock.count >= 1);
    // Closed: kept as it was, told, emailed, offered on WhatsApp.
    var c = await tab({ action: 'close', note: 'Zql quiet evening' });
    assert.equal(c.closed.day, day);
    assert.equal(c.closed.closedBy, 'Kojo Zql');
    assert.equal(c.closed.note, 'Zql quiet evening');
    assert.equal(c.closed.summary.sales.net, s.sales.net);
    assert.deepEqual(c.done.sent.email.to, ['zql.owner@example.com']);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /^Zql Grill — day closed \d{4}-\d{2}-\d{2}: GHS /);
    assert.match(sent[0].text, /Drawers:\n• Ama Zql: still open/);
    assert.match(sent[0].text, /Closed by Kojo Zql\./);
    assert.match(c.whatsappUrl, /^https:\/\/wa\.me\/233200000961\?text=/);
    assert.equal(c.history[0].day, day);
    // Once; again only when asked, up to date.
    await assert.rejects(tab({ action: 'close' }), /closed already by Kojo Zql/);
    await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 1 }], payments: cash(50) });
    c = await tab({ action: 'close', again: true });
    assert.equal(c.closed.summary.sales.count, s.sales.count + 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM restaurant_day_closes WHERE company_id = $1', [company.id])).rows[0].n, 1);
    // By itself: the day before's at a time before noon, the same day's after.
    assert.equal(closeDay.dueDay('23:30', new Date('2026-10-24T23:40:00Z')), '2026-10-24');
    assert.equal(closeDay.dueDay('23:30', new Date('2026-10-25T00:10:00Z')), '2026-10-24');
    assert.equal(closeDay.dueDay('03:00', new Date('2026-10-25T03:05:00Z')), '2026-10-24');
    assert.equal(closeDay.dueDay('03:00', new Date('2026-10-25T02:55:00Z')), '2026-10-23');
    await settings({ closeDay: { auto: true, at: '23:30', emails: [], whatsapp: '' } });
    var y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    var yo = await pos.createOrder(tok.ama, { tableId: t1, fulfillment: 'dine_in', items: [{ menuItemId: rice, qty: 2 }], payments: cash(100) });
    await pool.query('UPDATE restaurant_orders SET created_at = $2 WHERE id = $1', [yo.id, y + 'T13:00:00Z']);
    var n = await closeDay.runDue(new Date(y + 'T23:45:00Z'));
    assert.ok(n >= 1);
    var auto = (await pool.query('SELECT auto, closed_by, summary FROM restaurant_day_closes WHERE company_id = $1 AND day = $2', [company.id, y])).rows[0];
    assert.deepEqual([auto.auto, auto.closed_by, auto.summary.sales.net], [true, null, 100]);
    assert.equal(await closeDay.runDue(new Date(y + 'T23:55:00Z')) >= 0, true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM restaurant_day_closes WHERE company_id = $1 AND day = $2', [company.id, y])).rows[0].n, 1);
    await settings({ closeDay: { auto: false } });
  } finally { mail.setTransportForTests(null); }
});
