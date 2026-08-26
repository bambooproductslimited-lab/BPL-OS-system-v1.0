var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// Products & Services, restructured (migration 0027) to match Square's own
// catalog shape: an Item (this business's real Square catalog uses this
// heavily — items with anywhere from 1 to 22 variations) has one or more
// Variations, each the actual sellable/priced row. Real Categories replace
// the old free-text field.

function rowToVariation(r) {
  return {
    id: r.id, itemId: r.item_id, name: r.name, code: r.code, unit: r.unit,
    defaultQty: Number(r.default_qty), unitPrice: Number(r.unit_price), costPrice: Number(r.cost_price), active: r.active
  };
}

// 'Regular' (the default variation name for an item nobody bothered to name
// variations on) is never shown — same display rule squareImport.service.js
// already used before this redesign, so a single-variation item still reads
// as one plain product name, not "Widget - Regular".
function variationDisplayName(itemName, variationName) {
  return variationName && variationName !== 'Regular' ? itemName + ' — ' + variationName : itemName;
}

// kernel.js-style flat list — every existing consumer (Quotations,
// Estimates, Invoices, Waybills' "from catalogue" picker) expects one flat
// row per sellable thing, so a variation is that row, named to include its
// parent item.
async function list(ctx) {
  if (!ctx.can('catalog.read')) fail('forbidden', 'Your role does not allow this action (catalog.read).');
  var res = await pool.query(
    'SELECT v.*, i.name AS item_name FROM catalog_item_variations v JOIN catalog_items i ON i.id = v.item_id ORDER BY i.name, v.name'
  );
  return res.rows.map(function (r) {
    return Object.assign(rowToVariation(r), { name: variationDisplayName(r.item_name, r.name) });
  });
}

// Nested view for the Products & Services management screen itself.
async function listItems(ctx) {
  if (!ctx.can('catalog.read')) fail('forbidden', 'Your role does not allow this action (catalog.read).');
  var res = await pool.query(
    'SELECT i.*, c.name AS category_name, ' +
    "coalesce((SELECT json_agg(v.* ORDER BY v.name) FROM catalog_item_variations v WHERE v.item_id = i.id), '[]') AS variations " +
    'FROM catalog_items i LEFT JOIN catalog_categories c ON c.id = i.category_id ORDER BY i.name'
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, name: r.name, description: r.description, categoryId: r.category_id, categoryName: r.category_name || '—',
      taxRateId: r.tax_rate_id, active: r.active,
      variations: r.variations.map(rowToVariation)
    };
  });
}

async function listCategories(ctx) {
  if (!ctx.can('catalog.read')) fail('forbidden', 'Your role does not allow this action (catalog.read).');
  var res = await pool.query('SELECT * FROM catalog_categories ORDER BY name');
  return res.rows.map(function (r) { return { id: r.id, name: r.name }; });
}

async function createCategory(ctx, name) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  name = V.text(name, 'Category name', 100);
  var res = await pool.query('INSERT INTO catalog_categories (name) VALUES ($1) RETURNING *', [name]);
  await audit(pool, ctx, 'catalog.category.create', 'catalog_category', res.rows[0].id, 'Added category ' + name + '.');
  return { id: res.rows[0].id, name: res.rows[0].name };
}

function normalizeVariationInput(v) {
  return {
    name: (v.name || 'Regular').trim() || 'Regular',
    code: V.text(v.code, 'Variation code', 60).toUpperCase(),
    unit: v.unit || 'each',
    defaultQty: Math.max(1, Number(v.defaultQty) || 1),
    unitPrice: Math.max(0, Number(v.unitPrice) || 0),
    costPrice: Math.max(0, Number(v.costPrice) || 0)
  };
}

// kernel.js: handlers['catalog.create'] — an item is created together with
// its first variation (mirrors Square's own "New Item" flow, which always
// creates at least one variation alongside the item).
async function create(ctx, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var name = V.text(p.name, 'Name', 100);
  var variation = normalizeVariationInput({ name: p.variationName, code: p.code, unit: p.unit, defaultQty: p.defaultQty, unitPrice: p.unitPrice, costPrice: p.costPrice });

  var itemRes = await pool.query(
    'INSERT INTO catalog_items (name, description, category_id, tax_rate_id, active) VALUES ($1,$2,$3,$4,true) RETURNING *',
    [name, (p.description || '').trim(), p.categoryId || null, p.taxRateId || 'tx_zero']
  );
  var item = itemRes.rows[0];
  var varRes = await pool.query(
    'INSERT INTO catalog_item_variations (item_id, name, code, unit, default_qty, unit_price, cost_price, active) VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *',
    [item.id, variation.name, variation.code, variation.unit, variation.defaultQty, variation.unitPrice, variation.costPrice]
  );
  await audit(pool, ctx, 'catalog.create', 'catalog_item', item.id, 'Added catalogue item ' + item.name + '.');
  return { id: item.id, name: item.name, description: item.description, categoryId: item.category_id, taxRateId: item.tax_rate_id, active: item.active, variations: [rowToVariation(varRes.rows[0])] };
}

