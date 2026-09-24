var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var fileStore = require('../lib/fileStore');

// Chats (migration 0080): one-to-one ('direct') and group conversations,
// messages with files, and profile photos for people and groups.
//
// Anyone signed in can message anyone active, as before. A conversation's
// messages, files and details are only for its current members. In a group
// the admins (whoever created it, and anyone they make admin) rename it,
// change its photo and add or remove people; anyone can leave. Unread is
// what others sent after the member's last_read_at.

var MAX_FILES = 10;
var MAX_GROUP_MEMBERS = 256;

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
    'SELECT e.id, e.first_name, e.last_name, e.position_title, e.status, e.photo_updated_at, e.photo_key, d.name AS department ' +
    'FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ANY($1)', [ids]
  )).rows;
}
function personOut(e) {
  return {
    id: e.id, name: fullName(e), title: e.position_title || '', department: e.department || '',
    photo: e.photo_key ? version(e.photo_updated_at) : null, active: e.status === 'active'
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
    'SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.id, m.from_id, m.body, m.kind, m.meta, m.at, e.first_name, e.last_name, ' +
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
        fromMe: m.from_id === mine, fromName: m.first_name
      } : null
    };
    if (r.kind === 'direct') {
      var p = r.direct_key.split('|'); var peerId = p[0] === mine ? p[1] : p[0];
      var peer = peers[peerId];
      Object.assign(out, {
        peerId: peerId, name: peer ? fullName(peer) : '', title: peer ? peer.position_title || '' : '',
        photo: peer && peer.photo_key ? version(peer.photo_updated_at) : null
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
    "SELECT e.id, e.first_name, e.last_name, e.position_title, e.status, e.photo_key, e.photo_updated_at, d.name AS department " +
    "FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'active' AND e.id != $1",
    [ctx.employee.id]
  );
  return res.rows.map(personOut).sort(function (a, b) { return a.name.localeCompare(b.name); });
}

// ── one conversation ─────────────────────────────────────────────────
function messageOut(m, mine, attachmentsById) {
  return {
    id: m.id, fromId: m.from_id, fromName: fullName(m), fromMe: m.from_id === mine, body: m.body, at: m.at,
    kind: m.kind, meta: m.meta, attachments: attachmentsById[m.id] || []
  };
}
async function conversationOut(ctx, conversationId, m) {
  var mine = ctx.employee.id;
  var c = (await pool.query('SELECT * FROM conversations WHERE id = $1', [conversationId])).rows[0];
  var memberRows = (await pool.query(
    'SELECT employee_id, role, joined_at FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL', [conversationId]
  )).rows;
  var people = {};
  (await employeeRows(memberRows.map(function (x) { return x.employee_id; }))).forEach(function (e) { people[e.id] = e; });
  var members = memberRows.filter(function (x) { return people[x.employee_id]; }).map(function (x) {
    return Object.assign(personOut(people[x.employee_id]), { role: x.role, me: x.employee_id === mine });
  }).sort(function (a, b) { return (b.me - a.me) || ((a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1)) || a.name.localeCompare(b.name); });

  var msgs = (await pool.query(
    'SELECT * FROM (SELECT m.*, e.first_name, e.last_name FROM messages m JOIN employees e ON e.id = m.from_id ' +
    'WHERE m.conversation_id = $1 ORDER BY m.at DESC LIMIT 300) x ORDER BY at', [conversationId]
  )).rows;
  var attachmentsById = {};
  if (msgs.length) {
    (await pool.query(
      'SELECT id, message_id, file_name, content_type, size, kind FROM message_attachments WHERE message_id = ANY($1) ORDER BY created_at, file_name',
      [msgs.map(function (x) { return x.id; })]
    )).rows.forEach(function (a) {
      (attachmentsById[a.message_id] = attachmentsById[a.message_id] || []).push({ id: a.id, fileName: a.file_name, contentType: a.content_type, size: a.size, kind: a.kind });
    });
  }
  // Opening a chat reads it.
  await pool.query('UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND employee_id = $2', [conversationId, mine]);
  await pool.query('UPDATE messages SET read = true WHERE conversation_id = $1 AND to_id = $2 AND read = false', [conversationId, mine]);

  var out = {
    id: c.id, kind: c.kind, createdAt: c.created_at, myRole: m.role, members: members,
    messages: msgs.map(function (x) { return messageOut(x, mine, attachmentsById); })
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
    myRole: 'member', members: [], messages: []
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

// files: multer files ({ originalname, mimetype, buffer, size }).
async function sendTo(ctx, conversationId, body, files) {
  files = (files || []).filter(Boolean);
  body = String(body || '').trim();
  if (!body && !files.length) fail('invalid', 'Write a message or attach a file.');
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
      var msg = (await client.query(
        'INSERT INTO messages (from_id, to_id, body, conversation_id) VALUES ($1, $2, $3, $4) RETURNING *',
        [ctx.employee.id, toId, body, conversationId]
      )).rows[0];
      for (var j = 0; j < stored.length; j++) {
        var s = stored[j];
        await client.query(
          'INSERT INTO message_attachments (message_id, file_name, content_type, size, kind, storage_key) VALUES ($1,$2,$3,$4,$5,$6)',
          [msg.id, s.name, s.type, s.size, s.kind, s.key]
        );
      }
      await client.query('UPDATE conversations SET last_message_at = $2 WHERE id = $1', [conversationId, msg.at]);
      await client.query('UPDATE conversation_members SET last_read_at = $3 WHERE conversation_id = $1 AND employee_id = $2', [conversationId, ctx.employee.id, msg.at]);

      var me = ctx.employee.first_name + ' ' + ctx.employee.last_name;
      var preview = (body || attachmentLabel(files)).slice(0, 140);
      for (var k = 0; k < others.length; k++) {
        if (m.kind === 'direct') await notify(client, others[k], 'New message from ' + me, preview, 'message:' + ctx.employee.id);
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
async function sendDirect(ctx, peerId, body, files) {
  var conversationId = await withTransaction(function (client) { return getOrCreateDirect(client, ctx, peerId); });
  return sendTo(ctx, conversationId, body, files);
}
async function sendToConversation(ctx, conversationId, body, files) {
  await requireMember(pool, ctx, conversationId);
  return sendTo(ctx, conversationId, body, files);
}

// ── groups ───────────────────────────────────────────────────────────
async function systemMessage(client, ctx, conversationId, meta) {
  var r = (await client.query(
    "INSERT INTO messages (from_id, body, conversation_id, kind, meta) VALUES ($1, '', $2, 'system', $3) RETURNING at",
    [ctx.employee.id, conversationId, meta]
  )).rows[0];
  await client.query('UPDATE conversations SET last_message_at = $2 WHERE id = $1', [conversationId, r.at]);
  await client.query('UPDATE conversation_members SET last_read_at = $3 WHERE conversation_id = $1 AND employee_id = $2', [conversationId, ctx.employee.id, r.at]);
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
  inbox: inbox, directory: directory, conversation: conversation, direct: direct,
  sendDirect: sendDirect, sendToConversation: sendToConversation,
  createGroup: createGroup, updateGroup: updateGroup, addMembers: addMembers, removeMember: removeMember, setAdmin: setAdmin,
  attachment: attachment, setPersonPhoto: setPersonPhoto, personPhoto: personPhoto, setGroupPhoto: setGroupPhoto, groupPhoto: groupPhoto,
  unreadCount: unreadCount, fileKind: fileKind,
  // Before group chats these were the API; kept for anything still calling them.
  thread: direct, send: function (ctx, toId, body) { return sendDirect(ctx, toId, body, []); }
};
