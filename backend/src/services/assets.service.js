var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// Equipment and vehicles: who has it, where it is, its condition, when it
// is next due for a service, and what its maintenance has cost. Migration
// 0087 added the company, serial number, notes, status (in use, in for
// repair, retired) and a service interval — logging a service moves the
// next service date on by that many days (maintenance.service.js).

var CONDITIONS = ['good', 'fair', 'poor'];
var STATUSES = ['in_use', 'in_repair', 'retired'];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function optDate(v, label) { return v === undefined || v === null || String(v).trim() === '' ? null : V.date(String(v).trim(), label); }

function rowToAsset(r, extra) {
  return Object.assign({
    id: r.id, assetNo: r.asset_no, category: r.category, description: r.description, purchaseDate: r.purchase_date,
    purchasePrice: Number(r.purchase_price), assignedEmployeeId: r.assigned_employee_id, location: r.location,
    condition: r.condition, warrantyUntil: r.warranty_until, nextServiceDate: r.next_service_date,
    companyId: r.company_id || null, serialNo: r.serial_no || '', notes: r.notes || '', status: r.status || 'in_use',
    serviceIntervalDays: r.service_interval_days || null, retiredOn: r.retired_on || null
  }, extra || {});
}

// kernel.js: handlers['assets.list']
async function list(ctx) {
  if (!ctx.can('asset.read')) fail('forbidden', 'Your role does not allow this action (asset.read).');
  var soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  var res = await pool.query(
    'SELECT a.*, e.first_name, e.last_name, e.photo_key, e.photo_updated_at, c.code AS company_code, c.name AS company_name, m.records, m.cost, m.downtime, m.last_service, m.open_records, m.year_cost ' +
    'FROM assets a LEFT JOIN employees e ON e.id = a.assigned_employee_id LEFT JOIN companies c ON c.id = a.company_id ' +
    "LEFT JOIN (SELECT asset_id, count(*) FILTER (WHERE status = 'completed')::int AS records, coalesce(sum(cost) FILTER (WHERE status = 'completed'), 0)::float AS cost, " +
    "  coalesce(sum(downtime_hours) FILTER (WHERE status = 'completed'), 0)::float AS downtime, max(date) FILTER (WHERE status = 'completed')::text AS last_service, " +
    "  count(*) FILTER (WHERE status <> 'completed')::int AS open_records, " +
    "  coalesce(sum(cost) FILTER (WHERE status = 'completed' AND date >= date_trunc('year', current_date)), 0)::float AS year_cost " +
    '  FROM maintenance_records GROUP BY asset_id) m ON m.asset_id = a.id ' +
    'ORDER BY a.asset_no'
  );
  return res.rows.map(function (r) {
    return rowToAsset(r, {
      assigneeName: r.first_name ? r.first_name + ' ' + r.last_name : 'Unassigned',
      assigneePhoto: r.photo_key && r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : null,
      companyCode: r.company_code || null, companyName: r.company_name || null,
      serviceDue: !!(r.status !== 'retired' && r.next_service_date && r.next_service_date <= soon),
      maintenanceCount: r.records || 0, maintenanceCost: r.cost || 0, downtimeHours: r.downtime || 0,
      lastService: r.last_service || null, openRecords: r.open_records || 0, yearMaintenanceCost: r.year_cost || 0
    });
  });
}

