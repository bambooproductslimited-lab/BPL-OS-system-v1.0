// Chats (migration 0080): group chats with admins, files in messages, and
// profile photos — all through the HTTP API, members-only throughout.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');

var server, base;
var brian, esther, faith, samuel, kelvin; // samuel is never in the group
var ids = {};
var groupId;

async function login(email) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  var body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.token;
}
function call(token, method, path, body) {
  return fetch(base + path, {
    method: method,
    headers: Object.assign({ Authorization: 'Bearer ' + token }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}
function form(token, path, fields, files, method) {
  var fd = new FormData();
  Object.keys(fields || {}).forEach(function (k) { fd.append(k, fields[k]); });
  (files || []).forEach(function (f) { fd.append(f.field || 'files', new Blob([f.data], { type: f.type }), f.name); });
  return fetch(base + path, { method: method || 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
}
// A 1x1 PNG.
var PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.before(async function () {
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
  var rows = (await pool.query(
    "SELECT u.email, u.employee_id FROM users u WHERE u.email IN ('brian.mutua@bplghana.com','esther.chebet@bplghana.com','faith.wanjiru@bplghana.com','samuel.kiptoo@bplghana.com','kelvin.duho@bplghana.com')"
  )).rows;
  rows.forEach(function (r) { ids[r.email.split('.')[0]] = r.employee_id; });
  brian = await login('brian.mutua@bplghana.com');
  esther = await login('esther.chebet@bplghana.com');
  faith = await login('faith.wanjiru@bplghana.com');
  samuel = await login('samuel.kiptoo@bplghana.com');
  kelvin = await login('kelvin.duho@bplghana.com');
});
test.after(async function () {
  if (groupId) await pool.query('DELETE FROM conversations WHERE id = $1', [groupId]);
  await pool.query("DELETE FROM conversations WHERE direct_key = ANY($1)", [[
    [ids.brian, ids.esther].sort().join('|')
  ]]);
  await pool.query("DELETE FROM stored_files WHERE created_at > now() - interval '1 hour'");
  await pool.query('UPDATE employees SET photo_key = NULL, photo_updated_at = NULL WHERE id = ANY($1)', [[ids.brian, ids.esther]]);
  server.close();
  await pool.end();
});

test('a one-to-one chat with a photo and a document', async function () {
  var res = await form(brian, '/api/messages/' + ids.esther, { body: 'Here are the plans' }, [
    { name: 'site.png', type: 'image/png', data: PNG },
    { name: 'plan.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 test') }
  ]);
  assert.equal(res.status, 201, await res.clone().text());
  var sent = await res.json();

  var inbox = await (await call(esther, 'GET', '/api/messages/')).json();
  var chat = inbox.find(function (c) { return c.id === sent.conversationId; });
  assert.equal(chat.kind, 'direct');
  assert.equal(chat.unread, 1);
  assert.equal(chat.last.files, 2);

  var conv = await (await call(esther, 'GET', '/api/messages/conversations/' + sent.conversationId)).json();
  var msg = conv.messages[conv.messages.length - 1];
  assert.equal(msg.body, 'Here are the plans');
  assert.deepEqual(msg.attachments.map(function (a) { return a.kind; }).sort(), ['file', 'image']);
  var img = msg.attachments.find(function (a) { return a.kind === 'image'; });
  var file = await call(esther, 'GET', '/api/messages/files/' + img.id);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  // Not for anyone outside the chat.
  assert.equal((await call(samuel, 'GET', '/api/messages/files/' + img.id)).status, 404);
  assert.equal((await call(samuel, 'GET', '/api/messages/conversations/' + sent.conversationId)).status, 404);
  // Read now.
  assert.equal((await (await call(esther, 'GET', '/api/messages/')).json()).find(function (c) { return c.id === sent.conversationId; }).unread, 0);
  // Programs are refused.
  var exe = await form(brian, '/api/messages/' + ids.esther, {}, [{ name: 'run.exe', type: 'application/octet-stream', data: Buffer.from('MZ') }]);
  assert.equal(exe.status, 400);
});

test('a group chat: admins manage it, members talk, outsiders see nothing', async function () {
  var res = await call(brian, 'POST', '/api/messages/groups', { name: 'Site team', memberIds: [ids.esther] });
  assert.equal(res.status, 201);
  groupId = (await res.json()).id;

  // Esther is a member, not an admin: can talk, cannot add people.
  assert.equal((await form(esther, '/api/messages/conversations/' + groupId, { body: 'Hello all' })).status, 201);
  assert.equal((await call(esther, 'POST', '/api/messages/conversations/' + groupId + '/members', { employeeIds: [ids.faith] })).status, 403);
  assert.equal((await call(samuel, 'POST', '/api/messages/conversations/' + groupId, { body: 'let me in' })).status, 404);

  // Brian (admin) adds Faith and renames it; Faith sees the history.
  assert.equal((await call(brian, 'POST', '/api/messages/conversations/' + groupId + '/members', { employeeIds: [ids.faith] })).status, 200);
  assert.equal((await call(brian, 'PATCH', '/api/messages/conversations/' + groupId, { name: 'Site team A' })).status, 200);
  var conv = await (await call(faith, 'GET', '/api/messages/conversations/' + groupId)).json();
  assert.equal(conv.kind, 'group');
  assert.equal(conv.name, 'Site team A');
  assert.equal(conv.members.length, 3);
  assert.ok(conv.messages.some(function (m) { return m.body === 'Hello all'; }));
  assert.deepEqual(conv.messages.filter(function (m) { return m.kind === 'system'; }).map(function (m) { return m.meta.event; }), ['created', 'added', 'renamed']);

  // Group photo: admins only; members can see it.
  assert.equal((await form(esther, '/api/messages/conversations/' + groupId + '/photo', {}, [{ field: 'photo', name: 'g.png', type: 'image/png', data: PNG }])).status, 403);
  assert.equal((await form(brian, '/api/messages/conversations/' + groupId + '/photo', {}, [{ field: 'photo', name: 'g.png', type: 'image/png', data: PNG }])).status, 200);
  assert.equal((await call(faith, 'GET', '/api/messages/conversations/' + groupId + '/photo')).status, 200);
  assert.equal((await call(samuel, 'GET', '/api/messages/conversations/' + groupId + '/photo')).status, 404);

  // The last admin leaving hands the group to the longest-standing member.
  assert.equal((await call(brian, 'POST', '/api/messages/conversations/' + groupId + '/leave')).status, 200);
  var after = await (await call(esther, 'GET', '/api/messages/conversations/' + groupId)).json();
  assert.equal(after.members.length, 2);
  assert.equal(after.myRole, 'admin');
  assert.equal((await call(brian, 'GET', '/api/messages/conversations/' + groupId)).status, 404);
  // Faith can be removed by the new admin.
  assert.equal((await call(esther, 'DELETE', '/api/messages/conversations/' + groupId + '/members/' + ids.faith)).status, 200);
});

test('profile photos: your own, or anyone\'s with employee.write', async function () {
  assert.equal((await form(brian, '/api/messages/people/me/photo', {}, [{ field: 'photo', name: 'me.png', type: 'image/png', data: PNG }])).status, 200);
  var dir = await (await call(esther, 'GET', '/api/messages/directory')).json();
  assert.ok(dir.find(function (p) { return p.id === ids.brian; }).photo);
  assert.equal((await call(esther, 'GET', '/api/messages/people/' + ids.brian + '/photo')).status, 200);
  // Esther cannot change Brian's; Kelvin (HR/admin) can change Esther's.
  assert.equal((await form(esther, '/api/messages/people/' + ids.brian + '/photo', {}, [{ field: 'photo', name: 'x.png', type: 'image/png', data: PNG }])).status, 403);
  assert.equal((await form(kelvin, '/api/messages/people/' + ids.esther + '/photo', {}, [{ field: 'photo', name: 'e.png', type: 'image/png', data: PNG }])).status, 200);
  assert.equal((await call(brian, 'DELETE', '/api/messages/people/me/photo')).status, 200);
  assert.equal((await call(esther, 'GET', '/api/messages/people/' + ids.brian + '/photo')).status, 404);
});
