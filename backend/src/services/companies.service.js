var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// Companies are the new top-level org unit — "Group" in the UI becomes
// "Company" (see migration 0032). Departments belong to exactly one
// company; this service returns companies with their departments nested
// (each department carrying its headcount and shift count), matching the
// same "expandable parent → children" shape Catalog uses for
// items/variations, since the frontend reuses that same UI pattern.

async function list(ctx) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var companiesRes = await pool.query('SELECT * FROM companies ORDER BY name');
  var deptsRes = await pool.query(
    'SELECT d.id, d.company_id, d.code, d.name, d.status, d.manager_id, m.first_name AS mgr_first, m.last_name AS mgr_last, ' +
    'm.photo_key AS mgr_photo_key, m.photo_updated_at AS mgr_photo_at, ' +
    '(SELECT count(*)::int FROM employees e WHERE e.department_id = d.id AND e.status = \'active\') AS headcount, ' +
    '(SELECT count(*)::int FROM shifts s WHERE s.department_id = d.id AND s.status = \'active\') AS shift_count ' +
    'FROM departments d LEFT JOIN employees m ON m.id = d.manager_id ORDER BY d.name'
  );
  // The shift times of each department, and how many people each is
  // assigned to, so the page can show them without opening every one.
  var shiftsRes = await pool.query(
    "SELECT s.id, s.department_id, s.name, to_char(s.start_time, 'HH24:MI') AS start_time, to_char(s.end_time, 'HH24:MI') AS end_time, " +
    "(SELECT count(*)::int FROM employees e WHERE e.shift_id = s.id AND e.status <> 'terminated') AS assigned " +
    "FROM shifts s WHERE s.status = 'active' ORDER BY s.start_time, s.name"
  );
  var shiftsByDept = {};
  shiftsRes.rows.forEach(function (s) {
    if (!shiftsByDept[s.department_id]) shiftsByDept[s.department_id] = [];
    shiftsByDept[s.department_id].push({ id: s.id, name: s.name, startTime: s.start_time, endTime: s.end_time, assignedCount: s.assigned });
  });
  var deptsByCompany = {};
  deptsRes.rows.forEach(function (d) {
    if (!deptsByCompany[d.company_id]) deptsByCompany[d.company_id] = [];
    deptsByCompany[d.company_id].push({
      id: d.id, code: d.code, name: d.name, status: d.status,
      managerId: d.manager_id,
      managerName: d.mgr_first ? d.mgr_first + ' ' + d.mgr_last : '—',
      managerPhoto: d.mgr_photo_key && d.mgr_photo_at ? new Date(d.mgr_photo_at).getTime() : null,
      headcount: d.headcount, shiftCount: d.shift_count,
      shifts: shiftsByDept[d.id] || []
    });
  });
  return companiesRes.rows.map(function (c) {
    return { id: c.id, code: c.code, name: c.name, status: c.status, departments: deptsByCompany[c.id] || [] };
  });
}

async function save(ctx, id, p) {
  if (!ctx.can('department.manage')) fail('forbidden', 'Your role does not allow this action (department.manage).');
  var name = V.text(p.name, 'Company name', 80);
  var code = V.text(p.code, 'Code', 8).toUpperCase();

  var res;
  if (id) {
    res = await pool.query('UPDATE companies SET name = $1, code = $2, updated_at = now() WHERE id = $3 RETURNING *', [name, code, id]);
    if (!res.rows[0]) fail('notfound', 'Company not found.');
  } else {
    res = await pool.query("INSERT INTO companies (name, code, status) VALUES ($1,$2,'active') RETURNING *", [name, code]);
  }
  var c = res.rows[0];
  await audit(pool, ctx, 'company.save', 'company', c.id, 'Saved company ' + c.code + ' — ' + c.name + '.');
  return { id: c.id, code: c.code, name: c.name, status: c.status };
}

async function remove(ctx, id) {
  if (!ctx.can('department.manage')) fail('forbidden', 'Your role does not allow this action (department.manage).');
  var res = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
  var c = res.rows[0];
  if (!c) fail('notfound', 'Company not found.');

  var deptCountRes = await pool.query('SELECT count(*)::int AS n FROM departments WHERE company_id = $1', [id]);
  if (deptCountRes.rows[0].n > 0) fail('conflict', 'Cannot delete ' + c.name + ' — it still has department(s). Remove or reassign them first.');

  await pool.query('DELETE FROM companies WHERE id = $1', [id]);
  await audit(pool, ctx, 'company.delete', 'company', id, 'Deleted company ' + c.code + ' — ' + c.name + '.');
  return true;
}

module.exports = { list: list, save: save, remove: remove };
