// Work orders that make daily stock sheet items (woStock.service.js): picked
// on the WO, put on the day's stock sheet when it is completed — with a
// photo, which completing always needs — and the chosen people texted;
// taken back off when it is reopened. No real text is sent: sms.send is a
// fake here.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var tasks = require('../src/services/tasks.service');
var woStock = require('../src/services/woStock.service');
var stockSheet = require('../src/services/stockSheet.service');
var sms = require('../src/services/sms.service');

var PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
var boss, reader, bench, table, keeper, sent = [], real = { configured: sms.configured, send: sms.send }, hadSetting;
function today() { return new Date().toISOString().slice(0, 10); }
async function lineOf(productId) { return (await stockSheet.getDay(boss, today())).lines.find(function (l) { return l.productId === productId; }); }
async function stockOf(productId) { return Number((await pool.query('SELECT current_stock FROM products WHERE id = $1', [productId])).rows[0].current_stock); }

async function cleanUp() {
  await pool.query("DELETE FROM tasks WHERE title LIKE 'Zqw%'");
  await pool.query("DELETE FROM inventory_tx WHERE item_id IN (SELECT id FROM products WHERE sku LIKE 'ZQW-%')");
  await pool.query("DELETE FROM products WHERE sku LIKE 'ZQW-%'");
  await pool.query("DELETE FROM notifications WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQW-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQW-%'");
}
test.before(async function () {
  await cleanUp();
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  reader = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'alice.kamau@bplghana.com'")).rows[0].id);
  bench = (await pool.query("INSERT INTO products (sku, name, unit, active, current_stock) VALUES ('ZQW-1', 'Zqw Bamboo bench', 'pcs', true, 10) RETURNING id")).rows[0].id;
  table = (await pool.query("INSERT INTO products (sku, name, unit, active, current_stock) VALUES ('ZQW-2', 'Zqw Coffee table', 'pcs', true, 4) RETURNING id")).rows[0].id;
  var dept = (await pool.query('SELECT id FROM departments ORDER BY name LIMIT 1')).rows[0].id;
  keeper = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date, status, employment_type) " +
    "VALUES ('ZQW-001', 'Zqw Hayford', 'Stores', 'zqw001@example.com', '0207770909', $1, '2021-01-04', 'active', 'permanent') RETURNING id", [dept])).rows[0].id;
  hadSetting = (await pool.query('SELECT stock_sheet FROM settings WHERE id = 1')).rows[0].stock_sheet;
  sms.configured = function () { return true; };
  sms.send = async function (o) { sent.push(o); return { id: null, to: o.to }; };
});
test.after(async function () {
  sms.configured = real.configured; sms.send = real.send;
  await pool.query('UPDATE settings SET stock_sheet = $1 WHERE id = 1', [JSON.stringify(hadSetting || {})]);
  await cleanUp();
  await pool.end();
});

test('who gets the texts is set on the stock sheet page, by whoever manages stock', async function () {
  await assert.rejects(woStock.setTexts(reader, { employeeIds: [keeper] }), function (e) { return e.code === 'forbidden'; });
  var t = await woStock.setTexts(boss, { employeeIds: [keeper] });
  assert.deepEqual(t.people.map(function (p) { return [p.name, p.hasPhone]; }), [['Zqw Hayford Stores', true]]);
  var o = await tasks.options(boss);
  assert.ok(o.stockProducts.some(function (p) { return p.id === bench && p.unit === 'pcs'; }), 'the form offers the stock sheet\'s items');
  assert.deepEqual(o.stockTextIds, [keeper]);
});

test('a work order for stock sheet items: picked on the form, checked', async function () {
  await assert.rejects(tasks.create(boss, { title: 'Zqw bad qty', stockItems: [{ productId: bench, qty: 0 }] }), /how many/);
  await assert.rejects(tasks.create(boss, { title: 'Zqw twice', stockItems: [{ productId: bench, qty: 1 }, { productId: bench, qty: 2 }] }), /chosen twice/);
  var wo = await tasks.create(boss, { title: 'Zqw benches and a table', stockItems: [{ productId: bench, qty: 3 }, { productId: table, qty: 2 }] });
  assert.deepEqual(wo.stockItems.map(function (x) { return [x.name, x.qty, x.addedOn]; }).sort(), [['Zqw Bamboo bench', 3, null], ['Zqw Coffee table', 2, null]]);
  var edited = await tasks.update(boss, wo.id, { stockItems: [{ productId: bench, qty: 4 }] });
  assert.deepEqual(edited.stockItems.map(function (x) { return [x.name, x.qty]; }), [['Zqw Bamboo bench', 4]]);
  await tasks.update(boss, wo.id, { stockItems: [{ productId: bench, qty: 3 }, { productId: table, qty: 2 }] });
});

