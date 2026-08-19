var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var storage = require('../lib/storage');

var MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB

// Ported from kernel.js's documentVisible(ctx, doc).
function documentVisible(ctx, doc) {
  if (doc.visibility === 'all') return true;
  if (doc.visibility === 'managers') return ctx.can('document.manage') || ctx.can('employee.read.all');
  if (doc.visibility === 'department') return ctx.employee.department_id === doc.department_id || ctx.can('employee.read.all');
  return false;
}

function rowToDocument(r, extra) {
  return Object.assign({
    id: r.id, title: r.title, category: r.category, departmentId: r.department_id, visibility: r.visibility,
    uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at, fileName: r.file_name, hasFile: !!r.object_key
  }, extra || {});
}

// kernel.js: handlers['documents.list']
async function list(ctx) {
  if (!ctx.can('document.read')) fail('forbidden', 'Your role does not allow this action (document.read).');
  var res = await pool.query(
    'SELECT d.*, e.first_name, e.last_name FROM documents d JOIN employees e ON e.id = d.uploaded_by ORDER BY d.uploaded_at DESC'
  );
  return res.rows.filter(function (r) { return documentVisible(ctx, r); })
    .map(function (r) { return rowToDocument(r, { uploaderName: r.first_name + ' ' + r.last_name }); });
}

// kernel.js: handlers['documents.upload'] — p.file is multer's in-memory
// file object ({ originalname, mimetype, size, buffer }), set by the
// upload.single('file') middleware in documents.routes.js.
async function upload(ctx, p) {
  if (!ctx.can('document.manage')) fail('forbidden', 'Your role does not allow this action (document.manage).');
  if (!storage.configured) fail('invalid', 'File storage is not configured on the server yet — ask an administrator to set the R2_* environment variables.');
  if (!p.file) fail('invalid', 'Choose a file to upload.');
  if (p.file.size > MAX_FILE_BYTES) fail('invalid', 'File is too large — the limit is 25MB.');

  var title = V.text(p.title, 'Title', 100);
  var category = V.text(p.category, 'Category', 40);
  var visibility = V.oneOf(p.visibility || 'all', ['all', 'department', 'managers'], 'Visibility');
  var departmentId = visibility === 'department' ? ctx.employee.department_id : null;

  var objectKey = await storage.uploadFile(p.file.originalname, p.file.buffer, p.file.mimetype);

  var res = await pool.query(
    'INSERT INTO documents (title, category, department_id, visibility, uploaded_by, file_name, object_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [title, category, departmentId, visibility, ctx.employee.id, p.file.originalname, objectKey]
  );
  var doc = res.rows[0];
  await audit(pool, ctx, 'document.upload', 'document', doc.id, 'Uploaded "' + doc.title + '".');
  return rowToDocument(doc);
}

// New: a short-lived, permission-checked download link for a document's
// real file (documents uploaded before real storage was wired up have no
// object_key and can't be downloaded).
async function getDownloadUrl(ctx, id) {
  if (!ctx.can('document.read')) fail('forbidden', 'Your role does not allow this action (document.read).');
  var res = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
  var doc = res.rows[0];
  if (!doc) fail('notfound', 'Document not found.');
  if (!documentVisible(ctx, doc)) fail('forbidden', 'You do not have access to this document.');
  if (!doc.object_key) fail('invalid', 'This document has no file on record.');

  var url = await storage.getDownloadUrl(doc.object_key, doc.file_name);
  return { url: url };
}

// kernel.js: handlers['documents.delete']
async function remove(ctx, id) {
  if (!ctx.can('document.manage')) fail('forbidden', 'Your role does not allow this action (document.manage).');
  var res = await pool.query('SELECT title, object_key FROM documents WHERE id = $1', [id]);
  if (!res.rows[0]) fail('notfound', 'Document not found.');
  await pool.query('DELETE FROM documents WHERE id = $1', [id]);
  if (res.rows[0].object_key && storage.configured) {
    try { await storage.deleteFile(res.rows[0].object_key); } catch (err) { /* row is already gone; a stray object in the bucket isn't worth failing the request over */ }
  }
  await audit(pool, ctx, 'document.delete', 'document', id, 'Removed "' + res.rows[0].title + '".');
  return true;
}

module.exports = { list: list, upload: upload, remove: remove, getDownloadUrl: getDownloadUrl, documentVisible: documentVisible };
