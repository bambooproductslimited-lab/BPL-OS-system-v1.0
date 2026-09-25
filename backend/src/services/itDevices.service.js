var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// IT device inventory: company laptops/desktops/phones/monitors/etc, owned
// and tracked by IT specifically — separate from the general Assets &
// Maintenance module, which covers company assets broadly. A device is
// handed to someone and handed back (to storage), changes status (in for
// repair, retired, lost) and is checked by IT from time to time; every one
// of those is logged in it_device_events (migration 0089), which is the
// device's history.

var STATUSES = ['in_use', 'in_storage', 'under_repair', 'retired', 'lost'];
var CONDITIONS = ['good', 'fair', 'poor'];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function isoDate(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function has(p, k) { return p && Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined; }
function fullName(first, last) { return first ? first + (last ? ' ' + last : '') : null; }
function note(v) { return String(v || '').trim().slice(0, 300); }
function optDate(v, label) { return v ? V.date(v, label) : null; }

function rowToDevice(r, extra) {
  return Object.assign({
    id: r.id, deviceTag: r.device_tag, category: r.category, brand: r.brand, model: r.model, serialNumber: r.serial_number,
    assignedEmployeeId: r.assigned_employee_id, departmentId: r.department_id, location: r.location,
    purchaseDate: isoDate(r.purchase_date), purchasePrice: Number(r.purchase_price), warrantyUntil: isoDate(r.warranty_until),
    condition: r.condition, status: r.status, notes: r.notes,
    assignedAt: r.assigned_at || null, lastCheckedOn: isoDate(r.last_checked_on), createdAt: r.created_at || null
  }, extra || {});
}

async function logEvent(ctx, deviceId, kind, e) {
  e = e || {};
  await pool.query(
    'INSERT INTO it_device_events (device_id, kind, employee_id, status, condition, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [deviceId, kind, e.employeeId || null, e.status || null, e.condition || null, e.note || '', ctx.employee ? ctx.employee.id : null]
  );
}

async function findDevice(id) {
  var d = (await pool.query('SELECT * FROM it_devices WHERE id = $1', [id])).rows[0];
  if (!d) fail('notfound', 'Device not found.');
  return d;
}

async function findEmployee(id) {
  if (!id) return null;
  var e = (await pool.query('SELECT id, first_name, last_name, status FROM employees WHERE id = $1', [id])).rows[0];
  if (!e) fail('invalid', 'That employee was not found.');
  return e;
}

async function list(ctx) {
  if (!ctx.can('itdevice.read')) fail('forbidden', 'Your role does not allow this action (itdevice.read).');
  var res = await pool.query(
    'SELECT d.*, e.first_name, e.last_name, e.status AS assignee_status, e.phone AS assignee_phone, e.photo_key, e.photo_updated_at, ' +
    '  dept.name AS department_name, dept.company_id, c.code AS company_code, c.name AS company_name, ev.handovers ' +
    'FROM it_devices d ' +
    'LEFT JOIN employees e ON e.id = d.assigned_employee_id ' +
    'LEFT JOIN departments dept ON dept.id = coalesce(d.department_id, e.department_id) ' +
    'LEFT JOIN companies c ON c.id = dept.company_id ' +
    "LEFT JOIN (SELECT device_id, count(*) FILTER (WHERE kind = 'assign') AS handovers FROM it_device_events GROUP BY device_id) ev ON ev.device_id = d.id " +
    'ORDER BY d.device_tag'
  );
  return res.rows.map(function (r) {
    return rowToDevice(r, {
      assigneeName: fullName(r.first_name, r.last_name),
      assigneePhoto: r.photo_key && r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : null,
      assigneePhone: r.assignee_phone || null,
      // still holding a company device after leaving
      assigneeLeft: !!r.assigned_employee_id && r.assignee_status === 'terminated',
      departmentName: r.department_name || '',
      companyId: r.company_id || null, companyCode: r.company_code || null, companyName: r.company_name || null,
      handovers: Number(r.handovers || 0)
    });
  });
}

// Everything that happened to one device, newest first.
async function history(ctx, id) {
  if (!ctx.can('itdevice.read')) fail('forbidden', 'Your role does not allow this action (itdevice.read).');
  await findDevice(id);
  var res = await pool.query(
    'SELECT ev.*, e.first_name, e.last_name, e.photo_key, e.photo_updated_at, b.first_name AS by_first, b.last_name AS by_last ' +
    'FROM it_device_events ev LEFT JOIN employees e ON e.id = ev.employee_id LEFT JOIN employees b ON b.id = ev.created_by ' +
    'WHERE ev.device_id = $1 ORDER BY ev.created_at DESC, ev.id LIMIT 200', [id]
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, kind: r.kind, at: r.created_at, employeeId: r.employee_id,
      employeeName: fullName(r.first_name, r.last_name),
      employeePhoto: r.photo_key && r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : null,
      status: r.status, condition: r.condition, note: r.note, byName: fullName(r.by_first, r.by_last)
    };
  });
}

