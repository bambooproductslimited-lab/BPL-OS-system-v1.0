// Raw bamboo & production: what was received is kept apart from what is
// left; production records carry their workers and can be cancelled (the
// bamboo goes back, the output comes off stock); raw bamboo can be written
// off.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var raw = require('../src/services/rawBatches.service');
var production = require('../src/services/production.service');
var warehouses = require('../src/services/warehouses.service');
var { buildContext } = require('../src/services/context.service');

var boss, viewer, supplierId, warehouseId, productId, workerId;
var rawIds = [], batchIds = [];

async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}
async function stock(id) { return Number((await pool.query('SELECT current_stock FROM products WHERE id = $1', [id])).rows[0].current_stock); }

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  viewer = limited(boss, ['production.manage']);
  supplierId = (await pool.query('SELECT id FROM suppliers ORDER BY name LIMIT 1')).rows[0].id;
  warehouseId = (await pool.query("INSERT INTO warehouses (code, name, location, capacity) VALUES ('WH-ZQP', 'Zqp yard', 'Test', 5000) RETURNING id")).rows[0].id;
  productId = (await pool.query("INSERT INTO products (sku, name, category, unit, cost_price, current_stock) VALUES ('ZQP-001', 'Zqp slat', 'Test', 'piece', 4, 0) RETURNING id")).rows[0].id;
  workerId = (await ctxFor('samuel.kiptoo@bplghana.com')).employee.id;
});
test.after(async function () {
  await pool.query('DELETE FROM inventory_tx WHERE item_id = ANY($1::uuid[]) OR item_id = $2', [rawIds, productId]);
  await pool.query('DELETE FROM production_batches WHERE id = ANY($1::uuid[])', [batchIds]);
  await pool.query('DELETE FROM raw_batches WHERE id = ANY($1::uuid[])', [rawIds]);
  await pool.query('DELETE FROM products WHERE id = $1', [productId]);
  await pool.query('DELETE FROM warehouses WHERE id = $1', [warehouseId]);
  await pool.end();
});

test('receiving keeps what came in, the date, unit and cost per unit', async function () {
  var r = await raw.create(boss, { species: 'Zqp vulgaris', supplierId: supplierId, warehouseId: warehouseId, quantity: 400, unit: 'poles', qualityGrade: 'A', cost: 2000, dateReceived: '2026-01-05', notes: 'Zqp demo' });
  rawIds.push(r.id);
  assert.deepEqual([r.receivedQty, r.quantity, r.usedQty, r.unit, r.costPerUnit, r.dateReceived, r.notes], [400, 400, 0, 'poles', 5, '2026-01-05', 'Zqp demo']);
  assert.match(r.batchNo, /^RB-2026-\d{3}$/);
  await assert.rejects(function () { return raw.create(boss, { species: 'Zqp', supplierId: supplierId, warehouseId: warehouseId, quantity: 1, unit: 'litres' }); }, /Unit/);
  await assert.rejects(function () { return raw.create(boss, { species: 'Zqp', supplierId: supplierId, warehouseId: warehouseId, quantity: 1, dateReceived: '2999-01-01' }); }, /future/);
  await assert.rejects(function () { return raw.create(viewer, { species: 'Zqp', supplierId: supplierId, warehouseId: warehouseId, quantity: 1 }); }, /production.manage/);
});

