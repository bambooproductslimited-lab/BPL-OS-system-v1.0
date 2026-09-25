var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// Raw bamboo received from suppliers and farmers. `quantity` is what is
// left of a batch (production takes from it); `received_qty` is what came
// in and `disposed_qty` what was written off (migration 0084), so what has
// gone into production is received - left - written off.

var UNITS = ['kg', 'poles', 'bundles', 'tonnes'];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function num(v) { return v === null || v === undefined ? 0 : Number(v); }
function round2(n) { return Math.round(n * 100) / 100; }

function rowToRawBatch(r, extra) {
  var received = num(r.received_qty), left = num(r.quantity), disposed = num(r.disposed_qty);
  return Object.assign({
    id: r.id, batchNo: r.batch_no, species: r.species, supplierId: r.supplier_id, dateReceived: r.date_received,
    quantity: left, receivedQty: received, disposedQty: disposed, usedQty: round2(Math.max(0, received - left - disposed)),
    unit: r.unit, qualityGrade: r.quality_grade, cost: num(r.cost),
    costPerUnit: received > 0 ? round2(num(r.cost) / received) : null,
    warehouseId: r.warehouse_id, status: r.status, notes: r.notes || ''
  }, extra || {});
}

// kernel.js: handlers['rawBatches.list']
async function list(ctx) {
  if (!ctx.can('production.read')) fail('forbidden', 'Your role does not allow this action (production.read).');
  var res = await pool.query(
    'SELECT rb.*, s.name AS supplier_name, s.phone AS supplier_phone, s.town AS supplier_town, w.name AS warehouse_name, ' +
    "(SELECT count(*)::int FROM production_batches pb WHERE pb.raw_batch_id = rb.id AND pb.status <> 'cancelled') AS production_count, " +
    "(SELECT max(pb.date) FROM production_batches pb WHERE pb.raw_batch_id = rb.id AND pb.status <> 'cancelled') AS last_used_on " +
    'FROM raw_batches rb LEFT JOIN suppliers s ON s.id = rb.supplier_id LEFT JOIN warehouses w ON w.id = rb.warehouse_id ' +
    'ORDER BY rb.date_received DESC, rb.batch_no DESC'
  );
  return res.rows.map(function (r) {
    return rowToRawBatch(r, {
      supplierName: r.supplier_name || '—', supplierPhone: r.supplier_phone || '', supplierTown: r.supplier_town || '',
      warehouseName: r.warehouse_name || '—', productionCount: r.production_count, lastUsedOn: r.last_used_on || null
    });
  });
}

async function validateRefs(supplierId, warehouseId) {
  var supRes = await pool.query('SELECT id FROM suppliers WHERE id = $1', [supplierId || null]);
  if (!supRes.rows[0]) fail('invalid', 'Supplier is not a valid option.');
  var whRes = await pool.query('SELECT id FROM warehouses WHERE id = $1', [warehouseId || null]);
  if (!whRes.rows[0]) fail('invalid', 'Warehouse is not a valid option.');
}

function readUnit(v, fallback) {
  var unit = String(v || fallback || 'kg').trim();
  return V.oneOf(unit, UNITS.indexOf(fallback) < 0 && fallback ? UNITS.concat([fallback]) : UNITS, 'Unit');
}

// kernel.js: handlers['rawBatches.create']
async function create(ctx, p) {
  if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).');
  var species = V.text(p.species, 'Species', 60);
  await validateRefs(p.supplierId, p.warehouseId);
  var quantity = Math.max(0, Number(p.quantity) || 0);
  if (quantity <= 0) fail('invalid', 'Quantity must be greater than zero.');
  var qualityGrade = V.oneOf(p.qualityGrade || 'B', ['A', 'B', 'C'], 'Quality grade');
  var dateReceived = V.date(p.dateReceived || todayISO(), 'Date received');
  if (dateReceived > todayISO()) fail('invalid', 'The date received cannot be in the future.');

  var year = dateReceived.slice(0, 4);
  var countRes = await pool.query(
    "SELECT coalesce(max(substring(batch_no from '^RB-' || $1 || '-(\\d+)$')::int), 0) AS n FROM raw_batches", [year]
  );
  var batchNo = 'RB-' + year + '-' + String(countRes.rows[0].n + 1).padStart(3, '0');

  var res = await pool.query(
    "INSERT INTO raw_batches (batch_no, species, supplier_id, date_received, quantity, received_qty, unit, quality_grade, cost, warehouse_id, status, notes, created_by) " +
    "VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,'in_stock',$10,$11) RETURNING *",
    [batchNo, species, p.supplierId, dateReceived, quantity, readUnit(p.unit), qualityGrade, Math.max(0, Number(p.cost) || 0), p.warehouseId,
      String(p.notes || '').trim().slice(0, 500), ctx.employee.id]
  );
  var r = res.rows[0];
  await audit(pool, ctx, 'rawbatch.create', 'raw_batch', r.id, 'Received ' + r.quantity + r.unit + ' of ' + r.species + ' (' + r.batch_no + ').');
  return rowToRawBatch(r);
}

