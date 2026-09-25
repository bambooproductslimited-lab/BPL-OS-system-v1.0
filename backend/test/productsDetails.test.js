// Products & inventory: editing a product never changes its stock; stock
// changes (a count, a delivery, breakage, a sale) go onto today's line of
// the daily stock sheet and into the stock history; archiving takes a
// product off the page and the sheet; product photos.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var products = require('../src/services/products.service');
var stockSheet = require('../src/services/stockSheet.service');
var { buildContext } = require('../src/services/context.service');

var boss, viewer, ids = [];
function today() { return new Date().toISOString().slice(0, 10); }
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}
async function stock(id) { return Number((await pool.query('SELECT current_stock FROM products WHERE id = $1', [id])).rows[0].current_stock); }

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  viewer = limited(boss, ['inventory.manage']);
});
test.after(async function () {
  var keys = (await pool.query('SELECT photo_key FROM products WHERE id = ANY($1::uuid[]) AND photo_key IS NOT NULL', [ids])).rows;
  for (var k of keys) await pool.query('DELETE FROM stored_files WHERE id = $1', [k.photo_key.slice(3)]);
  await pool.query('DELETE FROM inventory_tx WHERE item_id = ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM products WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

test('a new product records its opening stock; editing changes details, not stock', async function () {
  var p = await products.create(boss, { sku: 'zqi-001', name: 'Zqi tray', category: 'Zqi', unit: 'piece', costPrice: 10, sellingPrice: 25, currentStock: 40, reorderLevel: 10, description: 'Zqi demo' });
  ids.push(p.id);
  assert.deepEqual([p.sku, p.currentStock, p.description, p.active, p.photo], ['ZQI-001', 40, 'Zqi demo', true, null]);
  var tx = (await pool.query('SELECT type, qty::float AS qty FROM inventory_tx WHERE item_id = $1', [p.id])).rows;
  assert.deepEqual(tx, [{ type: 'opening', qty: 40 }]);

  var e = await products.update(boss, p.id, { sku: 'ZQI-001', name: 'Zqi tray large', category: 'Zqi', costPrice: 12, sellingPrice: 30, currentStock: 999, reorderLevel: 15 });
  assert.deepEqual([e.name, e.currentStock, e.reorderLevel, e.unit, e.description], ['Zqi tray large', 40, 15, 'piece', 'Zqi demo']);
  await assert.rejects(function () { return products.update(viewer, p.id, { sku: 'ZQI-001', name: 'x', category: 'x' }); }, /inventory.manage/);
});

test('stock changes go onto today\'s stock sheet line and the history', async function () {
  var p = await products.create(boss, { sku: 'ZQI-002', name: 'Zqi mat', category: 'Zqi', unit: 'piece', currentStock: 20 });
  ids.push(p.id);
  var r = await products.adjustStock(boss, p.id, { mode: 'received', qty: 10, reason: 'Zqi from workshop' });
  assert.deepEqual([r.currentStock, r.stockBefore], [30, 20]);
  r = await products.adjustStock(boss, p.id, { mode: 'sold', qty: 4 });
  r = await products.adjustStock(boss, p.id, { mode: 'breakage', qty: 1, reason: 'Zqi dropped' });
  assert.equal(r.currentStock, 25);
  await assert.rejects(function () { return products.adjustStock(boss, p.id, { mode: 'sold', qty: 100 }); }, /Only 25/);

  var line = (await stockSheet.getDay(boss, today())).lines.find(function (l) { return l.productId === p.id; });
  assert.deepEqual([line.saved, line.opening, line.received, line.sold, line.breakage, line.closing], [true, 20, 10, 4, 1, 25]);
  assert.match(line.note, /Zqi from workshop; Zqi dropped/);

  // a count sets the stock; a later sale on the counted day moves the count
  r = await products.adjustStock(boss, p.id, { mode: 'count', qty: 22, reason: 'Zqi shelf count' });
  assert.equal(r.currentStock, 22);
  r = await products.adjustStock(boss, p.id, { mode: 'sold', qty: 2 });
  assert.equal(r.currentStock, 20);
  assert.equal(await stock(p.id), 20);
  assert.equal(r.sold30, 6);

  var tx = (await pool.query('SELECT type, qty::float AS qty FROM inventory_tx WHERE item_id = $1 ORDER BY qty', [p.id])).rows.map(function (t) { return t.type + ' ' + t.qty; });
  assert.deepEqual(tx.sort(), ['adjustment -3', 'breakage -1', 'opening 20', 'received 10', 'sale -2', 'sale -4']);

  var h = await products.history(viewer, p.id);
  assert.equal(h.lines.length, 1);
  assert.deepEqual([h.lines[0].date, h.lines[0].closing, h.lines[0].physical, !!h.lines[0].by], [today(), 20, 20, true]);

  await assert.rejects(function () { return products.adjustStock(viewer, p.id, { mode: 'count', qty: 1 }); }, /inventory.manage/);
  await assert.rejects(function () { return products.adjustStock(boss, p.id, { mode: 'stolen', qty: 1 }); }, /what happened/);
  await assert.rejects(function () { return products.adjustStock(boss, p.id, { mode: 'received', qty: 0 }); }, /how many/);
});

test('archiving takes a product off the stock sheet; its history stays', async function () {
  var p = await products.create(boss, { sku: 'ZQI-003', name: 'Zqi old basket', category: 'Zqi' });
  ids.push(p.id);
  var yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  var a = await products.setActive(boss, p.id, false);
  assert.equal(a.active, false);
  assert.equal((await stockSheet.getDay(boss, yesterday)).lines.some(function (l) { return l.productId === p.id; }), false);
  assert.equal((await products.list(viewer)).find(function (x) { return x.id === p.id; }).active, false);
  await assert.rejects(function () { return products.setActive(viewer, p.id, true); }, /inventory.manage/);
  assert.equal((await products.setActive(boss, p.id, true)).active, true);
  assert.equal((await stockSheet.getDay(boss, yesterday)).lines.some(function (l) { return l.productId === p.id; }), true);
});

test('a product photo is kept, replaced and removed', async function () {
  var p = await products.create(boss, { sku: 'ZQI-004', name: 'Zqi lamp', category: 'Zqi' });
  ids.push(p.id);
  var png = { mimetype: 'image/png', buffer: Buffer.from('zq-photo-1') };
  var withPhoto = await products.setPhoto(boss, p.id, png);
  assert.equal(typeof withPhoto.photo, 'number');
  var key1 = await products.photoFor(viewer, p.id);
  await products.setPhoto(boss, p.id, { mimetype: 'image/png', buffer: Buffer.from('zq-photo-2') });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM stored_files WHERE id = $1', [key1.slice(3)])).rows[0].n, 0, 'the old photo is removed');
  await assert.rejects(function () { return products.setPhoto(boss, p.id, { mimetype: 'text/plain', buffer: Buffer.from('x') }); }, /photo/);
  await assert.rejects(function () { return products.setPhoto(boss, p.id, undefined); }, /Choose a photo/);
  await assert.rejects(function () { return products.setPhoto(viewer, p.id, png); }, /inventory.manage/);
  var removed = await products.setPhoto(boss, p.id, null);
  assert.equal(removed.photo, null);
  await assert.rejects(function () { return products.photoFor(viewer, p.id); }, /No photo/);
});
