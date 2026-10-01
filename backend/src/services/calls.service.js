var crypto = require('crypto');
var jwt = require('jsonwebtoken');
var { pool, withTransaction } = require('../db/pool');
var config = require('../config');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { notify } = require('../utils/notify');
var messages = require('./messages.service');

// Voice and video calls in a chat, and meetings booked ahead (migration
// 0113). The sound and pictures travel through LiveKit (config.livekit);
// the OS decides who may join, keeps the call's record, and hands each
// person a pass for the call's room that runs out after a few hours.
//
// A call belongs to one chat, and only one runs in a chat at a time: calling
// a chat that already has a call joins it. The others in the chat see it
// ringing for a minute (live()), and in the chat as a note that says who
// called and, when it ends, for how long.
//
// A meeting is a call booked for a time in a chat. It can be joined from 15
// minutes before until an hour after its planned end. With a guest link,
// people outside the company join by name, without an account, in the same
// window. Everyone in the chat is reminded in the OS and by text 15 minutes
// before (remindDue(), jobs/meetingReminders.js).

var RING_MS = 60 * 1000;          // how long a call rings before it drops unanswered
var GONE_MS = 60 * 1000;          // a participant not heard from for this long has left
var PASS_HOURS = 6;               // how long a pass to a room lasts
var EARLY_MIN = 15;               // a meeting opens this long before it starts
var LATE_MIN = 60;                // and stays open this long after its planned end
var UUID = /^[0-9a-f-]{36}$/i;

// ── on the phone, with the OS closed ────────────────────────────────────
// A call reaches a device as a Web Push pop-up (push.service.js), sent
// urgently and only good for as long as the call rings. It carries Answer
// and Decline (public/sw.js). Decline works straight from the pop-up,
// without opening the OS: the pop-up holds a short-lived pass that can
// decline this one call for this one person and do nothing else. It is
// signed with a key derived from the session secret, so it can never pass
// for a sign-in.
var DECLINE_PURPOSE = 'call-decline';
function declineKey() { return crypto.createHmac('sha256', config.jwt.secret).update(DECLINE_PURPOSE).digest(); }
function declinePass(callId, employeeId) {
  return jwt.sign({ p: DECLINE_PURPOSE, c: callId, e: employeeId }, declineKey(), { algorithm: 'HS256', expiresIn: '5m' });
}
function ringPush(call, title, body, employeeId) {
  return {
    data: { type: 'call', callId: call.id, kind: call.kind, declinePass: declinePass(call.id, employeeId) },
    options: { ttl: Math.round(RING_MS / 1000), urgency: 'high', topic: call.id.replace(/-/g, '') }
  };
}
function missedPush(call) {
  return {
    data: { type: 'call-missed', callId: call.id, kind: call.kind },
    options: { ttl: 60 * 60 * 24, urgency: 'normal', topic: call.id.replace(/-/g, '') }
  };
}

function configured() { return config.livekit.configured; }
function needService() {
  if (!configured()) fail('unavailable', 'Calls aren\'t set up yet. An administrator adds LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the server.');
}
function kindOf(v) { return V.oneOf(v || 'voice', ['voice', 'video'], 'Call type'); }
function nameOf(e) { return (e.first_name + ' ' + e.last_name).trim(); }

// A LiveKit access token: a JWT signed with the project's secret, naming the
// room and what the holder may do there.
function pass(room, identity, name) {
  var now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: config.livekit.apiKey, sub: identity, name: name, nbf: now - 10, exp: now + PASS_HOURS * 3600,
    video: { room: room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true }
  }, config.livekit.apiSecret, { algorithm: 'HS256', noTimestamp: false });
}

