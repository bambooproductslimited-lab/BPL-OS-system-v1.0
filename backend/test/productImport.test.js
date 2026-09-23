/*
 * Importing a day's tab of the stores team's "BPL Finish Inventory" count
 * sheet into Products & inventory.
 *
 * The items below are invented (codes Z91–Z97, so the test can find and
 * remove its own products) but reproduce the sheet's SHAPE: the blank first
 * header later tabs have, one line per item AND variation, a code shared by
 * two different items, the same item twice under "[for slats]", 3\4'' typed
 * for 3/4", counts that differ from the expected closing, and the counter's
 * initials under the table.
 *
 * Requires `npm run migrate && npm run seed` first (the pretest hook).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var svc = require('../src/services/productImport.service');

var admin = { can: function () { return true; }, employee: { id: null }, user: { id: null } };
var nobody = { can: function () { return false; }, employee: { id: null }, user: { id: null } };

async function cleanup() {
  await pool.query("DELETE FROM inventory_tx WHERE item_type = 'product' AND item_id IN (SELECT id FROM products WHERE sku LIKE 'Z9%')");
  await pool.query("DELETE FROM products WHERE sku LIKE 'Z9%'");
}
test.before(cleanup);
test.after(async function () { await cleanup(); await pool.end(); });

var HEADER = ',Category,Variation,UOM,Opening Stock,Received,total stock,transfered,Breakage,Sold (Square),Expected Closing,Physical Count,Variance';
function csv(lines) { return Buffer.from([HEADER].concat(lines).join('\r\n')); }

var DAY_ONE = csv([
  'Z91 Test Slats,Bamboo,4\' A - pcs,12/bundle,"1,022",,"1,022",,,,"1,022","1,022",0',
  'Z91 Test Slats,Bamboo,8\' A - pcs,25/bundle,"4,871",,"4,871","1,871",,,"3,000","3,000",0',
  'Z92 Test Poles,Bamboo,2.7m poles,M,45,,45,,,,45,45,0',
  'Z92 Test Poles,Bamboo [for slats],2.7m poles,M,12,,12,,,,12,12,0',
  'Z93 Double Tester,Electricals,13A,Each,15,,15,,,,15,15,0',
  'Z93 Single Tester,Electricals,13A,Each,8,,8,,,,8,8,0',
  'Z94 Test Elbow,Plumbering,3\\4\'\',Each,65,,65,,,,65,65,0',
  'Z95 Test Lamp,Others,Regular,Each,6,,6,,,,6,20,-14',
  'Z96 Test Charcoal,Bamboo,Per kg,KG,511,,511,,,,488.8,,',
  ',,,,,,,,,,,,FK 09.22'
]);

test('a sheet line is split into code, name, category and variation the way the sheet means them', function () {
  assert.deepEqual(svc.splitCode('001 Bamboo Slats'), { code: '001', name: 'Bamboo Slats' });
  assert.deepEqual(svc.splitCode('P09  Booster'), { code: 'P09', name: 'Booster' });
  assert.deepEqual(svc.splitCode('S093 Nail panel boards'), { code: 'S093', name: 'Nail panel boards' });
  assert.deepEqual(svc.splitCode('P30 1\\2 K1'), { code: 'P30', name: '1/2 K1' });
  assert.deepEqual(svc.splitCategory('Bamboo [for slats]'), { category: 'Bamboo', note: 'for slats' });
  assert.deepEqual(svc.splitCategory('Plumbering'), { category: 'Plumbing', note: '' });
  assert.deepEqual(svc.splitCategory('Capentory'), { category: 'Carpentry', note: '' });
  assert.equal(svc.tidyVariation("3\\4''"), '3/4"');
  assert.equal(svc.tidyVariation("1''"), '1"');
});

test('the count date is read from the name Google Sheets gives a downloaded tab', function () {
  assert.equal(svc.countDateFromFileName('202609 BPL Finish Inventory - 22.csv'), '2026-09-22');
  assert.equal(svc.countDateFromFileName('202609 BPL Finish Inventory - 3.csv'), '2026-09-03');
  assert.equal(svc.countDateFromFileName('202602 BPL Finish Inventory - 30.csv'), null, 'no 30 February');
  assert.equal(svc.countDateFromFileName('stock.csv'), null);
});

test('only people who manage inventory can import, and they are told so before anything is read', async function () {
  await assert.rejects(svc.preview(nobody, DAY_ONE, 'x.csv'), /inventory\.manage/);
  await assert.rejects(svc.preview(nobody, null, 'x.csv'), /inventory\.manage/, 'no file: still forbidden, not "no file"');
  await assert.rejects(svc.commit(nobody, [{ sku: 'Z9X' }], '2026-09-22'), /inventory\.manage/);
});

test('the summary tab\'s date columns are read in either date order', function () {
  var us = svc.readDateColumns(['', 'Item', '9/1/2026', '9/2/2026', '9/30/2026']);
  assert.deepEqual(us.map(function (c) { return c.date; }), ['2026-09-01', '2026-09-02', '2026-09-30']);
  var uk = svc.readDateColumns(['1/9/2026', '2/9/2026', '30/9/2026']);
  assert.deepEqual(uk.map(function (c) { return c.date; }), ['2026-09-01', '2026-09-02', '2026-09-30']);
  assert.deepEqual(svc.readDateColumns(['2026-09-05']).map(function (c) { return c.date; }), ['2026-09-05']);
  assert.deepEqual(svc.readDateColumns(['Item', 'UOM']), []);
});

test('preview: one product per item and variation, every SKU distinct and stable', async function () {
  var r = await svc.preview(admin, DAY_ONE, '202609 BPL Finish Inventory - 22.csv');
  assert.equal(r.countDate, '2026-09-22');
  assert.equal(r.lines.length, 9, 'the initials under the table are not a product');
  var bySku = {};
  r.lines.forEach(function (l) { bySku[l.sku] = l; });
  assert.equal(Object.keys(bySku).length, 9, 'no two lines share a SKU');

  assert.equal(bySku['Z91-4FT-A-PCS'].stock, 1022, 'thousands separators read');
  assert.equal(bySku['Z91-4FT-A-PCS'].name, "Test Slats — 4' A - pcs");
  assert.equal(bySku['Z91-4FT-A-PCS'].unit, '12/bundle');
  // Same code and variation, different item: the name tells them apart.
  assert.ok(bySku['Z93-13A-DOUBLE'] && bySku['Z93-13A-SINGLE']);
  // Same item and variation twice: the category note tells them apart.
  assert.equal(bySku['Z92-2.7M-POLES'].stock, 45);
  assert.equal(bySku['Z92-2.7M-POLES-FOR-SLATS'].stock, 12);
  assert.equal(bySku['Z92-2.7M-POLES-FOR-SLATS'].name, 'Test Poles (for slats) — 2.7m poles');
  assert.equal(bySku['Z92-2.7M-POLES-FOR-SLATS'].category, 'Bamboo');
  // Tidied: 3\4'' is 3/4", Plumbering is Plumbing, Regular isn't in the name.
  assert.equal(bySku['Z94-3-4IN'].name, 'Test Elbow — 3/4"');
  assert.equal(bySku['Z94-3-4IN'].category, 'Plumbing');
  assert.equal(bySku.Z95.name, 'Test Lamp');

  // The physical count wins over the expected closing, and says so.
  assert.equal(bySku.Z95.stock, 20);
  assert.deepEqual(bySku.Z95.warnings, [{ code: 'variance', counted: 20, expected: 6 }]);
  // No count at all: the expected closing is used, and says so.
  assert.equal(bySku['Z96-PER-KG'].stock, 488.8);
  assert.equal(bySku['Z96-PER-KG'].warnings[0].code, 'no_count');

  assert.ok(r.lines.every(function (l) { return l.action === 'create'; }));
  assert.deepEqual(r.summary, { create: 9, update: 0, unchanged: 0, skipped: 0, withWarnings: 2 });
});

test('commit, then a later count: stock moves, everything set in the OS stays, history records both', async function () {
  var first = await svc.preview(admin, DAY_ONE, '202609 BPL Finish Inventory - 22.csv');
  var res = await svc.commit(admin, first.lines, '2026-09-22');
  assert.deepEqual(res, { created: 9, updated: 0, unchanged: 0 });

  var slats = (await pool.query("SELECT * FROM products WHERE sku = 'Z91-8FT-A-PCS'")).rows[0];
  assert.equal(Number(slats.current_stock), 3000);
  // Someone prices the product and renames it in the OS.
  await pool.query("UPDATE products SET selling_price = 42, reorder_level = 500, name = 'Slats 8ft grade A' WHERE id = $1", [slats.id]);

  var dayTwo = csv([
    'Z91 Test Slats,Bamboo,8\' A - pcs,25/bundle,"3,000",,"3,000",500,,,"2,500","2,500",0',
    'Z92 Test Poles,Bamboo,2.7m poles,M,45,,45,,,,45,45,0',
    'Z97 New Item,Others,Regular,Each,0,5,5,,,,5,5,0'
  ]);
  var second = await svc.preview(admin, dayTwo, '202609 BPL Finish Inventory - 23.csv');
  var s = {};
  second.lines.forEach(function (l) { s[l.sku] = l; });
  assert.equal(s['Z91-8FT-A-PCS'].action, 'update');
  assert.equal(s['Z91-8FT-A-PCS'].previousStock, 3000);
  assert.equal(s['Z92-2.7M-POLES'].action, 'unchanged');
  assert.equal(s.Z97.action, 'create');

  var res2 = await svc.commit(admin, second.lines, second.countDate);
  assert.deepEqual(res2, { created: 1, updated: 1, unchanged: 1 });

  var after = (await pool.query('SELECT * FROM products WHERE id = $1', [slats.id])).rows[0];
  assert.equal(Number(after.current_stock), 2500);
  assert.equal(Number(after.selling_price), 42, 'price set in the OS kept');
  assert.equal(Number(after.reorder_level), 500, 'reorder level kept');
  assert.equal(after.name, 'Slats 8ft grade A', 'rename kept — the SKU is what matched');

  var tx = (await pool.query("SELECT qty, date::text AS date, reference FROM inventory_tx WHERE item_id = $1 ORDER BY date", [slats.id])).rows;
  assert.deepEqual(tx.map(function (t) { return [Number(t.qty), t.date, t.reference]; }), [
    [3000, '2026-09-22', 'Stock count 2026-09-22'],
    [-500, '2026-09-23', 'Stock count 2026-09-23']
  ]);
});

// The monthly summary tab: a column per day of closing figures (the day
// tabs' Expected Closing), a UOM column that is wrong, no category, and
// #REF! for days that have no tab yet.
var SUMMARY_HEADER = ',Item,Variation,UOM,9/22/2026,9/23/2026,9/24/2026,9/25/2026,9/26/2026';
function summaryCsv(lines) { return Buffer.from([SUMMARY_HEADER].concat(lines).join('\r\n')); }

test('the monthly summary: latest day becomes the stock, later days go into the history, counts are never overwritten', async function () {
  // State left by the tests above: 8' A slats counted on the 23rd at 2,500;
  // poles counted on the 22nd (45) and 23rd (unchanged); the "for slats"
  // poles and both testers counted on the 22nd.
  var file = summaryCsv([
    '2,Z91 Test Slats,8\' A - pcs,12/bundle,"3,000","2,500","2,400","2,300",#REF!',
    '3,Z92 Test Poles,2.7m poles,12/bundle,45,45,45,40,#REF!',
    '4,Z92 Test Poles,2.7m poles,12/bundle,12,12,10,10,#REF!', // the "[for slats]" line, which the summary can't label
    '5,Z93 Double Tester,13A,12/bundle,15,15,15,15,#REF!',
    '6,Z93 Single Tester,13A,12/bundle,8,8,8,6,#REF!',
    '7,Z98 Summary Only,Regular,12/bundle,5,5,7,8,#REF!'
  ]);
  var r = await svc.preview(admin, file, '202609 BPL Finish Inventory - 2026 Sept.csv');
  assert.equal(r.source, 'summary');
  assert.equal(r.countDate, '2026-09-25', 'the last day with figures, not the #REF! day after');
  var bySku = {};
  r.lines.forEach(function (l) { bySku[l.sku] = l; });

  assert.equal(bySku['Z91-8FT-A-PCS'].action, 'update');
  assert.equal(bySku['Z91-8FT-A-PCS'].stock, 2300);
  assert.equal(bySku['Z91-8FT-A-PCS'].historyDays, 2, 'only the 24th and 25th: the 22nd and 23rd are already in the history');
  assert.equal(bySku['Z91-8FT-A-PCS'].name, 'Slats 8ft grade A', 'the name given in the OS is shown and kept');
  assert.equal(bySku['Z92-2.7M-POLES'].stock, 40);
  assert.equal(bySku['Z92-2.7M-POLES-FOR-SLATS'].stock, 10, 'the second identical line is the "for slats" product');
  assert.equal(bySku['Z93-13A-DOUBLE'].action, 'unchanged');
  assert.equal(bySku['Z93-13A-SINGLE'].stock, 6);
  var fresh = r.lines.filter(function (l) { return l.action === 'create'; });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].sku, 'Z98');
  assert.equal(fresh[0].unit, 'each', "the summary's UOM column is not used");
  assert.equal(fresh[0].category, 'Other');

  var res = await svc.commit(admin, r.lines.filter(function (l) { return l.action === 'create' || l.action === 'update'; }), r.countDate, 'summary');
  assert.deepEqual(res, { created: 1, updated: 4, unchanged: 0, kept: 0 });

  var stock = async function (sku) { return Number((await pool.query('SELECT current_stock FROM products WHERE sku = $1', [sku])).rows[0].current_stock); };
  assert.equal(await stock('Z91-8FT-A-PCS'), 2300);
  assert.equal(await stock('Z92-2.7M-POLES-FOR-SLATS'), 10);
  var history = async function (sku) {
    return (await pool.query(
      "SELECT t.type, t.qty, t.date::text AS date FROM inventory_tx t JOIN products p ON p.id = t.item_id WHERE p.sku = $1 ORDER BY t.date, t.type",
      [sku]
    )).rows.map(function (t) { return [t.date, t.type, Number(t.qty)]; });
  };
  assert.deepEqual(await history('Z91-8FT-A-PCS'), [
    ['2026-09-22', 'stock_count', 3000], ['2026-09-23', 'stock_count', -500],
    ['2026-09-24', 'sheet_closing', -100], ['2026-09-25', 'sheet_closing', -100]
  ]);
  assert.deepEqual(await history('Z98'), [
    ['2026-09-22', 'sheet_closing', 5], ['2026-09-24', 'sheet_closing', 2], ['2026-09-25', 'sheet_closing', 1]
  ]);
  var z98 = (await pool.query("SELECT last_counted_on FROM products WHERE sku = 'Z98'")).rows[0];
  assert.equal(z98.last_counted_on, null, 'a summary is not a count');

  var again = await svc.preview(admin, file, 'x.csv');
  assert.ok(again.lines.every(function (l) { return l.action === 'unchanged'; }), 'uploading the same summary twice adds nothing');
});

test('a summary never replaces a physical count of the same day, even if the browser asks it to', async function () {
  // The lamp was counted at 20 on the 22nd; the sheet expected 6.
  var file = summaryCsv(['2,Z95 Test Lamp,Regular,Each,6,#REF!,#REF!,#REF!,#REF!']);
  var r = await svc.preview(admin, file, 'x.csv');
  assert.equal(r.countDate, '2026-09-22');
  var lamp = r.lines[0];
  assert.equal(lamp.action, 'kept');
  assert.equal(lamp.stock, 20);
  assert.deepEqual(lamp.warnings, [{ code: 'count_differs', figure: 6, counted: 20 }]);

  var forged = Object.assign({}, lamp, { action: 'update', stock: 6 });
  var res = await svc.commit(admin, [forged], '2026-09-22', 'summary');
  assert.deepEqual(res, { created: 0, updated: 0, unchanged: 0, kept: 1 });
  assert.equal(Number((await pool.query("SELECT current_stock FROM products WHERE sku = 'Z95'")).rows[0].current_stock), 20);
});

test('a day tab whose figures match the OS still records that the day was counted', async function () {
  var sameAgain = csv(['Z93 Double Tester,Electricals,13A,Each,15,,15,,,,15,15,0']);
  var r = await svc.preview(admin, sameAgain, '202609 BPL Finish Inventory - 27.csv');
  assert.equal(r.lines[0].action, 'unchanged');
  await svc.commit(admin, r.lines, r.countDate);
  var row = (await pool.query("SELECT last_counted_on::text AS d FROM products WHERE sku = 'Z93-13A-DOUBLE'")).rows[0];
  assert.equal(row.d, '2026-09-27');
});

test('commit re-checks what the browser sends back', async function () {
  await assert.rejects(svc.commit(admin, [{ sku: 'Z9-BAD', name: 'Bad', category: 'Other', stock: -1 }], '2026-09-22'), /0 or more/);
  await assert.rejects(svc.commit(admin, [{ sku: 'Z9-BAD', name: 'Bad', category: 'Other', stock: 1 }], 'yesterday'), /Count date/);
  await assert.rejects(svc.commit(admin, [
    { sku: 'Z9-DUP', name: 'One', category: 'Other', stock: 1 },
    { sku: 'z9-dup', name: 'Two', category: 'Other', stock: 1 }
  ], '2026-09-22'), /appears twice/);
  await assert.rejects(svc.commit(admin, [{ sku: 'Z9-BAD', name: 'Bad', category: 'Other', stock: 1, history: [{ date: '2026-09-30', stock: 1 }] }], '2026-09-22', 'summary'), /daily figures/);
  var left = await pool.query("SELECT count(*)::int AS n FROM products WHERE sku IN ('Z9-BAD', 'Z9-DUP')");
  assert.equal(left.rows[0].n, 0, 'a failed import writes nothing');
});
