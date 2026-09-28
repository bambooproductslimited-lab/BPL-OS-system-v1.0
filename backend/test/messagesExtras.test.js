// Chats, migration 0110: mentions, replies, reactions, editing and deleting
// your own, pins (admins in a group), typing / seen / online, forwarding
// (files shared, not copied), OS records as cards, search and what was
// shared — members-only throughout.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var chatRecords = require('../src/services/chatRecords.service');
var { buildContext } = require('../src/services/context.service');

var server, base, ids = {}, tok = {}, groupId, directId, customerId;
async function login(email) {
  var res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: 'bamboo123' }) });
  return (await res.json()).token;
}
async function call(who, method, path, body) {
  var res = await fetch(base + '/api/messages' + path, {
    method: method,
    headers: Object.assign({ Authorization: 'Bearer ' + tok[who] }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  var data = null; try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data: data };
}
var PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
function msgBy(conv, pred) { return conv.messages.filter(pred)[0]; }

test.before(async function () {
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
  var people = { kelvin: 'kelvin.duho@bplghana.com', faith: 'faith.wanjiru@bplghana.com', samuel: 'samuel.kiptoo@bplghana.com', brian: 'brian.mutua@bplghana.com' };
  for (var k of Object.keys(people)) {
    ids[k] = (await pool.query('SELECT employee_id FROM users WHERE email = $1', [people[k]])).rows[0].employee_id;
    tok[k] = await login(people[k]);
  }
  customerId = (await pool.query("INSERT INTO customers (name, contact_person, phone) VALUES ('Zqx Buyer Ltd', 'Zq Ama', '0240000000') RETURNING id")).rows[0].id;
});
test.after(async function () {
  if (groupId) await pool.query('DELETE FROM conversations WHERE id = $1', [groupId]);
  if (directId) await pool.query('DELETE FROM conversations WHERE id = $1', [directId]);
  if (customerId) await pool.query('DELETE FROM customers WHERE id = $1', [customerId]);
  await pool.query("DELETE FROM notifications WHERE body LIKE 'Zqx%' OR title LIKE '%mentioned you%'").catch(function () {});
  server.close();
  await pool.end();
});

test('mentions, replies, reactions, edits, pins, typing and seen', async function () {
  var g = await call('kelvin', 'POST', '/groups', { name: 'Zqx crew', memberIds: [ids.faith, ids.samuel] });
  assert.equal(g.status, 201);
  groupId = g.data.id;

  // A mention of someone outside the chat is dropped; the one inside is notified.
  var sent = await call('kelvin', 'POST', '/conversations/' + groupId, { body: 'Zqx hello @Faith', mentions: [ids.faith, ids.brian] });
  assert.equal(sent.status, 201);
  var first = sent.data.id;
  assert.deepEqual((await pool.query('SELECT mentions FROM messages WHERE id = $1', [first])).rows[0].mentions, [ids.faith]);
  var note = (await pool.query("SELECT title FROM notifications WHERE employee_id = $1 AND title LIKE '%mentioned you%' ORDER BY at DESC LIMIT 1", [ids.faith])).rows[0];
  assert.ok(note && /mentioned you in Zqx crew/.test(note.title));

  // Faith replies to it.
  var reply = await call('faith', 'POST', '/conversations/' + groupId, { body: 'Zqx on my way', replyTo: first });
  assert.equal(reply.status, 201);
  var conv = (await call('faith', 'GET', '/conversations/' + groupId)).data;
  var r = msgBy(conv, function (m) { return m.id === reply.data.id; });
  assert.equal(r.replyTo.id, first);
  assert.equal(r.replyTo.body, 'Zqx hello @Faith');
  // Not to a message in another chat.
  var other = await call('kelvin', 'POST', '/' + ids.samuel, { body: 'Zqx direct' });
  directId = other.data.conversationId;
  assert.equal((await call('kelvin', 'POST', '/conversations/' + groupId, { body: 'x', replyTo: other.data.id })).status, 400);

  // Reactions: one per person, the same one again takes it back.
  var before = (await call('kelvin', 'GET', '/conversations/' + groupId + '/pulse')).data.updatedAt;
  assert.equal((await call('samuel', 'POST', '/m/' + first + '/react', { emoji: '👍' })).status, 200);
  await call('faith', 'POST', '/m/' + first + '/react', { emoji: '👍' });
  var re = (await call('faith', 'POST', '/m/' + first + '/react', { emoji: '❤️' })).data.reactions;
  assert.deepEqual(re.map(function (x) { return [x.emoji, x.count, x.mine]; }).sort(), [['❤️', 1, true], ['👍', 1, false]]);
  re = (await call('faith', 'POST', '/m/' + first + '/react', { emoji: '❤️' })).data.reactions;
  assert.deepEqual(re.map(function (x) { return x.emoji; }), ['👍']);
  assert.equal((await call('faith', 'POST', '/m/' + first + '/react', { emoji: 'lol' })).status, 400);
  assert.equal((await call('brian', 'POST', '/m/' + first + '/react', { emoji: '👍' })).status, 404, 'not in the chat');
  var after = (await call('kelvin', 'GET', '/conversations/' + groupId + '/pulse')).data.updatedAt;
  assert.ok(new Date(after) > new Date(before), 'a reaction moves the chat on');

  // Edit your own only.
  assert.equal((await call('kelvin', 'PATCH', '/m/' + reply.data.id, { body: 'nope' })).status, 403);
  assert.equal((await call('faith', 'PATCH', '/m/' + reply.data.id, { body: 'Zqx there in 5' })).status, 200);
  conv = (await call('kelvin', 'GET', '/conversations/' + groupId)).data;
  r = msgBy(conv, function (m) { return m.id === reply.data.id; });
  assert.equal(r.body, 'Zqx there in 5');
  assert.ok(r.editedAt);
  assert.deepEqual(msgBy(conv, function (m) { return m.id === first; }).reactions.map(function (x) { return x.emoji; }), ['👍']);

  // Pins: admins in a group, five at most.
  assert.equal((await call('faith', 'POST', '/m/' + first + '/pin', { pinned: true })).status, 403);
  assert.equal((await call('kelvin', 'POST', '/m/' + first + '/pin', { pinned: true })).status, 200);
  conv = (await call('kelvin', 'GET', '/conversations/' + groupId)).data;
  assert.deepEqual(conv.pinned.map(function (p) { return p.id; }), [first]);
  assert.ok(conv.messages.some(function (m) { return m.kind === 'system' && m.meta.event === 'pinned'; }));
  for (var i = 0; i < 4; i++) {
    var extra = await call('kelvin', 'POST', '/conversations/' + groupId, { body: 'Zqx pin ' + i });
    await call('kelvin', 'POST', '/m/' + extra.data.id + '/pin', { pinned: true });
  }
  var sixth = await call('kelvin', 'POST', '/conversations/' + groupId, { body: 'Zqx sixth' });
  var tooMany = await call('kelvin', 'POST', '/m/' + sixth.data.id + '/pin', { pinned: true });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error.message, /5 pinned/);
  await call('kelvin', 'POST', '/m/' + first + '/pin', { pinned: false });
  assert.equal((await call('kelvin', 'GET', '/conversations/' + groupId)).data.pinned.length, 4);

  // Typing shows to the others, and stops when the message is sent.
  await call('faith', 'POST', '/conversations/' + groupId + '/typing');
  var pulse = (await call('kelvin', 'GET', '/conversations/' + groupId + '/pulse')).data;
  assert.deepEqual(pulse.typing.map(function (t) { return t.id; }), [ids.faith]);
  assert.ok(pulse.online.indexOf(ids.faith) >= 0, 'faith has just used the OS');
  await call('faith', 'POST', '/conversations/' + groupId, { body: 'Zqx done' });
  assert.equal((await call('kelvin', 'GET', '/conversations/' + groupId + '/pulse')).data.typing.length, 0);
  // Seen: each member's last read.
  var reads = (await call('kelvin', 'GET', '/conversations/' + groupId + '/pulse')).data.reads;
  assert.equal(reads.length, 3);
  assert.equal((await call('brian', 'GET', '/conversations/' + groupId + '/pulse')).status, 404);
});

test('forwarding shares files; deleting clears a message but not its forwarded copies', async function () {
  var fd = new FormData();
  fd.append('body', 'Zqx photo');
  fd.append('files', new Blob([PNG], { type: 'image/png' }), 'zqx.png');
  var sent = await (await fetch(base + '/api/messages/conversations/' + groupId, { method: 'POST', headers: { Authorization: 'Bearer ' + tok.kelvin }, body: fd })).json();
  var fw = await call('kelvin', 'POST', '/m/' + sent.id + '/forward', { peerIds: [ids.samuel] });
  assert.equal(fw.status, 200);
  assert.equal(fw.data.sent, 1);
  var direct = (await call('samuel', 'GET', '/conversations/' + directId)).data;
  var copy = direct.messages[direct.messages.length - 1];
  assert.equal(copy.forwarded, true);
  assert.equal(copy.body, 'Zqx photo');
  assert.equal(copy.attachments.length, 1);
  var key = (await pool.query('SELECT storage_key FROM message_attachments WHERE message_id = $1', [sent.id])).rows[0].storage_key;

  assert.equal((await call('samuel', 'DELETE', '/m/' + sent.id)).status, 403, 'only your own');
  assert.equal((await call('kelvin', 'DELETE', '/m/' + sent.id)).status, 200);
  var conv = (await call('faith', 'GET', '/conversations/' + groupId)).data;
  var gone = msgBy(conv, function (m) { return m.id === sent.id; });
  assert.equal(gone.deleted, true);
  assert.equal(gone.body, '');
  assert.equal(gone.attachments.length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM message_attachments WHERE storage_key = $1', [key])).rows[0].n, 1, 'the forwarded copy keeps it');
  var file = await fetch(base + '/api/messages/files/' + copy.attachments[0].id, { headers: { Authorization: 'Bearer ' + tok.samuel } });
  assert.equal(file.status, 200);
  assert.equal((await call('kelvin', 'PATCH', '/m/' + sent.id, { body: 'x' })).status, 400, 'a deleted message can\'t be edited');
  assert.equal((await call('kelvin', 'POST', '/m/' + sent.id + '/forward', {})).status, 400);
});

test('OS records as cards, search, and what was shared', async function () {
  var inv = { id: customerId, invoice_no: 'Zqx Buyer Ltd' };
  var picker = await call('kelvin', 'GET', '/records');
  assert.ok(picker.data.types.indexOf('customer') >= 0);
  var found = await call('kelvin', 'GET', '/records?type=customer&q=' + encodeURIComponent('zqx buyer'));
  assert.ok(found.data.items.some(function (x) { return x.id === inv.id && x.sub === 'Zq Ama · 0240000000'; }));
  var card = await call('kelvin', 'POST', '/conversations/' + groupId, { body: '', record: { type: 'customer', id: inv.id } });
  assert.equal(card.status, 201);
  var conv = (await call('samuel', 'GET', '/conversations/' + groupId)).data;
  var m = msgBy(conv, function (x) { return x.id === card.data.id; });
  assert.equal(m.record.type, 'customer');
  assert.equal(m.record.title, inv.invoice_no);
  assert.equal((await call('kelvin', 'POST', '/conversations/' + groupId, { record: { type: 'customer', id: '00000000-0000-0000-0000-000000000000' } })).status, 404);
  assert.equal((await call('kelvin', 'POST', '/conversations/' + groupId, { record: { type: 'payslip', id: inv.id } })).status, 400);
  // Sharing needs the right to see it.
  var boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var noClients = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (p) { return p !== 'customer.read' && boss.can(p); } });
  await assert.rejects(chatRecords.snapshot(noClients, { type: 'customer', id: inv.id }), /customer.read/);

  // Search: your chats only.
  var hits = (await call('kelvin', 'GET', '/search?q=' + encodeURIComponent('zqx there'))).data;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].conversationId, groupId);
  assert.equal(hits[0].name, 'Zqx crew');
  assert.equal((await call('brian', 'GET', '/search?q=' + encodeURIComponent('zqx there'))).data.length, 0);
  assert.equal((await call('kelvin', 'GET', '/search?q=' + encodeURIComponent(inv.invoice_no))).data[0].id, card.data.id);

  var shared = (await call('faith', 'GET', '/conversations/' + groupId + '/shared')).data;
  assert.equal(shared.records.length, 1);
  assert.equal(shared.images.length, 0, 'the deleted photo is gone');
  // Online shows on people.
  var inbox = (await call('kelvin', 'GET', '')).data;
  var d = inbox.filter(function (c) { return c.id === directId; })[0];
  assert.equal(typeof d.online, 'boolean');
});