async function readFields(p, existing) {
  var g = function (k, dflt) { return p[k] === undefined ? dflt : p[k]; };
  var f = {
    category: V.text(g('category', existing && existing.category), 'Category', 40),
    description: V.text(g('description', existing && existing.description), 'Description', 120),
    purchaseDate: optDate(g('purchaseDate', existing ? existing.purchase_date : todayISO()), 'Purchase date'),
    purchasePrice: Math.max(0, Number(g('purchasePrice', existing ? existing.purchase_price : 0)) || 0),
    assignedEmployeeId: g('assignedEmployeeId', existing && existing.assigned_employee_id) || null,
    location: String(g('location', existing ? existing.location : '') || '').trim().slice(0, 120),
    condition: V.oneOf(g('condition', existing ? existing.condition : 'good') || 'good', CONDITIONS, 'Condition'),
    warrantyUntil: optDate(g('warrantyUntil', existing && existing.warranty_until), 'Warranty date'),
    nextServiceDate: optDate(g('nextServiceDate', existing && existing.next_service_date), 'Next service date'),
    companyId: g('companyId', existing && existing.company_id) || null,
    serialNo: String(g('serialNo', existing ? existing.serial_no : '') || '').trim().slice(0, 80),
    notes: String(g('notes', existing ? existing.notes : '') || '').trim().slice(0, 1000),
    status: V.oneOf(g('status', existing ? existing.status : 'in_use') || 'in_use', STATUSES, 'Status'),
    serviceIntervalDays: null
  };
  var interval = g('serviceIntervalDays', existing && existing.service_interval_days);
  if (interval !== null && interval !== undefined && String(interval).trim() !== '') {
    var n = Math.round(Number(interval));
    if (!(n > 0 && n <= 3650)) fail('invalid', 'The service interval must be a number of days, 1 or more.');
    f.serviceIntervalDays = n;
  }
  if (f.assignedEmployeeId && !(await pool.query('SELECT 1 FROM employees WHERE id = $1', [f.assignedEmployeeId])).rows[0]) fail('invalid', 'That person is not on the staff list.');
  if (f.companyId && !(await pool.query('SELECT 1 FROM companies WHERE id = $1', [f.companyId])).rows[0]) fail('invalid', 'Unknown company.');
  return f;
}

// kernel.js: handlers['assets.create']
async function create(ctx, p) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  var f = await readFields(p || {}, null);
  var maxRes = await pool.query("SELECT coalesce(max(substring(asset_no from '^AST-(\\d+)$')::int), 0) AS n FROM assets");
  var assetNo = 'AST-' + String(maxRes.rows[0].n + 1).padStart(3, '0');

  var res = await pool.query(
    'INSERT INTO assets (asset_no, category, description, purchase_date, purchase_price, assigned_employee_id, location, condition, warranty_until, next_service_date, ' +
    'company_id, serial_no, notes, status, service_interval_days, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now()) RETURNING *',
    [assetNo, f.category, f.description, f.purchaseDate, f.purchasePrice, f.assignedEmployeeId, f.location, f.condition, f.warrantyUntil, f.nextServiceDate,
      f.companyId, f.serialNo, f.notes, f.status, f.serviceIntervalDays]
  );
  var a = res.rows[0];
  await audit(pool, ctx, 'asset.create', 'asset', a.id, 'Registered asset ' + a.asset_no + ' — ' + a.description + '.');
  return rowToAsset(a);
}

// Change anything about an asset; only the fields sent change. Retiring it
// records the day.
async function update(ctx, id, p) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  var existing = (await pool.query('SELECT * FROM assets WHERE id = $1', [id])).rows[0];
  if (!existing) fail('notfound', 'Asset not found.');
  var f = await readFields(p || {}, existing);
  var retiredOn = f.status === 'retired' ? (existing.retired_on || todayISO()) : null;
  var res = await pool.query(
    'UPDATE assets SET category = $2, description = $3, purchase_date = $4, purchase_price = $5, assigned_employee_id = $6, location = $7, condition = $8, ' +
    'warranty_until = $9, next_service_date = $10, company_id = $11, serial_no = $12, notes = $13, status = $14, service_interval_days = $15, retired_on = $16, updated_at = now() ' +
    'WHERE id = $1 RETURNING *',
    [id, f.category, f.description, f.purchaseDate, f.purchasePrice, f.assignedEmployeeId, f.location, f.condition, f.warrantyUntil, f.nextServiceDate,
      f.companyId, f.serialNo, f.notes, f.status, f.serviceIntervalDays, retiredOn]
  );
  var a = res.rows[0];
  await audit(pool, ctx, 'asset.update', 'asset', id, (existing.status !== 'retired' && a.status === 'retired' ? 'Retired ' : 'Updated ') + a.asset_no + '.');
  return rowToAsset(a);
}

module.exports = { list: list, create: create, update: update, rowToAsset: rowToAsset };
