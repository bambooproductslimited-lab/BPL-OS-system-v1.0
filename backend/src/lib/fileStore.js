// Where uploaded files live: Cloudflare R2 when it is configured
// (lib/storage.js — Render's own disk is wiped on every deploy), otherwise
// the stored_files table (migration 0080), so chat attachments and profile
// photos work on a deployment that has not set R2 up. A key starting 'db:'
// is a stored_files row; anything else is an R2 object key.
var { pool } = require('../db/pool');
var storage = require('./storage');

// Kept in the database only when there is no R2: a database is not a good
// place for big files, so the cap is lower there.
var MAX_DB_BYTES = 15 * 1024 * 1024;

async function put(originalName, buffer, contentType, db) {
  if (storage.configured) return storage.uploadFile(originalName, buffer, contentType);
  if (buffer.length > MAX_DB_BYTES) {
    var { fail } = require('../utils/errors');
    fail('invalid', 'That file is too big (over 15 MB). Ask an administrator to connect file storage (Cloudflare R2) for bigger files.');
  }
  var res = await (db || pool).query(
    'INSERT INTO stored_files (content_type, size, data) VALUES ($1, $2, $3) RETURNING id',
    [contentType || 'application/octet-stream', buffer.length, buffer]
  );
  return 'db:' + res.rows[0].id;
}

// { contentType, size?, buffer } or { contentType, stream }.
async function get(key) {
  if (String(key).startsWith('db:')) {
    var r = (await pool.query('SELECT content_type, size, data FROM stored_files WHERE id = $1', [key.slice(3)])).rows[0];
    if (!r) return null;
    return { contentType: r.content_type, size: r.size, buffer: r.data };
  }
  return storage.getObjectStream(key);
}

async function del(key, db) {
  if (!key) return;
  try {
    if (String(key).startsWith('db:')) await (db || pool).query('DELETE FROM stored_files WHERE id = $1', [key.slice(3)]);
    else if (storage.configured) await storage.deleteFile(key);
  } catch { /* a file that cannot be removed must not break what removed its record */ }
}

// Sends a stored file as the response (the caller has checked access).
async function send(res, key, fileName, inline) {
  var f = await get(key);
  if (!f) { res.status(404).json({ error: { code: 'notfound', message: 'File not found.' } }); return; }
  res.setHeader('Content-Type', f.contentType || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (fileName) {
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + String(fileName).replace(/["\r\n]/g, '') + '"');
  }
  if (f.buffer) { res.end(f.buffer); return; }
  f.stream.pipe(res);
}

module.exports = { put: put, get: get, del: del, send: send, MAX_DB_BYTES: MAX_DB_BYTES };
