var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var fileStore = require('../lib/fileStore');
var stockSheet = require('./stockSheet.service');

// Finished products and their stock. The stock follows the daily stock
// sheet (stockSheet.service.js): a count, a delivery, breakage or a sale
// recorded here goes onto today's line of the sheet, so the two never
// disagree. Editing a product changes its details, never its stock.
// Migration 0085 adds a photo, a description and archiving.

function todayISO() { return new Date().toISOString().slice(0, 10); }
function num(v) { return v === null || v === undefined ? 0 : Number(v); }

function rowToProduct(r, extra) {
  return Object.assign({
    id: r.id, sku: r.sku, name: r.name, category: r.category, unit: r.unit, costPrice: num(r.cost_price),
    sellingPrice: num(r.selling_price), currentStock: num(r.current_stock), reorderLevel: num(r.reorder_level),
    description: r.description || '', active: r.active !== false,
    photo: r.photo_key && r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : null,
    lastCountedOn: r.last_counted_on || null, sheetOrder: r.sheet_order === null || r.sheet_order === undefined ? null : Number(r.sheet_order),
    updatedAt: r.updated_at || null
  }, extra || {});
}

// kernel.js: handlers['products.list'] — with what moved in the last 30
// days (from the stock sheet and production), for "days of stock left".
async function list(ctx) {
  if (!ctx.can('inventory.read')) fail('forbidden', 'Your role does not allow this action (inventory.read).');
  var res = await pool.query(
    'SELECT p.*, m.sold30, m.received30, m.breakage30, m.last_line, pr.made30 FROM products p ' +
    'LEFT JOIN (SELECT product_id, sum(sold) AS sold30, sum(received) AS received30, sum(breakage) AS breakage30, max(date) AS last_line ' +
    "  FROM stock_sheet_lines WHERE date > current_date - 30 GROUP BY product_id) m ON m.product_id = p.id " +
    "LEFT JOIN (SELECT output_product_id, sum(output_qty) AS made30 FROM production_batches WHERE status <> 'cancelled' AND date > current_date - 30 GROUP BY output_product_id) pr ON pr.output_product_id = p.id " +
    'ORDER BY p.sku'
  );
  return res.rows.map(function (r) {
    return rowToProduct(r, {
      lowStock: num(r.current_stock) <= num(r.reorder_level),
      sold30: num(r.sold30), received30: num(r.received30), breakage30: num(r.breakage30), made30: num(r.made30),
      lastSheetDate: r.last_line || null
    });
  });
}

function readDetails(p, existing) {
  var sku = V.text(p.sku, 'SKU', 30).toUpperCase();
  var name = V.text(p.name, 'Product name', 80);
  var category = V.text(p.category, 'Category', 40);
  return {
    sku: sku, name: name, category: category,
    unit: String(p.unit || (existing ? existing.unit : '') || 'unit').trim().slice(0, 20),
    costPrice: Math.max(0, Number(p.costPrice) || 0), sellingPrice: Math.max(0, Number(p.sellingPrice) || 0),
    reorderLevel: Math.max(0, Number(p.reorderLevel) || 0),
    description: p.description === undefined ? (existing ? existing.description : '') : String(p.description || '').trim().slice(0, 1000)
  };
}

// kernel.js: handlers['products.create'] — an opening stock is recorded in
// the stock history.
async function create(ctx, p) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  var d = readDetails(p, null);
  var existing = await pool.query('SELECT id FROM products WHERE sku = $1', [d.sku]);
  if (existing.rows[0]) fail('invalid', 'That SKU already exists.');
  var opening = Math.max(0, Number(p.currentStock) || 0);

  var res = await pool.query(
    'INSERT INTO products (sku, name, category, unit, cost_price, selling_price, current_stock, reorder_level, description, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) RETURNING *',
    [d.sku, d.name, d.category, d.unit, d.costPrice, d.sellingPrice, opening, d.reorderLevel, d.description]
  );
  var prod = res.rows[0];
  if (opening > 0) {
    await pool.query(
      "INSERT INTO inventory_tx (item_type, item_id, type, qty, date, user_id, reference, notes) VALUES ('product',$1,'opening',$2,$3,$4,$5,'Opening stock')",
      [prod.id, opening, todayISO(), ctx.employee.id, prod.sku]
    );
  }
  await audit(pool, ctx, 'product.create', 'product', prod.id, 'Added product ' + prod.sku + ' — ' + prod.name + '.');
  return rowToProduct(prod, { lowStock: num(prod.current_stock) <= num(prod.reorder_level) });
}

