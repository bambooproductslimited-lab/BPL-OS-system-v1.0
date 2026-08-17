var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function todayISO() { return new Date().toISOString().slice(0, 10); }

// kernel.js: handlers['maintenance.list']
async function list(ctx) {
  if (!ctx.can('asset.read')) fail('forbidden', 'Your role does not allow this action (asset.read).');
  var res = await pool.query(
    'SELECT m.*, a.asset_no, a.description FROM maintenance_records m JOIN assets a ON a.id = m.asset_id ORDER BY m.date DESC'
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, assetId: r.asset_id, date: r.date, technician: r.technician, cost: Number(r.cost),
      faultReport: r.fault_report, downtimeHours: Number(r.downtime_hours), partsReplaced: r.parts_replaced, status: r.status,
      assetLabel: r.asset_no + ' — ' + r.description
    };
  });
}

// kernel.js: handlers['maintenance.create']
async function create(ctx, p) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  var assetRes = await pool.query('SELECT * FROM assets WHERE id = $1', [p.assetId]);
  var asset = assetRes.rows[0];
  if (!asset) fail('invalid', 'Choose an asset.');

  var technician = V.text(p.technician, 'Technician', 60);
  var faultReport = V.text(p.faultReport, 'Fault report', 300);
  var date = V.date(p.date || todayISO(), 'Date');

  var res = await pool.query(
    "INSERT INTO maintenance_records (asset_id, date, technician, cost, fault_report, downtime_hours, parts_replaced, status) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,'completed') RETURNING *",
    [asset.id, date, technician, Math.max(0, Number(p.cost) || 0), faultReport, Math.max(0, Number(p.downtimeHours) || 0), (p.partsReplaced || '').trim()]
  );
  var m = res.rows[0];

  if (p.nextServiceDate) await pool.query('UPDATE assets SET next_service_date = $1 WHERE id = $2', [p.nextServiceDate, asset.id]);

  await audit(pool, ctx, 'maintenance.create', 'maintenance', m.id, 'Logged maintenance on ' + asset.asset_no + ': ' + faultReport);
  return {
    id: m.id, assetId: m.asset_id, date: m.date, technician: m.technician, cost: Number(m.cost),
    faultReport: m.fault_report, downtimeHours: Number(m.downtime_hours), partsReplaced: m.parts_replaced, status: m.status
  };
}

module.exports = { list: list, create: create };
