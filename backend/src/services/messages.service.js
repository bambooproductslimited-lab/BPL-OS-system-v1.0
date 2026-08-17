var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// kernel.js: handlers['messages.inbox']
async function inbox(ctx) {
  var mine = ctx.employee.id;
  var res = await pool.query(
    'SELECT m.*, e.first_name, e.last_name, e.position_title FROM messages m ' +
    'JOIN employees e ON e.id = (CASE WHEN m.from_id = $1 THEN m.to_id ELSE m.from_id END) ' +
    'WHERE m.from_id = $1 OR m.to_id = $1 ORDER BY m.at DESC',
    [mine]
  );

  var byPeer = {};
  res.rows.forEach(function (m) {
    var peerId = m.from_id === mine ? m.to_id : m.from_id;
    if (!byPeer[peerId]) byPeer[peerId] = { last: m, unread: 0, peerName: m.first_name + ' ' + m.last_name, peerTitle: m.position_title };
    if (m.to_id === mine && m.from_id === peerId && !m.read) byPeer[peerId].unread++;
  });

  return Object.keys(byPeer).map(function (peerId) {
    var p = byPeer[peerId];
    return {
      peerId: peerId, peerName: p.peerName, peerTitle: p.peerTitle,
      lastBody: p.last.body, lastAt: p.last.at, lastFromMe: p.last.from_id === mine, unread: p.unread
    };
  }).sort(function (a, b) { return a.lastAt < b.lastAt ? 1 : -1; });
}

// kernel.js: handlers['messages.directory']
async function directory(ctx) {
  var res = await pool.query(
    "SELECT id, first_name, last_name, position_title FROM employees WHERE status = 'active' AND id != $1 ORDER BY first_name",
    [ctx.employee.id]
  );
  return res.rows.map(function (e) { return { id: e.id, name: e.first_name + ' ' + e.last_name, title: e.position_title }; })
    .sort(function (a, b) { return a.name < b.name ? -1 : 1; });
}

// kernel.js: handlers['messages.thread']
async function thread(ctx, peerId) {
  var mine = ctx.employee.id;
  var peerRes = await pool.query('SELECT id, first_name, last_name, position_title FROM employees WHERE id = $1', [peerId]);
  var peer = peerRes.rows[0];
  if (!peer) fail('notfound', 'Employee not found.');

  var res = await pool.query(
    'SELECT * FROM messages WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1) ORDER BY at',
    [mine, peerId]
  );
  await pool.query('UPDATE messages SET read = true WHERE to_id = $1 AND from_id = $2 AND read = false', [mine, peerId]);

  return {
    peerId: peer.id, peerName: peer.first_name + ' ' + peer.last_name, peerTitle: peer.position_title,
    messages: res.rows.map(function (m) { return { id: m.id, fromMe: m.from_id === mine, body: m.body, at: m.at }; })
  };
}

// kernel.js: handlers['messages.send']
async function send(ctx, toId, body) {
  var peerRes = await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [toId]);
  var peer = peerRes.rows[0];
  if (!peer) fail('invalid', 'Choose a recipient.');
  if (toId === ctx.employee.id) fail('invalid', 'You cannot message yourself.');
  body = V.text(body, 'Message', 2000);

  return withTransaction(async function (client) {
    var res = await client.query(
      'INSERT INTO messages (from_id, to_id, body) VALUES ($1,$2,$3) RETURNING *',
      [ctx.employee.id, toId, body]
    );
    var msg = res.rows[0];
    await notify(client, toId, 'New message from ' + ctx.employee.first_name + ' ' + ctx.employee.last_name, body.slice(0, 140), 'message:' + ctx.employee.id);
    await audit(client, ctx, 'message.send', 'message', msg.id, 'Sent a message to ' + peer.first_name + ' ' + peer.last_name + '.');
    return { id: msg.id, fromId: msg.from_id, toId: msg.to_id, body: msg.body, at: msg.at, read: msg.read };
  });
}

// kernel.js: handlers['messages.unreadCount']
async function unreadCount(ctx) {
  var res = await pool.query('SELECT count(*)::int AS n FROM messages WHERE to_id = $1 AND read = false', [ctx.employee.id]);
  return res.rows[0].n;
}

module.exports = { inbox: inbox, directory: directory, thread: thread, send: send, unreadCount: unreadCount };
