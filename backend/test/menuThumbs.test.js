// The till's menu photos as small squares (restaurant.service.js
// getMenuItemThumb, migration 0154): made once from the photo, kept, made
// again when the photo changes, removed with it; a photo that cannot be
// shrunk is sent as it is. Test data uses the ZQP company code.
var test = require('node:test');
var assert = require('node:assert/strict');
var sharp = require('sharp');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var fileStore = require('../src/lib/fileStore');
var restaurant = require('../src/services/restaurant.service');
var { buildContext } = require('../src/services/context.service');

var server, base, company, item, admin;
async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQP'")).rows.map(function (r) { return r.id; });
  if (!cos.length) return;
  var keys = (await pool.query('SELECT photo_object_key AS a, photo_thumb_key AS b FROM restaurant_menu_items WHERE company_id = ANY($1)', [cos])).rows;
  for (var k of keys) { await fileStore.del(k.a); await fileStore.del(k.b); }
  await pool.query("DELETE FROM audit_logs WHERE summary LIKE '%Zqp%'");
  await pool.query('DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
}
function photo(w, h, color) { return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg({ quality: 95 }).toBuffer(); }
async function setPhoto(buf, type) {
  var key = await fileStore.put('zqp.jpg', buf, type || 'image/jpeg');
  await pool.query('UPDATE restaurant_menu_items SET photo_object_key = $2 WHERE id = $1', [item, key]);
  return key;
}
async function row() { return (await pool.query('SELECT photo_object_key, photo_thumb_key, photo_thumb_of FROM restaurant_menu_items WHERE id = $1', [item])).rows[0]; }
async function stored(key) { return (await pool.query('SELECT count(*)::int AS n FROM stored_files WHERE id = $1', [String(key).slice(3)])).rows[0].n; }

test.before(async function () {
  await cleanup();
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQP', 'Zqp Diner') RETURNING *")).rows[0];
  item = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqp jollof', 'Zqp', 50, true) RETURNING id", [company.id])).rows[0].id;
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(async function () { server.close(); await cleanup(); await pool.end(); });

test('a small square is made once, kept, and made again for a new photo', async function () {
  var big = await photo(2400, 1600, '#c2410c');
  var key1 = await setPhoto(big);
  var t = await restaurant.getMenuItemThumb(item);
  assert.equal(t.contentType, 'image/webp');
  var meta = await sharp(t.buffer).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [restaurant.THUMB_PX, restaurant.THUMB_PX, 'webp']);
  assert.ok(t.buffer.length < big.length / 10, 'a fraction of the photo: ' + t.buffer.length + ' of ' + big.length);
  var r1 = await row();
  assert.equal(r1.photo_thumb_of, key1);
  // Asked again (and many at once): the kept one, made once.
  var again = await Promise.all([restaurant.getMenuItemThumb(item), restaurant.getMenuItemThumb(item), restaurant.getMenuItemThumb(item)]);
  assert.ok(again.every(function (x) { return x.buffer.equals(t.buffer); }));
  assert.equal((await row()).photo_thumb_key, r1.photo_thumb_key);

  // A new photo: a new address, a new square, the old square gone.
  var url1 = restaurant.menuThumbUrl(item, key1);
  var key2 = await setPhoto(await photo(800, 1200, '#15803d'));
  assert.notEqual(restaurant.menuThumbUrl(item, key2), url1);
  var t2 = await restaurant.getMenuItemThumb(item);
  assert.ok(!t2.buffer.equals(t.buffer));
  var r2 = await row();
  assert.equal(r2.photo_thumb_of, key2);
  assert.equal(await stored(r1.photo_thumb_key), 0, 'the old square is removed');
  await fileStore.del(key1);
});

test('served by address: the square cached for good, the photo as before', async function () {
  var r = await row();
  var url = base + restaurant.menuThumbUrl(item, r.photo_object_key);
  var res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  var full = await fetch(base + '/api/menu-photos/' + item);
  assert.equal(full.headers.get('content-type'), 'image/jpeg');
  assert.doesNotMatch(full.headers.get('cache-control'), /immutable/);
});

test('a photo that cannot be shrunk is sent as it is; removing the photo removes its square', async function () {
  var junk = Buffer.from('not really a picture');
  await setPhoto(junk, 'image/png');
  var t = await restaurant.getMenuItemThumb(item);
  assert.ok(t.buffer.equals(junk));
  assert.equal(t.contentType, 'image/png');
  await setPhoto(await photo(600, 600, '#7c3aed'));
  await restaurant.getMenuItemThumb(item);
  var thumbKey = (await row()).photo_thumb_key;
  assert.equal(await stored(thumbKey), 1);
  await restaurant.removeMenuItemPhoto(admin, item);
  var r = await row();
  assert.deepEqual([r.photo_object_key, r.photo_thumb_key], [null, null]);
  assert.equal(await stored(thumbKey), 0);
  await assert.rejects(restaurant.getMenuItemThumb(item), /No photo/);
});
