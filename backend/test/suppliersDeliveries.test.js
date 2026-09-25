// Suppliers: what each has delivered (raw bamboo batches), their delivery
// history, and switching one to inactive.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var suppliers = require('../src/services/suppliers.service');
var raw = require('../src/services/rawBatches.service');
var { buildContext } = require('../src/services/context.service');

var boss, viewer, supId, whId, whName, rawIds = [];
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  viewer = limited(boss, ['supplier.manage']);
  supId = (await suppliers.create(boss, { name: 'Zqs farmer', contactPerson: 'Zqs farmer', materialsSupplied: 'Bamboo', phone: '0240000000', region: 'Zqs' })).id;
  // A seeded warehouse: other tests count them, so none is added here.
  var wh = (await pool.query('SELECT id, name FROM warehouses ORDER BY name LIMIT 1')).rows[0];
  whId = wh.id;
  whName = wh.name;
});
test.after(async function () {
  await pool.query('DELETE FROM raw_batches WHERE id = ANY($1::uuid[])', [rawIds]);
  await pool.query('DELETE FROM suppliers WHERE id = $1', [supId]);
  await pool.end();
});

test('the list shows what each supplier delivered; the history lists every batch', async function () {
  var thisYear = new Date().getFullYear();
  rawIds.push((await raw.create(boss, { species: 'Zqs vulgaris', supplierId: supId, warehouseId: whId, quantity: 300, unit: 'bundles', cost: 1500, dateReceived: thisYear + '-01-02' })).id);
  rawIds.push((await raw.create(boss, { species: 'Zqs vulgaris', supplierId: supId, warehouseId: whId, quantity: 200, unit: 'bundles', cost: 1000, dateReceived: (thisYear - 1) + '-12-20' })).id);
  var s = (await suppliers.list(viewer)).find(function (x) { return x.id === supId; });
  assert.deepEqual([s.batchCount, s.delivered, s.deliveredUnit, s.deliveredCost, s.lastDelivery, s.yearDelivered, s.yearCost],
    [2, 500, 'bundles', 2500, thisYear + '-01-02', 300, 1500]);
  var d = await suppliers.deliveries(viewer, supId);
  assert.deepEqual(d.map(function (x) { return [x.received, x.unit, x.warehouse]; }), [[300, 'bundles', whName], [200, 'bundles', whName]]);
  await assert.rejects(function () { return suppliers.deliveries(limited(boss, ['supplier.read']), supId); }, /supplier.read/);
});

test('a supplier can be switched to inactive and back; other fields stay', async function () {
  var u = await suppliers.update(boss, supId, { name: 'Zqs farmer', contactPerson: 'Zqs farmer', materialsSupplied: 'Bamboo', status: 'inactive' });
  assert.deepEqual([u.status, u.region, u.phone], ['inactive', 'Zqs', '']);
  u = await suppliers.update(boss, supId, { name: 'Zqs farmer', contactPerson: 'Zqs farmer', materialsSupplied: 'Bamboo', phone: '0240000000', status: 'active' });
  assert.equal(u.status, 'active');
  await assert.rejects(function () { return suppliers.update(boss, supId, { name: 'Zqs farmer', contactPerson: 'Zqs farmer', materialsSupplied: 'Bamboo', status: 'gone' }); }, /Status/);
});
