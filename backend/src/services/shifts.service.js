var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// Named shift templates, scoped to a department (migration 0032). Listed
// either for one department (the Companies page's "manage shifts" panel)
// or across all departments (the Employees dialog's shift picker, filtered
// client-side to the selected department).
async function list(ctx, departmentId) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var params = [];
  var where = '';
  if (departmentId) { params.push(departmentId); where = 'WHERE s.department_id = $1'; }
  var res = await pool.query(
    'SELECT s.*, d.name AS department_name, ' +
    '(SELECT count(*)::int FROM employees e WHERE e.shift_id = s.id AND e.status != \'terminated\') AS assigned_count ' +
    'FROM shifts s JOIN departments d ON d.id = s.department_id ' + where + ' ORDER BY d.name, s.start_time',
    params
  );
  return res.rows.map(function (s) {
    return {
      id: s.id, departmentId: s.department_id, departmentName: s.department_name, name: s.name,
      startTime: s.start_time.slice(0, 5), endTime: s.end_time.slice(0, 5), status: s.status,
      assignedCount: s.assigned_count
    };
  });
}

async function save(ctx, id, p) {
  if (!ctx.can('department.manage')) fail('forbidden', 'Your role does not allow this action (department.manage).');
  var name = V.text(p.name, 'Shift name', 40);
  var startTime = V.time(p.startTime, 'Start time');
  var endTime = V.time(p.endTime, 'End time');

  var res;
  if (id) {
    var deptRes = await pool.query('SELECT department_id FROM shifts WHERE id = $1', [id]);
    if (!deptRes.rows[0]) fail('notfound', 'Shift not found.');
    res = await pool.query(
      'UPDATE shifts SET name = $1, start_time = $2, end_time = $3, updated_at = now() WHERE id = $4 RETURNING *',
      [name, startTime, endTime, id]
    );
  } else {
    var departmentId = p.departmentId;
    var deptExists = await pool.query('SELECT id FROM departments WHERE id = $1', [departmentId]);
    if (!deptExists.rows[0]) fail('invalid', 'Department is not a valid option.');
    res = await pool.query(
      "INSERT INTO shifts (department_id, name, start_time, end_time, status) VALUES ($1,$2,$3,$4,'active') RETURNING *",
      [departmentId, name, startTime, endTime]
    );
  }
  var s = res.rows[0];
  await audit(pool, ctx, 'shift.save', 'shift', s.id, 'Saved shift ' + s.name + '.');
  return {
    id: s.id, departmentId: s.department_id, name: s.name,
    startTime: s.start_time.slice(0, 5), endTime: s.end_time.slice(0, 5), status: s.status
  };
}

async function remove(ctx, id) {
  if (!ctx.can('department.manage')) fail('forbidden', 'Your role does not allow this action (department.manage).');
  var res = await pool.query('SELECT * FROM shifts WHERE id = $1', [id]);
  var s = res.rows[0];
  if (!s) fail('notfound', 'Shift not found.');

  var assignedRes = await pool.query("SELECT count(*)::int AS n FROM employees WHERE shift_id = $1 AND status != 'terminated'", [id]);
  if (assignedRes.rows[0].n > 0) fail('conflict', 'Cannot delete ' + s.name + ' — ' + assignedRes.rows[0].n + ' employee(s) are still assigned to it. Reassign them first.');

  await pool.query('DELETE FROM shifts WHERE id = $1', [id]);
  await audit(pool, ctx, 'shift.delete', 'shift', id, 'Deleted shift ' + s.name + '.');
  return true;
}

module.exports = { list: list, save: save, remove: remove };
