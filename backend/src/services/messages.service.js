var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var fileStore = require('../lib/fileStore');
var chatRecords = require('./chatRecords.service');

// Chats (migration 0080): one-to-one ('direct') and group conversations,
// messages with files, and profile photos for people and groups.
//
// Anyone signed in can message anyone active, as before. A conversation's
// messages, files and details are only for its current members. In a group
// the admins (whoever created it, and anyone they make admin) rename it,
// change its photo and add or remove people; anyone can leave. Unread is
// what others sent after the member's last_read_at.
//
// Migration 0110 adds: replying to a message, editing and deleting your own,
// forwarding, pinning (anyone in a one-to-one chat, admins in a group),
// @mentions (which notify), one emoji reaction per person per message,
// sharing an OS record as a card (chatRecords.service.js), "seen" from each
// member's last_read_at, "typing…" and "online", search across your chats,
// and everything shared in a chat. conversations.updated_at moves on any of
// these, so an open chat asks pulse() and reloads only when it changed.

var MAX_FILES = 10;
var MAX_GROUP_MEMBERS = 256;
var MAX_PINS = 5;
var ONLINE_MS = 2 * 60 * 1000;
var TYPING_MS = 6000;
var REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '🔥'];
var UUID = /^[0-9a-f-]{36}$/i;

async function touch(db, conversationId) {
  await db.query('UPDATE conversations SET updated_at = clock_timestamp() WHERE id = $1', [conversationId]);
}
function online(ts) { return !!ts && Date.now() - new Date(ts).getTime() < ONLINE_MS; }

function fullName(r) { return r.first_name + ' ' + r.last_name; }
function directKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
function version(ts) { return ts ? new Date(ts).getTime() : null; }

// 'image' | 'video' | 'audio' | 'file', from the type the browser gave.
function fileKind(contentType, name) {
  var t = String(contentType || '').toLowerCase();
  var ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1] || '';
  if (t.indexOf('image/') === 0 && t !== 'image/svg+xml') return 'image';
  if (t.indexOf('video/') === 0) return 'video';
  if (t.indexOf('audio/') === 0) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].indexOf(ext.toLowerCase()) >= 0) return 'image';
  return 'file';
}

async function membership(db, conversationId, employeeId) {
  return (await db.query(
    'SELECT cm.*, c.kind, c.name, c.direct_key FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id ' +
    'WHERE cm.conversation_id = $1 AND cm.employee_id = $2 AND cm.left_at IS NULL', [conversationId, employeeId]
  )).rows[0];
}
async function requireMember(db, ctx, conversationId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(conversationId))) fail('notfound', 'Chat not found.');
  var m = await membership(db, conversationId, ctx.employee.id);
  if (!m) fail('notfound', 'Chat not found.');
  return m;
}
function requireAdmin(m) {
  if (m.kind !== 'group') fail('invalid', 'This is not a group.');
  if (m.role !== 'admin') fail('forbidden', 'Only a group admin can do that.');
}

async function employeeRows(ids) {
  if (!ids.length) return [];
  return (await pool.query(
    'SELECT e.id, e.first_name, e.last_name, e.position_title, e.status, e.photo_updated_at, e.photo_key, e.last_seen_at, d.name AS department ' +
    'FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ANY($1)', [ids]
  )).rows;
}
function personOut(e) {
  return {
    id: e.id, name: fullName(e), title: e.position_title || '', department: e.department || '',
    photo: e.photo_key ? version(e.photo_updated_at) : null, active: e.status === 'active',
    online: online(e.last_seen_at), lastSeenAt: e.last_seen_at || null
  };
}

// ── conversations list ────────────────────────────────────────────────
// kernel.js: handlers['messages.inbox']
async function inbox(ctx) {
  var mine = ctx.employee.id;
  var rows = (await pool.query(
    'SELECT c.*, cm.last_read_at, cm.role, ' +
    '(SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.from_id <> $1 AND m.at > cm.last_read_at) AS unread, ' +
    '(SELECT count(*)::int FROM conversation_members x WHERE x.conversation_id = c.id AND x.left_at IS NULL) AS member_count ' +
    'FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.employee_id = $1 AND cm.left_at IS NULL ' +
    "WHERE c.kind = 'group' OR c.last_message_at IS NOT NULL ORDER BY coalesce(c.last_message_at, c.created_at) DESC", [mine]
  )).rows;
  if (!rows.length) return [];
  var ids = rows.map(function (r) { return r.id; });
  var last = {};
  (await pool.query(
    'SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.id, m.from_id, m.body, m.kind, m.meta, m.at, m.deleted_at, m.record, e.first_name, e.last_name, ' +
    '(SELECT count(*)::int FROM message_attachments a WHERE a.message_id = m.id) AS files, ' +
    '(SELECT min(a.kind) FROM message_attachments a WHERE a.message_id = m.id) AS file_kind ' +
    'FROM messages m JOIN employees e ON e.id = m.from_id WHERE m.conversation_id = ANY($1) ORDER BY m.conversation_id, m.at DESC', [ids]
  )).rows.forEach(function (m) { last[m.conversation_id] = m; });
  // The other person in each one-to-one chat.
  var peerIds = rows.filter(function (r) { return r.kind === 'direct'; }).map(function (r) {
    var p = r.direct_key.split('|'); return p[0] === mine ? p[1] : p[0];
  });
  var peers = {};
  (await employeeRows(peerIds)).forEach(function (e) { peers[e.id] = e; });

  return rows.map(function (r) {
    var m = last[r.id];
    var out = {
      id: r.id, kind: r.kind, unread: r.unread, memberCount: r.member_count,
      lastAt: m ? m.at : r.created_at,
      last: m ? {
        body: m.body, kind: m.kind, meta: m.meta, files: m.files, fileKind: m.file_kind,
        fromMe: m.from_id === mine, fromName: m.first_name, deleted: !!m.deleted_at,
        record: m.record ? { type: m.record.type, title: m.record.title } : null
      } : null
    };
    if (r.kind === 'direct') {
      var p = r.direct_key.split('|'); var peerId = p[0] === mine ? p[1] : p[0];
      var peer = peers[peerId];
      Object.assign(out, {
        peerId: peerId, name: peer ? fullName(peer) : '', title: peer ? peer.position_title || '' : '',
        photo: peer && peer.photo_key ? version(peer.photo_updated_at) : null, online: peer ? online(peer.last_seen_at) : false
      });
    } else {
      Object.assign(out, { name: r.name, title: r.description, photo: r.photo_key ? version(r.photo_updated_at) : null, role: r.role });
    }
    return out;
  });
}

