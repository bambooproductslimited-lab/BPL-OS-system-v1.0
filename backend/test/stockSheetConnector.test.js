/*
 * A day of the daily stock sheet filled in through the Claude connector
 * (ai/tools.js preview_stock_sheet_day / fill_stock_sheet_day): the day
 * tab's rows go through the same reading and matching as an uploaded
 * workbook. Products use the ZQSS prefix and are removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var tools = require('../src/ai/tools');

var kelvin, tray, DAY;
async function cleanup() {
  var ids = "(SELECT id FROM products WHERE sku LIKE 'ZQSS%' OR name LIKE 'Zqss %')";
  await pool.query('DELETE FROM stock_sheet_lines WHERE product_id IN ' + ids);
  await pool.query("DELETE FROM inventory_tx WHERE item_type = 'product' AND item_id IN " + ids);
  await pool.query('DELETE FROM product_aliases WHERE product_id IN ' + ids);
  await pool.query('DELETE FROM products WHERE id IN ' + ids);
}
test.before(async function () {
  await cleanup();
  kelvin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  DAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  tray = (await pool.query("INSERT INTO products (sku, name, category, unit, current_stock) VALUES ('ZQSS-TRAY', 'Zqss Bamboo Tray — Large', 'Bamboo', 'each', 40) RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO products (sku, name, category, unit, current_stock) VALUES ('ZQSS-STOOL', 'Zqss Stool (old name)', 'Bamboo', 'each', 7)");
});
test.after(async function () { await cleanup(); await pool.end(); });

var ROWS = [
  // counted, and differs from expected
  { item: 'Zqss Bamboo Tray', category: 'Bamboo', variation: 'Large', uom: 'each', opening: 40, received: 10, transferred: 2, expected: 48, physical: 45, counted: true },
  // not counted: the Physical cell is the sheet's copy of Expected
  { item: 'Zqss Bamboo Lamp', category: 'Bamboo', variation: 'Pole', uom: 'each', opening: 5, expected: 5, physical: 5, counted: false },
  // the stool, renamed in the sheet: matched by hand
  { item: 'Zqss Bamboo Stool', category: 'Bamboo', variation: '', uom: 'each', opening: 7, sold: 1, expected: 6, physical: 6, counted: true }
];

test('preview, then fill in a day: counts, movements, new and matched products', async function () {
  var pv = await tools.get('preview_stock_sheet_day').run(kelvin, { date: DAY, rows: ROWS });
  assert.equal(pv.rows, 3);
  assert.equal(pv.matched, 1);
  assert.equal(pv.counted, 2);
  assert.deepEqual(pv.differences, [{ name: 'Zqss Bamboo Tray — Large', counted: 45, expected: 48 }]);
  assert.equal(pv.movements.total, 2);
  assert.deepEqual(pv.stockChanges.items, [{ name: 'Zqss Bamboo Tray — Large', from: 40, to: 45 }], 'which stock changes, by name');
  assert.deepEqual(pv.clashes, []);
  var stool = pv.newProducts.items.find(function (x) { return /Stool/.test(x.name); });
  assert.ok(stool, 'the renamed stool is not matched by itself');

  var fill = tools.get('fill_stock_sheet_day');
  var prepared = await fill.prepare(kelvin, { date: DAY, rows: ROWS, matches: { [stool.line_sku]: 'ZQSS-STOOL' } });
  assert.match(prepared.summary, /3 products \(1 in the OS, 1 new: Zqss Bamboo Lamp — Pole\), 2 counted, 1 different from expected, 2 with stock moving/);
  var done = await fill.execute(kelvin, prepared.payload);
  assert.match(done.message, /1 product\(s\) added/);

  var line = (await pool.query('SELECT opening::float, received::float, transferred::float, physical::float FROM stock_sheet_lines WHERE product_id = $1 AND date = $2', [tray, DAY])).rows[0];
  assert.deepEqual(line, { opening: 40, received: 10, transferred: 2, physical: 45 });
  assert.equal(Number((await pool.query('SELECT current_stock FROM products WHERE id = $1', [tray])).rows[0].current_stock), 45, 'stock from the count');
  var stoolRow = (await pool.query("SELECT p.current_stock, l.sold::float AS sold FROM products p JOIN stock_sheet_lines l ON l.product_id = p.id AND l.date = $1 WHERE p.sku = 'ZQSS-STOOL'", [DAY])).rows[0];
  assert.equal(stoolRow.sold, 1, 'the renamed stool is the existing product');
  assert.equal(Number(stoolRow.current_stock), 6);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM products WHERE name LIKE 'Zqss Bamboo Stool%'")).rows[0].n, 0, 'no duplicate made');

  // Again: the day is already there, nothing doubles.
  var again = await tools.get('preview_stock_sheet_day').run(kelvin, { date: DAY, rows: ROWS });
  assert.equal(again.alreadyOnSheet, 3);
  assert.equal(again.newProducts.total, 0, 'the stool is remembered by its alias');
});

test('two rows landing on one product are named in the preview; an unclosed [note is still a note', async function () {
  var import_ = require('../src/services/productImport.service');
  assert.deepEqual(import_.splitCategory('Bamboo [from 104'), { category: 'Bamboo', note: 'from 104' });
  var twice = [ROWS[0], Object.assign({}, ROWS[0], { uom: '25/bundle' })];
  var pv = await tools.get('preview_stock_sheet_day').run(kelvin, { date: DAY, rows: twice });
  assert.equal(pv.clashes.length, 1);
  assert.match(pv.note, /same product/);
});

test('only inventory.manage; no future days', async function () {
  var noStock = Object.assign({}, kelvin, { can: function (p) { return p !== 'inventory.manage' && kelvin.can(p); } });
  var offered = tools.toolsFor(noStock).map(function (t) { return t.name; });
  assert.ok(offered.indexOf('fill_stock_sheet_day') < 0 && offered.indexOf('preview_stock_sheet_day') < 0);
  await assert.rejects(tools.get('fill_stock_sheet_day').prepare(noStock, { date: DAY, rows: ROWS }), /inventory\.manage/);
  var tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  await assert.rejects(tools.get('preview_stock_sheet_day').run(kelvin, { date: tomorrow, rows: ROWS }), /not come yet/);
});
