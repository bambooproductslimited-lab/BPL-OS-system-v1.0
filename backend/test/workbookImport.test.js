/*
 * Importing a whole month's Finish Inventory workbook (.xlsx) at once: every
 * day tab becomes that day on the daily stock sheet, oldest first.
 *
 * The workbook is built here with exceljs the way Google Sheets exports it:
 * formulas with their stored results, a formula whose result is 0 stored
 * without one, a Physical Count typed over its "=K" formula on one line,
 * and a summary tab and PO tab that must be left out. Products use the Z71
 * and Z72 codes and are removed afterwards.
 * Requires `npm run migrate && npm run seed` first (the pretest hook).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var ExcelJS = require('exceljs');
var { pool } = require('../src/db/pool');
var svc = require('../src/services/productImport.service');
var sheet = require('../src/services/stockSheet.service');

var admin = { can: function () { return true; }, employee: { id: null }, user: { id: null } };
var nobody = { can: function () { return false; }, employee: { id: null }, user: { id: null } };
var FILE = '202608 BPL Finish Inventory.xlsx';

async function cleanup() {
  var ours = "(sku LIKE 'Z71%' OR sku LIKE 'Z72%' OR sku LIKE 'Z73%')";
  await pool.query("DELETE FROM product_aliases WHERE alias LIKE 'Z7%'");
  await pool.query("DELETE FROM inventory_tx WHERE item_type = 'product' AND item_id IN (SELECT id FROM products WHERE " + ours + ')');
  await pool.query('DELETE FROM products WHERE ' + ours);
}
test.before(cleanup);
test.after(async function () { await cleanup(); await pool.end(); });

var HEADER = ['Items/Description ', 'Category', 'Variation', 'UOM', 'Opening Stock', 'Received', 'total stock', 'transfered', 'Breakage', 'Sold (Square)', 'Expected Closing', 'Physical Count', 'Variance'];

// One line as the sheet has it: E..J typed, G/K/L/M formulas. physical: a
// number typed over L, or undefined to leave L as "=K".
function line(ws, r, item, cat, variation, uom, open, received, transferred, breakage, sold, physical) {
  var total = open + (received || 0);
  var expected = total - (transferred || 0) - (breakage || 0) - (sold || 0);
  var f = function (formula, result) { return result === 0 ? { formula: formula } : { formula: formula, result: result }; };
  ws.getRow(r).values = [item, cat, variation, uom, open, received || null, f('E' + r + '+F' + r, total), transferred || null, breakage || null, sold || null,
    f('E' + r + '+F' + r + '-H' + r + '-I' + r + '-J' + r, expected),
    physical === undefined ? f('K' + r, expected) : physical,
    f('K' + r + '-L' + r, expected - (physical === undefined ? expected : physical))];
}

async function workbook() {
  var wb = new ExcelJS.Workbook();
  var summary = wb.addWorksheet('2026 Aug');
  summary.getRow(1).values = ['', 'Item', 'Variation', 'UOM', new Date(Date.UTC(2026, 7, 1)), new Date(Date.UTC(2026, 7, 2))];
  var d1 = wb.addWorksheet('1');
  d1.getRow(1).values = HEADER;
  line(d1, 2, 'Z71 Test Slats', 'Bamboo', "8' A - pcs", '25/bundle', 100, 20, 10, 0, 5);
  line(d1, 3, 'Z72 Test Poles', 'Bamboo', '2.7m poles', 'M', 45, 0, 45, 0, 0); // expected 0: stored without a result
  var d2 = wb.addWorksheet('2');
  d2.getRow(1).values = HEADER;
  line(d2, 2, 'Z71 Test Slats', 'Bamboo', "8' A - pcs", '25/bundle', 105, 0, 0, 2, 3, 98); // counted: 98 against 100 expected
  line(d2, 3, 'Z72 Test Poles', 'Bamboo', '2.7m poles', 'M', 0, 12, 0, 0, 0, 12); // counted, and it matched
  var po = wb.addWorksheet('PO');
  po.getRow(1).values = ['Date', 'Supplier', 'Item'];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('only inventory managers can import a workbook, and it has to be one', async function () {
  await assert.rejects(svc.previewWorkbook(nobody, await workbook(), FILE), /inventory\.manage/);
  await assert.rejects(svc.previewWorkbook(nobody, null, FILE), /inventory\.manage/);
  await assert.rejects(svc.commitWorkbook(nobody, await workbook(), FILE, '2026-08'), /inventory\.manage/);
  await assert.rejects(svc.previewWorkbook(admin, Buffer.from('not,a,workbook'), FILE), /Excel workbook/);
  await assert.rejects(svc.commitWorkbook(admin, await workbook(), FILE, 'August'), /Month must/);
});

test('preview: the day tabs, oldest first, with what each holds; summary and PO tabs left out', async function () {
  var r = await svc.previewWorkbook(admin, await workbook(), FILE);
  assert.equal(r.month, '2026-08');
  assert.deepEqual(r.days.map(function (d) { return [d.date, d.items, d.counted, d.differences, d.skipped]; }), [
    ['2026-08-01', 2, 0, 0, 0],
    ['2026-08-02', 2, 2, 1, 0]
  ], 'a zero result stored without a value still reads as 0; typed counts are counts, even when they match');
  assert.deepEqual(r.skippedTabs.map(function (t) { return t.sheet; }).sort(), ['2026 Aug', 'PO']);
  assert.equal(r.newProducts, 2);
  assert.equal(r.lastDate, '2026-08-02');

  // No month in the name: the summary tab's dates say which.
  var again = await svc.previewWorkbook(admin, await workbook(), 'Finish Inventory.xlsx');
  assert.equal(again.month, '2026-08');
});

test('commit: every day lands on the daily sheet, and stock ends at the latest day', async function () {
  var res = await svc.commitWorkbook(admin, await workbook(), FILE, '2026-08');
  assert.equal(res.days, 2);
  assert.equal(res.created, 2);

  var day1 = await sheet.getDay(admin, '2026-08-01');
  var slats1 = day1.lines.filter(function (l) { return l.sku === 'Z71-8FT-A-PCS'; })[0];
  assert.deepEqual([slats1.opening, slats1.received, slats1.transferred, slats1.sold, slats1.expected, slats1.physical], [100, 20, 10, 5, 105, null]);
  var poles1 = day1.lines.filter(function (l) { return l.sku === 'Z72-2.7M-POLES'; })[0];
  assert.equal(poles1.closing, 0);

  var day2 = await sheet.getDay(admin, '2026-08-02');
  var slats2 = day2.lines.filter(function (l) { return l.sku === 'Z71-8FT-A-PCS'; })[0];
  assert.equal(slats2.expected, 100);
  assert.equal(slats2.physical, 98, 'the typed count');
  assert.equal(slats2.variance, 2);
  var poles2 = day2.lines.filter(function (l) { return l.sku === 'Z72-2.7M-POLES'; })[0];
  assert.equal(poles2.physical, 12, 'a count equal to the expected figure is still a count');

  var stock = (await pool.query("SELECT sku, current_stock FROM products WHERE sku IN ('Z71-8FT-A-PCS', 'Z72-2.7M-POLES') ORDER BY sku")).rows;
  assert.deepEqual(stock.map(function (p) { return [p.sku, Number(p.current_stock)]; }), [['Z71-8FT-A-PCS', 98], ['Z72-2.7M-POLES', 12]]);

  var m = await sheet.month(admin, '2026-08');
  var row = m.rows.filter(function (x) { return x.sku === 'Z71-8FT-A-PCS'; })[0];
  assert.deepEqual([row.cells['2026-08-01'].closing, row.cells['2026-08-02'].closing], [105, 98]);

  // Importing the same workbook again changes nothing.
  var twice = await svc.commitWorkbook(admin, await workbook(), FILE, '2026-08');
  assert.equal(twice.created, 0);
  assert.equal(twice.updated, 0);
  var r = await svc.previewWorkbook(admin, await workbook(), FILE);
  assert.deepEqual(r.days.map(function (d) { return d.alreadyInOs; }), [2, 2]);
  assert.equal(r.stockChanges, 0);
});

// A July workbook written the way the April 2026 one was: no Category
// column, the day's number typed into the item heading, the bundle size in
// the variation. Day 2 has the slats' variation left blank (as on 31 Aug)
// and a pack size typed into a sandpaper line's variation.
async function olderWorkbook() {
  var wb = new ExcelJS.Workbook();
  var d1 = wb.addWorksheet('1');
  d1.getRow(1).values = ['1', 'Variation', 'UOM', 'Opening Stock', 'Received', 'total stock', 'transfered', 'Breakage', 'Sold (Square)', 'Expected Closing', 'Physical Count', 'Variance'];
  d1.getRow(2).values = ['Z71 Test Slats', "8' (25/bundle) A - pcs", 'Each', 80, null, { formula: 'D2+E2', result: 80 }, null, null, null, { formula: 'D2', result: 80 }, { formula: 'J2', result: 80 }, { formula: 'J2-K2' }];
  var d2 = wb.addWorksheet('2');
  d2.getRow(1).values = HEADER;
  line(d2, 2, 'Z71 Test Slats', 'Bamboo', ' ', '25/bundle', 80, 0, 0, 0, 10);
  line(d2, 3, 'Z72 Test Poles', 'Bamboo', '2.7m poles', 'M', 12, 0, 0, 0, 0);
  line(d2, 4, 'Z73 Test Sandpaper', 'Supplies', 'P 20 - 5", 100pcs/box', 'Each', 9, 0, 0, 0, 0);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
var OLD_FILE = '202607 BPL Finish Inventory.xlsx';

test('an older layout reads the same, and a line the OS can\'t find is offered the products it might be', async function () {
  var r = await svc.previewWorkbook(admin, await olderWorkbook(), OLD_FILE);
  assert.deepEqual(r.days.map(function (d) { return [d.date, d.items]; }), [['2026-07-01', 1], ['2026-07-02', 3]]);
  // Day 1's "8' (25/bundle) A - pcs" is the slats product; the blank variation on day 2 isn't.
  assert.deepEqual(r.unmatched.map(function (u) { return u.sku; }).sort(), ['Z71', 'Z73-P-20-5IN']);
  var blank = r.unmatched.filter(function (u) { return u.sku === 'Z71'; })[0];
  assert.deepEqual(blank.candidates.map(function (c) { return c.sku; }), ['Z71-8FT-A-PCS'], 'same code, and not already on the sheet that day');
  assert.equal(blank.firstDay, '2026-07-02');
  var sand = r.unmatched.filter(function (u) { return u.sku === 'Z73-P-20-5IN'; })[0];
  assert.equal(sand.name, 'Test Sandpaper — P 20 - 5"', 'the pack size is not part of the name');
});

test('the person importing says which product it is; the OS remembers, and two lines of a day can\'t become one product', async function () {
  var slats = (await pool.query("SELECT id FROM products WHERE sku = 'Z71-8FT-A-PCS'")).rows[0].id;
  var poles = (await pool.query("SELECT id FROM products WHERE sku = 'Z72-2.7M-POLES'")).rows[0].id;

  await assert.rejects(svc.commitWorkbook(admin, await olderWorkbook(), OLD_FILE, '2026-07', JSON.stringify({ Z71: poles })), /both matched/);
  var none = await pool.query("SELECT count(*)::int AS n FROM stock_sheet_lines WHERE date BETWEEN '2026-07-01' AND '2026-07-02'");
  assert.equal(none.rows[0].n, 0, 'a refused import saves nothing');
  await assert.rejects(svc.commitWorkbook(admin, await olderWorkbook(), OLD_FILE, '2026-07', '{"Z71":"not-an-id"}'), /could not be read/);

  var res = await svc.commitWorkbook(admin, await olderWorkbook(), OLD_FILE, '2026-07', JSON.stringify({ Z71: slats, 'Z73-P-20-5IN': 'new' }));
  assert.equal(res.matched, 1);
  assert.equal(res.created, 1, 'the sandpaper, kept as new');
  var day2 = await sheet.getDay(admin, '2026-07-02');
  assert.equal(day2.lines.filter(function (l) { return l.productId === slats; })[0].closing, 70, 'the blank line landed on the slats');
  var sand = (await pool.query("SELECT unit, category FROM products WHERE sku = 'Z73-P-20-5IN'")).rows[0];
  assert.deepEqual(sand, { unit: '100pcs/box', category: 'Supplies' });
  var alias = (await pool.query("SELECT product_id FROM product_aliases WHERE alias = 'Z71'")).rows[0];
  assert.equal(alias.product_id, slats);
  assert.equal(Number((await pool.query('SELECT current_stock FROM products WHERE id = $1', [slats])).rows[0].current_stock), 98,
    'July is older than the August days already there, so today\'s stock is untouched');

  var again = await svc.previewWorkbook(admin, await olderWorkbook(), OLD_FILE);
  assert.deepEqual(again.unmatched, [], 'the next import finds it by itself');
});