test('completed only with a photo; then onto today\'s stock sheet, and the stores keeper texted', async function () {
  var wo = (await tasks.list(boss, { scope: 'all', q: 'Zqw benches' }))[0];
  await assert.rejects(tasks.setStatus(boss, wo.id, 'completed'), /photo of the finished work/);
  await assert.rejects(tasks.setStatus(boss, wo.id, 'completed', { photos: ['data:image/png;base64,AAAA'] }), /photo/);
  var before = await lineOf(bench);
  sent.length = 0;
  var done = await tasks.setStatus(boss, wo.id, 'completed', { photos: [PHOTO] });
  assert.equal(done.status, 'completed');
  assert.equal(done.donePhotos.length, 1);
  assert.ok((await tasks.photoOf(boss, wo.id, 0)).key, 'the photo is kept');
  assert.deepEqual(done.stock.added.map(function (x) { return [x.name, x.qty]; }), [['Zqw Bamboo bench', 3], ['Zqw Coffee table', 2]]);
  assert.ok(done.stockItems.every(function (x) { return x.addedOn === today(); }));

  var after = await lineOf(bench);
  assert.equal(after.saved, true);
  assert.equal(after.received, before.received + 3, 'Received on today\'s line');
  assert.equal(after.closing, before.closing + 3);
  assert.match(after.note, new RegExp(done.number + ' \\+3'));
  assert.equal(await stockOf(bench), 13, 'the product\'s stock follows');
  var tx = (await pool.query("SELECT qty, reference FROM inventory_tx WHERE item_id = $1 AND type = 'work_order_output'", [bench])).rows;
  assert.deepEqual(tx.map(function (r) { return [Number(r.qty), r.reference]; }), [[3, done.number]]);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '0207770909');
  assert.equal(sent[0].purpose, 'auto_stock_sheet');
  assert.match(sent[0].message, new RegExp(done.number + ' completed .*Added to today\'s stock sheet: 3 × Zqw Bamboo bench, 2 × Zqw Coffee table'));
  assert.equal(done.stock.texted.sent, 1);
  var bell = (await pool.query('SELECT title, body FROM notifications WHERE employee_id = $1 ORDER BY at DESC LIMIT 1', [keeper])).rows[0];
  assert.match(bell.title, /Stock sheet/);

  await assert.rejects(tasks.update(boss, wo.id, { stockItems: [{ productId: bench, qty: 5 }] }), /Reopen the work order first/);
  await tasks.update(boss, wo.id, { title: 'Zqw benches and a table (done)' });
});

test('reopened: taken back off the day it went on, and the keeper told; completed again, back on', async function () {
  var wo = (await tasks.list(boss, { scope: 'all', q: 'Zqw benches' }))[0];
  sent.length = 0;
  var open = await tasks.setStatus(boss, wo.id, 'in_progress');
  assert.deepEqual(open.stock.removed.map(function (x) { return [x.name, x.qty]; }), [['Zqw Bamboo bench', 3], ['Zqw Coffee table', 2]]);
  assert.ok(open.stockItems.every(function (x) { return x.addedOn === null; }));
  assert.equal((await lineOf(bench)).received, 0);
  assert.equal(await stockOf(bench), 10);
  assert.equal(await stockOf(table), 4);
  assert.match(sent[0].message, /was reopened .*Taken back off the stock sheet: 3 × Zqw Bamboo bench/);

  // A count already made today: the count takes the new tables too.
  await stockSheet.saveLine(boss, today(), table, { opening: 4, received: 0, transferred: 0, breakage: 0, sold: 0, physical: 4 });
  await assert.rejects(tasks.setStatus(boss, wo.id, 'completed'), /photo/);
  var again = await tasks.setStatus(boss, wo.id, 'completed', { photos: [PHOTO, PHOTO] });
  assert.equal(again.donePhotos.length, 3, 'the photos of each time are kept');
  var t = await lineOf(table);
  assert.deepEqual([t.received, t.physical, t.closing], [2, 6, 6]);
  assert.equal(await stockOf(table), 6);
});

test('nobody to text: the work order is completed all the same, and the screen is told', async function () {
  await woStock.setTexts(boss, { employeeIds: [] });
  var wo = await tasks.create(boss, { title: 'Zqw one bench', stockItems: [{ productId: bench, qty: 1 }] });
  sent.length = 0;
  var done = await tasks.setStatus(boss, wo.id, 'completed', { photos: [PHOTO] });
  assert.equal(done.stock.texted.nobody, true);
  assert.equal(sent.length, 0);
  assert.equal(await stockOf(bench), 14);
  var plain = await tasks.create(boss, { title: 'Zqw a gate repair' });
  var p = await tasks.setStatus(boss, plain.id, 'completed', { photos: [PHOTO] });
  assert.deepEqual([p.stock.added.length, p.stock.texted], [0, null], 'a work order for no stock items touches no stock');
});
