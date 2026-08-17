var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function rowToSupplier(r, extra) {
  return Object.assign({
    id: r.id, name: r.name, contactPerson: r.contact_person, phone: r.phone, email: r.email, address: r.address,
    materialsSupplied: r.materials_supplied, paymentTerms: r.payment_terms, status: r.status
  }, extra || {});
}

// kernel.js: handlers['suppliers.list']
async function list(ctx) {
  if (!ctx.can('supplier.read')) fail('forbidden', 'Your role does not allow this action (supplier.read).');
  var res = await pool.query(
    'SELECT s.*, (SELECT count(*)::int FROM raw_batches r WHERE r.supplier_id = s.id) AS batch_count FROM suppliers s ORDER BY s.name'
  );
  return res.rows.map(function (r) { return rowToSupplier(r, { batchCount: r.batch_count }); });
}

// kernel.js: handlers['suppliers.create']
async function create(ctx, p) {
  if (!ctx.can('supplier.manage')) fail('forbidden', 'Your role does not allow this action (supplier.manage).');
  var name = V.text(p.name, 'Supplier name', 100);
  var contactPerson = V.text(p.contactPerson, 'Contact person', 60);
  var materialsSupplied = V.text(p.materialsSupplied, 'Materials supplied', 200);
  var res = await pool.query(
    "INSERT INTO suppliers (name, contact_person, phone, email, address, materials_supplied, payment_terms, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *",
    [name, contactPerson, (p.phone || '').trim(), (p.email || '').trim(), (p.address || '').trim(), materialsSupplied, p.paymentTerms || 'Net 30']
  );
  var s = res.rows[0];
  await audit(pool, ctx, 'supplier.create', 'supplier', s.id, 'Added supplier ' + s.name + '.');
  return rowToSupplier(s);
}

// kernel.js: handlers['suppliers.update']
async function update(ctx, id, p) {
  if (!ctx.can('supplier.manage')) fail('forbidden', 'Your role does not allow this action (supplier.manage).');
  var name = V.text(p.name, 'Supplier name', 100);
  var contactPerson = V.text(p.contactPerson, 'Contact person', 60);
  var materialsSupplied = V.text(p.materialsSupplied, 'Materials supplied', 200);
  var res = await pool.query(
    'UPDATE suppliers SET name = $1, contact_person = $2, phone = $3, email = $4, address = $5, materials_supplied = $6, payment_terms = coalesce($7, payment_terms) WHERE id = $8 RETURNING *',
    [name, contactPerson, (p.phone || '').trim(), (p.email || '').trim(), (p.address || '').trim(), materialsSupplied, p.paymentTerms, id]
  );
  if (!res.rows[0]) fail('notfound', 'Supplier not found.');
  var s = res.rows[0];
  await audit(pool, ctx, 'supplier.update', 'supplier', s.id, 'Updated supplier ' + s.name + '.');
  return rowToSupplier(s);
}

// kernel.js: handlers['suppliers.delete']
async function remove(ctx, id) {
  if (!ctx.can('supplier.manage')) fail('forbidden', 'Your role does not allow this action (supplier.manage).');
  var res = await pool.query('SELECT * FROM suppliers WHERE id = $1', [id]);
  var s = res.rows[0];
  if (!s) fail('notfound', 'Supplier not found.');
  var inUse = await pool.query('SELECT 1 FROM raw_batches WHERE supplier_id = $1 LIMIT 1', [id]);
  if (inUse.rows.length) fail('conflict', 'Cannot delete ' + s.name + ' — raw material batches reference this supplier.');
  await pool.query('DELETE FROM suppliers WHERE id = $1', [id]);
  await audit(pool, ctx, 'supplier.delete', 'supplier', id, 'Deleted supplier ' + s.name + '.');
  return true;
}

module.exports = { list: list, create: create, update: update, remove: remove };
