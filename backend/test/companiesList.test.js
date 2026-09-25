// The companies list: each department carries its manager's id (so editing
// a department keeps its manager) and its shift times with how many people
// each is assigned to.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var companies = require('../src/services/companies.service');
var { buildContext } = require('../src/services/context.service');

var ctx, deptId, empId, shiftId;

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var co = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0];
  empId = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status) " +
    "SELECT 'CLT-1', 'Colt', 'Tester', 'colt.tester@example.com', id, 'Tester', 'permanent', '2020-01-01', 'active' FROM departments WHERE company_id = $1 LIMIT 1 RETURNING id", [co.id]
  )).rows[0].id;
  deptId = (await pool.query("INSERT INTO departments (name, code, manager_id, company_id, status) VALUES ('Colt Dept', 'CLTD', $1, $2, 'active') RETURNING id", [empId, co.id])).rows[0].id;
  shiftId = (await pool.query("INSERT INTO shifts (department_id, name, start_time, end_time, status) VALUES ($1, 'Colt Early', '06:30', '14:30', 'active') RETURNING id", [deptId])).rows[0].id;
  await pool.query('UPDATE employees SET department_id = $1, shift_id = $2 WHERE id = $3', [deptId, shiftId, empId]);
});
test.after(async function () {
  await pool.query('UPDATE employees SET shift_id = NULL WHERE id = $1', [empId]);
  await pool.query('UPDATE departments SET manager_id = NULL WHERE id = $1', [deptId]);
  await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM departments WHERE id = $1', [deptId]);
  await pool.end();
});

test('departments carry their manager id and shift times', async function () {
  var list = await companies.list(ctx);
  var dept = list.find(function (c) { return c.code === 'BPL'; }).departments.find(function (d) { return d.id === deptId; });
  assert.equal(dept.managerId, empId);
  assert.equal(dept.managerName, 'Colt Tester');
  assert.equal(dept.headcount, 1);
  assert.deepEqual(dept.shifts.map(function (s) { return [s.name, s.startTime, s.endTime, s.assignedCount]; }), [['Colt Early', '06:30', '14:30', 1]]);
});