// kernel.js: handlers['messages.directory'] — everyone active, for starting
// a chat or adding people to a group.
async function directory(ctx) {
  var res = await pool.query(
    "SELECT e.id, e.first_name, e.last_name, e.position_title, e.status, e.photo_key, e.photo_updated_at, e.last_seen_at, d.name AS department " +
    "FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'active' AND e.id != $1",
    [ctx.employee.id]
  );
  return res.rows.map(personOut).sort(function (a, b) { return a.name.localeCompare(b.name); });
}

// ── one conversation ─────────────────────────────────────────────────
function snippet(m) {
  if (!m) return null;
  return {
    id: m.id, fromId: m.from_id, fromName: fullName(m), deleted: !!m.deleted_at,
    body: m.deleted_at ? '' : String(m.body || '').slice(0, 160), files: Number(m.files || 0), fileKind: m.file_kind || null,
    record: !m.deleted_at && m.record ? { type: m.record.type, title: m.record.title } : null
  };
}
function messageOut(m, mine, extra) {
  var deleted = !!m.deleted_at;
  return {
    id: m.id, fromId: m.from_id, fromName: fullName(m), fromMe: m.from_id === mine, body: deleted ? '' : m.body, at: m.at,
    kind: m.kind, meta: m.meta, attachments: deleted ? [] : (extra.attachments[m.id] || []),
    replyTo: m.reply_to ? (extra.replies[m.reply_to] || { id: m.reply_to, deleted: true, fromName: '', body: '' }) : null,
    editedAt: m.edited_at || null, deleted: deleted, forwarded: !!m.forwarded, pinned: !!m.pinned_at,
    record: deleted ? null : m.record || null, mentions: m.mentions || [],
    reactions: deleted ? [] : (extra.reactions[m.id] || [])
  };
}
var MSG_SELECT = 'SELECT m.*, e.first_name, e.last_name, ' +
  '(SELECT count(*)::int FROM message_attachments a WHERE a.message_id = m.id) AS files, ' +
  '(SELECT min(a.kind) FROM message_attachments a WHERE a.message_id = m.id) AS file_kind ' +
  'FROM messages m JOIN employees e ON e.id = m.from_id ';

// Reactions grouped by emoji: [{ emoji, count, mine, names }].
async function reactionsFor(ids, mine) {
  var out = {};
  if (!ids.length) return out;
  (await pool.query(
    'SELECT r.message_id, r.emoji, r.employee_id, e.first_name, e.last_name FROM message_reactions r JOIN employees e ON e.id = r.employee_id ' +
    'WHERE r.message_id = ANY($1) ORDER BY r.created_at', [ids]
  )).rows.forEach(function (r) {
    var list = out[r.message_id] = out[r.message_id] || [];
    var g = list.filter(function (x) { return x.emoji === r.emoji; })[0];
    if (!g) { g = { emoji: r.emoji, count: 0, mine: false, names: [] }; list.push(g); }
    g.count += 1; g.names.push(fullName(r));
    if (r.employee_id === mine) g.mine = true;
  });
  return out;
}

async function conversationOut(ctx, conversationId, m) {
  var mine = ctx.employee.id;
  var c = (await pool.query('SELECT * FROM conversations WHERE id = $1', [conversationId])).rows[0];
  var memberRows = (await pool.query(
    'SELECT employee_id, role, joined_at, last_read_at, typing_at FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL', [conversationId]
  )).rows;
  var people = {};
  (await employeeRows(memberRows.map(function (x) { return x.employee_id; }))).forEach(function (e) { people[e.id] = e; });
  var members = memberRows.filter(function (x) { return people[x.employee_id]; }).map(function (x) {
    return Object.assign(personOut(people[x.employee_id]), {
      role: x.role, me: x.employee_id === mine, lastReadAt: x.last_read_at,
      typing: x.employee_id !== mine && !!x.typing_at && Date.now() - new Date(x.typing_at).getTime() < TYPING_MS
    });
  }).sort(function (a, b) { return (b.me - a.me) || ((a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1)) || a.name.localeCompare(b.name); });

  var msgs = (await pool.query(
    'SELECT * FROM (' + MSG_SELECT + 'WHERE m.conversation_id = $1 ORDER BY m.at DESC LIMIT 300) x ORDER BY at', [conversationId]
  )).rows;
  var ids = msgs.map(function (x) { return x.id; });
  var attachmentsById = {};
  if (msgs.length) {
    (await pool.query(
      'SELECT id, message_id, file_name, content_type, size, kind FROM message_attachments WHERE message_id = ANY($1) ORDER BY created_at, file_name',
      [ids]
    )).rows.forEach(function (a) {
      (attachmentsById[a.message_id] = attachmentsById[a.message_id] || []).push({ id: a.id, fileName: a.file_name, contentType: a.content_type, size: a.size, kind: a.kind });
    });
  }
  // What each reply points at, even when that message is older than the 300 shown.
  var replyIds = Array.from(new Set(msgs.map(function (x) { return x.reply_to; }).filter(Boolean)));
  var replies = {};
  if (replyIds.length) {
    (await pool.query(MSG_SELECT + 'WHERE m.id = ANY($1)', [replyIds])).rows.forEach(function (r) { replies[r.id] = snippet(r); });
  }
  var reactions = await reactionsFor(ids, mine);
  var pinned = (await pool.query(MSG_SELECT + 'WHERE m.conversation_id = $1 AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL ORDER BY m.pinned_at DESC', [conversationId]))
    .rows.map(function (r) { return Object.assign(snippet(r), { at: r.at, pinnedAt: r.pinned_at }); });

  // Opening a chat reads it.
  await markRead(pool, conversationId, mine, null);
  await pool.query('UPDATE messages SET read = true WHERE conversation_id = $1 AND to_id = $2 AND read = false', [conversationId, mine]);

  var out = {
    id: c.id, kind: c.kind, createdAt: c.created_at, updatedAt: c.updated_at, myRole: m.role, members: members, pinned: pinned,
    canPin: c.kind === 'direct' || m.role === 'admin',
    reactionChoices: REACTIONS,
    messages: msgs.map(function (x) { return messageOut(x, mine, { attachments: attachmentsById, replies: replies, reactions: reactions }); })
  };
  if (c.kind === 'direct') {
    var p = c.direct_key.split('|'); var peerId = p[0] === mine ? p[1] : p[0];
    var peer = members.filter(function (x) { return x.id === peerId; })[0] || personOut((await employeeRows([peerId]))[0]);
    Object.assign(out, { peerId: peerId, name: peer.name, title: peer.title, department: peer.department, photo: peer.photo, peer: peer });
  } else {
    Object.assign(out, { name: c.name, description: c.description, photo: c.photo_key ? version(c.photo_updated_at) : null, createdBy: c.created_by });
  }
  return out;
}

