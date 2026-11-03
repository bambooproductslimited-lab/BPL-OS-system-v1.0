// The file storage's health (services/storageHealth.service.js, lib/
// storage.js check, lib/fileStore.js): every photo — the till's menu, the
// shops, the OS — is read through the server from Cloudflare R2. When R2
// refuses, the check says why in plain words with what to do, a photo
// answers with a clear refusal (not a crash), and a photo that is not in
// R2 any more is simply not found. A stand-in for R2 answers as R2 would.
// Fake Zsh data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var app = require('../src/app');
var storage = require('../src/lib/storage');
var health = require('../src/services/storageHealth.service');

var company, dish, server, base;
function r2(answer) {
  storage.setForTests({ configured: true, client: { send: async function (cmd) {
    var kind = cmd.constructor.name;
    var a = typeof answer === 'function' ? answer(kind) : answer;
    if (a === 'ok') return kind === 'GetObjectCommand' ? { Body: require('stream').Readable.from([Buffer.from('zsh photo')]), ContentType: 'image/jpeg' } : {};
    throw Object.assign(new Error('R2 said ' + a), a === 'HTTP 404' ? { name: 'NotFound', $metadata: { httpStatusCode: 404 } } : { name: a });
  } } });
  health.forgetForTests();
}
async function cleanup() {
  await pool.query("DELETE FROM restaurant_menu_items WHERE company_id IN (SELECT id FROM companies WHERE code = 'ZSH')");
  await pool.query("DELETE FROM companies WHERE code = 'ZSH'");
}
test.before(async function () {
  await cleanup();
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZSH', 'Zsh Kitchen') RETURNING id")).rows[0].id;
  dish = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active, photo_object_key) VALUES ($1, 'Zsh stew', 'Zsh Mains', 50, true, 'documents/zsh-0001-catalog-zsh-stew.jpg') RETURNING id", [company])).rows[0].id;
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(async function () { storage.setForTests(null); await new Promise(function (r) { server.close(r); }); await cleanup(); await pool.end(); });

test('the check: what R2 said, the state, and what to do', async function () {
  r2('ok');
  var s = await health.status(true);
  assert.deepEqual([s.state, s.ok], ['ok', true]);
  assert.ok(s.photos.r2 >= 1);
  r2('InvalidAccessKeyId');
  s = await health.status(true);
  assert.deepEqual([s.state, s.ok, s.code, s.step], ['refused', false, 'InvalidAccessKeyId', 'read']);
  assert.ok(/refused the server's R2 key/.test(s.why) && /Manage API tokens/.test(s.fix));
  r2('AccessDenied');
  assert.equal((await health.status(true)).state, 'refused');
  // A photo not in the bucket; a bucket that is not there.
  r2(function (kind) { return kind === 'HeadObjectCommand' ? 'HTTP 404' : 'ok'; });
  s = await health.status(true);
  assert.deepEqual([s.state, s.code], ['not-in-bucket', 'NoSuchKey']);
  r2(function (kind) { return kind === 'HeadObjectCommand' ? 'HTTP 404' : 'NoSuchBucket'; });
  assert.equal((await health.status(true)).state, 'no-bucket');
  r2('ENOTFOUND');
  assert.equal((await health.status(true)).state, 'unreachable');
  r2('SomethingOdd');
  assert.equal((await health.status(true)).state, 'error');
  // No R2 settings at all, with photos kept there: they are missing.
  storage.setForTests({ configured: false, client: null }); health.forgetForTests();
  s = await health.status(true);
  assert.deepEqual([s.state, s.code], ['missing-settings', 'NotConfigured']);
  assert.ok(/R2_ACCESS_KEY_ID/.test(s.fix));
  // Without photos in R2 and without R2: the database keeps the files — fine.
  assert.equal(health.stateOf({ ok: false, code: 'NotConfigured' }, { r2: 0, db: 3 }), 'database');
});

test('a photo: shown when R2 gives it, a plain refusal when R2 refuses, not found when it is gone; the public check', async function () {
  r2('ok');
  var r = await fetch(base + '/api/menu-photos/' + dish);
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'zsh photo');
  r2('InvalidAccessKeyId');
  r = await fetch(base + '/api/menu-photos/' + dish);
  assert.equal(r.status, 502);
  assert.ok(/file storage \(Cloudflare R2\) refused it \(InvalidAccessKeyId\)/.test((await r.json()).error.message));
  r2('NoSuchKey');
  r = await fetch(base + '/api/menu-photos/' + dish);
  assert.equal(r.status, 404);
  // Anyone can see whether the storage works and what to do — no numbers.
  r2('InvalidAccessKeyId');
  var h = await (await fetch(base + '/api/health/storage')).json();
  assert.deepEqual([h.storage, h.ok, h.code], ['refused', false, 'InvalidAccessKeyId']);
  assert.ok(h.fix && h.photos === undefined);
  // Asked again within the minute: the same answer, R2 not asked again.
  var asked = 0;
  storage.setForTests({ configured: true, client: { send: async function () { asked++; return {}; } } });
  h = await (await fetch(base + '/api/health/storage')).json();
  assert.equal(h.storage, 'refused');
  assert.equal(asked, 0);
});