// The next free IT-NNN tag: one more than the highest number in use, so a
// removed or imported device never makes two share a tag.
async function nextTag() {
  var res = await pool.query("SELECT max((substring(device_tag from '^IT-(\\d+)$'))::int) AS n FROM it_devices");
  var n = (res.rows[0].n || 0) + 1;
  return 'IT-' + String(n).padStart(3, '0');
}

async function create(ctx, p) {
  if (!ctx.can('itdevice.manage')) fail('forbidden', 'Your role does not allow this action (itdevice.manage).');
  p = p || {};
  var category = V.text(p.category, 'Category', 40);
  var condition = V.oneOf(p.condition || 'good', CONDITIONS, 'Condition');
  var deviceTag = String(p.deviceTag || '').trim().toUpperCase().slice(0, 30);
  if (!deviceTag) {
    deviceTag = await nextTag();
  } else {
    var existing = await pool.query('SELECT id FROM it_devices WHERE device_tag = $1', [deviceTag]);
    if (existing.rows[0]) fail('invalid', 'That device tag already exists.');
  }
  var emp = await findEmployee(p.assignedEmployeeId);
  var status = has(p, 'status') && p.status ? V.oneOf(p.status, STATUSES, 'Status') : 'in_use';

  var res = await pool.query(
    'INSERT INTO it_devices (device_tag, category, brand, model, serial_number, assigned_employee_id, department_id, location, purchase_date, purchase_price, warranty_until, condition, status, notes, assigned_at) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
    [deviceTag, category, String(p.brand || '').trim().slice(0, 60), String(p.model || '').trim().slice(0, 100), String(p.serialNumber || '').trim().slice(0, 100),
      emp ? emp.id : null, p.departmentId || null, String(p.location || '').trim().slice(0, 120), optDate(p.purchaseDate, 'Purchase date'),
      Math.max(0, Number(p.purchasePrice) || 0), optDate(p.warrantyUntil, 'Warranty until'), condition, status,
      String(p.notes || '').trim().slice(0, 2000), emp ? new Date() : null]
  );
  var d = res.rows[0];
  if (emp) await logEvent(ctx, d.id, 'assign', { employeeId: emp.id, note: 'Registered' });
  await audit(pool, ctx, 'itdevice.create', 'it_device', d.id, 'Registered device ' + d.device_tag + ' — ' + (d.brand + ' ' + d.model).trim() + '.');
  return rowToDevice(d);
}

// Only what was sent changes. A new person or a new status is logged, so the
// history shows every handover even when it was made through the form.
async function update(ctx, id, p) {
  if (!ctx.can('itdevice.manage')) fail('forbidden', 'Your role does not allow this action (itdevice.manage).');
  p = p || {};
  var cur = await findDevice(id);

  var category = has(p, 'category') ? V.text(p.category, 'Category', 40) : cur.category;
  var condition = has(p, 'condition') ? V.oneOf(p.condition || 'good', CONDITIONS, 'Condition') : cur.condition;
  var status = has(p, 'status') ? V.oneOf(p.status || 'in_use', STATUSES, 'Status') : cur.status;
  var assignee = has(p, 'assignedEmployeeId') ? p.assignedEmployeeId || null : cur.assigned_employee_id;
  var emp = assignee !== cur.assigned_employee_id ? await findEmployee(assignee) : null;
  var text = function (k, col, max) { return has(p, k) ? String(p[k] || '').trim().slice(0, max) : cur[col]; };

  var res = await pool.query(
    'UPDATE it_devices SET category = $1, brand = $2, model = $3, serial_number = $4, assigned_employee_id = $5, department_id = $6, location = $7, ' +
    'purchase_date = $8, purchase_price = $9, warranty_until = $10, condition = $11, status = $12, notes = $13, ' +
    'assigned_at = CASE WHEN $5::uuid IS DISTINCT FROM assigned_employee_id THEN (CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END) ELSE assigned_at END, ' +
    'updated_at = now() WHERE id = $14 RETURNING *',
    [category, text('brand', 'brand', 60), text('model', 'model', 100), text('serialNumber', 'serial_number', 100), assignee,
      has(p, 'departmentId') ? p.departmentId || null : cur.department_id, text('location', 'location', 120),
      has(p, 'purchaseDate') ? optDate(p.purchaseDate, 'Purchase date') : cur.purchase_date,
      has(p, 'purchasePrice') ? Math.max(0, Number(p.purchasePrice) || 0) : cur.purchase_price,
      has(p, 'warrantyUntil') ? optDate(p.warrantyUntil, 'Warranty until') : cur.warranty_until,
      condition, status, text('notes', 'notes', 2000), id]
  );
  var d = res.rows[0];
  if (assignee !== cur.assigned_employee_id) {
    await logEvent(ctx, id, assignee ? 'assign' : 'return', { employeeId: assignee || cur.assigned_employee_id });
  }
  if (status !== cur.status) await logEvent(ctx, id, 'status', { status: status });
  await audit(pool, ctx, 'itdevice.update', 'it_device', d.id, 'Updated device ' + d.device_tag + '.');
  return rowToDevice(d);
}

