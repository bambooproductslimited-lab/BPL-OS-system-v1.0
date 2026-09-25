// Restaurants: stock received, used, thrown away and counted, with the
// history of each item; the sales overview (days, month against last month,
// best sellers, payments, voids) and the waste it reports. Runs against a
// throwaway company of its own so other test files' orders don't move the
// numbers.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var restaurant = require('../src/services/restaurant.service');
var overview = require('../src/services/restaurantOverview.service');
var pos = require('../src/services/restaurantPos.service');
var { buildContext } = require('../src/services/context.service');

var boss, viewer, cashierId, companyId, seq = 0;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
async function order(daysAgo, lines, opts) {
  opts = opts || {};
  var total = lines.reduce(function (s, l) { return s + l.qty * l.price; }, 0);
  var at = new Date(); at.setUTCDate(at.getUTCDate() - daysAgo); at.setUTCHours(opts.hour || 12, 0, 0, 0);
  if (at > new Date()) at = new Date(Date.now() - 60000);
  var o = (await pool.query(
    'INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, payment_method, status, created_at) VALUES ($1,$2,$3,$4,$4,$5,$6,$7) RETURNING id',
    [companyId, 'ZQR-' + Date.now() + '-' + (seq++), cashierId, total, opts.method || 'cash', opts.status || 'completed', at]
  )).rows[0];
  for (var i = 0; i < lines.length; i++) {
    await pool.query('INSERT INTO restaurant_order_items (order_id, menu_item_id, name, qty, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6)',
      [o.id, lines[i].id || null, lines[i].name, lines[i].qty, lines[i].price, lines[i].qty * lines[i].price]);
  }
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  viewer = limited(boss, ['restaurant.manage']);
  cashierId = boss.employee.id;
  companyId = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQR', 'Zqr Diner') RETURNING id")).rows[0].id;
});
test.after(async function () {
  await pool.query('DELETE FROM restaurant_orders WHERE company_id = $1', [companyId]);
  await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
  await pool.end();
});