// kernel.js: handlers['catalog.update'] — item-level fields only; variation
// prices/codes are edited via the variation endpoints below.
async function update(ctx, id, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var existing = await pool.query('SELECT * FROM catalog_items WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Item not found.');
  var name = V.text(p.name, 'Name', 100);
  var res = await pool.query(
    'UPDATE catalog_items SET name = $1, description = $2, category_id = $3, tax_rate_id = $4 WHERE id = $5 RETURNING *',
    [name, (p.description || '').trim(), p.categoryId !== undefined ? (p.categoryId || null) : existing.rows[0].category_id, p.taxRateId || existing.rows[0].tax_rate_id, id]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'catalog.update', 'catalog_item', item.id, 'Updated catalogue item ' + item.name + '.');
  return { id: item.id, name: item.name, description: item.description, categoryId: item.category_id, taxRateId: item.tax_rate_id, active: item.active };
}

// kernel.js: handlers['catalog.setActive'] — archiving an item archives all
// its variations too (an archived product shouldn't have some variations
// still pickable); un-archiving only un-archives the item itself, leaving
// variation-level status as a separate, deliberate choice.
async function setActive(ctx, id, active) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var res = await pool.query('UPDATE catalog_items SET active = $1 WHERE id = $2 RETURNING *', [!!active, id]);
  if (!res.rows[0]) fail('notfound', 'Item not found.');
  if (!active) await pool.query('UPDATE catalog_item_variations SET active = false WHERE item_id = $1', [id]);
  var item = res.rows[0];
  await audit(pool, ctx, 'catalog.status', 'catalog_item', item.id, (item.active ? 'Activated ' : 'Deactivated ') + item.name + '.');
  return { id: item.id, active: item.active };
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

async function addVariation(ctx, itemId, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var itemRes = await pool.query('SELECT id FROM catalog_items WHERE id = $1', [itemId]);
  if (!itemRes.rows[0]) fail('notfound', 'Item not found.');
  var v = normalizeVariationInput(p);
  var res = await pool.query(
    'INSERT INTO catalog_item_variations (item_id, name, code, unit, default_qty, unit_price, cost_price, active) VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *',
    [itemId, v.name, v.code, v.unit, v.defaultQty, v.unitPrice, v.costPrice]
  );
  await audit(pool, ctx, 'catalog.variation.create', 'catalog_item_variation', res.rows[0].id, 'Added variation ' + v.name + '.');
  return rowToVariation(res.rows[0]);
}

async function updateVariation(ctx, id, p) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var existing = await pool.query('SELECT * FROM catalog_item_variations WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Variation not found.');
  var v = normalizeVariationInput(Object.assign({}, existing.rows[0], {
    name: p.name !== undefined ? p.name : existing.rows[0].name,
    code: p.code !== undefined ? p.code : existing.rows[0].code,
    unit: p.unit !== undefined ? p.unit : existing.rows[0].unit,
    defaultQty: p.defaultQty !== undefined ? p.defaultQty : existing.rows[0].default_qty,
    unitPrice: p.unitPrice !== undefined ? p.unitPrice : existing.rows[0].unit_price,
    costPrice: p.costPrice !== undefined ? p.costPrice : existing.rows[0].cost_price
  }));
  var res = await pool.query(
    'UPDATE catalog_item_variations SET name = $1, code = $2, unit = $3, default_qty = $4, unit_price = $5, cost_price = $6 WHERE id = $7 RETURNING *',
    [v.name, v.code, v.unit, v.defaultQty, v.unitPrice, v.costPrice, id]
  );
  await audit(pool, ctx, 'catalog.variation.update', 'catalog_item_variation', id, 'Updated variation ' + v.name + '.');
  return rowToVariation(res.rows[0]);
}

async function setVariationActive(ctx, id, active) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var res = await pool.query('UPDATE catalog_item_variations SET active = $1 WHERE id = $2 RETURNING *', [!!active, id]);
  if (!res.rows[0]) fail('notfound', 'Variation not found.');
  return rowToVariation(res.rows[0]);
}

async function removeVariation(ctx, id) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
  var existing = await pool.query('SELECT * FROM catalog_item_variations WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Variation not found.');
  var countRes = await pool.query('SELECT count(*)::int AS n FROM catalog_item_variations WHERE item_id = $1', [existing.rows[0].item_id]);
  if (countRes.rows[0].n <= 1) fail('conflict', 'An item must have at least one variation — delete the item itself instead.');
  await pool.query('DELETE FROM catalog_item_variations WHERE id = $1', [id]);
  await audit(pool, ctx, 'catalog.variation.delete', 'catalog_item_variation', id, 'Deleted variation ' + existing.rows[0].name + '.');
  return true;
}

module.exports = {
  list: list, listItems: listItems, listCategories: listCategories, createCategory: createCategory,
  create: create, update: update, setActive: setActive, remove: remove,
  addVariation: addVariation, updateVariation: updateVariation, setVariationActive: setVariationActive, removeVariation: removeVariation
};
