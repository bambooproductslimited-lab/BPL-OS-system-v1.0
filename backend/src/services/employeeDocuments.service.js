var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var storage = require('../lib/storage');

// Three fixed ID/passport document slots per employee — front of ID, back
// of ID, passport scan. Gated behind employee.write (the same permission
// that already lets you edit this employee's record), not the broader
// employee.read most roles have, since these are sensitive identity
// documents. Uses the same R2 storage as the Documents module.

var KINDS = ['id_front', 'id_back', 'passport'];
var MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB — these are photos/scans, not large files

function requireManage(ctx) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
}

async function requireEmployee(employeeId) {
  var res = await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [employeeId]);
  if (!res.rows[0]) fail('notfound', 'Employee not found.');
  return res.rows[0];
}

// employeeDocuments.list — current status of all 3 slots (present or not).
async function list(ctx, employeeId) {
  requireManage(ctx);
  await requireEmployee(employeeId);
  var res = await pool.query('SELECT kind, file_name, uploaded_at FROM employee_documents WHERE employee_id = $1', [employeeId]);
  var byKind = {};
  res.rows.forEach(function (r) { byKind[r.kind] = { fileName: r.file_name, uploadedAt: r.uploaded_at }; });
  return KINDS.map(function (kind) {
    var found = byKind[kind];
    return { kind: kind, fileName: found ? found.fileName : null, uploadedAt: found ? found.uploadedAt : null };
  });
}

// employeeDocuments.upload — p.file is multer's in-memory file object.
async function upload(ctx, employeeId, kind, file) {
  requireManage(ctx);
  if (KINDS.indexOf(kind) < 0) fail('invalid', 'Unknown document type.');
  if (!storage.configured) fail('invalid', 'File storage is not configured on the server yet — ask an administrator to set the R2_* environment variables.');
  if (!file) fail('invalid', 'Choose a file to upload.');
  if (file.size > MAX_FILE_BYTES) fail('invalid', 'File is too large — the limit is 10MB.');

  var emp = await requireEmployee(employeeId);
  var existing = await pool.query('SELECT object_key FROM employee_documents WHERE employee_id = $1 AND kind = $2', [employeeId, kind]);
  var objectKey = await storage.uploadFile(file.originalname, file.buffer, file.mimetype);

  if (existing.rows[0]) {
    await pool.query(
      'UPDATE employee_documents SET file_name = $1, object_key = $2, uploaded_by = $3, uploaded_at = now() WHERE employee_id = $4 AND kind = $5',
      [file.originalname, objectKey, ctx.employee.id, employeeId, kind]
    );
    try { await storage.deleteFile(existing.rows[0].object_key); } catch (err) { /* record's already updated; a stray old object in the bucket isn't worth failing over */ }
  } else {
    await pool.query(
      'INSERT INTO employee_documents (employee_id, kind, file_name, object_key, uploaded_by) VALUES ($1,$2,$3,$4,$5)',
      [employeeId, kind, file.originalname, objectKey, ctx.employee.id]
    );
  }

  await audit(pool, ctx, 'employee.document.upload', 'employee', employeeId, 'Uploaded ' + kind.replace('_', ' ') + ' for ' + emp.first_name + ' ' + emp.last_name + '.');
  return list(ctx, employeeId);
}

// employeeDocuments.getDownloadUrl — short-lived signed URL, same pattern as Documents.
async function getDownloadUrl(ctx, employeeId, kind) {
  requireManage(ctx);
  if (KINDS.indexOf(kind) < 0) fail('invalid', 'Unknown document type.');
  var res = await pool.query('SELECT object_key, file_name FROM employee_documents WHERE employee_id = $1 AND kind = $2', [employeeId, kind]);
  if (!res.rows[0]) fail('notfound', 'No file on record for this document.');
  var url = await storage.getDownloadUrl(res.rows[0].object_key, res.rows[0].file_name);
  return { url: url };
}

module.exports = { list: list, upload: upload, getDownloadUrl: getDownloadUrl };