async function conversation(ctx, conversationId) {
  var m = await requireMember(pool, ctx, conversationId);
  return conversationOut(ctx, conversationId, m);
}

// A one-to-one chat with someone, or an empty one if there is none yet (it
// is created with the first message).
// kernel.js: handlers['messages.thread']
async function direct(ctx, peerId) {
  var peer = (await employeeRows([peerId]))[0];
  if (!peer) fail('notfound', 'Employee not found.');
  if (peerId === ctx.employee.id) fail('invalid', 'You cannot message yourself.');
  var c = (await pool.query('SELECT id FROM conversations WHERE direct_key = $1', [directKey(ctx.employee.id, peerId)])).rows[0];
  if (c) {
    var m = await membership(pool, c.id, ctx.employee.id);
    if (m) return conversationOut(ctx, c.id, m);
  }
  var p = personOut(peer);
  return {
    id: null, kind: 'direct', peerId: peerId, name: p.name, title: p.title, department: p.department, photo: p.photo, peer: p,
    myRole: 'member', members: [], messages: [], pinned: [], canPin: true, reactionChoices: REACTIONS
  };
}

async function getOrCreateDirect(client, ctx, peerId) {
  var peer = (await client.query("SELECT id, first_name, last_name, status FROM employees WHERE id = $1", [peerId])).rows[0];
  if (!peer) fail('invalid', 'Choose a recipient.');
  if (peerId === ctx.employee.id) fail('invalid', 'You cannot message yourself.');
  var key = directKey(ctx.employee.id, peerId);
  var c = (await client.query('SELECT id FROM conversations WHERE direct_key = $1', [key])).rows[0];
  if (!c) {
    c = (await client.query(
      "INSERT INTO conversations (kind, direct_key, created_by) VALUES ('direct', $1, $2) ON CONFLICT (direct_key) DO UPDATE SET direct_key = EXCLUDED.direct_key RETURNING id",
      [key, ctx.employee.id]
    )).rows[0];
  }
  await client.query(
    'INSERT INTO conversation_members (conversation_id, employee_id) VALUES ($1, $2), ($1, $3) ON CONFLICT (conversation_id, employee_id) DO UPDATE SET left_at = NULL',
    [c.id, ctx.employee.id, peerId]
  );
  return c.id;
}

// ── sending ──────────────────────────────────────────────────────────
function attachmentLabel(files) {
  if (!files.length) return '';
  var k = fileKind(files[0].mimetype, files[0].originalname);
  if (files.length > 1) return files.length + ' files';
  return k === 'image' ? 'Photo' : k === 'video' ? 'Video' : k === 'audio' ? 'Audio' : files[0].originalname;
}

// A value from a form or JSON: an id list may arrive as JSON text.
function idList(v) {
  if (v == null || v === '') return [];
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = [v]; } }
  return (Array.isArray(v) ? v : [v]).map(String).filter(function (x) { return UUID.test(x); });
}
function recordIn(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { fail('invalid', 'Choose something to share.'); } }
  return v;
}

