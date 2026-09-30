var { fail } = require('../utils/errors');
var stockSheet = require('./stockSheet.service');

// Selling from stock. An invoice line that is a stock product (Products &
// inventory) takes its quantity off that product the moment the invoice is
// made; voiding or deleting the invoice puts it back.
//
// It goes through the daily stock sheet (stockSheet.service.js), so the
// sheet and the product's stock never disagree: the day's line gets the
// quantity in its Invoiced column — next to Sold, which stays for sales
// that aren't on an invoice, so nothing is counted twice — and the
// product's stock follows the day's closing as it always does. A day nobody
// has filled in yet is started the way the sheet starts it (opening = the
// last closing, received = that day's production). If the day was already
// counted, the count comes down too: whatever was invoiced after the count
// has left the shelf since.
//
// Every movement is kept (invoice_stock_moves), so an invoice's stock goes
// back exactly, and a product shows which invoices took from it.

function todayISO() { return new Date().toISOString().slice(0, 10); }
function round2(n) { return Math.round(n * 100) / 100; }

// The day's line for one product, as the sheet would show it.
async function dayLine(client, productId, date) {
  var saved = (await client.query('SELECT * FROM stock_sheet_lines WHERE product_id = $1 AND date = $2', [productId, date])).rows[0];
  if (saved) return Object.assign(stockSheet.lineFromRow(saved), { note: saved.note || '' });
  var before = (await client.query(
    'SELECT * FROM stock_sheet_lines WHERE product_id = $1 AND date < $2 ORDER BY date DESC LIMIT 1', [productId, date])).rows[0];
  var product = (await client.query('SELECT current_stock FROM products WHERE id = $1', [productId])).rows[0];
  var made = (await client.query(
    "SELECT coalesce(sum(qty), 0) AS qty FROM inventory_tx WHERE item_type = 'product' AND type = 'production_output' AND item_id = $1 AND date = $2",
    [productId, date])).rows[0];
  return {
    opening: before ? stockSheet.lineFromRow(before).closing : Number(product.current_stock),
    received: Number(made.qty) || 0, transferred: 0, breakage: 0, sold: 0, invoiced: 0, physical: null, note: ''
  };
}

// qty > 0 out to the customer, < 0 back into stock.
async function move(client, ctx, productId, qty, invoice, reason) {
  var date = todayISO();
  // One invoice at a time per product, so two sales can't both read the
  // same line and one of them be lost.
  await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [productId]);
  var line = await dayLine(client, productId, date);
  line.invoiced = round2(line.invoiced + qty);
  if (line.physical !== null) line.physical = Math.max(0, round2(line.physical - qty));
  await stockSheet.writeLine(client, ctx, date, productId, line);
  await client.query(
    'INSERT INTO invoice_stock_moves (invoice_id, invoice_no, product_id, qty, date, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [invoice.id, invoice.invoice_no, productId, round2(qty), date, reason, ctx.employee ? ctx.employee.id : null]);
}

// Right after an invoice's lines are saved, in the same transaction.
// Returns what was taken: [{ productId, qty }].
async function takeForInvoice(client, ctx, invoice) {
  var rows = (await client.query(
    "SELECT product_id, sum(qty) AS qty FROM document_line_items WHERE document_type = 'invoice' AND document_id = $1 AND product_id IS NOT NULL GROUP BY product_id",
    [invoice.id])).rows;
  for (var i = 0; i < rows.length; i++) await move(client, ctx, rows[i].product_id, Number(rows[i].qty), invoice, 'invoiced');
  return rows.map(function (r) { return { productId: r.product_id, qty: Number(r.qty) }; });
}

// Voided or deleted: everything the invoice still holds goes back.
async function giveBack(client, ctx, invoice, reason) {
  var rows = (await client.query(
    'SELECT product_id, sum(qty) AS qty FROM invoice_stock_moves WHERE invoice_id = $1 GROUP BY product_id HAVING sum(qty) > 0',
    [invoice.id])).rows;
  for (var i = 0; i < rows.length; i++) await move(client, ctx, rows[i].product_id, -Number(rows[i].qty), invoice, reason);
  return rows.map(function (r) { return { productId: r.product_id, qty: Number(r.qty) }; });
}

// Which stock product each line is, before the lines are saved (any
// document). A line picked from Products & Services whose item is linked
// to a stock product gets that product; a line whose code is a product's
// SKU gets that product. And when someone links a line to a product by
// hand, its Products & Services item remembers it, so next time it links
// by itself.
async function resolveLines(client, items) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i], code = String(it.itemNo || '').trim();
    if (it.productId) {
      var p = (await client.query('SELECT id FROM products WHERE id = $1', [it.productId])).rows[0];
      if (!p) fail('invalid', 'Line ' + (i + 1) + ' is linked to a stock product that no longer exists. Pick it again.');
      if (code) await client.query('UPDATE catalog_item_variations SET product_id = $1 WHERE code = $2 AND product_id IS NULL', [it.productId, code]);
      continue;
    }
    if (!code) continue;
    var v = (await client.query('SELECT product_id FROM catalog_item_variations WHERE code = $1 AND product_id IS NOT NULL LIMIT 1', [code])).rows[0];
    if (v) { it.productId = v.product_id; continue; }
    var bySku = (await client.query('SELECT id FROM products WHERE sku = $1 LIMIT 1', [code])).rows[0];
    if (bySku) it.productId = bySku.id;
  }
  return items;
}

module.exports = { takeForInvoice: takeForInvoice, giveBack: giveBack, resolveLines: resolveLines };
