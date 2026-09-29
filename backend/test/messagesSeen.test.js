// Who has seen a message in a group (migration 0111): opening a chat records
// when each new message was read; the sender, or a group admin, sees who has
// read it and when, and who hasn't yet. Nobody else can.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');

var server, base, ids = {}, tok = {}, groupId;
async function login(email) {
  var res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: 'bamboo123' }) });
  return (await res.json()).token;
}
async function call(who, method, path, body) {
  var res = await fetch(base + '/api/messages' + path, {
    method: method, headers: Object.assign({ Authorization: 'Bearer ' + tok[who] }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  var data = null; try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data: data };
}
test.before(async function () {
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
  var people = { kelvin: 'kelvin.duho@bplghana.com', faith: 'faith.wanjiru@bplghana.com', samuel: 'samuel.kiptoo@bplghana.com', brian: 'brian.mutua@bplghana.com' };
  for (var k of Object.keys(people)) {
    ids[k] = (await pool.query('SELECT employee_id FROM users WHERE email = $1', [people[k]])).rows[0].employee_id;
    tok[k] = await login(people[k]);
  }
});
test.after(async function () {
  if (groupId) await pool.query('DELETE FROM conversations WHERE id = $1', [groupId]);
  server.close();
  await pool.end();
});

test('the sender sees who has read a group message and when; others can\'t', async function () {
  groupId = (await call('kelvin', 'POST', '/groups', { name: 'Zqs seen', memberIds: [ids.faith, ids.samuel] })).data.id;
  var sent = (await call('kelvin', 'POST', '/conversations/' + groupId, { body: 'Zqs please read' })).data;

  var before = (await call('kelvin', 'GET', '/m/' + sent.id + '/seen')).data;
  assert.equal(before.seen.length, 0);
  assert.deepEqual(before.notSeen.map(function (p) { return p.id; }).sort(), [ids.faith, ids.samuel].sort());

  // Faith opens the chat.
  await call('faith', 'GET', '/conversations/' + groupId);
  var after = (await call('kelvin', 'GET', '/m/' + sent.id + '/seen')).data;
  assert.deepEqual(after.seen.map(function (p) { return p.id; }), [ids.faith]);
  assert.ok(after.seen[0].readAt, 'with the time it was read');
  assert.ok(new Date(after.seen[0].readAt) >= new Date(sent.at));
  assert.deepEqual(after.notSeen.map(function (p) { return p.id; }), [ids.samuel]);
  assert.equal(after.body, 'Zqs please read');
  // Opening again doesn't change when it was first read.
  var first = after.seen[0].readAt;
  await call('faith', 'GET', '/conversations/' + groupId);
  assert.equal((await call('kelvin', 'GET', '/m/' + sent.id + '/seen')).data.seen[0].readAt, first);

  // Faith is neither the sender nor an admin; Brian isn't in the chat.
  assert.equal((await call('faith', 'GET', '/m/' + sent.id + '/seen')).status, 403);
  assert.equal((await call('brian', 'GET', '/m/' + sent.id + '/seen')).status, 404);
  // Made an admin, she can.
  await call('kelvin', 'POST', '/conversations/' + groupId + '/admins/' + ids.faith, { admin: true });
  assert.equal((await call('faith', 'GET', '/m/' + sent.id + '/seen')).status, 200);

  // Answering in the chat reads what came before, with the time, even without opening it again.
  var ask = (await call('kelvin', 'POST', '/conversations/' + groupId, { body: 'Zqs who is on shift?' })).data;
  await call('samuel', 'POST', '/conversations/' + groupId, { body: 'Zqs me' });
  var answered = (await call('kelvin', 'GET', '/m/' + ask.id + '/seen')).data;
  var bySam = answered.seen.find(function (p) { return p.id === ids.samuel; });
  assert.ok(bySam && bySam.readAt, 'seen with a time');
  assert.deepEqual(answered.notSeen.map(function (p) { return p.id; }), [ids.faith]);

  // Read before the times were kept: seen from where the member has read up to, with no time.
  var old = (await call('kelvin', 'POST', '/conversations/' + groupId, { body: 'Zqs older' })).data;
  await pool.query("UPDATE conversation_members SET last_read_at = now() + interval '1 minute' WHERE conversation_id = $1 AND employee_id = $2", [groupId, ids.samuel]);
  var legacy = (await call('kelvin', 'GET', '/m/' + old.id + '/seen')).data;
  var sam = legacy.seen.find(function (p) { return p.id === ids.samuel; });
  assert.ok(sam);
  assert.equal(sam.readAt, null);
  // Group events have no readers.
  var sys = (await pool.query("SELECT id FROM messages WHERE conversation_id = $1 AND kind = 'system' LIMIT 1", [groupId])).rows[0];
  assert.equal((await call('kelvin', 'GET', '/m/' + sys.id + '/seen')).status, 400);
});