test('production takes from the batch, adds stock, keeps its workers; cancelling puts it all back', async function () {
  var rb = await raw.create(boss, { species: 'Zqp oldhamii', supplierId: supplierId, warehouseId: warehouseId, quantity: 1000, cost: 3000 });
  rawIds.push(rb.id);
  var b = await production.create(boss, { rawBatchId: rb.id, outputProductId: productId, productionLine: 'Zqp line', inputQty: 250, outputQty: 500, wasteQty: 25, rejectedQty: 20, employeeIds: [workerId], notes: 'Zqp note' });
  batchIds.push(b.id);
  assert.deepEqual([b.productionLine, b.notes, b.workers.length, b.workers[0].id, b.rawUnit, b.productUnit], ['Zqp line', 'Zqp note', 1, workerId, 'kg', 'piece']);
  assert.deepEqual([b.yieldPerUnit, b.wastePct, b.rejectPct, b.rawCost, b.outputValue], [2, 10, 3.8, 750, 2000]);
  assert.equal(await stock(productId), 500);

  var after = (await raw.list(viewer)).find(function (x) { return x.id === rb.id; });
  assert.deepEqual([after.quantity, after.receivedQty, after.usedQty, after.productionCount], [750, 1000, 250, 1]);

  // received cannot be edited below what has been used
  await assert.rejects(function () { return raw.update(boss, rb.id, { species: 'Zqp oldhamii', supplierId: supplierId, warehouseId: warehouseId, quantity: 200 }); }, /already been used/);
  var edited = await raw.update(boss, rb.id, { species: 'Zqp oldhamii', supplierId: supplierId, warehouseId: warehouseId, quantity: 1100, cost: 3300 });
  assert.deepEqual([edited.receivedQty, edited.quantity], [1100, 850]);

  await assert.rejects(function () { return production.cancel(viewer, b.id, { reason: 'x' }); }, /production.manage/);
  await assert.rejects(function () { return production.cancel(boss, b.id, {}); }, /Reason/);
  var c = await production.cancel(boss, b.id, { reason: 'Zqp typed twice' });
  assert.deepEqual([c.status, c.cancelReason, !!c.cancelledAt, !!c.cancelledByName], ['cancelled', 'Zqp typed twice', true, true]);
  assert.equal(await stock(productId), 0);
  var back = (await raw.list(boss)).find(function (x) { return x.id === rb.id; });
  assert.deepEqual([back.quantity, back.usedQty, back.productionCount], [1100, 0, 0]);
  var sheet = (await pool.query("SELECT sum(qty)::float AS q FROM inventory_tx WHERE item_id = $1 AND type = 'production_output'", [productId])).rows[0].q;
  assert.equal(sheet, 0, 'the stock sheet sees no output for that day');
  await assert.rejects(function () { return production.cancel(boss, b.id, { reason: 'again' }); }, /already cancelled/);
});

test('cancelling is refused when the output has already left stock', async function () {
  var rb = await raw.create(boss, { species: 'Zqp sold', supplierId: supplierId, warehouseId: warehouseId, quantity: 100 });
  rawIds.push(rb.id);
  var b = await production.create(boss, { rawBatchId: rb.id, outputProductId: productId, inputQty: 100, outputQty: 40 });
  batchIds.push(b.id);
  var used = (await raw.list(boss)).find(function (x) { return x.id === rb.id; });
  assert.equal(used.status, 'depleted');
  await pool.query('UPDATE products SET current_stock = 10 WHERE id = $1', [productId]);
  await assert.rejects(function () { return production.cancel(boss, b.id, { reason: 'Zqp' }); }, /cannot be taken back/);
  await pool.query('UPDATE products SET current_stock = 0 WHERE id = $1', [productId]);
});

test('production checks the batch has enough, the people and the numbers', async function () {
  var rb = await raw.create(boss, { species: 'Zqp small', supplierId: supplierId, warehouseId: warehouseId, quantity: 50 });
  rawIds.push(rb.id);
  await assert.rejects(function () { return production.create(boss, { rawBatchId: rb.id, outputProductId: productId, inputQty: 60, outputQty: 1 }); }, /Only 50kg remain/);
  await assert.rejects(function () { return production.create(boss, { rawBatchId: rb.id, outputProductId: productId, inputQty: 10, outputQty: 1, wasteQty: 11 }); }, /Waste/);
  await assert.rejects(function () { return production.create(boss, { rawBatchId: rb.id, outputProductId: productId, inputQty: 10, outputQty: 1, employeeIds: ['00000000-0000-0000-0000-000000000000'] }); }, /staff list/);
  await assert.rejects(function () { return production.create(boss, { rawBatchId: rb.id, outputProductId: productId, inputQty: 10, outputQty: 1, date: '2999-01-01' }); }, /future/);
});

test('writing off takes from what is left and is recorded; warehouses show what they hold per unit', async function () {
  var rb = await raw.create(boss, { species: 'Zqp rotten', supplierId: supplierId, warehouseId: warehouseId, quantity: 80, unit: 'poles' });
  rawIds.push(rb.id);
  await assert.rejects(function () { return raw.writeOff(boss, rb.id, { qty: 10 }); }, /Reason/);
  await assert.rejects(function () { return raw.writeOff(boss, rb.id, { qty: 90, reason: 'Zqp' }); }, /Only 80poles/);
  var w = await raw.writeOff(boss, rb.id, { qty: 30, reason: 'Zqp termites' });
  assert.deepEqual([w.quantity, w.disposedQty, w.usedQty, w.status], [50, 30, 0, 'in_stock']);
  assert.match(w.notes, /Zqp termites/);

  var wh = (await warehouses.list(boss)).find(function (x) { return x.id === warehouseId; });
  assert.ok(wh.batchCount >= 2);
  assert.ok(wh.rawByUnit.some(function (u) { return u.unit === 'poles' && u.qty === 450; }));

  w = await raw.writeOff(boss, rb.id, { reason: 'Zqp the rest' });
  assert.deepEqual([w.quantity, w.disposedQty, w.status], [0, 80, 'disposed']);
});
