var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var storage = require('../lib/storage');
var fileStore = require('../lib/fileStore');

var MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB

// Company documents: policies, licences, permits, certificates, forms.
// Files go through lib/fileStore.js — Cloudflare R2 when it is configured,
// otherwise the database (up to 15 MB) — so uploading works on a deployment
// without R2 too. A document can belong to one company (company_id; none
// means the whole group), carry an expiry date (jobs/dailyAlerts.js warns
// before it) and be replaced by a new version when it is renewed.

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
    uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at, fileName: r.file_name, hasFile: !!r.object_key,
    expiresOn: r.expires_on ? String(r.expires_on).slice(0, 10) : null,
    companyId: r.company_id || null, description: r.description || '', size: r.size === null || r.size === undefined ? null : Number(r.size),
    contentType: r.content_type || null, version: r.version || 1, updatedAt: r.updated_at || null
  }, extra || {});
}

// The date a licence, permit, certificate or policy runs out, or none.
// Blank clears it. The daily alerts (jobs/dailyAlerts.js) warn before it.
function expiryDate(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  var d = V.date(String(v).trim(), 'Expiry date');
  if (isNaN(new Date(d + 'T00:00:00Z').getTime())) fail('invalid', 'Expiry date must be a valid date.');
  return d;
}

// kernel.js: handlers['documents.list']
async function list(ctx) {
  if (!ctx.can('document.read')) fail('forbidden', 'Your role does not allow this action (document.read).');
  var res = await pool.query(
    'SELECT d.*, e.first_name, e.last_name, e.photo_key AS up_photo_key, e.photo_updated_at AS up_photo_at, ' +
    'dp.name AS department_name, c.name AS company_name, c.code AS company_code ' +
    'FROM documents d JOIN employees e ON e.id = d.uploaded_by ' +
    'LEFT JOIN departments dp ON dp.id = d.department_id LEFT JOIN companies c ON c.id = d.company_id ' +
    'ORDER BY d.uploaded_at DESC'
  );
  return res.rows.filter(function (r) { return documentVisible(ctx, r); })
    .map(function (r) {
      return rowToDocument(r, {
        uploaderName: r.first_name + ' ' + r.last_name,
        uploaderPhoto: r.up_photo_key && r.up_photo_at ? new Date(r.up_photo_at).getTime() : null,
        departmentName: r.department_name || null, companyName: r.company_name || null, companyCode: r.company_code || null
      });
    });
}

// Who may see it and which company it belongs to, from a form.
async function readPlacement(ctx, p, existing) {
  var visibility = V.oneOf(p.visibility || (existing && existing.visibility) || 'all', ['all', 'department', 'managers'], 'Visibility');
  var departmentId = null;
  if (visibility === 'department') {
    departmentId = p.departmentId || (existing && existing.department_id) || ctx.employee.department_id;
    var dept = await pool.query('SELECT id FROM departments WHERE id = $1', [departmentId]);
    if (!dept.rows[0]) fail('invalid', 'Choose the department that may see it.');
  }
  var companyId = p.companyId === undefined ? (existing ? existing.company_id : null) : (p.companyId || null);
  if (companyId) {
    var co = await pool.query('SELECT id FROM companies WHERE id = $1', [companyId]);
    if (!co.rows[0]) fail('invalid', 'Unknown company.');
  }
  return { visibility: visibility, departmentId: departmentId, companyId: companyId };
}

function checkFile(file) {
  if (!file) fail('invalid', 'Choose a file to upload.');
  if (file.size > MAX_FILE_BYTES) fail('invalid', 'File is too large — the limit is 25MB.');
}

// kernel.js: handlers['documents.upload'] — p.file is multer's in-memory
// file object ({ originalname, mimetype, size, buffer }), set by the
// upload.single('file') middleware in documents.routes.js.
async function upload(ctx, p) {
  if (!ctx.can('document.manage')) fail('forbidden', 'Your role does not allow this action (document.manage).');
  checkFile(p.file);

  var title = V.text(p.title, 'Title', 100);
  var category = V.text(p.category, 'Category', 40);
  var place = await readPlacement(ctx, p, null);
  var expiresOn = expiryDate(p.expiresOn);
  var description = String(p.description || '').trim().slice(0, 500);
  var objectKey = await fileStore.put(p.file.originalname, p.file.buffer, p.file.mimetype);

  var res;
  try {
    res = await pool.query(
      'INSERT INTO documents (title, category, department_id, visibility, uploaded_by, file_name, object_key, expires_on, company_id, description, size, content_type) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [title, category, place.departmentId, place.visibility, ctx.employee.id, p.file.originalname, objectKey, expiresOn,
        place.companyId, description, p.file.size, p.file.mimetype || null]
    );
  } catch (err) {
    await fileStore.del(objectKey);
    throw err;
  }
  var doc = res.rows[0];
  await audit(pool, ctx, 'document.upload', 'document', doc.id, 'Uploaded "' + doc.title + '".');
  return rowToDocument(doc);
}

