var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function rowToProduct(r, extra) {
  return Object.assign({
    id: r.id, sku: r.sku, name: r.name, category: r.category, unit: r.unit, costPrice: Number(r.cost_price),
    sellingPrice: Number(r.selling_price), currentStock: Number(r.current_stock), reorderLevel: Number(r.reorder_level)
  }, extra || {});
}

// kernel.js: handlers['products.list']
async function list(ctx) {
  if (!ctx.can('inventory.read')) fail('forbidden', 'Your role does not allow this action (inventory.read).');
  var res = await pool.query('SELECT * FROM products ORDER BY sku');
  return res.rows.map(function (r) { return rowToProduct(r, { lowStock: Number(r.current_stock) <= Number(r.reorder_level) }); });
}

// kernel.js: handlers['products.create']
async function create(ctx, p) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  var sku = V.text(p.sku, 'SKU', 30).toUpperCase();
  var name = V.text(p.name, 'Product name', 80);
  var category = V.text(p.category, 'Category', 40);
  var existing = await pool.query('SELECT id FROM products WHERE sku = $1', [sku]);
  if (existing.rows[0]) fail('invalid', 'That SKU already exists.');

  var res = await pool.query(
    'INSERT INTO products (sku, name, category, unit, cost_price, selling_price, current_stock, reorder_level) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [sku, name, category, p.unit || 'unit', Math.max(0, Number(p.costPrice) || 0), Math.max(0, Number(p.sellingPrice) || 0), Math.max(0, Number(p.currentStock) || 0), Math.max(0, Number(p.reorderLevel) || 0)]
  );
  var prod = res.rows[0];
  await audit(pool, ctx, 'product.create', 'product', prod.id, 'Added product ' + prod.sku + ' — ' + prod.name + '.');
  return rowToProduct(prod);
}

// kernel.js: handlers['products.update']
async function update(ctx, id, p) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  var existing = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Product not found.');

  var sku = V.text(p.sku, 'SKU', 30).toUpperCase();
  var name = V.text(p.name, 'Product name', 80);
  var category = V.text(p.category, 'Category', 40);
  if (sku !== existing.rows[0].sku) {
    var dupe = await pool.query('SELECT id FROM products WHERE sku = $1', [sku]);
    if (dupe.rows[0]) fail('invalid', 'That SKU already exists.');
  }

  var res = await pool.query(
    'UPDATE products SET sku = $1, name = $2, category = $3, unit = $4, cost_price = $5, selling_price = $6, current_stock = $7, reorder_level = $8 WHERE id = $9 RETURNING *',
    [sku, name, category, p.unit || existing.rows[0].unit, Math.max(0, Number(p.costPrice) || 0), Math.max(0, Number(p.sellingPrice) || 0), Math.max(0, Number(p.currentStock) || 0), Math.max(0, Number(p.reorderLevel) || 0), id]
  );
  var prod = res.rows[0];
  await audit(pool, ctx, 'product.update', 'product', prod.id, 'Updated product ' + prod.sku + '.');
  return rowToProduct(prod);
}

module.exports = { list: list, create: create, update: update };