// files: multer files ({ originalname, mimetype, buffer, size }).
// opts: { replyTo, mentions: [employee ids], record: { type, id } } — or,
// when forwarding, { forwarded: true, recordSnapshot, copyAttachments }.
async function sendTo(ctx, conversationId, body, files, opts) {
  opts = opts || {};
  files = (files || []).filter(Boolean);
  body = String(body || '').trim();
  var record = opts.recordSnapshot || null;
  var wantRecord = recordIn(opts.record);
  if (wantRecord) record = await chatRecords.snapshot(ctx, wantRecord);
  var copies = opts.copyAttachments || [];
  if (!body && !files.length && !record && !copies.length) fail('invalid', 'Write a message or attach a file.');
  if (body.length > 4000) fail('invalid', 'Message is too long (4000 characters at most).');
  if (files.length > MAX_FILES) fail('invalid', 'Send at most ' + MAX_FILES + ' files at a time.');

  // Files are stored before the transaction (R2 cannot roll back), and
  // removed again if the message cannot be saved.
  var stored = [];
  try {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      stored.push({
        key: await fileStore.put(f.originalname, f.buffer, f.mimetype),
        name: String(f.originalname || 'file').slice(-200), type: f.mimetype || 'application/octet-stream', size: f.size || f.buffer.length,
        kind: fileKind(f.mimetype, f.originalname)
      });
    }
    return await withTransaction(async function (client) {
      var m = await membership(client, conversationId, ctx.employee.id);
      if (!m) fail('notfound', 'Chat not found.');
      var others = (await client.query(
        'SELECT cm.employee_id FROM conversation_members cm WHERE cm.conversation_id = $1 AND cm.left_at IS NULL AND cm.employee_id <> $2',
        [conversationId, ctx.employee.id]
      )).rows.map(function (r) { return r.employee_id; });
      var toId = m.kind === 'direct' ? others[0] || null : null;
      var replyTo = null;
      if (opts.replyTo) {
        if (!UUID.test(String(opts.replyTo))) fail('invalid', 'That message isn\'t in this chat.');
        var target = (await client.query("SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 AND kind = 'text' AND deleted_at IS NULL", [opts.replyTo, conversationId])).rows[0];
        if (!target) fail('invalid', 'That message isn\'t in this chat.');
        replyTo = target.id;
      }
      // Only people in this chat can be mentioned.
      var mentions = idList(opts.mentions).filter(function (id, i, a) { return others.indexOf(id) >= 0 && a.indexOf(id) === i; });
      var msg = (await client.query(
        'INSERT INTO messages (from_id, to_id, body, conversation_id, reply_to, record, mentions, forwarded) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
        [ctx.employee.id, toId, body, conversationId, replyTo, record, mentions, !!opts.forwarded]
      )).rows[0];
      for (var cp = 0; cp < copies.length; cp++) {
        var a0 = copies[cp];
        await client.query(
          'INSERT INTO message_attachments (message_id, file_name, content_type, size, kind, storage_key) VALUES ($1,$2,$3,$4,$5,$6)',
          [msg.id, a0.file_name, a0.content_type, a0.size, a0.kind, a0.storage_key]
        );
      }
      for (var j = 0; j < stored.length; j++) {
        var s = stored[j];
        await client.query(
          'INSERT INTO message_attachments (message_id, file_name, content_type, size, kind, storage_key) VALUES ($1,$2,$3,$4,$5,$6)',
          [msg.id, s.name, s.type, s.size, s.kind, s.key]
        );
      }
      await client.query('UPDATE conversations SET last_message_at = $2, updated_at = clock_timestamp() WHERE id = $1', [conversationId, msg.at]);
      await markRead(client, conversationId, ctx.employee.id, msg.at);
      await client.query('UPDATE conversation_members SET typing_at = NULL WHERE conversation_id = $1 AND employee_id = $2', [conversationId, ctx.employee.id]);

      var me = ctx.employee.first_name + ' ' + ctx.employee.last_name;
      var preview = (body || (record ? record.title : '') || attachmentLabel(files) || (copies.length ? copies.length + ' file(s)' : '')).slice(0, 140);
      for (var k = 0; k < others.length; k++) {
        if (mentions.indexOf(others[k]) >= 0) await notify(client, others[k], me + ' mentioned you' + (m.kind === 'group' ? ' in ' + m.name : ''), preview, m.kind === 'direct' ? 'message:' + ctx.employee.id : 'chat:' + conversationId);
        else if (m.kind === 'direct') await notify(client, others[k], 'New message from ' + me, preview, 'message:' + ctx.employee.id);
        else await notify(client, others[k], me + ' in ' + m.name, preview, 'chat:' + conversationId);
      }
      await audit(client, ctx, 'message.send', 'message', msg.id,
        m.kind === 'direct' ? 'Sent a message.' : 'Sent a message to the group "' + m.name + '".');
      return { id: msg.id, conversationId: conversationId, at: msg.at };
    });
  } catch (err) {
    for (var x = 0; x < stored.length; x++) await fileStore.del(stored[x].key);
    throw err;
  }
}

// kernel.js: handlers['messages.send'] — to a person (creating the chat if
// needed) or to a conversation.
async function sendDirect(ctx, peerId, body, files, opts) {
  var conversationId = await withTransaction(function (client) { return getOrCreateDirect(client, ctx, peerId); });
  return sendTo(ctx, conversationId, body, files, opts);
}
async function sendToConversation(ctx, conversationId, body, files, opts) {
  await requireMember(pool, ctx, conversationId);
  return sendTo(ctx, conversationId, body, files, opts);
}

