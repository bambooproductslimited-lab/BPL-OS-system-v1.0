// Products & Services photos (migration 0105): several per item, the first
// is the cover, one can be tagged to a variation (the pickers then show that
// variation its own photo), and removing a photo or the item removes the file.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var catalog = require('../src/services/catalog.service');
var { buildContext } = require('../src/services/context.service');

var server, base, admin, boss, viewer, itemId;
async function login(email) {
  var res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: 'bamboo123' }) });
  return (await res.json()).token;
}
function authed(token) { return { Authorization: 'Bearer ' + token }; }
function jsonAuthed(token) { return Object.assign({ 'Content-Type': 'application/json' }, authed(token)); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}
async function upload(files, variationId) {
  var fd = new FormData();
  files.forEach(function (f, i) { fd.append('photos', new Blob([f], { type: 'image/png' }), 'zq-' + i + '.png'); });
  if (variationId) fd.append('variationId', variationId);
  return fetch(base + '/api/catalog/items/' + itemId + '/photos', { method: 'POST', headers: authed(admin), body: fd });
}
async function storedCount(keys) {
  return (await pool.query('SELECT count(*)::int AS n FROM stored_files WHERE id = ANY($1::uuid[])', [keys.map(function (k) { return k.slice(3); })])).rows[0].n;
}

test.before(async function () {
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
  admin = await login('kelvin.duho@bplghana.com');
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  viewer = limited(boss, ['catalog.manage']);
});
test.after(async function () {
  if (itemId) {
    var keys = (await pool.query('SELECT photo_key FROM catalog_item_photos WHERE item_id = $1', [itemId])).rows;
    for (var k of keys) await pool.query('DELETE FROM stored_files WHERE id = $1', [k.photo_key.slice(3)]);
    await pool.query('DELETE FROM catalog_items WHERE id = $1', [itemId]);
  }
  server.close();
  await pool.end();
});

test('item photos: add several, cover first, tag one to a variation, reorder, remove', async function () {
  var item = await (await fetch(base + '/api/catalog/items', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ name: 'Zqp Lighting', variationName: 'Bedside lamp', code: 'ZQP-LAMP', unitPrice: 300 })
  })).json();
  itemId = item.id;
  var pole = await (await fetch(base + '/api/catalog/items/' + itemId + '/variations', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ name: 'Pole light', code: 'ZQP-POLE', unitPrice: 900 })
  })).json();

  var res = await upload([Buffer.from('zq-a'), Buffer.from('zq-b')]);
  assert.equal(res.status, 201);
  var photos = await res.json();
  assert.equal(photos.length, 2);
  var [a, b] = photos;

  // A photo of the pole light only.
  var tagged = await (await upload([Buffer.from('zq-c')], pole.id)).json();
  var c = tagged[2];
  assert.equal(c.variationId, pole.id);

  // The Products & Services list carries them, cover first.
  var items = await (await fetch(base + '/api/catalog/items', { headers: authed(admin) })).json();
  var mine = items.find(function (it) { return it.id === itemId; });
  assert.deepEqual(mine.photos.map(function (p) { return p.id; }), [a.id, b.id, c.id]);

  // The pickers' flat list: the pole light gets its own photo, the lamp the cover.
  var flat = await (await fetch(base + '/api/catalog', { headers: authed(admin) })).json();
  assert.equal(flat.find(function (v) { return v.code === 'ZQP-POLE'; }).photoId, c.id);
  assert.equal(flat.find(function (v) { return v.code === 'ZQP-LAMP'; }).photoId, a.id);

  // The file itself.
  var img = await fetch(base + '/api/catalog/photos/' + b.id, { headers: authed(admin) });
  assert.equal(img.status, 200);
  assert.equal(Buffer.from(await img.arrayBuffer()).toString(), 'zq-b');

  // Make b the cover; caption it; untag c.
  var order = await (await fetch(base + '/api/catalog/photos/' + b.id + '/cover', { method: 'POST', headers: authed(admin) })).json();
  assert.deepEqual(order.map(function (p) { return p.id; }), [b.id, a.id, c.id]);
  var captioned = await (await fetch(base + '/api/catalog/photos/' + b.id, { method: 'PUT', headers: jsonAuthed(admin), body: JSON.stringify({ caption: '  Zq in a bedroom  ' }) })).json();
  assert.equal(captioned[0].caption, 'Zq in a bedroom');
  var untagged = await catalog.updatePhoto(boss, c.id, { variationId: null });
  assert.equal(untagged[2].variationId, null);

  // A variation from another item is refused.
  var other = (await pool.query("SELECT id FROM catalog_item_variations WHERE item_id <> $1 LIMIT 1", [itemId])).rows[0];
  if (other) await assert.rejects(function () { return catalog.updatePhoto(boss, c.id, { variationId: other.id }); }, /isn’t part of this item/);

  // Remove one: the file goes too, the rest close up.
  var aKey = (await pool.query('SELECT photo_key FROM catalog_item_photos WHERE id = $1', [a.id])).rows[0].photo_key;
  var left = await (await fetch(base + '/api/catalog/photos/' + a.id, { method: 'DELETE', headers: authed(admin) })).json();
  assert.deepEqual(left.map(function (p) { return p.id; }), [b.id, c.id]);
  assert.equal(await storedCount([aKey]), 0);
  assert.deepEqual((await pool.query('SELECT position FROM catalog_item_photos WHERE item_id = $1 ORDER BY position', [itemId])).rows.map(function (r) { return r.position; }), [0, 1]);
});

test('item photos: only images, at most 12, catalog.manage to change, catalog.read to see', async function () {
  await assert.rejects(function () { return catalog.addPhotos(boss, itemId, [{ mimetype: 'text/plain', buffer: Buffer.from('x') }]); }, /isn’t a photo/);
  await assert.rejects(function () { return catalog.addPhotos(boss, itemId, []); }, /Choose a photo/);
  await assert.rejects(function () { return catalog.addPhotos(viewer, itemId, [{ mimetype: 'image/png', buffer: Buffer.from('x') }]); }, /catalog.manage/);
  var have = (await catalog.listItems(viewer)).find(function (it) { return it.id === itemId; }).photos;
  assert.ok(await catalog.photoFor(viewer, have[0].id));
  await assert.rejects(function () { return catalog.makeCover(viewer, have[0].id); }, /catalog.manage/);
  await assert.rejects(function () { return catalog.removePhoto(viewer, have[0].id); }, /catalog.manage/);
  var many = Array.from({ length: 11 }, function () { return { mimetype: 'image/png', buffer: Buffer.from('zq') }; });
  await assert.rejects(function () { return catalog.addPhotos(boss, itemId, many); }, /up to 12 photos/);
  var txt = await (async function () {
    var fd = new FormData(); fd.append('photos', new Blob(['x']), 'zq.txt');
    return fetch(base + '/api/catalog/items/' + itemId + '/photos', { method: 'POST', headers: authed(admin), body: fd });
  })();
  assert.equal(txt.status, 400);
});

test('deleting an item deletes its photo files', async function () {
  var keys = (await pool.query('SELECT photo_key FROM catalog_item_photos WHERE item_id = $1', [itemId])).rows.map(function (r) { return r.photo_key; });
  assert.ok(keys.length > 0);
  await catalog.remove(boss, itemId);
  assert.equal(await storedCount(keys), 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_item_photos WHERE item_id = $1', [itemId])).rows[0].n, 0);
  itemId = null;
});
