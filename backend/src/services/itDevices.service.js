var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// IT device inventory: company laptops/desktops/phones/monitors/etc, owned
// and tracked by IT specifically — separate from the general Assets &
// Maintenance module, which covers company assets broadly.

function rowToDevice(r, extra) {
  return Object.assign({
    id: r.id, deviceTag: r.device_tag, category: r.category, brand: r.brand, model: r.model, serialNumber: r.serial_number,
    assignedEmployeeId: r.assigned_employee_id, departmentId: r.department_id, location: r.location,
    purchaseDate: r.purchase_date, purchasePrice: Number(r.purchase_price), warrantyUntil: r.warranty_until,
    condition: r.condition, status: r.status, notes: r.notes
  }, extra || {});
}

async function list(ctx) {
  if (!ctx.can('itdevice.read')) fail('forbidden', 'Your role does not allow this action (itdevice.read).');
  var res = await pool.query(
    'SELECT d.*, e.first_name, e.last_name, dept.name AS department_name FROM it_devices d ' +
    'LEFT JOIN employees e ON e.id = d.assigned_employee_id LEFT JOIN departments dept ON dept.id = d.department_id ' +
    'ORDER BY d.device_tag'
  );
  return res.rows.map(function (r) {
    return rowToDevice(r, {
      assigneeName: r.first_name ? r.first_name + ' ' + r.last_name : 'Unassigned',
      departmentName: r.department_name || ''
    });
  });
}

async function create(ctx, p) {
  if (!ctx.can('itdevice.manage')) fail('forbidden', 'Your role does not allow this action (itdevice.manage).');
  var category = V.text(p.category, 'Category', 40);
  var deviceTag = (p.deviceTag || '').trim().toUpperCase();
  if (!deviceTag) {
    var countRes = await pool.query('SELECT count(*)::int AS n FROM it_devices');
    deviceTag = 'IT-' + String(1000 + countRes.rows[0].n + 1).slice(1);
  } else {
    var existing = await pool.query('SELECT id FROM it_devices WHERE device_tag = $1', [deviceTag]);
    if (existing.rows[0]) fail('invalid', 'That device tag already exists.');
  }

  var res = await pool.query(
    "INSERT INTO it_devices (device_tag, category, brand, model, serial_number, assigned_employee_id, department_id, location, purchase_date, purchase_price, warranty_until, condition, status) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'in_use') RETURNING *",
    [deviceTag, category, (p.brand || '').trim(), (p.model || '').trim(), (p.serialNumber || '').trim(),
      p.assignedEmployeeId || null, p.departmentId || null, (p.location || '').trim(), p.purchaseDate || null,
      Math.max(0, Number(p.purchasePrice) || 0), p.warrantyUntil || null, p.condition || 'good']
  );
  var d = res.rows[0];
  await audit(pool, ctx, 'itdevice.create', 'it_device', d.id, 'Registered device ' + d.device_tag + ' — ' + (d.brand + ' ' + d.model).trim() + '.');
  return rowToDevice(d);
}

async function update(ctx, id, p) {
  if (!ctx.can('itdevice.manage')) fail('forbidden', 'Your role does not allow this action (itdevice.manage).');
  var existing = await pool.query('SELECT * FROM it_devices WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Device not found.');

  var category = V.text(p.category, 'Category', 40);
  var condition = V.oneOf(p.condition || 'good', ['good', 'fair', 'poor'], 'Condition');
  var status = V.oneOf(p.status || 'in_use', ['in_use', 'in_storage', 'under_repair', 'retired', 'lost'], 'Status');

  var res = await pool.query(
    'UPDATE it_devices SET category = $1, brand = $2, model = $3, serial_number = $4, assigned_employee_id = $5, department_id = $6, location = $7, purchase_date = $8, purchase_price = $9, warranty_until = $10, condition = $11, status = $12, notes = $13 WHERE id = $14 RETURNING *',
    [category, (p.brand || '').trim(), (p.model || '').trim(), (p.serialNumber || '').trim(), p.assignedEmployeeId || null,
      p.departmentId || null, (p.location || '').trim(), p.purchaseDate || null, Math.max(0, Number(p.purchasePrice) || 0),
      p.warrantyUntil || null, condition, status, (p.notes || '').trim(), id]
  );
  var d = res.rows[0];
  await audit(pool, ctx, 'itdevice.update', 'it_device', d.id, 'Updated device ' + d.device_tag + '.');
  return rowToDevice(d);
}

module.exports = { list: list, create: create, update: update };
