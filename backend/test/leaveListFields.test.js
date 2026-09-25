// The leave list carries what the leave page needs to scope and show each
// request: the company code, the department and company ids, whether the
// type is paid, and the employee's photo version.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var leave = require('../src/services/leave.service');
var { buildContext } = require('../src/services/context.service');

var ctx, empId, reqId;

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query("SELECT d.id, d.company_id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0];
  empId = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status, photo_key, photo_updated_at) " +
    "VALUES ('LVF-1', 'Lvf', 'Tester', 'lvf.tester@example.com', $1, 'Tester', 'permanent', '2020-01-01', 'active', 'db:00000000-0000-0000-0000-000000000001', '2031-05-06T07:08:09Z') RETURNING id", [dept.id]
  )).rows[0].id;
  var type = (await pool.query('SELECT id FROM leave_types WHERE paid LIMIT 1')).rows[0];
  reqId = (await pool.query(
    "INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES ($1, $2, '2032-02-02', '2032-02-03', 2, 'LVF', 'pending') RETURNING id",
    [empId, type.id]
  )).rows[0].id;
});
test.after(async function () {
  await pool.query('DELETE FROM leave_requests WHERE employee_id = $1', [empId]);
  await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
  await pool.end();
});

test('leave rows carry company, department, paid and photo', async function () {
  var rows = await leave.list(ctx, {});
  var r = rows.find(function (x) { return x.id === reqId; });
  assert.ok(r);
  assert.equal(r.companyCode, 'BPL');
  assert.ok(r.departmentId && r.companyId);
  assert.equal(r.paid, true);
  assert.equal(r.employeePhoto, new Date('2031-05-06T07:08:09Z').getTime());
  assert.equal(r.employeeName, 'Lvf Tester');
});