async function employee(id) {
  return (await pool.query('SELECT id, first_name, last_name, phone FROM employees WHERE id = $1', [id])).rows[0];
}
async function members(db, conversationId) {
  return (await db.query(
    'SELECT e.id, e.first_name, e.last_name, e.phone FROM conversation_members cm JOIN employees e ON e.id = cm.employee_id ' +
    "WHERE cm.conversation_id = $1 AND cm.left_at IS NULL AND e.status <> 'terminated'", [conversationId])).rows;
}
async function liveCall(db, conversationId) {
  return (await db.query('SELECT * FROM calls WHERE conversation_id = $1 AND ended_at IS NULL', [conversationId])).rows[0] || null;
}
function callOut(c) {
  return { id: c.id, conversationId: c.conversation_id, meetingId: c.meeting_id, kind: c.kind, startedBy: c.started_by, startedAt: c.started_at, endedAt: c.ended_at };
}

// ── ending ──────────────────────────────────────────────────────────────
// A call ends when nobody is left in it. Someone who closed the page
// without hanging up stops sending heartbeats and counts as gone.
async function endIfEmpty(db, call, ctx) {
  var here = (await db.query(
    'SELECT count(*)::int AS n FROM call_participants WHERE call_id = $1 AND left_at IS NULL AND seen_at > now() - $2::interval',
    [call.id, GONE_MS / 1000 + ' seconds'])).rows[0].n;
  if (here > 0) return false;
  var ended = (await db.query('UPDATE calls SET ended_at = now() WHERE id = $1 AND ended_at IS NULL RETURNING *', [call.id])).rows[0];
  if (!ended) return false;
  await db.query('UPDATE call_participants SET left_at = coalesce(left_at, seen_at) WHERE call_id = $1', [call.id]);
  var joined = (await db.query('SELECT count(DISTINCT coalesce(employee_id::text, guest_name))::int AS n FROM call_participants WHERE call_id = $1 AND NOT declined', [call.id])).rows[0].n;
  var minutes = Math.max(0, Math.round((new Date(ended.ended_at) - new Date(ended.started_at)) / 60000));
  // Who ended it doesn't matter for the note; it is written as the caller
  // (a note needs someone's name on it, so none when there is nobody).
  if (!call.meeting_id) await tellMissed(db, call);
  var author = ctx ? ctx.employee.id : call.started_by;
  if (author) {
    await messages.systemMessage(db, { employee: { id: author } }, call.conversation_id,
      { type: 'callEnded', callId: call.id, kind: call.kind, minutes: minutes, missed: joined < 2, meetingId: call.meeting_id || null });
    await messages.touch(db, call.conversation_id);
  }
  return true;
}

// A call nobody answered in RING_MS drops for the caller too, and the chat
// shows it as missed. "Answered" is anyone but the caller joining; a booked
// meeting's call is never dropped this way, people join it when they're ready.
async function dropIfUnanswered(db, call) {
  if (call.meeting_id || call.ended_at) return false;
  if (Date.now() - new Date(call.started_at).getTime() < RING_MS - 1000) return false;
  var answered = (await db.query(
    'SELECT 1 FROM call_participants WHERE call_id = $1 AND NOT declined AND (employee_id IS DISTINCT FROM $2) LIMIT 1',
    [call.id, call.started_by])).rows[0];
  if (answered) return false;
  await db.query('UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND left_at IS NULL', [call.id]);
  return endIfEmpty(db, call);
}

// When a call ends, everyone in the chat who never picked up it and didn't
// decline it gets "Missed call" — in the OS, and on their phone in place of
// the ringing pop-up.
async function tellMissed(db, call) {
  var caller = call.started_by ? await employee(call.started_by) : null;
  var who = caller ? nameOf(caller) : 'someone';
  var conv = (await db.query('SELECT kind, name FROM conversations WHERE id = $1', [call.conversation_id])).rows[0];
  var missed = (await db.query(
    'SELECT cm.employee_id AS id FROM conversation_members cm WHERE cm.conversation_id = $1 AND cm.left_at IS NULL ' +
    '  AND cm.employee_id IS DISTINCT FROM $2 ' +
    '  AND NOT EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = $3 AND p.employee_id = cm.employee_id)',
    [call.conversation_id, call.started_by, call.id])).rows;
  var title = (call.kind === 'video' ? 'Missed video call from ' : 'Missed call from ') + who;
  var body = conv && conv.kind === 'group' ? 'In ' + conv.name + '.' : 'Open the chat to call back.';
  for (var i = 0; i < missed.length; i++) {
    await notify(db, missed[i].id, title, body, 'chat:' + call.conversation_id, missedPush(call));
  }
}

