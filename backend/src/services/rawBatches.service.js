var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function todayISO() { return new Date().toISOString().slice(0, 10); }

function rowToRawBatch(r, extra) {
  return Object.assign({
    id: r.id, batchNo: r.batch_no, species: r.species, supplierId: r.supplier_id, dateReceived: r.date_received,
    quantity: Number(r.quantity), unit: r.unit, qualityGrade: r.quality_grade, cost: Number(r.cost),
    warehouseId: r.warehouse_id, status: r.status
  }, extra || {});
}

// kernel.js: handlers['rawBatches.list']
async function list(ctx) {
  if (!ctx.can('production.read')) fail('forbidden', 'Your role does not allow this action (production.read).');
  var res = await pool.query(
    'SELECT rb.*, s.name AS supplier_name, w.name AS warehouse_name FROM raw_batches rb ' +
    'LEFT JOIN suppliers s ON s.id = rb.supplier_id LEFT JOIN warehouses w ON w.id = rb.warehouse_id ' +
    'ORDER BY rb.date_received DESC'
  );
  return res.rows.map(function (r) { return rowToRawBatch(r, { supplierName: r.supplier_name || '—', warehouseName: r.warehouse_name || '—' }); });
}

async function validateRefs(supplierId, warehouseId) {
  var supRes = await pool.query('SELECT id FROM suppliers WHERE id = $1', [supplierId]);
  if (!supRes.rows[0]) fail('invalid', 'Supplier is not a valid option.');
  var whRes = await pool.query('SELECT id FROM warehouses WHERE id = $1', [warehouseId]);
  if (!whRes.rows[0]) fail('invalid', 'Warehouse is not a valid option.');
}

// kernel.js: handlers['rawBatches.create']
async function create(ctx, p) {
  if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).');
  var species = V.text(p.species, 'Species', 60);
  await validateRefs(p.supplierId, p.warehouseId);
  var quantity = Math.max(0, Number(p.quantity) || 0);
  if (quantity <= 0) fail('invalid', 'Quantity must be greater than zero.');
  var qualityGrade = V.oneOf(p.qualityGrade || 'B', ['A', 'B', 'C'], 'Quality grade');

  var countRes = await pool.query('SELECT count(*)::int AS n FROM raw_batches');
  var batchNo = 'RB-' + new Date().getFullYear() + '-' + String(countRes.rows[0].n + 1).padStart(3, '0');

  var res = await pool.query(
    "INSERT INTO raw_batches (batch_no, species, supplier_id, date_received, quantity, unit, quality_grade, cost, warehouse_id, status) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'in_stock') RETURNING *",
    [batchNo, species, p.supplierId, V.date(p.dateReceived || todayISO(), 'Date received'), quantity, p.unit || 'kg', qualityGrade, Math.max(0, Number(p.cost) || 0), p.warehouseId]
  );
  var r = res.rows[0];
  await audit(pool, ctx, 'rawbatch.create', 'raw_batch', r.id, 'Received ' + r.quantity + r.unit + ' of ' + r.species + ' (' + r.batch_no + ').');
  return rowToRawBatch(r);
}

// kernel.js: handlers['rawBatches.update']
async function update(ctx, id, p) {
  if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).');
  var existing = await pool.query('SELECT * FROM raw_batches WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Raw batch not found.');
  var current = existing.rows[0];

  var species = V.text(p.species, 'Species', 60);
  await validateRefs(p.supplierId, p.warehouseId);
  var quantity = Math.max(0, Number(p.quantity) || 0);
  if (quantity <= 0) fail('invalid', 'Quantity must be greater than zero.');
  var qualityGrade = V.oneOf(p.qualityGrade || current.quality_grade, ['A', 'B', 'C'], 'Quality grade');

  var res = await pool.query(
    'UPDATE raw_batches SET species = $1, supplier_id = $2, quantity = $3, unit = $4, quality_grade = $5, cost = $6, warehouse_id = $7 WHERE id = $8 RETURNING *',
    [species, p.supplierId, quantity, p.unit || current.unit, qualityGrade, Math.max(0, Number(p.cost) || 0), p.warehouseId, id]
  );
  var r = res.rows[0];
  await audit(pool, ctx, 'rawbatch.update', 'raw_batch', r.id, 'Updated batch ' + r.batch_no + '.');
  return rowToRawBatch(r);
}

module.exports = { list: list, create: create, update: update };
