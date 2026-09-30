/*
 * Selling from stock (inventorySales.service.js): an invoice takes what it
 * sells off Products & inventory through the daily stock sheet's Invoiced
 * column, and a voided or deleted invoice puts it back.
 *
 * Products, customers and documents use the Z8S prefix and are removed.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var invoices = require('../src/services/invoices.service');
var quotations = require('../src/services/quotations.service');
var stockSheet = require('../src/services/stockSheet.service');
var products = require('../src/services/products.service');
var catalog = require('../src/services/catalog.service');
var { buildContext } = require('../src/services/context.service');

var admin, cust, slat, pole, variation;
function today() { return new Date().toISOString().slice(0, 10); }
function yesterday() { return new Date(Date.now() - 86400000).toISOString().slice(0, 10); }
async function stock(id) { return Number((await pool.query('SELECT current_stock FROM products WHERE id = $1', [id])).rows[0].current_stock); }
async function line(id, date) { return (await pool.query('SELECT * FROM stock_sheet_lines WHERE product_id = $1 AND date = $2', [id, date || today()])).rows[0]; }
async function moves(invoiceId) {
  return (await pool.query('SELECT product_id, qty::float AS qty, reason FROM invoice_stock_moves WHERE invoice_id = $1 OR invoice_no = $2 ORDER BY created_at, qty DESC', [invoiceId, invoiceId])).rows;
}
function invoice(items) { return invoices.createManual(admin, { customerId: cust, items: items }); }

async function cleanup() {
  var ids = "(SELECT id FROM products WHERE sku LIKE 'Z8S-%')";
  var inv = "(SELECT id FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Z8S%'))";
  var quo = "(SELECT id FROM quotations WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Z8S%'))";
  await pool.query('DELETE FROM invoice_stock_moves WHERE product_id IN ' + ids);
  await pool.query('DELETE FROM stock_sheet_lines WHERE product_id IN ' + ids);
  await pool.query('DELETE FROM receipts WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM payments WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM document_line_items WHERE document_id IN ' + inv + ' OR document_id IN ' + quo);
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query('DELETE FROM quotations WHERE id IN ' + quo);
  await pool.query("DELETE FROM catalog_items WHERE name LIKE 'Z8S%'");
  await pool.query('DELETE FROM products WHERE id IN ' + ids);
  await pool.query("DELETE FROM customers WHERE name LIKE 'Z8S%'");
}

test.before(async function () {
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = (await pool.query("INSERT INTO customers (name, email) VALUES ('Z8S Builders', '') RETURNING id")).rows[0].id;
  slat = (await pool.query("INSERT INTO products (sku, name, unit, current_stock, selling_price) VALUES ('Z8S-SLAT', 'Z8S Bamboo slat 8ft', 'each', 100, 25) RETURNING id")).rows[0].id;
  pole = (await pool.query("INSERT INTO products (sku, name, unit, current_stock, selling_price) VALUES ('Z8S-POLE', 'Z8S Bamboo pole', 'each', 40, 60) RETURNING id")).rows[0].id;
  // The pole was on yesterday's sheet: 50 in, 10 sold, closing 40.
  await pool.query("INSERT INTO stock_sheet_lines (date, product_id, opening, received, transferred, breakage, sold) VALUES ($1, $2, 50, 0, 0, 0, 10)", [yesterday(), pole]);
  var item = (await pool.query("INSERT INTO catalog_items (name) VALUES ('Z8S Slat bundle') RETURNING id")).rows[0].id;
  variation = (await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price) VALUES ($1, 'Regular', 'Z8S-V1', 'each', 30) RETURNING id", [item])).rows[0].id;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('an invoice takes its stock products off stock, through the day\'s stock sheet line', async function () {
  var inv = await invoice([
    { description: 'Z8S slats', qty: 30, unitPrice: 25, productId: slat },
    { description: 'Z8S poles', qty: 5, unitPrice: 60, productId: pole },
    { description: 'Z8S labour', qty: 1, unitPrice: 500 }
  ]);
  assert.equal(await stock(slat), 70);
  assert.equal(await stock(pole), 35);
  var s = await line(slat);
  assert.deepEqual([Number(s.opening), Number(s.sold), Number(s.invoiced)], [100, 0, 30], 'a new day starts at the stock, the sale is Invoiced — not Sold');
  var p = await line(pole);
  assert.deepEqual([Number(p.opening), Number(p.invoiced)], [40, 5], 'opens at yesterday\'s closing');
  assert.deepEqual((await moves(inv.id)).map(function (m) { return [m.qty, m.reason]; }).sort(), [[30, 'invoiced'], [5, 'invoiced']]);
  // The lines remember their product.
  assert.equal(inv.items.filter(function (it) { return it.productId; }).length, 2);

  // The sheet shows it, and a hand-entered sale that day adds to it rather than replacing it.
  var day = await stockSheet.getDay(admin, today());
  var row = day.lines.find(function (l) { return l.productId === slat; });
  assert.equal(row.invoiced, 30);
  assert.equal(row.closing, 70);
  await stockSheet.saveLine(admin, today(), slat, { opening: 100, received: 0, transferred: 0, breakage: 0, sold: 5, physical: '' });
  assert.equal(await stock(slat), 65, 'sold by hand 5 more, invoiced 30 kept');
  assert.equal(Number((await line(slat)).invoiced), 30);

  // Voided: back in stock.
  await invoices.voidInvoice(admin, inv.id);
  assert.equal(await stock(slat), 95);
  assert.equal(await stock(pole), 40);
  assert.equal(Number((await line(slat)).invoiced), 0);
  assert.deepEqual((await moves(inv.id)).filter(function (m) { return m.reason === 'voided'; }).map(function (m) { return m.qty; }).sort(), [-30, -5]);
  await assert.rejects(invoices.voidInvoice(admin, inv.id), /already been voided/);
  assert.equal(await stock(slat), 95, 'not twice');
});

test('deleting an invoice puts its stock back too, and the record keeps the invoice number', async function () {
  var inv = await invoice([{ description: 'Z8S slats', qty: 10, unitPrice: 25, productId: slat }]);
  assert.equal(await stock(slat), 85);
  await invoices.remove(admin, inv.id);
  assert.equal(await stock(slat), 95);
  var kept = (await pool.query("SELECT invoice_id, qty::float AS qty, reason FROM invoice_stock_moves WHERE invoice_no = $1 ORDER BY created_at", [inv.invoiceNo])).rows;
  assert.deepEqual(kept.map(function (m) { return [m.invoice_id, m.qty, m.reason]; }), [[null, 10, 'invoiced'], [null, -10, 'deleted']]);
});

test('a Products & Services item learns its stock product, and a SKU code links by itself', async function () {
  // Linked by hand once, on a line picked from the catalogue…
  await invoice([{ itemNo: 'Z8S-V1', description: 'Z8S Slat bundle', qty: 2, unitPrice: 30, productId: slat }]);
  assert.equal((await pool.query('SELECT product_id FROM catalog_item_variations WHERE id = $1', [variation])).rows[0].product_id, slat);
  var before = await stock(slat);
  // …the next time it links itself.
  var inv = await invoice([{ itemNo: 'Z8S-V1', description: 'Z8S Slat bundle', qty: 3, unitPrice: 30 }]);
  assert.equal(inv.items[0].productId, slat);
  assert.equal(await stock(slat), before - 3);
  // A code that is a product's SKU.
  var p0 = await stock(pole);
  await invoice([{ itemNo: 'Z8S-POLE', description: 'Z8S poles', qty: 4, unitPrice: 60 }]);
  assert.equal(await stock(pole), p0 - 4);
  // The catalogue shows the link, with the product's stock.
  var row = (await catalog.list(admin)).find(function (v) { return v.id === variation; });
  assert.equal(row.productId, slat);
  assert.equal(row.product.stock, await stock(slat));
  // …and can be changed or cleared.
  await catalog.updateVariation(admin, variation, { productId: null });
  assert.equal((await pool.query('SELECT product_id FROM catalog_item_variations WHERE id = $1', [variation])).rows[0].product_id, null);
});

test('counted already today: the count comes down with the sale', async function () {
  var d = await stockSheet.getDay(admin, today());
  var cur = d.lines.find(function (l) { return l.productId === pole; });
  await stockSheet.saveLine(admin, today(), pole, { opening: cur.opening, received: 0, transferred: 0, breakage: 0, sold: 0, physical: 30 });
  assert.equal(await stock(pole), 30);
  await invoice([{ description: 'Z8S poles', qty: 6, unitPrice: 60, productId: pole }]);
  assert.equal(await stock(pole), 24);
  assert.equal(Number((await line(pole)).physical), 24);
});

test('a quotation doesn\'t take stock; the invoice made from it does', async function () {
  var q = await quotations.create(admin, { customerId: cust, items: [{ description: 'Z8S slats', qty: 7, unitPrice: 25, productId: slat }] });
  var before = await stock(slat);
  assert.equal(await stock(slat), before);
  await pool.query("UPDATE quotations SET status = 'accepted' WHERE id = $1", [q.id]);
  var inv = await invoices.createFromQuotation(admin, q.id);
  assert.equal(inv.items[0].productId, slat);
  assert.equal(await stock(slat), before - 7);
});

test('a product shows which invoices took from it; a vanished product is refused', async function () {
  var h = await products.history(admin, slat);
  assert.ok(h.invoiced.length >= 3);
  assert.ok(h.invoiced.some(function (m) { return m.reason === 'voided' && m.qty === -30; }));
  assert.ok(h.lines[0].invoiced > 0);
  await assert.rejects(invoice([{ description: 'Z8S ghost', qty: 1, unitPrice: 1, productId: '00000000-0000-4000-8000-000000000000' }]), /no longer exists/);
});

test('Products & Services: an invoice takes an item\'s own stock too, puts it back, and never below 0', async function () {
  var item = (await pool.query("INSERT INTO catalog_items (name) VALUES ('Z8S Chair') RETURNING id")).rows[0].id;
  var chair = (await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price, stock_qty) VALUES ($1, 'Regular', 'Z8S-CH', 'each', 450, 50) RETURNING id", [item])).rows[0].id;
  var table = (await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price, stock_qty) VALUES ($1, 'Oak', 'Z8S-CH-OAK', 'each', 900, 5) RETURNING id", [item])).rows[0].id;
  async function qtyOf(id) { return Number((await pool.query('SELECT stock_qty FROM catalog_item_variations WHERE id = $1', [id])).rows[0].stock_qty); }

  // Picked from the catalogue (by code), and typed by its exact name.
  var inv = await invoice([
    { itemNo: 'Z8S-CH', description: 'Z8S Chair', qty: 8, unitPrice: 450 },
    { description: 'Z8S Chair — Oak', qty: 2, unitPrice: 900 }
  ]);
  assert.equal(await qtyOf(chair), 42);
  assert.equal(await qtyOf(table), 3);
  await invoices.voidInvoice(admin, inv.id);
  assert.equal(await qtyOf(chair), 50);
  assert.equal(await qtyOf(table), 5);

  // More than there is: down to 0, and only what was taken comes back.
  var big = await invoice([{ itemNo: 'Z8S-CH-OAK', description: 'Z8S Chair — Oak', qty: 9, unitPrice: 900 }]);
  assert.equal(await qtyOf(table), 0);
  var m = (await pool.query("SELECT qty::float AS qty FROM catalog_stock_moves WHERE invoice_id = $1", [big.id])).rows;
  assert.deepEqual(m.map(function (r) { return r.qty; }), [5]);
  await invoices.remove(admin, big.id);
  assert.equal(await qtyOf(table), 5);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_stock_moves WHERE invoice_no = $1 AND reason = 'deleted'", [big.invoiceNo])).rows[0].n, 1);

  // Linked to a stock product: the product's stock goes down, the item's own count doesn't.
  await pool.query('UPDATE catalog_item_variations SET product_id = $1 WHERE id = $2', [pole, chair]);
  var p0 = await stock(pole);
  await invoice([{ itemNo: 'Z8S-CH', description: 'Z8S Chair', qty: 3, unitPrice: 450 }]);
  assert.equal(await stock(pole), p0 - 3);
  assert.equal(await qtyOf(chair), 50);
  await pool.query('DELETE FROM catalog_stock_moves WHERE variation_id IN ($1, $2)', [chair, table]);
});
