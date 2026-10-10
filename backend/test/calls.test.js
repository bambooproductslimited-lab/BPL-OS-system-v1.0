// Voice and video calls in chats, and booked meetings with guest links
// (calls.service.js, migration 0113). LiveKit itself is not reached here:
// the OS only signs passes for it, which is checked against the secret.
process.env.LIVEKIT_URL = 'wss://zq-test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'ZQTESTKEY';
process.env.LIVEKIT_API_SECRET = 'zq-test-secret-that-is-long-enough-for-hs256';

var test = require('node:test');
var assert = require('node:assert/strict');
var jwt = require('jsonwebtoken');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var config = require('../src/config');
var calls = require('../src/services/calls.service');

var server, base, ids = {}, tok = {}, groupId, directId;
async function login(email) {
  var res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: 'bamboo123' }) });
  return (await res.json()).token;
}
async function call(who, method, path, body) {
  var res = await fetch(base + '/api' + path, {
    method: method, headers: Object.assign(who ? { Authorization: 'Bearer ' + tok[who] } : {}, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  var data = null; try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data: data };
}
function decode(t) { return jwt.verify(t, process.env.LIVEKIT_API_SECRET, { algorithms: ['HS256'] }); }
async function notes(conv) {
  return (await pool.query("SELECT meta FROM messages WHERE conversation_id = $1 AND kind = 'system' ORDER BY at", [conv])).rows.map(function (r) { return r.meta; });
}
function minutesFromNow(n) { return new Date(Date.now() + n * 60000).toISOString(); }

test.before(async function () {
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
  var people = { kelvin: 'kelvin.duho@bplghana.com', faith: 'faith.wanjiru@bplghana.com', samuel: 'samuel.kiptoo@bplghana.com', brian: 'brian.mutua@bplghana.com' };
  for (var k of Object.keys(people)) {
    ids[k] = (await pool.query('SELECT employee_id FROM users WHERE email = $1', [people[k]])).rows[0].employee_id;
    tok[k] = await login(people[k]);
  }
  groupId = (await call('kelvin', 'POST', '/messages/groups', { name: 'Zqc calls', memberIds: [ids.faith, ids.samuel] })).data.id;
  await call('kelvin', 'POST', '/messages/' + ids.brian, { body: 'Zqc hello' });
  directId = (await pool.query("SELECT id FROM conversations WHERE kind = 'direct' AND direct_key = $1", [ids.kelvin < ids.brian ? ids.kelvin + '|' + ids.brian : ids.brian + '|' + ids.kelvin])).rows[0].id;
});
test.after(async function () {
  await pool.query('DELETE FROM conversations WHERE id = ANY($1)', [[groupId, directId].filter(Boolean)]);
  server.close();
  await pool.end();
});

test('a video call in a group: a pass for its room, a note in the chat, ringing for the others', async function () {
  var r = await call('kelvin', 'POST', '/messages/conversations/' + groupId + '/calls', { kind: 'video' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  var c = r.data;
  assert.equal(c.kind, 'video');
  assert.equal(c.url, 'wss://zq-test.livekit.cloud');
  var claims = decode(c.token);
  assert.equal(claims.iss, 'ZQTESTKEY');
  assert.equal(claims.sub, 'emp:' + ids.kelvin);
  assert.equal(claims.video.room, c.room);
  assert.equal(claims.video.roomJoin, true);
  assert.ok(claims.exp - claims.nbf <= 6 * 3600 + 10, 'a pass runs out within hours');
  assert.deepEqual((await notes(groupId)).pop(), { type: 'call', callId: c.id, kind: 'video' });
  var told = (await pool.query("SELECT title FROM notifications WHERE employee_id = $1 AND title LIKE 'Video call from %' ORDER BY at DESC LIMIT 1", [ids.faith])).rows[0];
  assert.ok(told, 'the others are notified');

  var faithLive = (await call('faith', 'GET', '/messages/calls/live')).data;
  var mine = faithLive.calls.find(function (x) { return x.id === c.id; });
  assert.equal(mine.ringing, true);
  assert.equal(mine.inCall, false);
  var kelvinLive = (await call('kelvin', 'GET', '/messages/calls/live')).data.calls.find(function (x) { return x.id === c.id; });
  assert.equal(kelvinLive.ringing, false);
  assert.equal(kelvinLive.inCall, true);

  // Calling the chat again joins the same call.
  var s = (await call('samuel', 'POST', '/messages/conversations/' + groupId + '/calls', { kind: 'voice' })).data;
  assert.equal(s.id, c.id);
  assert.equal(decode(s.token).sub, 'emp:' + ids.samuel);
  // Someone not in the chat can't join or see it.
  assert.equal((await call('brian', 'POST', '/messages/calls/' + c.id + '/join')).status, 404);
  assert.ok(!(await call('brian', 'GET', '/messages/calls/live')).data.calls.some(function (x) { return x.id === c.id; }));

  // Everyone leaves: the call ends, with how long it ran.
  await call('kelvin', 'POST', '/messages/calls/' + c.id + '/leave');
  assert.equal((await pool.query('SELECT ended_at FROM calls WHERE id = $1', [c.id])).rows[0].ended_at, null, 'Samuel is still in it');
  await call('samuel', 'POST', '/messages/calls/' + c.id + '/leave');
  assert.ok((await pool.query('SELECT ended_at FROM calls WHERE id = $1', [c.id])).rows[0].ended_at);
  var ended = (await notes(groupId)).pop();
  assert.equal(ended.type, 'callEnded');
  assert.equal(ended.missed, false);
  assert.equal((await call('faith', 'POST', '/messages/calls/' + c.id + '/join')).status, 409);
});

test('declining a one-to-one call ends it as missed', async function () {
  var c = (await call('kelvin', 'POST', '/messages/conversations/' + directId + '/calls', { kind: 'voice' })).data;
  assert.equal((await call('brian', 'GET', '/messages/calls/live')).data.calls[0].ringing, true);
  await call('brian', 'POST', '/messages/calls/' + c.id + '/decline');
  assert.ok((await pool.query('SELECT ended_at FROM calls WHERE id = $1', [c.id])).rows[0].ended_at);
  var ended = (await notes(directId)).pop();
  assert.equal(ended.type, 'callEnded');
  assert.equal(ended.missed, true);
});

test('a meeting: booked, opens 15 minutes before, guests join by name, cancelled by who booked it', async function () {
  var r = await call('faith', 'POST', '/messages/conversations/' + groupId + '/meetings',
    { title: 'Zqc weekly review', kind: 'video', startsAt: minutesFromNow(120), durationMin: 45, guests: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  var m = r.data;
  assert.equal(m.open, false);
  assert.ok(m.guestToken && m.guestToken.length >= 16);
  assert.deepEqual((await notes(groupId)).pop(), { type: 'meeting', meetingId: m.id });
  assert.equal((await call('kelvin', 'GET', '/messages/meetings/upcoming')).data.filter(function (x) { return x.id === m.id; }).length, 1);

  // Not yet open, for staff or guests.
  var early = await call('kelvin', 'POST', '/messages/meetings/' + m.id + '/join');
  assert.equal(early.status, 409);
  assert.match(early.data.error.message || early.data.error, /opens 15 minutes before/);
  var view = (await call(null, 'GET', '/meet/' + m.guestToken)).data;
  assert.equal(view.title, 'Zqc weekly review');
  assert.equal(view.open, false);
  assert.equal((await call(null, 'POST', '/meet/' + m.guestToken + '/join', { name: 'Zqc Client' })).status, 409);

  // Only who booked it (or a group admin) can move it; moved to 5 minutes from now it is open.
  assert.equal((await call('samuel', 'PATCH', '/messages/meetings/' + m.id, { startsAt: minutesFromNow(5) })).status, 403);
  var moved = (await call('faith', 'PATCH', '/messages/meetings/' + m.id, { startsAt: minutesFromNow(5) })).data;
  assert.equal(moved.open, true);

  var k = (await call('kelvin', 'POST', '/messages/meetings/' + m.id + '/join')).data;
  assert.equal(decode(k.token).video.room, k.room);
  var g = await call(null, 'POST', '/meet/' + m.guestToken + '/join', { name: 'Zqc Client' });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal(g.data.room, k.room, 'guests join the same room');
  assert.equal(decode(g.data.token).name, 'Zqc Client (guest)');
  assert.equal((await call(null, 'POST', '/meet/' + m.guestToken + '/heartbeat', { guestId: g.data.guestId })).data.ended, false);
  assert.equal((await call(null, 'POST', '/meet/not-a-real-meeting-token/join', { name: 'Zq' })).status, 404);

  await call(null, 'POST', '/meet/' + m.guestToken + '/leave', { guestId: g.data.guestId });
  await call('kelvin', 'POST', '/messages/calls/' + k.id + '/leave');
  // Samuel neither booked it nor runs the group; Faith booked it.
  assert.equal((await call('samuel', 'POST', '/messages/meetings/' + m.id + '/cancel')).status, 403);
  var c = await call('faith', 'POST', '/messages/meetings/' + m.id + '/cancel');
  assert.equal(c.status, 200);
  assert.equal(c.data.cancelled, true);
  assert.deepEqual((await notes(groupId)).pop(), { type: 'meetingCancelled', meetingId: m.id, title: 'Zqc weekly review' });
  assert.equal((await call(null, 'POST', '/meet/' + m.guestToken + '/join', { name: 'Zqc Late' })).status, 409);
});

test('15 minutes before, everyone in the chat is reminded once, in the OS and by text', async function () {
  var m = (await call('kelvin', 'POST', '/messages/conversations/' + groupId + '/meetings',
    { title: 'Zqc stand-up', kind: 'voice', startsAt: minutesFromNow(10), durationMin: 15 })).data;
  await pool.query("UPDATE employees SET phone = '0240000001' WHERE id = $1 AND (phone IS NULL OR phone = '')", [ids.samuel]);
  var texts = [];
  var r = await calls.remindDue(async function (opts) { texts.push(opts); return {}; });
  assert.ok(r.meetings >= 1);
  var told = (await pool.query("SELECT employee_id FROM notifications WHERE title = 'Starting soon: Zqc stand-up' AND link = $1", ['chat:' + groupId])).rows.map(function (x) { return x.employee_id; }).sort();
  assert.deepEqual(told, [ids.kelvin, ids.faith, ids.samuel].sort());
  assert.ok(texts.some(function (t) { return t.refId === m.id && /Zqc stand-up/.test(t.message) && t.purpose === 'meeting'; }));
  var again = await calls.remindDue(async function (opts) { texts.push(opts); return {}; });
  assert.equal(again.meetings, 0, 'only once');
});

test('without LiveKit set up, calls say so', async function () {
  var keep = config.livekit.url;
  config.livekit.url = '';
  try {
    var r = await call('kelvin', 'POST', '/messages/conversations/' + groupId + '/calls', { kind: 'voice' });
    assert.equal(r.status, 502);
    assert.match(JSON.stringify(r.data), /LIVEKIT_URL/);
    assert.equal((await call('kelvin', 'GET', '/messages/calls/live')).data.configured, false);
  } finally { config.livekit.url = keep; }
});

test('a call nobody answers drops after a minute, for the caller too, and shows as missed', async function () {
  await pool.query('UPDATE calls SET ended_at = now() WHERE conversation_id = ANY($1) AND ended_at IS NULL', [[groupId, directId]]);
  var c = (await call('kelvin', 'POST', '/messages/conversations/' + directId + '/calls', { kind: 'voice' })).data;
  assert.equal(c.ringFor, calls.RING_MS);
  assert.equal(calls.RING_MS, 60000);

  // Too early: it keeps ringing.
  var early = await call('kelvin', 'POST', '/messages/calls/' + c.id + '/unanswered');
  assert.equal(early.status, 200); assert.equal(early.data.ended, false);
  assert.ok((await call('brian', 'GET', '/messages/calls/live')).data.calls.find(function (x) { return x.id === c.id; }).ringing);

  await pool.query("UPDATE calls SET started_at = now() - interval '61 seconds' WHERE id = $1", [c.id]);
  // Only the caller can drop it; Brian no longer sees it ringing.
  assert.equal((await call('brian', 'POST', '/messages/calls/' + c.id + '/unanswered')).status, 403);
  var live = (await call('brian', 'GET', '/messages/calls/live')).data.calls.find(function (x) { return x.id === c.id; });
  assert.ok(!live || !live.ringing);

  var r = await call('kelvin', 'POST', '/messages/calls/' + c.id + '/unanswered');
  assert.equal(r.data.ended, true);
  var row = (await pool.query('SELECT ended_at FROM calls WHERE id = $1', [c.id])).rows[0];
  assert.ok(row.ended_at);
  var last = (await notes(directId)).pop();
  assert.equal(last.type, 'callEnded'); assert.equal(last.missed, true);
  // Joining it afterwards says it has ended.
  assert.equal((await call('brian', 'POST', '/messages/calls/' + c.id + '/join')).status, 409);
});

test('someone who answers at the last moment keeps the call; the background job drops the rest', async function () {
  var c = (await call('kelvin', 'POST', '/messages/conversations/' + groupId + '/calls', { kind: 'video' })).data;
  await pool.query("UPDATE calls SET started_at = now() - interval '61 seconds' WHERE id = $1", [c.id]);
  assert.equal((await call('faith', 'POST', '/messages/calls/' + c.id + '/join')).status, 200);
  assert.equal((await call('kelvin', 'POST', '/messages/calls/' + c.id + '/unanswered')).data.ended, false);
  await calls.sweep();
  assert.equal((await pool.query('SELECT ended_at FROM calls WHERE id = $1', [c.id])).rows[0].ended_at, null);
  await call('faith', 'POST', '/messages/calls/' + c.id + '/leave');
  await call('kelvin', 'POST', '/messages/calls/' + c.id + '/leave');

  // The caller closed the page while it rang: the job ends it as missed.
  var d = (await call('kelvin', 'POST', '/messages/conversations/' + groupId + '/calls', { kind: 'voice' })).data;
  await call('samuel', 'POST', '/messages/calls/' + d.id + '/decline');
  await pool.query("UPDATE calls SET started_at = now() - interval '61 seconds' WHERE id = $1", [d.id]);
  await calls.sweep();
  assert.ok((await pool.query('SELECT ended_at FROM calls WHERE id = $1', [d.id])).rows[0].ended_at);
  var last = (await notes(groupId)).pop();
  assert.equal(last.type, 'callEnded'); assert.equal(last.missed, true);
});

test('a call rings on phones with the OS closed: an urgent pop-up with Decline, then "Missed call" in its place', async function () {
  var push = require('../src/services/push.service');
  var real = push.sendToEmployee, sent = [];
  push.sendToEmployee = async function (emp, payload, opts) { sent.push({ emp: emp, payload: payload, opts: opts || {} }); return { sent: 1 }; };
  try {
    await pool.query('UPDATE calls SET ended_at = now() WHERE conversation_id = ANY($1) AND ended_at IS NULL', [[groupId, directId]]);
    var c = (await call('kelvin', 'POST', '/messages/conversations/' + groupId + '/calls', { kind: 'video' })).data;
    await new Promise(function (r) { setTimeout(r, 150); });
    var rings = sent.filter(function (s) { return s.payload.type === 'call'; });
    assert.deepEqual(rings.map(function (s) { return s.emp; }).sort(), [ids.faith, ids.samuel].sort());
    var ring = rings[0];
    assert.equal(ring.payload.callId, c.id);
    assert.equal(ring.payload.kind, 'video');
    assert.match(ring.payload.title, /^Video call from /);
    assert.equal(ring.payload.link, 'chat:' + groupId);
    assert.equal(ring.opts.urgency, 'high');
    assert.equal(ring.opts.ttl, 60);
    assert.equal(ring.opts.topic, c.id.replace(/-/g, ''));

    // Decline from the pop-up: works once for that person and call only.
    var samuelRing = rings.find(function (s) { return s.emp === ids.samuel; });
    assert.equal((await call(null, 'POST', '/meet/call-decline', { pass: 'nonsense' })).status, 400);
    var forged = jwt.sign({ p: 'call-decline', c: c.id, e: ids.samuel }, config.jwt.secret, { expiresIn: '5m' });
    assert.equal((await call(null, 'POST', '/meet/call-decline', { pass: forged })).status, 400, 'signed with the session secret: refused');
    // …and the pass is not a sign-in.
    assert.equal((await fetch(base + '/api/messages/calls/live', { headers: { Authorization: 'Bearer ' + samuelRing.payload.declinePass } })).status, 401);
    var d = await call(null, 'POST', '/meet/call-decline', { pass: samuelRing.payload.declinePass });
    assert.equal(d.status, 200, JSON.stringify(d.data));
    var row = (await pool.query('SELECT declined FROM call_participants WHERE call_id = $1 AND employee_id = $2', [c.id, ids.samuel])).rows[0];
    assert.equal(row.declined, true);
    assert.ok(!(await call('samuel', 'GET', '/messages/calls/live')).data.calls.find(function (x) { return x.id === c.id; }).ringing);

    // Nobody answers: Faith (who never picked up) gets "Missed", Samuel (who declined) doesn't.
    sent.length = 0;
    await pool.query("UPDATE calls SET started_at = now() - interval '61 seconds' WHERE id = $1", [c.id]);
    assert.equal((await call('kelvin', 'POST', '/messages/calls/' + c.id + '/unanswered')).data.ended, true);
    await new Promise(function (r) { setTimeout(r, 150); });
    var missed = sent.filter(function (s) { return s.payload.type === 'call-missed'; });
    assert.deepEqual(missed.map(function (s) { return s.emp; }), [ids.faith]);
    assert.match(missed[0].payload.title, /^Missed video call from /);
    assert.equal(missed[0].opts.topic, c.id.replace(/-/g, ''), 'replaces the undelivered ring');
    // Her latest chat notification (other tests running alongside may add a stock alert for her at the same moment).
    var bell = (await pool.query("SELECT title, link FROM notifications WHERE employee_id = $1 AND link LIKE 'chat:%' ORDER BY at DESC LIMIT 1", [ids.faith])).rows[0];
    assert.match(bell.title, /^Missed video call from /);
    assert.equal(bell.link, 'chat:' + groupId);

    // A pass for an ended call is harmless.
    assert.equal((await call(null, 'POST', '/meet/call-decline', { pass: calls.declinePass(c.id, ids.faith) })).data.ended, true);
  } finally {
    push.sendToEmployee = real;
  }
});
