var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// kernel.js: handlers['departments.list']
async function list(ctx) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var res = await pool.query(
    'SELECT d.id, d.code, d.name, d.status, d.company_id, c.name AS company_name, m.first_name AS mgr_first, m.last_name AS mgr_last, ' +
    '(SELECT count(*)::int FROM employees e WHERE e.department_id = d.id AND e.status = \'active\') AS headcount ' +
    'FROM departments d JOIN companies c ON c.id = d.company_id LEFT JOIN employees m ON m.id = d.manager_id ORDER BY d.name'
  );
  return res.rows.map(function (d) {
    return {
      id: d.id, code: d.code, name: d.name, status: d.status,
      companyId: d.company_id, companyName: d.company_name,
      managerName: d.mgr_first ? d.mgr_first + ' ' + d.mgr_last : '—',
      headcount: d.headcount
    };
  });
}

// kernel.js: handlers['departments.save'] — companyId is required on create
// (a department must belong to a company from the moment it exists) but
// left alone on update unless explicitly passed, so editing a department's
// name/code/manager doesn't require re-sending its company every time.
async function save(ctx, id, p) {
  if (!ctx.can('department.manage')) fail('forbidden', 'Your role does not allow this action (department.manage).');
  var name = V.text(p.name, 'Department name', 60);
  var code = V.text(p.code, 'Code', 5).toUpperCase();

  var res;
  if (id) {
    if (p.companyId) {
      var companyRes = await pool.query('SELECT id FROM companies WHERE id = $1', [p.companyId]);
      if (!companyRes.rows[0]) fail('invalid', 'Company is not a valid option.');
      res = await pool.query(
        'UPDATE departments SET name = $1, code = $2, manager_id = $3, company_id = $4, updated_at = now() WHERE id = $5 RETURNING *',
        [name, code, p.managerId || null, p.companyId, id]
      );
    } else {
      res = await pool.query(
        'UPDATE departments SET name = $1, code = $2, manager_id = $3, updated_at = now() WHERE id = $4 RETURNING *',
        [name, code, p.managerId || null, id]
      );
    }
    if (!res.rows[0]) fail('notfound', 'Department not found.');
  } else {
    var newCompanyRes = await pool.query('SELECT id FROM companies WHERE id = $1', [p.companyId]);
    if (!newCompanyRes.rows[0]) fail('invalid', 'Company is not a valid option.');
    res = await pool.query(
      "INSERT INTO departments (name, code, manager_id, company_id, status) VALUES ($1,$2,$3,$4,'active') RETURNING *",
      [name, code, p.managerId || null, p.companyId]
    );
  }
  var d = res.rows[0];
  await audit(pool, ctx, 'department.save', 'department', d.id, 'Saved department ' + d.code + ' — ' + d.name + '.');
  return { id: d.id, code: d.code, name: d.name, managerId: d.manager_id, companyId: d.company_id, status: d.status };
}

// kernel.js: handlers['departments.delete']
async function remove(ctx, id) {
  if (!ctx.can('department.manage')) fail('forbidden', 'Your role does not allow this action (department.manage).');
  var res = await pool.query('SELECT * FROM departments WHERE id = $1', [id]);
  var d = res.rows[0];
  if (!d) fail('notfound', 'Department not found.');

  var headcountRes = await pool.query("SELECT count(*)::int AS n FROM employees WHERE department_id = $1 AND status != 'terminated'", [id]);
  var headcount = headcountRes.rows[0].n;
  if (headcount > 0) fail('conflict', 'Cannot delete ' + d.name + ' — ' + headcount + ' employee(s) are still assigned to it. Reassign them first.');

  await pool.query('DELETE FROM departments WHERE id = $1', [id]);
  await audit(pool, ctx, 'department.delete', 'department', id, 'Deleted department ' + d.code + ' — ' + d.name + '.');
  return true;
}

module.exports = { list: list, save: save, remove: remove };