// ── one message: edit, delete, react, pin, forward ──────────────────
async function ownMessage(ctx, messageId) {
  if (!UUID.test(String(messageId))) fail('notfound', 'Message not found.');
  var msg = (await pool.query('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];
  if (!msg || !msg.conversation_id) fail('notfound', 'Message not found.');
  var m = await requireMember(pool, ctx, msg.conversation_id);
  return { msg: msg, member: m };
}
function needLive(msg) {
  if (msg.kind !== 'text') fail('invalid', 'That can\'t be done to a group event.');
  if (msg.deleted_at) fail('invalid', 'That message was deleted.');
}

async function editMessage(ctx, messageId, body) {
  var x = await ownMessage(ctx, messageId);
  needLive(x.msg);
  if (x.msg.from_id !== ctx.employee.id) fail('forbidden', 'You can only edit your own messages.');
  body = String(body || '').trim();
  if (body.length > 4000) fail('invalid', 'Message is too long (4000 characters at most).');
  var files = (await pool.query('SELECT count(*)::int AS n FROM message_attachments WHERE message_id = $1', [messageId])).rows[0].n;
  if (!body && !files && !x.msg.record) fail('invalid', 'A message can\'t be empty. Delete it instead.');
  if (body === x.msg.body) return { ok: true };
  await pool.query('UPDATE messages SET body = $2, edited_at = now() WHERE id = $1', [messageId, body]);
  await touch(pool, x.msg.conversation_id);
  return { ok: true };
}

// Deleting clears what it said and its files for everyone; a line "This
// message was deleted" stays in its place. A file forwarded elsewhere is
// kept for that other message.
async function deleteMessage(ctx, messageId) {
  var x = await ownMessage(ctx, messageId);
  needLive(x.msg);
  if (x.msg.from_id !== ctx.employee.id) fail('forbidden', 'You can only delete your own messages.');
  var keys = await withTransaction(async function (client) {
    var files = (await client.query('DELETE FROM message_attachments WHERE message_id = $1 RETURNING storage_key', [messageId])).rows;
    await client.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
    await client.query("UPDATE messages SET body = '', record = NULL, mentions = '{}', pinned_at = NULL, pinned_by = NULL, deleted_at = now() WHERE id = $1", [messageId]);
    await touch(client, x.msg.conversation_id);
    var unused = [];
    for (var i = 0; i < files.length; i++) {
      var still = (await client.query('SELECT 1 FROM message_attachments WHERE storage_key = $1 LIMIT 1', [files[i].storage_key])).rows[0];
      if (!still) unused.push(files[i].storage_key);
    }
    await audit(client, ctx, 'message.delete', 'message', messageId, 'Deleted a message.');
    return unused;
  });
  for (var k = 0; k < keys.length; k++) await fileStore.del(keys[k]);
  return { ok: true };
}

// One reaction per person: the same emoji again takes it back.
async function react(ctx, messageId, emoji) {
  var x = await ownMessage(ctx, messageId);
  needLive(x.msg);
  if (REACTIONS.indexOf(emoji) < 0) fail('invalid', 'Pick one of the reactions.');
  var cur = (await pool.query('SELECT emoji FROM message_reactions WHERE message_id = $1 AND employee_id = $2', [messageId, ctx.employee.id])).rows[0];
  if (cur && cur.emoji === emoji) {
    await pool.query('DELETE FROM message_reactions WHERE message_id = $1 AND employee_id = $2', [messageId, ctx.employee.id]);
  } else {
    await pool.query(
      'INSERT INTO message_reactions (message_id, employee_id, emoji) VALUES ($1, $2, $3) ON CONFLICT (message_id, employee_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()',
      [messageId, ctx.employee.id, emoji]);
  }
  await touch(pool, x.msg.conversation_id);
  return { reactions: (await reactionsFor([messageId], ctx.employee.id))[messageId] || [] };
}

async function pin(ctx, messageId, pinned) {
  var x = await ownMessage(ctx, messageId);
  needLive(x.msg);
  if (x.member.kind === 'group' && x.member.role !== 'admin') fail('forbidden', 'Only a group admin can pin messages.');
  if (pinned && !x.msg.pinned_at) {
    var n = (await pool.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND pinned_at IS NOT NULL', [x.msg.conversation_id])).rows[0].n;
    if (n >= MAX_PINS) fail('invalid', 'A chat can have ' + MAX_PINS + ' pinned messages. Unpin one first.');
  }
  await withTransaction(async function (client) {
    await client.query('UPDATE messages SET pinned_at = $2, pinned_by = $3 WHERE id = $1', [messageId, pinned ? new Date() : null, pinned ? ctx.employee.id : null]);
    if (pinned && !x.msg.pinned_at) await systemMessage(client, ctx, x.msg.conversation_id, { event: 'pinned', by: ctx.employee.first_name + ' ' + ctx.employee.last_name });
    await touch(client, x.msg.conversation_id);
  });
  return { ok: true };
}

// To up to 10 chats and people at once; files are shared, not copied.
async function forward(ctx, messageId, p) {
  var x = await ownMessage(ctx, messageId);
  needLive(x.msg);
  var convIds = idList(p && p.conversationIds), peerIds = idList(p && p.peerIds);
  if (!convIds.length && !peerIds.length) fail('invalid', 'Pick where to forward it.');
  if (convIds.length + peerIds.length > 10) fail('invalid', 'Forward to at most 10 chats at a time.');
  var files = (await pool.query('SELECT file_name, content_type, size, kind, storage_key FROM message_attachments WHERE message_id = $1', [messageId])).rows;
  var opts = { forwarded: true, recordSnapshot: x.msg.record || null, copyAttachments: files };
  var sent = [];
  for (var i = 0; i < convIds.length; i++) sent.push(await sendToConversation(ctx, convIds[i], x.msg.body, [], opts));
  for (var j = 0; j < peerIds.length; j++) sent.push(await sendDirect(ctx, peerIds[j], x.msg.body, [], opts));
  return { sent: sent.length, conversationIds: sent.map(function (s) { return s.conversationId; }) };
}

// Who has seen a message, and when: for its sender, or a group admin.
// Everyone else in the chat is listed as seen (with the time it was read,
// when known) or not seen yet.
async function seenBy(ctx, messageId) {
  var x = await ownMessage(ctx, messageId);
  if (x.msg.kind !== 'text') fail('invalid', 'That can\'t be done to a group event.');
  if (x.msg.from_id !== ctx.employee.id && x.member.role !== 'admin') fail('forbidden', 'Only the sender or a group admin can see who has read a message.');
  var rows = (await pool.query(
    'SELECT cm.employee_id, cm.last_read_at, cm.joined_at, r.read_at FROM conversation_members cm ' +
    'LEFT JOIN message_reads r ON r.message_id = $1 AND r.employee_id = cm.employee_id ' +
    'WHERE cm.conversation_id = $2 AND cm.left_at IS NULL AND cm.employee_id <> $3', [messageId, x.msg.conversation_id, x.msg.from_id])).rows;
  var people = {};
  (await employeeRows(rows.map(function (r) { return r.employee_id; }))).forEach(function (e) { people[e.id] = e; });
  var seen = [], notSeen = [];
  rows.forEach(function (r) {
    var p = people[r.employee_id];
    if (!p) return;
    var out = Object.assign(personOut(p), { me: r.employee_id === ctx.employee.id });
    if (r.read_at) seen.push(Object.assign(out, { readAt: r.read_at }));
    else if (new Date(r.last_read_at) >= new Date(x.msg.at)) seen.push(Object.assign(out, { readAt: null }));
    else notSeen.push(out);
  });
  seen.sort(function (a, b) { return (a.readAt ? new Date(a.readAt) : 0) - (b.readAt ? new Date(b.readAt) : 0) || a.name.localeCompare(b.name); });
  notSeen.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { messageId: x.msg.id, at: x.msg.at, body: x.msg.deleted_at ? '' : String(x.msg.body || '').slice(0, 200), seen: seen, notSeen: notSeen };
}

// ── live: typing, seen, online ────────────────────────────────────────
async function typing(ctx, conversationId) {
  await requireMember(pool, ctx, conversationId);
  await pool.query('UPDATE conversation_members SET typing_at = now() WHERE conversation_id = $1 AND employee_id = $2', [conversationId, ctx.employee.id]);
  return { ok: true };
}

// What an open chat asks every few seconds: whether anything changed (then
// it reloads), who is typing, how far each member has read, who is online.
async function pulse(ctx, conversationId) {
  await requireMember(pool, ctx, conversationId);
  var c = (await pool.query('SELECT updated_at FROM conversations WHERE id = $1', [conversationId])).rows[0];
  var rows = (await pool.query(
    'SELECT cm.employee_id, cm.last_read_at, cm.typing_at, e.first_name, e.last_seen_at FROM conversation_members cm JOIN employees e ON e.id = cm.employee_id ' +
    'WHERE cm.conversation_id = $1 AND cm.left_at IS NULL', [conversationId])).rows;
  var others = rows.filter(function (r) { return r.employee_id !== ctx.employee.id; });
  return {
    updatedAt: c.updated_at,
    typing: others.filter(function (r) { return r.typing_at && Date.now() - new Date(r.typing_at).getTime() < TYPING_MS; }).map(function (r) { return { id: r.employee_id, name: r.first_name }; }),
    reads: rows.map(function (r) { return { id: r.employee_id, lastReadAt: r.last_read_at }; }),
    online: others.filter(function (r) { return online(r.last_seen_at); }).map(function (r) { return r.employee_id; })
  };
}

// ── find and keep ─────────────────────────────────────────────────────
// Messages in your chats with these words, newest first.
async function search(ctx, q) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  var pattern = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  var mine = ctx.employee.id;
  var rows = (await pool.query(
    'SELECT m.id, m.conversation_id, m.body, m.at, m.from_id, e.first_name, e.last_name, c.kind, c.name, c.direct_key ' +
    'FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.employee_id = $1 AND cm.left_at IS NULL ' +
    'JOIN conversations c ON c.id = m.conversation_id JOIN employees e ON e.id = m.from_id ' +
    "WHERE m.kind = 'text' AND m.deleted_at IS NULL AND (m.body ILIKE $2 OR m.record->>'title' ILIKE $2) ORDER BY m.at DESC LIMIT 40", [mine, pattern])).rows;
  var peerIds = rows.filter(function (r) { return r.kind === 'direct'; }).map(function (r) { var p = r.direct_key.split('|'); return p[0] === mine ? p[1] : p[0]; });
  var peers = {};
  (await employeeRows(peerIds)).forEach(function (e) { peers[e.id] = e; });
  return rows.map(function (r) {
    var name = r.name, photo = null, peerId = null;
    if (r.kind === 'direct') { var p = r.direct_key.split('|'); peerId = p[0] === mine ? p[1] : p[0]; var pe = peers[peerId]; name = pe ? fullName(pe) : ''; photo = pe && pe.photo_key ? version(pe.photo_updated_at) : null; }
    return { id: r.id, conversationId: r.conversation_id, kind: r.kind, name: name, peerId: peerId, photo: photo, fromName: fullName(r), fromMe: r.from_id === mine, body: r.body.slice(0, 200), at: r.at };
  });
}

// Everything shared in a chat: photos, other files, and OS records.
async function shared(ctx, conversationId) {
  await requireMember(pool, ctx, conversationId);
  var files = (await pool.query(
    'SELECT a.id, a.file_name, a.content_type, a.size, a.kind, m.at FROM message_attachments a JOIN messages m ON m.id = a.message_id ' +
    'WHERE m.conversation_id = $1 AND m.deleted_at IS NULL ORDER BY m.at DESC LIMIT 400', [conversationId])).rows
    .map(function (a) { return { id: a.id, fileName: a.file_name, contentType: a.content_type, size: a.size, kind: a.kind, at: a.at }; });
  var records = (await pool.query(
    "SELECT m.id, m.record, m.at, e.first_name, e.last_name FROM messages m JOIN employees e ON e.id = m.from_id WHERE m.conversation_id = $1 AND m.record IS NOT NULL AND m.deleted_at IS NULL ORDER BY m.at DESC LIMIT 100",
    [conversationId])).rows.map(function (r) { return { messageId: r.id, at: r.at, fromName: fullName(r), record: r.record }; });
  return {
    images: files.filter(function (a) { return a.kind === 'image'; }),
    files: files.filter(function (a) { return a.kind !== 'image'; }),
    records: records
  };
}

// A member's place in a chat moves on to upTo (now when null). What others
// sent in between is recorded as read at this moment (message_reads), so
// "Seen by" has a time even when someone answers without reopening the chat.
async function markRead(q, conversationId, employeeId, upTo) {
  await q.query(
    "INSERT INTO message_reads (message_id, employee_id) SELECT m.id, $2 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.employee_id = $2 " +
    "WHERE m.conversation_id = $1 AND m.from_id <> $2 AND m.kind = 'text' AND m.at > cm.last_read_at AND m.at <= COALESCE($3::timestamptz, now()) ON CONFLICT DO NOTHING",
    [conversationId, employeeId, upTo]);
  await q.query('UPDATE conversation_members SET last_read_at = COALESCE($3::timestamptz, now()) WHERE conversation_id = $1 AND employee_id = $2', [conversationId, employeeId, upTo]);
}

// ── groups ───────────────────────────────────────────────────────────
async function systemMessage(client, ctx, conversationId, meta) {
  var r = (await client.query(
    "INSERT INTO messages (from_id, body, conversation_id, kind, meta) VALUES ($1, '', $2, 'system', $3) RETURNING at",
    [ctx.employee.id, conversationId, meta]
  )).rows[0];
  await client.query('UPDATE conversations SET last_message_at = $2 WHERE id = $1', [conversationId, r.at]);
  await markRead(client, conversationId, ctx.employee.id, r.at);
}
async function activePeople(client, ids) {
  ids = Array.from(new Set((ids || []).map(String)));
  if (!ids.length) return [];
  var rows = (await client.query("SELECT id, first_name, last_name FROM employees WHERE id = ANY($1::uuid[]) AND status = 'active'", [ids])).rows;
  if (rows.length !== ids.length) fail('invalid', 'Someone you picked is not an active employee.');
  return rows;
}

async function createGroup(ctx, p) {
  var name = V.text(p && p.name, 'Group name', 80);
  var description = String((p && p.description) || '').trim().slice(0, 300);
  var ids = ((p && p.memberIds) || []).filter(function (id) { return id !== ctx.employee.id; });
  if (!ids.length) fail('invalid', 'Add at least one person to the group.');
  if (ids.length + 1 > MAX_GROUP_MEMBERS) fail('invalid', 'A group can have at most ' + MAX_GROUP_MEMBERS + ' people.');
  return withTransaction(async function (client) {
    var people = await activePeople(client, ids);
    var c = (await client.query(
      "INSERT INTO conversations (kind, name, description, created_by) VALUES ('group', $1, $2, $3) RETURNING id",
      [name, description, ctx.employee.id]
    )).rows[0];
    await client.query("INSERT INTO conversation_members (conversation_id, employee_id, role) VALUES ($1, $2, 'admin')", [c.id, ctx.employee.id]);
    for (var i = 0; i < people.length; i++) {
      await client.query('INSERT INTO conversation_members (conversation_id, employee_id, last_read_at) VALUES ($1, $2, now() - interval \'1 second\')', [c.id, people[i].id]);
      await notify(client, people[i].id, ctx.employee.first_name + ' ' + ctx.employee.last_name + ' added you to "' + name + '"', 'A new group chat.', 'chat:' + c.id);
    }
    await systemMessage(client, ctx, c.id, { event: 'created', by: ctx.employee.first_name + ' ' + ctx.employee.last_name, name: name });
    await audit(client, ctx, 'chat.group.create', 'conversation', c.id, 'Created the group chat "' + name + '" with ' + people.length + ' people.');
    return { id: c.id };
  });
}

async function updateGroup(ctx, conversationId, p) {
  var m = await requireMember(pool, ctx, conversationId);
  requireAdmin(m);
  return withTransaction(async function (client) {
    var c = (await client.query('SELECT name, description FROM conversations WHERE id = $1', [conversationId])).rows[0];
    var name = p.name !== undefined ? V.text(p.name, 'Group name', 80) : c.name;
    var description = p.description !== undefined ? String(p.description || '').trim().slice(0, 300) : c.description;
    await client.query('UPDATE conversations SET name = $2, description = $3 WHERE id = $1', [conversationId, name, description]);
    if (name !== c.name) await systemMessage(client, ctx, conversationId, { event: 'renamed', by: ctx.employee.first_name + ' ' + ctx.employee.last_name, name: name });
    return { ok: true };
  });
}

async function addMembers(ctx, conversationId, ids) {
  var m = await requireMember(pool, ctx, conversationId);
  requireAdmin(m);
  return withTransaction(async function (client) {
    var people = await activePeople(client, ids);
    var count = (await client.query('SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL', [conversationId])).rows[0].n;
    if (count + people.length > MAX_GROUP_MEMBERS) fail('invalid', 'A group can have at most ' + MAX_GROUP_MEMBERS + ' people.');
    var added = [];
    for (var i = 0; i < people.length; i++) {
      var r = await client.query(
        "INSERT INTO conversation_members (conversation_id, employee_id, role, last_read_at) VALUES ($1, $2, 'member', now()) " +
        "ON CONFLICT (conversation_id, employee_id) DO UPDATE SET left_at = NULL, role = 'member', joined_at = now(), last_read_at = now() " +
        'WHERE conversation_members.left_at IS NOT NULL RETURNING employee_id', [conversationId, people[i].id]
      );
      if (r.rows[0]) {
        added.push(people[i]);
        await notify(client, people[i].id, ctx.employee.first_name + ' ' + ctx.employee.last_name + ' added you to "' + m.name + '"', 'A group chat.', 'chat:' + conversationId);
      }
    }
    if (added.length) {
      await systemMessage(client, ctx, conversationId, { event: 'added', by: ctx.employee.first_name + ' ' + ctx.employee.last_name, names: added.map(fullName) });
      await audit(client, ctx, 'chat.group.members', 'conversation', conversationId, 'Added ' + added.map(fullName).join(', ') + ' to "' + m.name + '".');
    }
    return { added: added.length };
  });
}

// Removing someone else (admins), or leaving (anyone). A group is never
// left without an admin: the longest-standing member becomes one.
async function removeMember(ctx, conversationId, employeeId) {
  var m = await requireMember(pool, ctx, conversationId);
  if (m.kind !== 'group') fail('invalid', 'This is not a group.');
  var self = employeeId === ctx.employee.id;
  if (!self) requireAdmin(m);
  return withTransaction(async function (client) {
    var target = (await client.query(
      'SELECT cm.role, e.first_name, e.last_name FROM conversation_members cm JOIN employees e ON e.id = cm.employee_id ' +
      'WHERE cm.conversation_id = $1 AND cm.employee_id = $2 AND cm.left_at IS NULL', [conversationId, employeeId]
    )).rows[0];
    if (!target) fail('notfound', 'That person is not in this group.');
    await client.query('UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND employee_id = $2', [conversationId, employeeId]);
    var admins = (await client.query("SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL AND role = 'admin'", [conversationId])).rows[0].n;
    if (!admins) {
      await client.query(
        "UPDATE conversation_members SET role = 'admin' WHERE (conversation_id, employee_id) = (SELECT conversation_id, employee_id FROM conversation_members " +
        'WHERE conversation_id = $1 AND left_at IS NULL ORDER BY joined_at LIMIT 1)', [conversationId]
      );
    }
    await systemMessage(client, ctx, conversationId, self
      ? { event: 'left', by: fullName(target) }
      : { event: 'removed', by: ctx.employee.first_name + ' ' + ctx.employee.last_name, names: [fullName(target)] });
    await audit(client, ctx, 'chat.group.members', 'conversation', conversationId, self ? 'Left "' + m.name + '".' : 'Removed ' + fullName(target) + ' from "' + m.name + '".');
    return { ok: true };
  });
}

async function setAdmin(ctx, conversationId, employeeId, makeAdmin) {
  var m = await requireMember(pool, ctx, conversationId);
  requireAdmin(m);
  return withTransaction(async function (client) {
    var target = await membership(client, conversationId, employeeId);
    if (!target) fail('notfound', 'That person is not in this group.');
    if (!makeAdmin) {
      var admins = (await client.query("SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL AND role = 'admin'", [conversationId])).rows[0].n;
      if (admins <= 1 && target.role === 'admin') fail('invalid', 'A group needs at least one admin.');
    }
    await client.query('UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND employee_id = $2', [conversationId, employeeId, makeAdmin ? 'admin' : 'member']);
    return { ok: true };
  });
}

// ── files and photos ─────────────────────────────────────────────────
async function attachment(ctx, attachmentId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(attachmentId))) fail('notfound', 'File not found.');
  var a = (await pool.query(
    'SELECT a.*, m.conversation_id FROM message_attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = $1', [attachmentId]
  )).rows[0];
  if (!a) fail('notfound', 'File not found.');
  await requireMember(pool, ctx, a.conversation_id);
  return { key: a.storage_key, fileName: a.file_name };
}

