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
  var ours = "(sku LIKE 'Z71%' OR sku LIKE 'Z72%')";
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
