/*
 * Tests for the restaurant menu item photo feature (migration 0045):
 * upload/remove gated on restaurant.manage, served back via a public,
 * unauthenticated GET (menuPhotos.routes.js — a plain <img src> can't
 * attach an Authorization header, and this needs to work from both the
 * main app and the separately-authenticated POS till). R2 isn't
 * configured in this test environment, so the actual upload path is
 * exercised only up to its "not configured" failure — the same class of
 * environment limitation the original Documents/employee-ID-document
 * tests already accept.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');

var server;
var base;

test.before(function (t, done) {
  server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); });
});
test.after(function () { server.close(); });

async function login(email) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  return (await res.json()).token;
}
function authed(token) { return { Authorization: 'Bearer ' + token }; }

async function starBarMenuItemId(token) {
  var companies = await (await fetch(base + '/api/companies', { headers: authed(token) })).json();
  var sbr = companies.find(function (c) { return c.code === 'SBR'; });
  var items = await (await fetch(base + '/api/restaurant/menu-items?companyId=' + sbr.id, { headers: authed(token) })).json();
  assert.ok(items.length, 'expected at least one Star Bar menu item to test against');
  return items[0].id;
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

test('POST menu-items/:id/photo fails clearly when photo storage is not configured', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var itemId = await starBarMenuItemId(admin);
  var form = new FormData();
  form.append('file', new Blob(['fake'], { type: 'image/jpeg' }), 'test.jpg');
  var res = await fetch(base + '/api/restaurant/menu-items/' + itemId + '/photo', { method: 'POST', headers: authed(admin), body: form });
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.match(body.error.message, /Photo storage is not configured/);
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
