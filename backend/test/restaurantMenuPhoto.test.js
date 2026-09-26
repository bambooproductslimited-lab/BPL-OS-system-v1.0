/*
 * Tests for the restaurant menu item photo feature (migration 0045):
 * upload/remove gated on restaurant.manage, served back via a public,
 * unauthenticated GET (menuPhotos.routes.js — a plain <img src> can't
 * attach an Authorization header, and this needs to work from both the
 * main app and the separately-authenticated POS till). R2 isn't
 * configured in this test environment, so photos are kept in the database
 * (lib/fileStore.js) — the same place they go on a deployment without R2.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');

var server;
var base;

test.before(function (t, done) {
  server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); });
});
// Leaves the database as it found it — the items created below are this
// file's own fixtures, not data any other test should trip over.
test.after(async function () {
  for (var i = 0; i < createdItemIds.length; i++) {
    await pool.query('DELETE FROM restaurant_menu_items WHERE id = $1', [createdItemIds[i]]);
  }
  server.close();
});

async function login(email) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  return (await res.json()).token;
}
function authed(token) { return { Authorization: 'Bearer ' + token }; }

// Creates an item of this file's own to test against, rather than picking
// the first one that happens to exist.
//
// This used to read whatever was already there, and failed roughly two
// runs in five. The seed creates no Star Bar menu items at all — it only
// preserves Square-imported ones across a reseed, and a fresh test
// database has none — so the item it found was a leftover from
// restaurant.test.js. node --test runs files in parallel, so whether that
// leftover existed yet was a coin flip.
var createdItemIds = [];
async function starBarMenuItemId(token) {
  var companies = await (await fetch(base + '/api/companies', { headers: authed(token) })).json();
  var sbr = companies.find(function (c) { return c.code === 'SBR'; });
  assert.ok(sbr, 'the seed must contain Star Bar Restaurant');
  var created = await (await fetch(base + '/api/restaurant/menu-items', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authed(token)),
    body: JSON.stringify({ companyId: sbr.id, name: 'Photo test dish ' + Date.now() + '-' + createdItemIds.length, category: 'Mains', price: 25 })
  })).json();
  assert.ok(created.id, 'could not create a menu item to test against');
  createdItemIds.push(created.id);
  return created.id;
}

test('POST menu-items/:id/photo is forbidden without restaurant.manage', async function () {
  var alice = await login('alice.kamau@bplghana.com'); // employee — no restaurant.manage
  var admin = await login('kelvin.duho@bplghana.com');
  var itemId = await starBarMenuItemId(admin);
  var form = new FormData();
  form.append('file', new Blob(['fake'], { type: 'image/jpeg' }), 'test.jpg');
  var res = await fetch(base + '/api/restaurant/menu-items/' + itemId + '/photo', { method: 'POST', headers: authed(alice), body: form });
  assert.equal(res.status, 403);
});

// A tiny real JPEG: its bytes are all this test compares.
var JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

test('a photo saves without R2, is served back to the till, and is removed with its file', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var itemId = await starBarMenuItemId(admin);
  var form = new FormData();
  form.append('file', new Blob([JPEG], { type: 'image/jpeg' }), '20230802_113549.jpg');
  var res = await fetch(base + '/api/restaurant/menu-items/' + itemId + '/photo', { method: 'POST', headers: authed(admin), body: form });
  assert.equal(res.status, 200);
  var item = await res.json();
  assert.equal(item.photoUrl, '/api/menu-photos/' + itemId);
  var key = (await pool.query('SELECT photo_object_key FROM restaurant_menu_items WHERE id = $1', [itemId])).rows[0].photo_object_key;
  assert.match(key, /^db:/);

  var img = await fetch(base + item.photoUrl);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  // the OS pages and the server are on different sites: the browser must be allowed to show it there
  assert.equal(img.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG);

  // a new photo replaces the old one's file
  var again = new FormData();
  again.append('file', new Blob([JPEG], { type: 'image/jpeg' }), 'second.jpg');
  assert.equal((await fetch(base + '/api/restaurant/menu-items/' + itemId + '/photo', { method: 'POST', headers: authed(admin), body: again })).status, 200);
  assert.equal((await pool.query('SELECT 1 FROM stored_files WHERE id = $1', [key.slice(3)])).rowCount, 0);
  var key2 = (await pool.query('SELECT photo_object_key FROM restaurant_menu_items WHERE id = $1', [itemId])).rows[0].photo_object_key;

  var del = await fetch(base + '/api/restaurant/menu-items/' + itemId + '/photo', { method: 'DELETE', headers: authed(admin) });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).photoUrl, null);
  assert.equal((await pool.query('SELECT 1 FROM stored_files WHERE id = $1', [key2.slice(3)])).rowCount, 0);
  assert.equal((await fetch(base + item.photoUrl)).status, 404);
});

test('a photo that is too big, or not an image, gets a clear reason instead of "Something went wrong"', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var itemId = await starBarMenuItemId(admin);
  var big = new FormData();
  big.append('file', new Blob([Buffer.alloc(6 * 1024 * 1024, 1)], { type: 'image/jpeg' }), 'big.jpg');
  var res = await fetch(base + '/api/restaurant/menu-items/' + itemId + '/photo', { method: 'POST', headers: authed(admin), body: big });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /too big/);

  var notImage = new FormData();
  notImage.append('file', new Blob(['plain text'], { type: 'text/plain' }), 'photo.jpg');
  res = await fetch(base + '/api/restaurant/menu-items/' + itemId + '/photo', { method: 'POST', headers: authed(admin), body: notImage });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /JPG, PNG or WebP/);
});

test('POST menu-items/:id/photo rejects a disallowed file extension before touching storage', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var itemId = await starBarMenuItemId(admin);
  var form = new FormData();
  form.append('file', new Blob(['not an image'], { type: 'application/x-msdownload' }), 'virus.exe');
  var res = await fetch(base + '/api/restaurant/menu-items/' + itemId + '/photo', { method: 'POST', headers: authed(admin), body: form });
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.match(body.error.message, /menu photos/);
});

test('GET /api/menu-photos/:id needs no auth and 404s cleanly for an item with no photo', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var itemId = await starBarMenuItemId(admin);
  var res = await fetch(base + '/api/menu-photos/' + itemId); // no Authorization header at all
  assert.equal(res.status, 404);
});
