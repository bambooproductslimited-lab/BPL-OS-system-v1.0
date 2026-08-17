var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

function todayISO() { return new Date().toISOString().slice(0, 10); }

function rowToAsset(r, extra) {
  return Object.assign({
    id: r.id, assetNo: r.asset_no, category: r.category, description: r.description, purchaseDate: r.purchase_date,
    purchasePrice: Number(r.purchase_price), assignedEmployeeId: r.assigned_employee_id, location: r.location,
    condition: r.condition, warrantyUntil: r.warranty_until, nextServiceDate: r.next_service_date
  }, extra || {});
}

// kernel.js: handlers['assets.list']
async function list(ctx) {
  if (!ctx.can('asset.read')) fail('forbidden', 'Your role does not allow this action (asset.read).');
  var soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  var res = await pool.query('SELECT a.*, e.first_name, e.last_name FROM assets a LEFT JOIN employees e ON e.id = a.assigned_employee_id ORDER BY a.asset_no');
  return res.rows.map(function (r) {
    return rowToAsset(r, {
      assigneeName: r.first_name ? r.first_name + ' ' + r.last_name : 'Unassigned',
      serviceDue: !!(r.next_service_date && r.next_service_date <= soon)
    });
  });
}

// kernel.js: handlers['assets.create']
async function create(ctx, p) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  var category = V.text(p.category, 'Category', 40);
  var description = V.text(p.description, 'Description', 120);

  var countRes = await pool.query('SELECT count(*)::int AS n FROM assets');
  var assetNo = 'AST-' + String(1000 + countRes.rows[0].n + 1).slice(1);

  var res = await pool.query(
    'INSERT INTO assets (asset_no, category, description, purchase_date, purchase_price, assigned_employee_id, location, condition, warranty_until, next_service_date) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [assetNo, category, description, V.date(p.purchaseDate || todayISO(), 'Purchase date'), Math.max(0, Number(p.purchasePrice) || 0),
      p.assignedEmployeeId || null, (p.location || '').trim(), p.condition || 'good', p.warrantyUntil || null, p.nextServiceDate || null]
  );
  var a = res.rows[0];
  await audit(pool, ctx, 'asset.create', 'asset', a.id, 'Registered asset ' + a.asset_no + ' — ' + a.description + '.');
  return rowToAsset(a);
}

module.exports = { list: list, create: create };
