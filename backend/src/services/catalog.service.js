var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function rowToItem(r) {
  return {
    id: r.id, name: r.name, code: r.code, description: r.description, category: r.category, unit: r.unit,
    defaultQty: Number(r.default_qty), unitPrice: Number(r.unit_price), costPrice: Number(r.cost_price),
    taxRateId: r.tax_rate_id, active: r.active
  };
}

// kernel.js: handlers['catalog.list']
async function list(ctx) {
  if (!ctx.can('catalog.read')) fail('forbidden', 'Your role does not allow this action (catalog.read).');
  var res = await pool.query('SELECT * FROM catalog_items ORDER BY name');
  return res.rows.map(rowToItem);
}

// kernel.js: handlers['catalog.create']
async function create(ctx, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var name = V.text(p.name, 'Name', 100);
  var res = await pool.query(
    'INSERT INTO catalog_items (name, code, description, category, unit, default_qty, unit_price, cost_price, tax_rate_id, active) ' +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING *",
    [name, (p.code || '').trim().toUpperCase(), (p.description || '').trim(), (p.category || '').trim(), p.unit || 'each',
      Math.max(1, Number(p.defaultQty) || 1), Math.max(0, Number(p.unitPrice) || 0), Math.max(0, Number(p.costPrice) || 0), p.taxRateId || 'tx_zero']
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'catalog.create', 'catalog_item', item.id, 'Added catalogue item ' + item.name + '.');
  return rowToItem(item);
}

// kernel.js: handlers['catalog.setActive']
async function setActive(ctx, id, active) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var res = await pool.query('UPDATE catalog_items SET active = $1 WHERE id = $2 RETURNING *', [!!active, id]);
  if (!res.rows[0]) fail('notfound', 'Item not found.');
  var item = res.rows[0];
  await audit(pool, ctx, 'catalog.status', 'catalog_item', item.id, (item.active ? 'Activated ' : 'Deactivated ') + item.name + '.');
  return rowToItem(item);
}

// kernel.js: handlers['catalog.update']
async function update(ctx, id, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var existing = await pool.query('SELECT * FROM catalog_items WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Item not found.');
  var name = V.text(p.name, 'Name', 100);
  var res = await pool.query(
    'UPDATE catalog_items SET name = $1, code = $2, description = $3, category = $4, unit = $5, default_qty = $6, unit_price = $7, cost_price = $8, tax_rate_id = $9 WHERE id = $10 RETURNING *',
    [name, (p.code || '').trim().toUpperCase(), (p.description || '').trim(), (p.category || '').trim(), p.unit || existing.rows[0].unit,
      Math.max(1, Number(p.defaultQty) || 1), Math.max(0, Number(p.unitPrice) || 0), Math.max(0, Number(p.costPrice) || 0), p.taxRateId || existing.rows[0].tax_rate_id, id]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'catalog.update', 'catalog_item', item.id, 'Updated catalogue item ' + item.name + '.');
  return rowToItem(item);
}

// kernel.js: handlers['catalog.delete']
async function remove(ctx, id) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var res = await pool.query('SELECT name FROM catalog_items WHERE id = $1', [id]);
  if (!res.rows[0]) fail('notfound', 'Item not found.');
  await pool.query('DELETE FROM catalog_items WHERE id = $1', [id]);
  await audit(pool, ctx, 'catalog.delete', 'catalog_item', id, 'Deleted catalogue item ' + res.rows[0].name + '.');
  return true;
}

module.exports = { list: list, create: create, setActive: setActive, update: update, remove: remove };