// kernel.js: handlers['rawBatches.update'] — the quantity is what was
// received; what is left follows from it (it cannot go below what has
// already been used or written off).
async function update(ctx, id, p) {
  if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).');
  var existing = await pool.query('SELECT * FROM raw_batches WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Raw batch not found.');
  var current = existing.rows[0];

  var species = V.text(p.species, 'Species', 60);
  await validateRefs(p.supplierId, p.warehouseId);
  var received = Math.max(0, Number(p.quantity) || 0);
  if (received <= 0) fail('invalid', 'Quantity must be greater than zero.');
  var gone = num(current.received_qty) - num(current.quantity);
  if (received < gone) fail('invalid', gone + current.unit + ' of this batch has already been used or written off, so it cannot be less than that.');
  var left = round2(received - gone);
  var qualityGrade = V.oneOf(p.qualityGrade || current.quality_grade, ['A', 'B', 'C'], 'Quality grade');
  var dateReceived = p.dateReceived ? V.date(p.dateReceived, 'Date received') : current.date_received;
  if (dateReceived > todayISO()) fail('invalid', 'The date received cannot be in the future.');
  var status = left <= 0 ? (current.status === 'in_stock' ? 'depleted' : current.status) : 'in_stock';

  var res = await pool.query(
    'UPDATE raw_batches SET species = $1, supplier_id = $2, quantity = $3, received_qty = $4, unit = $5, quality_grade = $6, cost = $7, warehouse_id = $8, ' +
    'date_received = $9, notes = $10, status = $11 WHERE id = $12 RETURNING *',
    [species, p.supplierId, left, received, readUnit(p.unit, current.unit), qualityGrade, Math.max(0, Number(p.cost) || 0), p.warehouseId,
      dateReceived, p.notes === undefined ? current.notes : String(p.notes || '').trim().slice(0, 500), status, id]
  );
  var r = res.rows[0];
  await audit(pool, ctx, 'rawbatch.update', 'raw_batch', r.id, 'Updated batch ' + r.batch_no + '.');
  return rowToRawBatch(r);
}

// Write off part or all of what is left (rotten, split, stolen); a reason
// is kept with the batch and in the stock movements.
async function writeOff(ctx, id, p) {
  if (!ctx.can('production.manage')) fail('forbidden', 'Your role does not allow this action (production.manage).');
  var reason = V.text(p && p.reason, 'Reason', 200);
  return withTransaction(async function (client) {
    var rb = (await client.query('SELECT * FROM raw_batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!rb) fail('notfound', 'Raw batch not found.');
    var left = num(rb.quantity);
    var qty = p.qty === undefined || p.qty === null || p.qty === '' ? left : Number(p.qty);
    if (!(qty > 0)) fail('invalid', 'Enter how much to write off.');
    if (qty > left) fail('invalid', 'Only ' + left + rb.unit + ' is left in batch ' + rb.batch_no + '.');
    var newLeft = round2(left - qty);
    var note = (rb.notes ? rb.notes + '\n' : '') + 'Written off ' + qty + rb.unit + ' on ' + todayISO() + ': ' + reason;
    var r = (await client.query(
      'UPDATE raw_batches SET quantity = $1, disposed_qty = disposed_qty + $2, status = $3, notes = $4 WHERE id = $5 RETURNING *',
      [newLeft, qty, newLeft <= 0 ? 'disposed' : rb.status, note.slice(-2000), id]
    )).rows[0];
    await client.query(
      "INSERT INTO inventory_tx (item_type, item_id, warehouse_id, type, qty, date, user_id, reference, notes) VALUES ('raw',$1,$2,'write_off',$3,$4,$5,$6,$7)",
      [rb.id, rb.warehouse_id, -qty, todayISO(), ctx.employee.id, rb.batch_no, reason]
    );
    await audit(client, ctx, 'rawbatch.writeoff', 'raw_batch', id, 'Wrote off ' + qty + rb.unit + ' of ' + rb.batch_no + ': ' + reason);
    return rowToRawBatch(r);
  });
}

module.exports = { list: list, create: create, update: update, writeOff: writeOff, UNITS: UNITS };