// kernel.js: handlers['products.update'] — details only; the stock changes
// with adjustStock (a count, a delivery, breakage or a sale).
async function update(ctx, id, p) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  var existing = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Product not found.');
  var d = readDetails(p, existing.rows[0]);
  if (d.sku !== existing.rows[0].sku) {
    var dupe = await pool.query('SELECT id FROM products WHERE sku = $1', [d.sku]);
    if (dupe.rows[0]) fail('invalid', 'That SKU already exists.');
  }

  var res = await pool.query(
    'UPDATE products SET sku = $1, name = $2, category = $3, unit = $4, cost_price = $5, selling_price = $6, reorder_level = $7, description = $8, updated_at = now() WHERE id = $9 RETURNING *',
    [d.sku, d.name, d.category, d.unit, d.costPrice, d.sellingPrice, d.reorderLevel, d.description, id]
  );
  var prod = res.rows[0];
  await audit(pool, ctx, 'product.update', 'product', prod.id, 'Updated product ' + prod.sku + '.');
  return rowToProduct(prod, { lowStock: num(prod.current_stock) <= num(prod.reorder_level) });
}

var MODES = {
  count: { field: 'physical', tx: 'adjustment' },
  received: { field: 'received', tx: 'received', sign: 1 },
  breakage: { field: 'breakage', tx: 'breakage', sign: -1 },
  sold: { field: 'sold', tx: 'sale', sign: -1 }
};

// A change to the stock, recorded on today's line of the daily stock sheet:
// counted on the shelf (the count becomes the stock), received, broken or
// damaged, or sold. A later movement on a day that was already counted moves
// that count too, so the day still closes at what is really there.
async function adjustStock(ctx, id, p) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  p = p || {};
  var mode = MODES[p.mode] ? p.mode : fail('invalid', 'Choose what happened to the stock.');
  var qty = Number(p.qty);
  if (!Number.isFinite(qty) || qty < 0 || qty > 1e9) fail('invalid', 'Enter a quantity, 0 or more.');
  if (mode !== 'count' && qty === 0) fail('invalid', 'Enter how many.');
  qty = Math.round(qty * 100) / 100;
  var reason = String(p.reason || '').trim().slice(0, 200);
  var prod = (await pool.query('SELECT * FROM products WHERE id = $1', [id])).rows[0];
  if (!prod) fail('notfound', 'Product not found.');

  var today = todayISO();
  var day = await stockSheet.getDay(ctx, today);
  var line = day.lines.filter(function (l) { return l.productId === id; })[0];
  var before = line ? line.closing : num(prod.current_stock);
  var next = {
    opening: line ? line.opening : num(prod.current_stock), received: line ? line.received : 0, transferred: line ? line.transferred : 0,
    breakage: line ? line.breakage : 0, sold: line ? line.sold : 0, physical: line ? line.physical : null,
    note: line && line.note ? line.note : ''
  };
  var m = MODES[mode];
  if (mode === 'count') {
    next.physical = qty;
  } else {
    next[m.field] = Math.round((next[m.field] + qty) * 100) / 100;
    if (next.physical !== null) next.physical = Math.max(0, Math.round((next.physical + m.sign * qty) * 100) / 100);
    if (m.sign < 0 && next.physical === null && stockSheet.computed(next).expected < 0) {
      fail('invalid', 'Only ' + before + ' ' + prod.unit + '(s) of ' + prod.name + ' are in stock.');
    }
  }
  if (reason) next.note = (next.note ? next.note + '; ' : '') + reason;
  next.note = next.note.slice(-300);

  var saved = await stockSheet.saveLine(ctx, today, id, next);
  var diff = Math.round((saved.closing - before) * 100) / 100;
  var txQty = mode === 'count' ? diff : m.sign * qty;
  if (txQty) {
    await pool.query(
      "INSERT INTO inventory_tx (item_type, item_id, type, qty, date, user_id, reference, notes) VALUES ('product',$1,$2,$3,$4,$5,$6,$7)",
      [id, m.tx, txQty, today, ctx.employee.id, p.reference || 'Stock sheet', reason]
    );
  }
  await audit(pool, ctx, 'product.stockAdjust', 'product', id,
    (mode === 'count' ? 'Counted ' : mode === 'received' ? 'Received ' : mode === 'breakage' ? 'Broken or damaged: ' : 'Sold ') +
    qty + ' ' + prod.unit + '(s) of ' + prod.sku + (reason ? ' — ' + reason : '') + '. Stock ' + before + ' → ' + saved.closing + '.');
  var fresh = (await list(ctx)).filter(function (x) { return x.id === id; })[0];
  return Object.assign(fresh, { stockBefore: before });
}