function checkPhoto(file) {
  if (!file) fail('invalid', 'Choose a photo.');
  if (fileKind(file.mimetype, file.originalname) !== 'image') fail('invalid', 'That is not a photo.');
  if (file.size > 5 * 1024 * 1024) fail('invalid', 'That photo is too big (5 MB at most).');
}

// A person's photo: your own, or anyone's for those who manage employees.
async function setPersonPhoto(ctx, employeeId, file) {
  if (employeeId !== ctx.employee.id && !ctx.can('employee.write')) fail('forbidden', 'You can only change your own photo.');
  var e = (await pool.query('SELECT id, photo_key, first_name, last_name FROM employees WHERE id = $1', [employeeId])).rows[0];
  if (!e) fail('notfound', 'Employee not found.');
  var old = e.photo_key;
  if (file) {
    checkPhoto(file);
    var key = await fileStore.put('photo-' + employeeId + '.jpg', file.buffer, file.mimetype);
    await pool.query('UPDATE employees SET photo_key = $2, photo_updated_at = now() WHERE id = $1', [employeeId, key]);
  } else {
    await pool.query('UPDATE employees SET photo_key = NULL, photo_updated_at = now() WHERE id = $1', [employeeId]);
  }
  await fileStore.del(old);
  await audit(pool, ctx, 'employee.photo', 'employee', employeeId, (file ? 'Changed' : 'Removed') + ' the photo of ' + fullName(e) + '.');
  return { photo: file ? Date.now() : null };
}
async function personPhoto(ctx, employeeId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(employeeId))) fail('notfound', 'No photo.');
  var e = (await pool.query('SELECT photo_key FROM employees WHERE id = $1', [employeeId])).rows[0];
  if (!e || !e.photo_key) fail('notfound', 'No photo.');
  return { key: e.photo_key };
}

