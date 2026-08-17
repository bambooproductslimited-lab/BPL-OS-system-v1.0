var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

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
    uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at, fileName: r.file_name
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

// kernel.js: handlers['documents.upload']
async function upload(ctx, p) {
  if (!ctx.can('document.manage')) fail('forbidden', 'Your role does not allow this action (document.manage).');
  var title = V.text(p.title, 'Title', 100);
  var category = V.text(p.category, 'Category', 40);
  var fileName = V.text(p.fileName, 'File name', 120);
  var visibility = V.oneOf(p.visibility || 'all', ['all', 'department', 'managers'], 'Visibility');
  var departmentId = visibility === 'department' ? ctx.employee.department_id : null;

  var res = await pool.query(
    'INSERT INTO documents (title, category, department_id, visibility, uploaded_by, file_name) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [title, category, departmentId, visibility, ctx.employee.id, fileName]
  );
  var doc = res.rows[0];
  await audit(pool, ctx, 'document.upload', 'document', doc.id, 'Uploaded "' + doc.title + '".');
  return rowToDocument(doc);
}

// kernel.js: handlers['documents.delete']
async function remove(ctx, id) {
  if (!ctx.can('document.manage')) fail('forbidden', 'Your role does not allow this action (document.manage).');
  var res = await pool.query('SELECT title FROM documents WHERE id = $1', [id]);
  if (!res.rows[0]) fail('notfound', 'Document not found.');
  await pool.query('DELETE FROM documents WHERE id = $1', [id]);
  await audit(pool, ctx, 'document.delete', 'document', id, 'Removed "' + res.rows[0].title + '".');
  return true;
}

module.exports = { list: list, upload: upload, remove: remove, documentVisible: documentVisible };
