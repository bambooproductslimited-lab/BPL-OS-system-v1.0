/*
 * The daily stock sheet and its monthly summary (stockSheet.service.js):
 * the Finish Inventory workbook's day tab and summary tab, kept in the OS.
 *
 * Uses products with the Z8S, Z81 and Z82 prefixes and days in August 2026, and removes
 * them afterwards. Requires `npm run migrate && npm run seed` first.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var svc = require('../src/services/stockSheet.service');
var productImport = require('../src/services/productImport.service');

var admin = { can: function () { return true; }, employee: { id: null }, user: { id: null } };
var viewer = { can: function (p) { return p === 'inventory.read'; }, employee: { id: null }, user: { id: null } };
var nobody = { can: function () { return false; }, employee: { id: null }, user: { id: null } };

var slats, poles;

async function cleanup() {
  var ours = "(sku LIKE 'Z8S%' OR sku LIKE 'Z81%' OR sku LIKE 'Z82%')";
  await pool.query("DELETE FROM inventory_tx WHERE item_type = 'product' AND item_id IN (SELECT id FROM products WHERE " + ours + ')');
  await pool.query('DELETE FROM products WHERE ' + ours);
}
test.before(async function () {
  await cleanup();
  slats = (await pool.query("INSERT INTO products (sku, name, category, unit, current_stock, sheet_order) VALUES ('Z8S-SLATS', 'Z8S Slats', 'Bamboo', 'pcs', 100, 1) RETURNING id")).rows[0].id;
  poles = (await pool.query("INSERT INTO products (sku, name, category, unit, current_stock, sheet_order) VALUES ('Z8S-POLES', 'Z8S Poles', 'Bamboo', 'pcs', 40, 2) RETURNING id")).rows[0].id;
  // Production finished 25 slats on the 3rd.
  await pool.query("INSERT INTO inventory_tx (item_type, item_id, type, qty, date) VALUES ('product', $1, 'production_output', 25, '2026-08-03')", [slats]);
});
test.after(async function () { await cleanup(); await pool.end(); });

function lineOf(day, id) { return day.lines.filter(function (l) { return l.productId === id; })[0]; }
async function stockOf(id) { return Number((await pool.query('SELECT current_stock FROM products WHERE id = $1', [id])).rows[0].current_stock); }

test('only inventory people see the sheet, and only inventory managers fill it in', async function () {
  await assert.rejects(svc.getDay(nobody, '2026-08-01'), /inventory\.read/);
  await assert.rejects(svc.month(nobody, '2026-08'), /inventory\.read/);
  await assert.rejects(svc.saveLine(viewer, '2026-08-01', slats, { sold: 1 }), /inventory\.manage/);
  var day = await svc.getDay(viewer, '2026-08-01');
  assert.ok(lineOf(day, slats), 'a viewer can read the day');
});

test('an untouched day opens at the stock, with that day\'s production as Received', async function () {
  var day = await svc.getDay(admin, '2026-08-03');
  var l = lineOf(day, slats);
  assert.equal(l.saved, false);
  assert.equal(l.opening, 100);
  assert.equal(l.received, 25, 'production recorded that day');
  assert.equal(l.total, 125);
  assert.equal(l.expected, 125);
  assert.equal(l.physical, null);
  assert.equal(l.variance, null);
  // Listed in the sheet's order.
  var ours = day.lines.filter(function (x) { return /^Z8S/.test(x.sku); }).map(function (x) { return x.sku; });
  assert.deepEqual(ours, ['Z8S-SLATS', 'Z8S-POLES']);
});

test('a day works out like the sheet: expected closing, physical count, variance, and the next day opens at the closing', async function () {
  var l = await svc.saveLine(admin, '2026-08-03', slats, { opening: 100, received: 25, transferred: 10, breakage: 2, sold: 8 });
  assert.equal(l.saved, true);
  assert.equal(l.total, 125);
  assert.equal(l.expected, 105);
  assert.equal(l.closing, 105, 'not counted: closes at the expected figure');
  assert.equal(await stockOf(slats), 105, 'the product follows its latest day');

  var counted = await svc.saveLine(admin, '2026-08-03', slats, { opening: 100, received: 25, transferred: 10, breakage: 2, sold: 8, physical: 101 });
  assert.equal(counted.closing, 101);
  assert.equal(counted.variance, 4, 'expected − physical, as on the sheet');
  assert.equal(await stockOf(slats), 101);
  var lc = (await pool.query('SELECT last_counted_on::text AS d FROM products WHERE id = $1', [slats])).rows[0].d;
  assert.equal(lc, '2026-08-03');

  var next = lineOf(await svc.getDay(admin, '2026-08-04'), slats);
  assert.equal(next.opening, 101);
  assert.equal(next.received, 0);
  assert.equal(next.previousDate, '2026-08-03');
  assert.equal(next.previousClosing, 101);

  await svc.saveLine(admin, '2026-08-04', slats, { opening: 101, sold: 11 });
  assert.equal(await stockOf(slats), 90);
});

test('correcting an older day changes that day, not today\'s stock', async function () {
  await svc.saveLine(admin, '2026-08-03', slats, { opening: 100, received: 25, transferred: 10, breakage: 2, sold: 8, physical: 99 });
  assert.equal(await stockOf(slats), 90, 'the 4th is later, so the product keeps the 4th\'s closing');
  var fourth = lineOf(await svc.getDay(admin, '2026-08-04'), slats);
  assert.equal(fourth.opening, 101, 'a saved opening stays as entered, like the sheet');
  assert.equal(fourth.previousClosing, 99, 'the screen can show it no longer matches');
});

test('figures are checked', async function () {
  await assert.rejects(svc.saveLine(admin, '2026-08-05', slats, { sold: -1 }), /Sold must be a number/);
  await assert.rejects(svc.saveLine(admin, '2026-08-05', slats, { physical: 'lots' }), /Physical count must be a number/);
  var future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await assert.rejects(svc.saveLine(admin, future, slats, { sold: 1 }), /future/);
  await assert.rejects(svc.saveLine(admin, '2026-08-05', '00000000-0000-0000-0000-000000000000', { sold: 1 }), /not found/);
});

test('saving the rest of a day in one go', async function () {
  await assert.rejects(svc.saveDay(viewer, '2026-08-06', [{ productId: poles }]), /inventory\.manage/);
  await assert.rejects(svc.saveDay(admin, '2026-08-06', [{ productId: poles, sold: 1 }, { productId: slats, sold: -5 }]), /Sold must be/);
  var before = await pool.query("SELECT count(*)::int AS n FROM stock_sheet_lines WHERE date = '2026-08-06'");
  assert.equal(before.rows[0].n, 0, 'a bad line saves nothing');
  var day = await svc.saveDay(admin, '2026-08-06', [{ productId: poles, opening: 40 }, { productId: slats, opening: 90, sold: 5 }]);
  assert.equal(lineOf(day, poles).saved, true);
  assert.equal(lineOf(day, slats).closing, 85);
  assert.equal(await stockOf(slats), 85);
  await pool.query("DELETE FROM stock_sheet_lines WHERE date = '2026-08-06'");
  await pool.query('UPDATE products SET current_stock = 90 WHERE id = $1', [slats]);
});

test('the monthly summary is each day\'s closing, with the month\'s movements', async function () {
  await svc.saveLine(admin, '2026-08-04', poles, { opening: 40, received: 5, sold: 3 });
  var m = await svc.month(admin, '2026-08');
  assert.equal(m.days.length, 31);
  ['2026-08-03', '2026-08-04'].forEach(function (d) {
    assert.ok(m.days.filter(function (x) { return x.date === d; })[0].hasLines, d + ' is marked as filled in');
  });
  var row = m.rows.filter(function (r) { return r.productId === slats; })[0];
  assert.deepEqual(Object.keys(row.cells).sort(), ['2026-08-03', '2026-08-04']);
  assert.deepEqual(row.cells['2026-08-03'], { closing: 99, expected: 105, physical: 99, variance: 6 });
  assert.equal(row.cells['2026-08-04'].closing, 90);
  assert.equal(row.opening, 100);
  assert.equal(row.closing, 90);
  assert.deepEqual(row.totals, { received: 25, transferred: 10, breakage: 2, sold: 19 });
  assert.equal(row.daysWithVariance, 1);
  var p = m.rows.filter(function (r) { return r.productId === poles; })[0];
  assert.equal(p.cells['2026-08-04'].closing, 42);
  assert.equal(p.cells['2026-08-03'], undefined);
  await assert.rejects(svc.month(admin, '2026-13'), /Month/);
});

test('importing a day tab fills in that day of the sheet, column for column', async function () {
  var HEADER = ',Category,Variation,UOM,Opening Stock,Received,total stock,transfered,Breakage,Sold (Square),Expected Closing,Physical Count,Variance';
  var file = Buffer.from([HEADER,
    'Z81 Test Panels,Bamboo,4x8,Each,50,10,60,5,1,4,50,48,2',
    'Z82 Test Mats,Bamboo,Regular,Each,20,,20,,,2,18,18,0'
  ].join('\r\n'));
  var r = await productImport.preview(admin, file, '202608 BPL Finish Inventory - 10.csv');
  await productImport.commit(admin, r.lines, r.countDate);
  var day = await svc.getDay(admin, '2026-08-10');
  var panels = day.lines.filter(function (l) { return l.sku === 'Z81-4X8'; })[0];
  assert.ok(panels && panels.saved);
  assert.deepEqual([panels.opening, panels.received, panels.transferred, panels.breakage, panels.sold, panels.expected, panels.physical, panels.variance],
    [50, 10, 5, 1, 4, 50, 48, 2]);
  var mats = day.lines.filter(function (l) { return l.sku === 'Z82'; })[0];
  assert.equal(mats.physical, null, 'a Physical Count that only repeats the expected figure is not a count');
  assert.equal(mats.closing, 18);

  // Filling in an earlier day afterwards leaves today's stock alone.
  var earlier = Buffer.from([HEADER, 'Z81 Test Panels,Bamboo,4x8,Each,40,10,50,,,,50,50,0'].join('\r\n'));
  var r2 = await productImport.preview(admin, earlier, '202608 BPL Finish Inventory - 9.csv');
  await productImport.commit(admin, r2.lines.filter(function (l) { return l.action !== 'skip'; }), r2.countDate);
  var panelsId = panels.productId;
  assert.equal(await stockOf(panelsId), 48, 'still the 10th\'s count');
  assert.equal(lineOf(await svc.getDay(admin, '2026-08-09'), panelsId).closing, 50);
});