// Calls nobody is in any more (everyone closed the page), and calls nobody
// answered, are ended here, from the background job and before a chat is
// called again.
async function sweep() {
  var open = (await pool.query(
    'SELECT * FROM calls WHERE ended_at IS NULL AND started_at < now() - $1::interval',
    [Math.min(GONE_MS, RING_MS) / 1000 + ' seconds'])).rows;
  var n = 0;
  for (var i = 0; i < open.length; i++) {
    await withTransaction(async function (client) {
      var call = (await client.query('SELECT * FROM calls WHERE id = $1 FOR UPDATE', [open[i].id])).rows[0];
      if (await dropIfUnanswered(client, call)) { n++; return; }
      if (Date.now() - new Date(call.started_at).getTime() >= GONE_MS && await endIfEmpty(client, call)) n++;
    });
  }
  return n;
}

// ── in a chat ───────────────────────────────────────────────────────────
async function joinAs(db, ctx, call) {
  var me = ctx.employee;
  var row = (await db.query('SELECT id FROM call_participants WHERE call_id = $1 AND employee_id = $2', [call.id, me.id])).rows[0];
  if (row) await db.query('UPDATE call_participants SET left_at = NULL, declined = false, seen_at = now() WHERE id = $1', [row.id]);
  else await db.query('INSERT INTO call_participants (call_id, employee_id) VALUES ($1, $2)', [call.id, me.id]);
  return Object.assign(callOut(call), {
    url: config.livekit.url, room: call.room,
    token: pass(call.room, 'emp:' + me.id, nameOf(me)),
    me: { identity: 'emp:' + me.id, name: nameOf(me) }
  });
}

