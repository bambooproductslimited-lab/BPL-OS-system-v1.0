var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function rowToWarehouse(r, extra) {
  return Object.assign({ id: r.id, code: r.code, name: r.name, location: r.location, capacity: Number(r.capacity) }, extra || {});
}

// kernel.js: handlers['warehouses.list']
async function list(ctx) {
  if (!ctx.can('inventory.read')) fail('forbidden', 'Your role does not allow this action (inventory.read).');
  var res = await pool.query(
    'SELECT w.*, coalesce((SELECT sum(quantity) FROM raw_batches r WHERE r.warehouse_id = w.id), 0) AS raw_qty FROM warehouses w ORDER BY w.name'
  );
  return res.rows.map(function (r) { return rowToWarehouse(r, { rawQty: Number(r.raw_qty) }); });
}

// kernel.js: handlers['warehouses.create']
async function create(ctx, p) {
  if (!ctx.can('warehouse.manage')) fail('forbidden', 'Your role does not allow this action (warehouse.manage).');
  var name = V.text(p.name, 'Warehouse name', 80);
  var code = 'WH-' + name.slice(0, 3).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  var res = await pool.query(
    'INSERT INTO warehouses (code, name, location, capacity) VALUES ($1,$2,$3,$4) RETURNING *',
    [code, name, (p.location || '').trim(), Math.max(0, Number(p.capacity) || 0)]
  );
  var w = res.rows[0];
  await audit(pool, ctx, 'warehouse.create', 'warehouse', w.id, 'Added warehouse ' + w.name + '.');
  return rowToWarehouse(w);
}

// kernel.js: handlers['warehouses.update']
async function update(ctx, id, p) {
  if (!ctx.can('warehouse.manage')) fail('forbidden', 'Your role does not allow this action (warehouse.manage).');
  var name = V.text(p.name, 'Warehouse name', 80);
  var res = await pool.query(
    'UPDATE warehouses SET name = $1, location = $2, capacity = $3 WHERE id = $4 RETURNING *',
    [name, (p.location || '').trim(), Math.max(0, Number(p.capacity) || 0), id]
  );
  if (!res.rows[0]) fail('notfound', 'Warehouse not found.');
  var w = res.rows[0];
  await audit(pool, ctx, 'warehouse.update', 'warehouse', w.id, 'Updated warehouse ' + w.name + '.');
  return rowToWarehouse(w);
}

// kernel.js: handlers['warehouses.delete']
async function remove(ctx, id) {
  if (!ctx.can('warehouse.manage')) fail('forbidden', 'Your role does not allow this action (warehouse.manage).');
  var res = await pool.query('SELECT * FROM warehouses WHERE id = $1', [id]);
  var w = res.rows[0];
  if (!w) fail('notfound', 'Warehouse not found.');
  var inUse = await pool.query('SELECT 1 FROM raw_batches WHERE warehouse_id = $1 LIMIT 1', [id]);
  if (inUse.rows.length) fail('conflict', 'Cannot delete ' + w.name + ' — it has stock recorded against it.');
  await pool.query('DELETE FROM warehouses WHERE id = $1', [id]);
  await audit(pool, ctx, 'warehouse.delete', 'warehouse', id, 'Deleted warehouse ' + w.name + '.');
  return true;
}

module.exports = { list: list, create: create, update: update, remove: remove };