async function setGroupPhoto(ctx, conversationId, file) {
  var m = await requireMember(pool, ctx, conversationId);
  requireAdmin(m);
  var c = (await pool.query('SELECT photo_key FROM conversations WHERE id = $1', [conversationId])).rows[0];
  if (file) {
    checkPhoto(file);
    var key = await fileStore.put('group-' + conversationId + '.jpg', file.buffer, file.mimetype);
    await pool.query('UPDATE conversations SET photo_key = $2, photo_updated_at = now() WHERE id = $1', [conversationId, key]);
  } else {
    await pool.query('UPDATE conversations SET photo_key = NULL, photo_updated_at = now() WHERE id = $1', [conversationId]);
  }
  await fileStore.del(c.photo_key);
  await withTransaction(function (client) {
    return systemMessage(client, ctx, conversationId, { event: file ? 'photo' : 'photoRemoved', by: ctx.employee.first_name + ' ' + ctx.employee.last_name });
  });
  return { photo: file ? Date.now() : null };
}
async function groupPhoto(ctx, conversationId) {
  await requireMember(pool, ctx, conversationId);
  var c = (await pool.query('SELECT photo_key FROM conversations WHERE id = $1', [conversationId])).rows[0];
  if (!c || !c.photo_key) fail('notfound', 'No photo.');
  return { key: c.photo_key };
}