// Hand a device to someone (it is then in use), or back to IT (employeeId
// empty: it goes into storage).
async function assign(ctx, id, p) {
  if (!ctx.can('itdevice.manage')) fail('forbidden', 'Your role does not allow this action (itdevice.manage).');
  p = p || {};
  var cur = await findDevice(id);
  if (cur.status === 'retired' || cur.status === 'lost') fail('invalid', cur.device_tag + ' is ' + (cur.status === 'lost' ? 'lost' : 'retired') + '.');
  var emp = await findEmployee(p.employeeId);
  if (emp && emp.status === 'terminated') fail('invalid', emp.first_name + ' ' + emp.last_name + ' has left the company.');
  if (!emp && !cur.assigned_employee_id) fail('invalid', cur.device_tag + ' is not with anyone.');
  if (emp && emp.id === cur.assigned_employee_id) fail('invalid', cur.device_tag + ' is already with ' + emp.first_name + ' ' + emp.last_name + '.');
  var condition = p.condition ? V.oneOf(p.condition, CONDITIONS, 'Condition') : cur.condition;
  var location = has(p, 'location') ? String(p.location || '').trim().slice(0, 120) : (emp ? cur.location : (cur.location || 'IT store'));

  var res = await pool.query(
    'UPDATE it_devices SET assigned_employee_id = $1, assigned_at = $2, status = $3, condition = $4, location = $5, updated_at = now() WHERE id = $6 RETURNING *',
    [emp ? emp.id : null, emp ? new Date() : null, emp ? 'in_use' : (cur.status === 'under_repair' ? 'under_repair' : 'in_storage'), condition, location, id]
  );
  if (!emp) await logEvent(ctx, id, 'return', { employeeId: cur.assigned_employee_id, condition: condition, note: note(p.note) });
  else {
    if (cur.assigned_employee_id) await logEvent(ctx, id, 'return', { employeeId: cur.assigned_employee_id, condition: condition });
    await logEvent(ctx, id, 'assign', { employeeId: emp.id, note: note(p.note) });
  }
  await audit(pool, ctx, 'itdevice.assign', 'it_device', id, emp ? 'Handed ' + cur.device_tag + ' to ' + emp.first_name + ' ' + emp.last_name + '.' : cur.device_tag + ' returned to IT.');
  return rowToDevice(res.rows[0]);
}

// In for repair, back in use, retired, lost. A device that is retired or
// lost is no longer with anyone.
async function setStatus(ctx, id, p) {
  if (!ctx.can('itdevice.manage')) fail('forbidden', 'Your role does not allow this action (itdevice.manage).');
  p = p || {};
  var cur = await findDevice(id);
  var status = V.oneOf(p.status, STATUSES, 'Status');
  if (status === cur.status) return rowToDevice(cur);
  var drop = (status === 'retired' || status === 'lost' || status === 'in_storage') && cur.assigned_employee_id;
  var res = await pool.query(
    'UPDATE it_devices SET status = $1, assigned_employee_id = CASE WHEN $2 THEN NULL ELSE assigned_employee_id END, ' +
    'assigned_at = CASE WHEN $2 THEN NULL ELSE assigned_at END, updated_at = now() WHERE id = $3 RETURNING *',
    [status, !!drop, id]
  );
  if (drop) await logEvent(ctx, id, 'return', { employeeId: cur.assigned_employee_id });
  await logEvent(ctx, id, 'status', { status: status, note: note(p.note) });
  await audit(pool, ctx, 'itdevice.status', 'it_device', id, cur.device_tag + ' is now ' + status.replace('_', ' ') + '.');
  return rowToDevice(res.rows[0]);
}

// IT saw the device and it works: records the day, and its condition.
async function markChecked(ctx, id, p) {
  if (!ctx.can('itdevice.manage')) fail('forbidden', 'Your role does not allow this action (itdevice.manage).');
  p = p || {};
  var cur = await findDevice(id);
  var condition = p.condition ? V.oneOf(p.condition, CONDITIONS, 'Condition') : cur.condition;
  var res = await pool.query('UPDATE it_devices SET last_checked_on = $1, condition = $2, updated_at = now() WHERE id = $3 RETURNING *', [todayISO(), condition, id]);
  await logEvent(ctx, id, 'check', { condition: condition, employeeId: cur.assigned_employee_id, note: note(p.note) });
  await audit(pool, ctx, 'itdevice.check', 'it_device', id, 'Checked ' + cur.device_tag + '.');
  return rowToDevice(res.rows[0]);
}

module.exports = { list: list, history: history, create: create, update: update, assign: assign, setStatus: setStatus, markChecked: markChecked };
