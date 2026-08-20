/*
 * Integration test for employee ID/passport document uploads (front of ID,
 * back of ID, passport). Requires `npm run migrate && npm run seed` first.
 */
var test = require('node:test');
var assert = require('node:assert/strict');

// Fake R2 credentials, same reasoning/stub as work-comms.test.js's
// documents test: exercise the real upload/download code path without
// hitting real R2.
process.env.R2_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.R2_BUCKET = 'test-bucket';

var app = require('../src/app');
var { S3Client } = require('@aws-sdk/client-s3');
S3Client.prototype.send = async function () { return {}; };

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

async function employeeId(adminToken, email) {
  var list = await (await fetch(base + '/api/employees', { headers: authed(adminToken) })).json();
  return list.find(function (e) { return e.email === email; }).id;
}

test('employee ID documents: gated to employee.write, upload/list/download all 3 slots, invalid kind rejected', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com'); // employee — no employee.write
  var targetId = await employeeId(admin, 'alice.kamau@bplghana.com');

  var deniedList = await fetch(base + '/api/employees/' + targetId + '/id-documents', { headers: authed(alice) });
  assert.equal(deniedList.status, 403);

  var emptySlots = await (await fetch(base + '/api/employees/' + targetId + '/id-documents', { headers: authed(admin) })).json();
  assert.equal(emptySlots.length, 3);
  assert.ok(emptySlots.every(function (s) { return s.fileName === null; }));

  var badKind = new FormData();
  badKind.append('file', new Blob(['x'], { type: 'image/jpeg' }), 'x.jpg');
  var badKindRes = await fetch(base + '/api/employees/' + targetId + '/id-documents/selfie', { method: 'POST', headers: authed(admin), body: badKind });
  assert.equal(badKindRes.status, 400);

  var deniedUpload = new FormData();
  deniedUpload.append('file', new Blob(['x'], { type: 'image/jpeg' }), 'x.jpg');
  var deniedUploadRes = await fetch(base + '/api/employees/' + targetId + '/id-documents/id_front', { method: 'POST', headers: authed(alice), body: deniedUpload });
  assert.equal(deniedUploadRes.status, 403);

  var kinds = ['id_front', 'id_back', 'passport'];
  for (var i = 0; i < kinds.length; i++) {
    var form = new FormData();
    form.append('file', new Blob(['fake image bytes'], { type: 'image/jpeg' }), kinds[i] + '.jpg');
    var uploadRes = await fetch(base + '/api/employees/' + targetId + '/id-documents/' + kinds[i], { method: 'POST', headers: authed(admin), body: form });
    assert.equal(uploadRes.status, 201);
  }

  var slots = await (await fetch(base + '/api/employees/' + targetId + '/id-documents', { headers: authed(admin) })).json();
  kinds.forEach(function (kind) {
    var slot = slots.find(function (s) { return s.kind === kind; });
    assert.equal(slot.fileName, kind + '.jpg');
    assert.ok(slot.uploadedAt);
  });

  // Re-upload replaces the same slot rather than adding a second row.
  var replace = new FormData();
  replace.append('file', new Blob(['newer bytes'], { type: 'image/jpeg' }), 'id_front_v2.jpg');
  await fetch(base + '/api/employees/' + targetId + '/id-documents/id_front', { method: 'POST', headers: authed(admin), body: replace });
  var afterReplace = await (await fetch(base + '/api/employees/' + targetId + '/id-documents', { headers: authed(admin) })).json();
  assert.equal(afterReplace.filter(function (s) { return s.kind === 'id_front'; }).length, 1);
  assert.equal(afterReplace.find(function (s) { return s.kind === 'id_front'; }).fileName, 'id_front_v2.jpg');

  var downloadRes = await fetch(base + '/api/employees/' + targetId + '/id-documents/passport/download', { headers: authed(admin) });
  assert.equal(downloadRes.status, 200);
  var download = await downloadRes.json();
  assert.ok(download.url.startsWith('https://'));
});