// kernel.js: handlers['messages.unreadCount']
async function unreadCount(ctx) {
  var res = await pool.query(
    'SELECT count(*)::int AS n FROM conversation_members cm JOIN messages m ON m.conversation_id = cm.conversation_id ' +
    'AND m.from_id <> cm.employee_id AND m.at > cm.last_read_at WHERE cm.employee_id = $1 AND cm.left_at IS NULL', [ctx.employee.id]
  );
  return res.rows[0].n;
}

module.exports = {
  seenBy: seenBy, editMessage: editMessage, deleteMessage: deleteMessage, react: react, pin: pin, forward: forward,
  typing: typing, pulse: pulse, search: search, shared: shared, REACTIONS: REACTIONS,
  inbox: inbox, directory: directory, conversation: conversation, direct: direct,
  sendDirect: sendDirect, sendToConversation: sendToConversation,
  createGroup: createGroup, updateGroup: updateGroup, addMembers: addMembers, removeMember: removeMember, setAdmin: setAdmin,
  attachment: attachment, setPersonPhoto: setPersonPhoto, personPhoto: personPhoto, setGroupPhoto: setGroupPhoto, groupPhoto: groupPhoto,
  unreadCount: unreadCount, fileKind: fileKind,
  // Before group chats these were the API; kept for anything still calling them.
  thread: direct, send: function (ctx, toId, body) { return sendDirect(ctx, toId, body, []); }
};