async function loadVisible(ctx, id, permission) {
  if (!ctx.can(permission)) fail('forbidden', 'Your role does not allow this action (' + permission + ').');
  var res = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
  var doc = res.rows[0];
  if (!doc) fail('notfound', 'Document not found.');
  if (!documentVisible(ctx, doc)) fail('forbidden', 'You do not have access to this document.');
  return doc;
}

// A short-lived link for a document kept in R2 (documents uploaded before
// real storage was wired up have no object_key and can't be opened; ones
// kept in the database are opened with GET /:id/file instead).
async function getDownloadUrl(ctx, id) {
  var doc = await loadVisible(ctx, id, 'document.read');
  if (!doc.object_key) fail('invalid', 'This document has no file on record.');
  if (String(doc.object_key).startsWith('db:')) return { url: null, file: '/documents/' + id + '/file' };
  var url = await storage.getDownloadUrl(doc.object_key, doc.file_name);
  return { url: url };
}

// The file itself, for the viewer on the page: { key, fileName } for
// fileStore.send (the route streams it with the caller's permission).
async function fileFor(ctx, id) {
  var doc = await loadVisible(ctx, id, 'document.read');
  if (!doc.object_key) fail('notfound', 'This document has no file on record.');
  return { key: doc.object_key, fileName: doc.file_name };
}

// Change a document's details. Only the fields sent change; sending just
// { expiresOn } still works as before (renewed a licence, no new file).
async function update(ctx, id, p) {
  var doc = await loadVisible(ctx, id, 'document.manage');
  p = p || {};
  var onlyExpiry = Object.keys(p).length === 1 && Object.prototype.hasOwnProperty.call(p, 'expiresOn');
  var title = p.title === undefined ? doc.title : V.text(p.title, 'Title', 100);
  var category = p.category === undefined ? doc.category : V.text(p.category, 'Category', 40);
  var description = p.description === undefined ? doc.description : String(p.description || '').trim().slice(0, 500);
  var expiresOn = p.expiresOn === undefined ? doc.expires_on : expiryDate(p.expiresOn);
  var place = onlyExpiry ? { visibility: doc.visibility, departmentId: doc.department_id, companyId: doc.company_id } : await readPlacement(ctx, p, doc);

  var updated = (await pool.query(
    'UPDATE documents SET title = $1, category = $2, description = $3, expires_on = $4, visibility = $5, department_id = $6, company_id = $7, updated_at = now() WHERE id = $8 RETURNING *',
    [title, category, description, expiresOn, place.visibility, place.departmentId, place.companyId, id]
  )).rows[0];
  var summary = onlyExpiry
    ? (updated.expires_on ? '"' + updated.title + '" expires on ' + String(updated.expires_on).slice(0, 10) + '.' : 'Cleared the expiry date of "' + updated.title + '".')
    : 'Edited "' + updated.title + '".';
  await audit(pool, ctx, onlyExpiry ? 'document.expiry' : 'document.update', 'document', id, summary);
  return rowToDocument(updated);
}

// Sets or clears when a document expires (kept for older callers).
async function setExpiry(ctx, id, expiresOn) {
  return update(ctx, id, { expiresOn: expiresOn === undefined ? null : expiresOn });
}

// A new version of the file — a renewed licence, an updated policy. The old
// file is removed; the expiry date can be moved on at the same time.
async function replaceFile(ctx, id, p) {
  var doc = await loadVisible(ctx, id, 'document.manage');
  checkFile(p.file);
  var expiresOn = p.expiresOn === undefined || p.expiresOn === '' ? doc.expires_on : expiryDate(p.expiresOn);
  var objectKey = await fileStore.put(p.file.originalname, p.file.buffer, p.file.mimetype);
  var updated;
  try {
    updated = (await pool.query(
      'UPDATE documents SET file_name = $1, object_key = $2, size = $3, content_type = $4, expires_on = $5, version = version + 1, updated_at = now() WHERE id = $6 RETURNING *',
      [p.file.originalname, objectKey, p.file.size, p.file.mimetype || null, expiresOn, id]
    )).rows[0];
  } catch (err) {
    await fileStore.del(objectKey);
    throw err;
  }
  if (doc.object_key) await fileStore.del(doc.object_key);
  await audit(pool, ctx, 'document.replace', 'document', id, 'Uploaded version ' + updated.version + ' of "' + updated.title + '".');
  return rowToDocument(updated);
}

// kernel.js: handlers['documents.delete']
async function remove(ctx, id) {
  var doc = await loadVisible(ctx, id, 'document.manage');
  await pool.query('DELETE FROM documents WHERE id = $1', [id]);
  // The row is already gone; a stray file left behind isn't worth failing over.
  await fileStore.del(doc.object_key);
  await audit(pool, ctx, 'document.delete', 'document', id, 'Removed "' + doc.title + '".');
  return true;
}

module.exports = {
  list: list, upload: upload, update: update, setExpiry: setExpiry, replaceFile: replaceFile, expiryDate: expiryDate,
  remove: remove, getDownloadUrl: getDownloadUrl, fileFor: fileFor, documentVisible: documentVisible
};
