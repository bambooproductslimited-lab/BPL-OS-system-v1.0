var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// Maintenance on assets: services and repairs done (completed), or planned
// for a day (scheduled) and marked done later. A completed service moves
// the asset's next service date on by its service interval, when it has
// one (migration 0087), and an asset in for repair is back in use.

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function rowToRecord(r, extra) {
  return Object.assign({
    id: r.id, assetId: r.asset_id, date: r.date, technician: r.technician, cost: Number(r.cost),
    faultReport: r.fault_report, downtimeHours: Number(r.downtime_hours), partsReplaced: r.parts_replaced, status: r.status,
    notes: r.notes || '', completedAt: r.completed_at || null
  }, extra || {});
}

// kernel.js: handlers['maintenance.list']
async function list(ctx) {
  if (!ctx.can('asset.read')) fail('forbidden', 'Your role does not allow this action (asset.read).');
  var res = await pool.query(
    'SELECT m.*, a.asset_no, a.description, a.category, e.first_name, e.last_name FROM maintenance_records m JOIN assets a ON a.id = m.asset_id ' +
    'LEFT JOIN employees e ON e.id = m.created_by ORDER BY m.date DESC'
  );
  return res.rows.map(function (r) {
    return rowToRecord(r, { assetLabel: r.asset_no + ' — ' + r.description, assetNo: r.asset_no, assetName: r.description, assetCategory: r.category, loggedBy: r.first_name ? r.first_name + ' ' + r.last_name : null });
  });
}

// After a completed service: the next one is due an interval later, and an
// asset that was in for repair is back in use.
async function afterService(client, asset, date, nextServiceDate) {
  var next = nextServiceDate || (asset.service_interval_days ? addDays(date, asset.service_interval_days) : null);
  if (next) await client.query('UPDATE assets SET next_service_date = $1 WHERE id = $2', [next, asset.id]);
  if (asset.status === 'in_repair') await client.query("UPDATE assets SET status = 'in_use' WHERE id = $1", [asset.id]);
}

// kernel.js: handlers['maintenance.create'] — done (the default) or planned
// (status 'scheduled', for a day to come).
async function create(ctx, p) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  var assetRes = await pool.query('SELECT * FROM assets WHERE id = $1', [p.assetId || null]);
  var asset = assetRes.rows[0];
  if (!asset) fail('invalid', 'Choose an asset.');

  var planned = p.status === 'scheduled';
  var technician = planned ? String(p.technician || '').trim().slice(0, 60) : V.text(p.technician, 'Technician', 60);
  var faultReport = V.text(p.faultReport, planned ? 'What needs doing' : 'Fault report', 300);
  var date = V.date(p.date || todayISO(), 'Date');
  if (!planned && date > todayISO()) fail('invalid', 'Work done cannot be in the future; plan it instead.');
  var nextServiceDate = p.nextServiceDate ? V.date(p.nextServiceDate, 'Next service date') : null;

  return withTransaction(async function (client) {
    var res = await client.query(
      'INSERT INTO maintenance_records (asset_id, date, technician, cost, fault_report, downtime_hours, parts_replaced, status, created_by, completed_at, notes) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [asset.id, date, technician, planned ? 0 : Math.max(0, Number(p.cost) || 0), faultReport, planned ? 0 : Math.max(0, Number(p.downtimeHours) || 0),
        planned ? '' : (p.partsReplaced || '').trim(), planned ? 'scheduled' : 'completed', ctx.employee.id, planned ? null : new Date(), String(p.notes || '').trim().slice(0, 500)]
    );
    var m = res.rows[0];
    if (planned) {
      if (!asset.next_service_date || date < asset.next_service_date) await client.query('UPDATE assets SET next_service_date = $1 WHERE id = $2', [date, asset.id]);
    } else {
      await afterService(client, asset, date, nextServiceDate);
    }
    await audit(client, ctx, 'maintenance.create', 'maintenance', m.id, (planned ? 'Planned maintenance on ' : 'Logged maintenance on ') + asset.asset_no + ': ' + faultReport);
    return rowToRecord(m);
  });
}

// A planned service is done: who did it, what it cost, parts and downtime.
async function complete(ctx, id, p) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  p = p || {};
  return withTransaction(async function (client) {
    var m = (await client.query('SELECT * FROM maintenance_records WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!m) fail('notfound', 'Maintenance record not found.');
    if (m.status === 'completed') fail('conflict', 'That work is already marked done.');
    var asset = (await client.query('SELECT * FROM assets WHERE id = $1', [m.asset_id])).rows[0];
    var technician = V.text(p.technician || m.technician, 'Technician', 60);
    var date = V.date(p.date || todayISO(), 'Date');
    if (date > todayISO()) fail('invalid', 'Work done cannot be in the future.');
    var updated = (await client.query(
      "UPDATE maintenance_records SET status = 'completed', technician = $2, date = $3, cost = $4, downtime_hours = $5, parts_replaced = $6, " +
      'notes = $7, completed_at = now() WHERE id = $1 RETURNING *',
      [id, technician, date, Math.max(0, Number(p.cost) || 0), Math.max(0, Number(p.downtimeHours) || 0), String(p.partsReplaced || '').trim(), String(p.notes || m.notes || '').trim().slice(0, 500)]
    )).rows[0];
    // The planned date no longer holds the asset's next service.
    if (asset.next_service_date && String(asset.next_service_date) === String(m.date)) await client.query('UPDATE assets SET next_service_date = NULL WHERE id = $1', [asset.id]);
    await afterService(client, asset, date, p.nextServiceDate ? V.date(p.nextServiceDate, 'Next service date') : null);
    await audit(client, ctx, 'maintenance.complete', 'maintenance', id, 'Done: ' + updated.fault_report + ' on ' + asset.asset_no + '.');
    return rowToRecord(updated);
  });
}

// A planned service that will not happen.
async function remove(ctx, id) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  var m = (await pool.query('SELECT * FROM maintenance_records WHERE id = $1', [id])).rows[0];
  if (!m) fail('notfound', 'Maintenance record not found.');
  if (m.status === 'completed') fail('conflict', 'Work already done stays on record.');
  await pool.query('DELETE FROM maintenance_records WHERE id = $1', [id]);
  await audit(pool, ctx, 'maintenance.delete', 'maintenance', id, 'Removed planned work: ' + m.fault_report + '.');
  return true;
}

module.exports = { list: list, create: create, complete: complete, remove: remove };