// One product's stock history: the stock sheet lines of the last 60 days
// (newest first) and the production that made it.
async function history(ctx, id) {
  if (!ctx.can('inventory.read')) fail('forbidden', 'Your role does not allow this action (inventory.read).');
  var prod = (await pool.query('SELECT id FROM products WHERE id = $1', [id])).rows[0];
  if (!prod) fail('notfound', 'Product not found.');
  var lines = (await pool.query(
    'SELECT l.date::text AS date, l.opening, l.received, l.transferred, l.breakage, l.sold, l.physical, l.note, e.first_name, e.last_name ' +
    'FROM stock_sheet_lines l LEFT JOIN employees e ON e.id = l.updated_by WHERE l.product_id = $1 AND l.date > current_date - 60 ORDER BY l.date DESC',
    [id]
  )).rows.map(function (r) {
    var line = { opening: num(r.opening), received: num(r.received), transferred: num(r.transferred), breakage: num(r.breakage), sold: num(r.sold), physical: r.physical === null ? null : num(r.physical) };
    return Object.assign({ date: r.date, note: r.note || '', by: r.first_name ? r.first_name + ' ' + r.last_name : null }, line, stockSheet.computed(line));
  });
  var made = (await pool.query(
    "SELECT pb.id, pb.batch_no, pb.date, pb.output_qty, pb.production_line FROM production_batches pb WHERE pb.output_product_id = $1 AND pb.status <> 'cancelled' ORDER BY pb.date DESC, pb.created_at DESC LIMIT 10",
    [id]
  )).rows.map(function (r) { return { id: r.id, batchNo: r.batch_no, date: r.date, qty: num(r.output_qty), line: r.production_line }; });
  return { lines: lines, production: made };
}

// Archive a product no longer made or sold: it drops off the page and the
// daily stock sheet; its history stays. Unarchiving brings it back.
async function setActive(ctx, id, active) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  var r = (await pool.query('UPDATE products SET active = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, !!active])).rows[0];
  if (!r) fail('notfound', 'Product not found.');
  await audit(pool, ctx, active ? 'product.unarchive' : 'product.archive', 'product', id, (active ? 'Brought back ' : 'Archived ') + r.sku + ' — ' + r.name + '.');
  return rowToProduct(r, { lowStock: num(r.current_stock) <= num(r.reorder_level) });
}

// Product photos: anyone who can see the stock sees them.
async function photoFor(ctx, id) {
  if (!ctx.can('inventory.read')) fail('forbidden', 'Your role does not allow this action (inventory.read).');
  var r = (await pool.query('SELECT photo_key FROM products WHERE id = $1', [id])).rows[0];
  if (!r || !r.photo_key) fail('notfound', 'No photo.');
  return r.photo_key;
}

// file undefined: nothing was sent; null: remove the photo.
async function setPhoto(ctx, id, file) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  if (file === undefined) fail('invalid', 'Choose a photo.');
  var r = (await pool.query('SELECT * FROM products WHERE id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Product not found.');
  var key = null;
  if (file) {
    if (!/^image\//.test(file.mimetype || '')) fail('invalid', 'That isn’t a photo.');
    key = await fileStore.put('product-' + r.sku + '.jpg', file.buffer, file.mimetype);
  }
  var updated;
  try {
    updated = (await pool.query('UPDATE products SET photo_key = $2, photo_updated_at = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, key, key ? new Date() : null])).rows[0];
  } catch (err) {
    if (key) await fileStore.del(key);
    throw err;
  }
  if (r.photo_key) await fileStore.del(r.photo_key);
  await audit(pool, ctx, 'product.photo', 'product', id, (key ? 'Changed the photo of ' : 'Removed the photo of ') + r.sku + '.');
  return rowToProduct(updated, { lowStock: num(updated.current_stock) <= num(updated.reorder_level) });
}

module.exports = {
  list: list, create: create, update: update, adjustStock: adjustStock, history: history,
  setActive: setActive, photoFor: photoFor, setPhoto: setPhoto
};
