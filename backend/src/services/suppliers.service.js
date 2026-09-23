var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function num(v) { return v === null || v === undefined ? null : Number(v); }
function isoDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function rowToSupplier(r, extra) {
  return Object.assign({
    id: r.id, name: r.name, contactPerson: r.contact_person, phone: r.phone, email: r.email, address: r.address,
    materialsSupplied: r.materials_supplied, paymentTerms: r.payment_terms, status: r.status,
    region: r.region, town: r.town, district: r.district, phone2: r.phone2,
    quotedPrice: num(r.quoted_price), priceUnit: r.price_unit,
    assessment: r.assessment, sourcingStatus: r.sourcing_status, expectedQty: num(r.expected_qty),
    iouAmount: num(r.iou_amount), iouNotes: r.iou_notes,
    firstContactDate: isoDate(r.first_contact_date), notes: r.notes
  }, extra || {});
}

// Optional text: trimmed, bounded, never required.
function optText(v, label, max) {
  v = (v == null ? '' : String(v)).trim();
  if (v.length > max) fail('invalid', label + ' must be under ' + max + ' characters.');
  return v;
}

// Optional number: blank means "not recorded", which is different from 0 —
// a farmer with no quoted price has not quoted one, not quoted zero.
function optNumber(v, label, opts) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  var n = Number(v);
  if (!Number.isFinite(n)) fail('invalid', label + ' must be a number.');
  if (opts && opts.min !== undefined && n < opts.min) fail('invalid', label + ' cannot be negative.');
  return Math.round(n * 100) / 100;
}

function optDate(v, label) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  return V.date(v, label);
}

// Every field beyond the original seven, validated in one place so the
// supplier form and the sheet import cannot drift apart on what they
// accept. See migration 0067 for why these exist and why status and
// assessment are free text.
function cleanFarmerFields(p) {
  return {
    region: optText(p.region, 'Region', 60),
    town: optText(p.town, 'Town', 80),
    district: optText(p.district, 'District', 80),
    phone2: optText(p.phone2, 'Second phone', 30),
    quotedPrice: optNumber(p.quotedPrice, 'Quoted price', { min: 0 }),
    priceUnit: optText(p.priceUnit, 'Price unit', 20),
    assessment: optText(p.assessment, 'Assessment', 60),
    sourcingStatus: optText(p.sourcingStatus, 'Sourcing status', 60),
    expectedQty: optNumber(p.expectedQty, 'Expected quantity', { min: 0 }),
    iouAmount: optNumber(p.iouAmount, 'IOU'),
    iouNotes: optText(p.iouNotes, 'IOU notes', 300),
    firstContactDate: optDate(p.firstContactDate, 'First contact date'),
    notes: optText(p.notes, 'Notes', 2000)
  };
}

var FARMER_KEYS = ['region', 'town', 'district', 'phone2', 'quotedPrice', 'priceUnit', 'assessment', 'sourcingStatus',
  'expectedQty', 'iouAmount', 'iouNotes', 'firstContactDate', 'notes'];
var FARMER_COLUMNS = 'region, town, district, phone2, quoted_price, price_unit, assessment, sourcing_status, expected_qty, iou_amount, iou_notes, first_contact_date, notes';
function farmerValues(f) {
  return [f.region, f.town, f.district, f.phone2, f.quotedPrice, f.priceUnit, f.assessment, f.sourcingStatus,
    f.expectedQty, f.iouAmount, f.iouNotes, f.firstContactDate, f.notes];
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
  var f = cleanFarmerFields(p);
  var res = await pool.query(
    'INSERT INTO suppliers (name, contact_person, phone, email, address, materials_supplied, payment_terms, status, ' + FARMER_COLUMNS + ') ' +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *",
    [name, contactPerson, (p.phone || '').trim(), (p.email || '').trim(), (p.address || '').trim(), materialsSupplied, p.paymentTerms || 'Net 30']
      .concat(farmerValues(f))
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

  // Only the farmer fields this request actually carries are changed; any
  // it leaves out keep their stored value. Without that, a client that
  // predates these fields — the old supplier form, still cached in a
  // browser during the window between the backend and the frontend being
  // deployed — would save an edit and silently blank every imported
  // region, price, assessment and IOU on that supplier.
  var existingRes = await pool.query('SELECT * FROM suppliers WHERE id = $1', [id]);
  if (!existingRes.rows[0]) fail('notfound', 'Supplier not found.');
  var current = rowToSupplier(existingRes.rows[0]);
  var merged = {};
  FARMER_KEYS.forEach(function (k) {
    merged[k] = Object.prototype.hasOwnProperty.call(p, k) ? p[k] : current[k];
  });
  var f = cleanFarmerFields(merged);

  var res = await pool.query(
    'UPDATE suppliers SET name = $1, contact_person = $2, phone = $3, email = $4, address = $5, materials_supplied = $6, ' +
    'payment_terms = coalesce($7, payment_terms), region = $8, town = $9, district = $10, phone2 = $11, quoted_price = $12, ' +
    'price_unit = $13, assessment = $14, sourcing_status = $15, expected_qty = $16, iou_amount = $17, iou_notes = $18, ' +
    'first_contact_date = $19, notes = $20 WHERE id = $21 RETURNING *',
    [name, contactPerson, (p.phone || '').trim(), (p.email || '').trim(), (p.address || '').trim(), materialsSupplied, p.paymentTerms]
      .concat(farmerValues(f), [id])
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

module.exports = {
  list: list, create: create, update: update, remove: remove,
  rowToSupplier: rowToSupplier, cleanFarmerFields: cleanFarmerFields, FARMER_KEYS: FARMER_KEYS,
  FARMER_COLUMNS: FARMER_COLUMNS, farmerValues: farmerValues
};