// POST /api/messages/conversations/:id/calls { kind } — start a call, or join
// the one already running in this chat.
async function start(ctx, conversationId, kind) {
  needService();
  kind = kindOf(kind);
  await messages.requireMember(pool, ctx, conversationId);
  var existing = await liveCall(pool, conversationId);
  if (existing) {
    if (await withTransaction(function (client) { return endIfEmpty(client, existing, ctx); })) existing = null;
  }
  if (existing) return withTransaction(function (client) { return joinAs(client, ctx, existing); });

  return withTransaction(async function (client) {
    var call;
    try {
      call = (await client.query(
        'INSERT INTO calls (conversation_id, kind, room, started_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [conversationId, kind, 'bpl-' + crypto.randomUUID(), ctx.employee.id])).rows[0];
    } catch (e) {
      if (e.code !== '23505') throw e; // someone else started one this instant: join theirs
      return joinAs(client, ctx, await liveCall(client, conversationId));
    }
    await messages.systemMessage(client, ctx, conversationId, { type: 'call', callId: call.id, kind: kind });
    await messages.touch(client, conversationId);
    var who = nameOf(ctx.employee);
    var conv = (await client.query('SELECT kind, name FROM conversations WHERE id = $1', [conversationId])).rows[0];
    var others = (await members(client, conversationId)).filter(function (m) { return m.id !== ctx.employee.id; });
    var title = (kind === 'video' ? 'Video call from ' : 'Call from ') + who;
    var body = conv.kind === 'group' ? 'In ' + conv.name + '. Tap to answer.' : 'Tap to answer.';
    for (var i = 0; i < others.length; i++) {
      await notify(client, others[i].id, title, body, 'chat:' + conversationId, ringPush(call, title, body, others[i].id));
    }
    return Object.assign(await joinAs(client, ctx, call), { ringFor: RING_MS });
  });
}

async function callFor(ctx, callId) {
  if (!UUID.test(String(callId))) fail('notfound', 'Call not found.');
  var call = (await pool.query('SELECT * FROM calls WHERE id = $1', [callId])).rows[0];
  if (!call) fail('notfound', 'Call not found.');
  await messages.requireMember(pool, ctx, call.conversation_id);
  return call;
}

// POST /api/messages/calls/:id/join
async function join(ctx, callId) {
  needService();
  var call = await callFor(ctx, callId);
  if (call.ended_at) fail('conflict', 'This call has ended.');
  return withTransaction(function (client) { return joinAs(client, ctx, call); });
}

// POST /api/messages/calls/:id/leave
async function leave(ctx, callId) {
  var call = await callFor(ctx, callId);
  await withTransaction(async function (client) {
    await client.query('UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND employee_id = $2 AND left_at IS NULL', [call.id, ctx.employee.id]);
    if (!call.ended_at) await endIfEmpty(client, call, ctx);
  });
  return { ok: true };
}

// POST /api/messages/calls/:id/decline — stop it ringing for me. In a
// one-to-one chat that ends the call for the caller too.
async function decline(ctx, callId) {
  var call = await callFor(ctx, callId);
  await withTransaction(async function (client) {
    var row = (await client.query('SELECT id FROM call_participants WHERE call_id = $1 AND employee_id = $2', [call.id, ctx.employee.id])).rows[0];
    if (row) await client.query('UPDATE call_participants SET declined = true WHERE id = $1', [row.id]);
    else await client.query('INSERT INTO call_participants (call_id, employee_id, declined, left_at) VALUES ($1, $2, true, now())', [call.id, ctx.employee.id]);
    var conv = (await client.query('SELECT kind FROM conversations WHERE id = $1', [call.conversation_id])).rows[0];
    if (conv && conv.kind === 'direct' && !call.ended_at) {
      await client.query('UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND left_at IS NULL', [call.id]);
      await endIfEmpty(client, call, ctx);
    }
  });
  return { ok: true };
}

// POST /api/messages/calls/:id/unanswered — the caller's screen asks, once
// the call has rung for RING_MS with nobody there. The server decides, so
// someone who answered at the last moment keeps the call.
async function unanswered(ctx, callId) {
  var call = await callFor(ctx, callId);
  if (call.started_by !== ctx.employee.id) fail('forbidden', 'Only the caller can drop an unanswered call.');
  var dropped = await withTransaction(async function (client) {
    var locked = (await client.query('SELECT * FROM calls WHERE id = $1 FOR UPDATE', [call.id])).rows[0];
    return dropIfUnanswered(client, locked);
  });
  return { ended: dropped };
}

// POST /api/meet/call-decline { pass } — Decline on the phone's pop-up.
async function declineByPass(pass) {
  var claims;
  try { claims = jwt.verify(String(pass || ''), declineKey(), { algorithms: ['HS256'] }); } catch (e) { claims = null; }
  if (!claims || claims.p !== DECLINE_PURPOSE || !UUID.test(String(claims.c)) || !UUID.test(String(claims.e))) {
    fail('invalid', 'This call can no longer be declined from here.');
  }
  var me = await employee(claims.e);
  if (!me) fail('invalid', 'This call can no longer be declined from here.');
  var call = (await pool.query('SELECT * FROM calls WHERE id = $1', [claims.c])).rows[0];
  if (!call || call.ended_at) return { ok: true, ended: true };
  return decline({ employee: me }, call.id);
}

// POST /api/messages/calls/:id/heartbeat — still here (every 20 s from the call screen).
async function heartbeat(ctx, callId) {
  var call = await callFor(ctx, callId);
  await pool.query('UPDATE call_participants SET seen_at = now() WHERE call_id = $1 AND employee_id = $2 AND left_at IS NULL', [call.id, ctx.employee.id]);
  return { ended: !!call.ended_at };
}

// GET /api/messages/calls/live — calls running in my chats, and which of them
// are ringing for me (started by someone else in the last minute, and I have
// neither joined nor declined). Polled by the app wherever I am.
async function live(ctx) {
  var me = ctx.employee.id;
  var rows = (await pool.query(
    'SELECT c.*, conv.kind AS conv_kind, conv.name AS conv_name, e.first_name, e.last_name, m.title AS meeting_title, ' +
    '  (SELECT count(*)::int FROM call_participants p WHERE p.call_id = c.id AND p.left_at IS NULL AND NOT p.declined AND p.seen_at > now() - interval \'60 seconds\') AS here, ' +
    '  mine.left_at AS my_left_at, mine.declined AS my_declined, mine.id AS my_row ' +
    'FROM calls c JOIN conversations conv ON conv.id = c.conversation_id ' +
    'JOIN conversation_members cm ON cm.conversation_id = c.conversation_id AND cm.employee_id = $1 AND cm.left_at IS NULL ' +
    'LEFT JOIN employees e ON e.id = c.started_by LEFT JOIN meetings m ON m.id = c.meeting_id ' +
    'LEFT JOIN call_participants mine ON mine.call_id = c.id AND mine.employee_id = $1 ' +
    'WHERE c.ended_at IS NULL ORDER BY c.started_at DESC', [me])).rows;
  return rows.map(function (r) {
    var inIt = !!(r.my_row && !r.my_left_at && !r.my_declined);
    var ringing = !r.my_row && r.started_by !== me && !r.meeting_id && Date.now() - new Date(r.started_at).getTime() < RING_MS;
    return {
      id: r.id, conversationId: r.conversation_id, meetingId: r.meeting_id, meetingTitle: r.meeting_title || null, kind: r.kind,
      group: r.conv_kind === 'group', chatName: r.conv_name || null,
      startedBy: r.started_by ? { id: r.started_by, name: r.first_name + ' ' + r.last_name } : null,
      startedAt: r.started_at, people: r.here, inCall: inIt, ringing: ringing
    };
  });
}

// ── meetings ────────────────────────────────────────────────────────────
function meetingOut(m, extra) {
  var start = new Date(m.starts_at).getTime();
  var end = start + m.duration_min * 60000;
  var now = Date.now();
  return Object.assign({
    id: m.id, conversationId: m.conversation_id, title: m.title, kind: m.kind, startsAt: m.starts_at, durationMin: m.duration_min,
    note: m.note, createdBy: m.created_by, cancelled: !!m.cancelled_at,
    guestLink: !!m.guest_token,
    open: !m.cancelled_at && now >= start - EARLY_MIN * 60000 && now <= end + LATE_MIN * 60000,
    over: now > end + LATE_MIN * 60000
  }, extra || {});
}
function meetingInput(p, current) {
  var title = p.title !== undefined ? V.text(p.title, 'Meeting title', 120) : current.title;
  var kind = p.kind !== undefined ? kindOf(p.kind) : current.kind;
  var startsAt = p.startsAt !== undefined ? new Date(p.startsAt) : new Date(current.starts_at);
  if (isNaN(startsAt.getTime())) fail('invalid', 'Choose when the meeting starts.');
  var duration = p.durationMin !== undefined ? Math.round(Number(p.durationMin)) : current.duration_min;
  if (!(duration >= 5 && duration <= 480)) fail('invalid', 'A meeting lasts between 5 minutes and 8 hours.');
  var note = p.note !== undefined ? String(p.note || '').trim().slice(0, 1000) : current.note;
  return { title: title, kind: kind, startsAt: startsAt, durationMin: duration, note: note };
}
function guestToken() { return crypto.randomBytes(18).toString('base64url'); }

// POST /api/messages/conversations/:id/meetings { title, kind, startsAt, durationMin, note, guests }
async function schedule(ctx, conversationId, p) {
  await messages.requireMember(pool, ctx, conversationId);
  var m = meetingInput(p || {}, { title: undefined, kind: 'video', starts_at: null, duration_min: 30, note: '' });
  if (m.startsAt.getTime() < Date.now() - 5 * 60000) fail('invalid', 'That time has already passed.');
  return withTransaction(async function (client) {
    var row = (await client.query(
      'INSERT INTO meetings (conversation_id, title, kind, starts_at, duration_min, note, created_by, guest_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [conversationId, m.title, m.kind, m.startsAt, m.durationMin, m.note, ctx.employee.id, p.guests ? guestToken() : null])).rows[0];
    await messages.systemMessage(client, ctx, conversationId, { type: 'meeting', meetingId: row.id });
    await messages.touch(client, conversationId);
    var who = nameOf(ctx.employee);
    var others = (await members(client, conversationId)).filter(function (x) { return x.id !== ctx.employee.id; });
    for (var i = 0; i < others.length; i++) {
      await notify(client, others[i].id, 'Meeting: ' + m.title, who + ' booked a ' + m.kind + ' call. Open it in Messages.', 'chat:' + conversationId);
    }
    return meetingOut(row, { guestToken: row.guest_token || null });
  });
}

async function meetingFor(ctx, meetingId, manage) {
  if (!UUID.test(String(meetingId))) fail('notfound', 'Meeting not found.');
  var m = (await pool.query('SELECT * FROM meetings WHERE id = $1', [meetingId])).rows[0];
  if (!m) fail('notfound', 'Meeting not found.');
  var mem = await messages.requireMember(pool, ctx, m.conversation_id);
  if (manage && m.created_by !== ctx.employee.id && mem.role !== 'admin') fail('forbidden', 'Only the person who booked it, or a group admin, can change this meeting.');
  return m;
}

// GET /api/messages/meetings/:id
async function meeting(ctx, meetingId) {
  var m = await meetingFor(ctx, meetingId, false);
  var by = m.created_by ? await employee(m.created_by) : null;
  return meetingOut(m, {
    createdByName: by ? nameOf(by) : null, guestToken: m.guest_token || null,
    canManage: m.created_by === ctx.employee.id || (await messages.requireMember(pool, ctx, m.conversation_id)).role === 'admin'
  });
}

// PATCH /api/messages/meetings/:id — change the time, title, type or guest link.
async function update(ctx, meetingId, p) {
  var cur = await meetingFor(ctx, meetingId, true);
  if (cur.cancelled_at) fail('conflict', 'This meeting was cancelled.');
  var m = meetingInput(p || {}, cur);
  var token = cur.guest_token;
  if (p.guests === true && !token) token = guestToken();
  if (p.guests === false) token = null;
  var moved = m.startsAt.getTime() !== new Date(cur.starts_at).getTime();
  var row = (await pool.query(
    'UPDATE meetings SET title = $2, kind = $3, starts_at = $4, duration_min = $5, note = $6, guest_token = $7, reminded_at = CASE WHEN $8 THEN NULL ELSE reminded_at END WHERE id = $1 RETURNING *',
    [cur.id, m.title, m.kind, m.startsAt, m.durationMin, m.note, token, moved])).rows[0];
  return meetingOut(row, { guestToken: row.guest_token || null });
}

// POST /api/messages/meetings/:id/cancel
async function cancel(ctx, meetingId) {
  var cur = await meetingFor(ctx, meetingId, true);
  if (cur.cancelled_at) return meetingOut(cur);
  return withTransaction(async function (client) {
    var row = (await client.query('UPDATE meetings SET cancelled_at = now() WHERE id = $1 RETURNING *', [cur.id])).rows[0];
    await messages.systemMessage(client, ctx, cur.conversation_id, { type: 'meetingCancelled', meetingId: cur.id, title: cur.title });
    await messages.touch(client, cur.conversation_id);
    return meetingOut(row);
  });
}

// GET /api/messages/conversations/:id/meetings — upcoming (and just finished) in a chat.
async function forConversation(ctx, conversationId) {
  await messages.requireMember(pool, ctx, conversationId);
  var rows = (await pool.query(
    "SELECT * FROM meetings WHERE conversation_id = $1 AND cancelled_at IS NULL AND starts_at + (duration_min + $2) * interval '1 minute' > now() ORDER BY starts_at",
    [conversationId, LATE_MIN])).rows;
  return rows.map(function (m) { return meetingOut(m); });
}

// GET /api/messages/meetings/upcoming — mine, in every chat, the next 30 days.
async function upcoming(ctx) {
  var rows = (await pool.query(
    'SELECT m.*, conv.name AS conv_name, conv.kind AS conv_kind FROM meetings m ' +
    'JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.employee_id = $1 AND cm.left_at IS NULL ' +
    'JOIN conversations conv ON conv.id = m.conversation_id ' +
    "WHERE m.cancelled_at IS NULL AND m.starts_at + (m.duration_min + $2) * interval '1 minute' > now() AND m.starts_at < now() + interval '30 days' " +
    'ORDER BY m.starts_at LIMIT 50', [ctx.employee.id, LATE_MIN])).rows;
  return rows.map(function (m) { return meetingOut(m, { chatName: m.conv_name || null, group: m.conv_kind === 'group' }); });
}

// The meeting's call: the one running, or a new one when the first person joins.
async function meetingCall(db, m, starterId) {
  var call = (await db.query('SELECT * FROM calls WHERE meeting_id = $1 AND ended_at IS NULL', [m.id])).rows[0];
  if (call) return call;
  var other = await liveCall(db, m.conversation_id);
  if (other) {
    // A quick call is still running in the chat: the meeting takes it over.
    await db.query('UPDATE calls SET meeting_id = $2 WHERE id = $1', [other.id, m.id]);
    return Object.assign(other, { meeting_id: m.id });
  }
  return (await db.query(
    'INSERT INTO calls (conversation_id, meeting_id, kind, room, started_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [m.conversation_id, m.id, m.kind, 'bpl-' + crypto.randomUUID(), starterId])).rows[0];
}

// POST /api/messages/meetings/:id/join
async function joinMeeting(ctx, meetingId) {
  needService();
  var m = await meetingFor(ctx, meetingId, false);
  var out = meetingOut(m);
  if (m.cancelled_at) fail('conflict', 'This meeting was cancelled.');
  if (!out.open) fail('conflict', out.over ? 'This meeting is over.' : 'The meeting opens ' + EARLY_MIN + ' minutes before it starts.');
  return withTransaction(async function (client) {
    var call = await meetingCall(client, m, ctx.employee.id);
    return Object.assign(await joinAs(client, ctx, call), { meeting: out });
  });
}

// ── guests (no account; the meeting's guest link) ────────────────────────
var guestTries = {};
function guestLimit(ip) {
  var now = Date.now(), k = String(ip || '?');
  var t = (guestTries[k] || []).filter(function (x) { return now - x < 10 * 60000; });
  if (t.length >= 20) fail('rateLimited', 'Too many tries. Wait a few minutes and try again.');
  t.push(now); guestTries[k] = t;
}
async function byGuestToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail('notfound', 'This meeting link isn\'t valid.');
  var m = (await pool.query('SELECT * FROM meetings WHERE guest_token = $1', [token])).rows[0];
  if (!m) fail('notfound', 'This meeting link isn\'t valid any more.');
  return m;
}

// GET /api/meet/:token — what a guest sees before joining.
async function guestView(token) {
  var m = await byGuestToken(token);
  var by = m.created_by ? await employee(m.created_by) : null;
  var co = (await pool.query('SELECT company_name FROM settings WHERE id = 1')).rows[0];
  var out = meetingOut(m);
  return {
    title: m.title, kind: m.kind, startsAt: m.starts_at, durationMin: m.duration_min, note: m.note,
    host: by ? nameOf(by) : null, company: co ? co.company_name : null,
    cancelled: out.cancelled, open: out.open, over: out.over, configured: configured()
  };
}

// POST /api/meet/:token/join { name }
async function guestJoin(token, name, ip) {
  guestLimit(ip);
  needService();
  var m = await byGuestToken(token);
  var out = meetingOut(m);
  if (m.cancelled_at) fail('conflict', 'This meeting was cancelled.');
  if (!out.open) fail('conflict', out.over ? 'This meeting is over.' : 'The meeting opens ' + EARLY_MIN + ' minutes before it starts. Come back then.');
  var guest = V.text(name, 'Your name', 60);
  return withTransaction(async function (client) {
    var call = await meetingCall(client, m, m.created_by);
    var row = (await client.query('INSERT INTO call_participants (call_id, guest_name) VALUES ($1, $2) RETURNING id', [call.id, guest])).rows[0];
    return {
      callId: call.id, guestId: row.id, kind: call.kind, url: config.livekit.url, room: call.room,
      token: pass(call.room, 'guest:' + row.id, guest + ' (guest)'),
      me: { identity: 'guest:' + row.id, name: guest + ' (guest)' },
      meeting: { title: m.title, startsAt: m.starts_at, durationMin: m.duration_min }
    };
  });
}

async function guestRow(token, guestId) {
  var m = await byGuestToken(token);
  if (!UUID.test(String(guestId))) fail('notfound', 'Not in this meeting.');
  var row = (await pool.query(
    'SELECT p.id, c.* FROM call_participants p JOIN calls c ON c.id = p.call_id WHERE p.id = $1 AND c.meeting_id = $2 AND p.guest_name IS NOT NULL',
    [guestId, m.id])).rows[0];
  if (!row) fail('notfound', 'Not in this meeting.');
  return row;
}
// POST /api/meet/:token/heartbeat { guestId } and /leave { guestId }
async function guestHeartbeat(token, guestId) {
  var row = await guestRow(token, guestId);
  await pool.query('UPDATE call_participants SET seen_at = now() WHERE id = $1 AND left_at IS NULL', [guestId]);
  return { ended: !!row.ended_at };
}
async function guestLeave(token, guestId) {
  var row = await guestRow(token, guestId);
  await withTransaction(async function (client) {
    await client.query('UPDATE call_participants SET left_at = now() WHERE id = $1 AND left_at IS NULL', [guestId]);
    var call = (await client.query('SELECT * FROM calls WHERE id = $1', [row.call_id || row.id])).rows[0];
    if (call && !call.ended_at) await endIfEmpty(client, call, null);
  });
  return { ok: true };
}

// ── reminders ───────────────────────────────────────────────────────────
// 15 minutes before a meeting: a notification to everyone in the chat, and a
// text to those with a phone number when texts are set up. Once per meeting;
// moving a meeting to a new time reminds again.
async function remindDue(sendSms) {
  var due = (await pool.query(
    "SELECT m.*, conv.name AS conv_name FROM meetings m JOIN conversations conv ON conv.id = m.conversation_id " +
    "WHERE m.cancelled_at IS NULL AND m.reminded_at IS NULL AND m.starts_at <= now() + interval '15 minutes' AND m.starts_at > now() - interval '5 minutes'")).rows;
  var sent = 0, texts = 0;
  for (var i = 0; i < due.length; i++) {
    var m = due[i];
    var claimed = (await pool.query('UPDATE meetings SET reminded_at = now() WHERE id = $1 AND reminded_at IS NULL RETURNING id', [m.id])).rows[0];
    if (!claimed) continue; // another server got there first
    var people = await members(pool, m.conversation_id);
    var at = new Date(m.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Accra' });
    for (var j = 0; j < people.length; j++) {
      await notify(pool, people[j].id, 'Starting soon: ' + m.title, (m.kind === 'video' ? 'Video' : 'Voice') + ' meeting at ' + at + '. Join it in Messages.', 'chat:' + m.conversation_id);
      sent++;
      if (sendSms && people[j].phone) {
        try {
          await sendSms({ to: people[j].phone, purpose: 'meeting', refId: m.id,
            message: 'Reminder: "' + m.title + '" (' + m.kind + ' meeting) starts at ' + at + '. Join in Bamboo OS > Messages.' });
          texts++;
        } catch (e) { /* a number that can't be texted must not stop the others */ }
      }
    }
  }
  return { meetings: due.length, notified: sent, texted: texts };
}

module.exports = {
  configured: configured, pass: pass,
  start: start, join: join, leave: leave, decline: decline, declineByPass: declineByPass, unanswered: unanswered, heartbeat: heartbeat, live: live, sweep: sweep,
  RING_MS: RING_MS, declinePass: declinePass,
  schedule: schedule, meeting: meeting, update: update, cancel: cancel, forConversation: forConversation, upcoming: upcoming, joinMeeting: joinMeeting,
  guestView: guestView, guestJoin: guestJoin, guestHeartbeat: guestHeartbeat, guestLeave: guestLeave,
  remindDue: remindDue, EARLY_MIN: EARLY_MIN, LATE_MIN: LATE_MIN
};