test('stock is received (new cost and expiry), used, wasted and counted; never below zero; every move is in the history', async function () {
  var ing = await restaurant.createIngredient(boss, { companyId: companyId, name: 'Zqr tilapia', unit: 'kg', stockQty: 10, reorderLevel: 4, unitCost: 50 });
  await assert.rejects(function () { return restaurant.moveStock(viewer, 'ingredient', ing.id, { kind: 'used', qty: 1 }); }, /restaurant.manage/);
  await assert.rejects(function () { return restaurant.moveStock(boss, 'ingredient', ing.id, { kind: 'eaten', qty: 1 }); }, /What happened/);
  await assert.rejects(function () { return restaurant.moveStock(boss, 'ingredient', ing.id, { kind: 'used', qty: 0 }); }, /how much/);
  await assert.rejects(function () { return restaurant.moveStock(boss, 'ingredient', ing.id, { kind: 'used', qty: 11 }); }, /Only 10 kg/);

  var r = await restaurant.moveStock(boss, 'ingredient', ing.id, { kind: 'received', qty: 5, unitCost: 60, expiryDate: day(-4), note: 'Zqr market' });
  assert.deepEqual([r.stockQty, r.unitCost, String(r.expiryDate).slice(0, 10) === day(-4) || new Date(r.expiryDate).toISOString().slice(0, 10) === day(-4)], [15, 60, true]);
  assert.equal((await restaurant.moveStock(boss, 'ingredient', ing.id, { kind: 'used', qty: 6 })).stockQty, 9);
  assert.equal((await restaurant.moveStock(boss, 'ingredient', ing.id, { kind: 'wasted', qty: 2, note: 'Zqr spoiled' })).stockQty, 7);
  assert.equal((await restaurant.moveStock(boss, 'ingredient', ing.id, { kind: 'count', qty: 6.5 })).stockQty, 6.5);
  assert.equal((await restaurant.adjustIngredientStock(boss, ing.id, -0.5, 'old way')).stockQty, 6); // { delta } still works

  var h = await restaurant.stockHistory(viewer, 'ingredient', ing.id);
  assert.deepEqual(h.map(function (m) { return [m.kind, m.delta, m.qtyAfter]; }),
    [['used', -0.5, 6], ['count', -0.5, 6.5], ['wasted', -2, 7], ['used', -6, 9], ['received', 5, 15], ['count', 10, 10]]);
  assert.deepEqual([h[2].note, h[2].unitCost, !!h[2].byName], ['Zqr spoiled', 60, true]);

  var sup = await restaurant.createSupply(boss, { companyId: companyId, name: 'Zqr napkins', unit: 'pack', stockQty: 0, unitCost: 12 });
  assert.equal((await restaurant.moveStock(boss, 'supply', sup.id, { kind: 'received', qty: 20 })).stockQty, 20);
  assert.equal((await restaurant.stockHistory(viewer, 'supply', sup.id)).length, 1); // no opening move for an empty start
  await restaurant.removeSupply(boss, sup.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM restaurant_stock_moves WHERE item_id = $1", [sup.id])).rows[0].n, 0);
});

test('the overview adds up sales by day and month, ranks what sells, and keeps voided orders apart', async function () {
  var fish = await restaurant.createMenuItem(boss, { companyId: companyId, name: 'Zqr grilled fish', category: 'Mains', price: 120 });
  var beer = await restaurant.createMenuItem(boss, { companyId: companyId, name: 'Zqr beer', category: 'Drinks', price: 25 });
  await order(0, [{ id: fish.id, name: fish.name, qty: 2, price: 120 }, { id: beer.id, name: beer.name, qty: 4, price: 25 }], { hour: 19, method: 'mobile_money' });
  await order(0, [{ id: beer.id, name: beer.name, qty: 2, price: 25 }], { hour: 20 });
  await order(1, [{ id: fish.id, name: fish.name, qty: 1, price: 120 }]);
  await order(0, [{ id: fish.id, name: fish.name, qty: 5, price: 120 }], { status: 'voided' });
  await order(60, [{ id: fish.id, name: fish.name, qty: 9, price: 120 }]); // outside every window

  var o = await overview.overview(viewer, companyId);
  assert.equal(o.days.length, 35);
  var last = o.days[34], before = o.days[33];
  assert.deepEqual([last.day, last.orders, last.sales], [day(0), 2, 390]);
  assert.deepEqual([before.day, before.orders, before.sales], [day(1), 1, 120]);
  assert.deepEqual(o.items.map(function (i) { return [i.name, i.qty, i.revenue]; }), [['Zqr grilled fish', 3, 360], ['Zqr beer', 6, 150]]);
  assert.equal(o.items[0].menuItemId, fish.id);
  assert.deepEqual(o.voided7, { orders: 1, total: 600 });
  var mm = o.payments.find(function (p) { return p.method === 'mobile_money'; });
  assert.deepEqual([mm.orders, mm.sales], [1, 340]);
  assert.equal(o.hours.reduce(function (n, h) { return n + h.orders; }, 0), 3);
  assert.equal(o.staff[0].id, cashierId);
  var monthSales = new Date().getUTCDate() === 1 ? 390 : 510;
  assert.equal(o.month.sales, monthSales);
  // the 2 kg of tilapia thrown away in the first test, at 60 a kg
  assert.equal(o.stock.wasted30, 120);
  assert.equal(o.stock.bought30, 5 * 60); // the napkins went with their history when they were removed

  var list = await pos.listOrders(viewer, companyId, { from: day(0), to: day(0) });
  assert.deepEqual([list.total, list.voidedCount, list.revenueTotal], [3, 1, 390]); // a voided sale is not revenue

  var cos = await overview.companies(viewer);
  var mine = cos.find(function (c) { return c.id === companyId; });
  assert.deepEqual([mine.menuItems, mine.orders30, mine.salesToday], [2, 3, 390]);
  await assert.rejects(function () { return overview.overview(viewer, null); }, /Choose a restaurant/);
});
