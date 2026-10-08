// An employee's hire date can be fixed after they are added: people added
// from a list or the clock got the day they were added.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var employees = require('../src/services/employees.service');
var { buildContext } = require('../src/services/context.service');

var boss, dept, ids = [];
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0].id;
});
test.after(async function () {
  await pool.query('DELETE FROM leave_balances WHERE employee_id = ANY($1::uuid[])', [ids]).catch(function () {});
  await pool.query('DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])', [ids]).catch(function () {});
  await pool.query('DELETE FROM employees WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

test('the hire date can be changed, checked, and is noted in the audit log', async function () {
  var a = await employees.create(boss, { firstName: 'Zqh', lastName: 'One', email: 'zqh.one@example.com', departmentId: dept, positionTitle: 'Zq weaver', employmentType: 'permanent' });
  ids.push(a.id);
  assert.equal(String(a.hireDate).slice(0, 10), new Date().toISOString().slice(0, 10), 'left out, it is the day they were added');

  var b = await employees.update(boss, a.id, { hireDate: '2019-03-11' });
  assert.equal(String(b.hireDate).slice(0, 10), '2019-03-11');
  var row = (await pool.query('SELECT hire_date FROM employees WHERE id = $1', [a.id])).rows[0];
  assert.equal(String(row.hire_date).slice(0, 10), '2019-03-11');
  var log = (await pool.query("SELECT summary FROM audit_logs WHERE entity_id = $1 AND action = 'employee.update' ORDER BY at DESC LIMIT 1", [a.id])).rows[0];
  assert.match(log.summary, /hireDate/);

  await assert.rejects(employees.update(boss, a.id, { hireDate: '' }), /Hire date is required/);
  await assert.rejects(employees.update(boss, a.id, { hireDate: '2019-02-30' }), /valid date/);
  await assert.rejects(employees.update(boss, a.id, { hireDate: '1919-03-11' }), /check the year/);
  var farAhead = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  await assert.rejects(employees.update(boss, a.id, { hireDate: farAhead }), /check the year/);
  await assert.rejects(employees.create(boss, { firstName: 'Zqh', lastName: 'Two', email: 'zqh.two@example.com', departmentId: dept, positionTitle: 'Zq weaver', hireDate: '2091-01-01' }), /check the year/);

  // Saving the form unchanged leaves it alone.
  await employees.update(boss, a.id, { hireDate: '2019-03-11', firstName: 'Zqh' });
  var last = (await pool.query("SELECT summary FROM audit_logs WHERE entity_id = $1 AND action = 'employee.update' ORDER BY at DESC LIMIT 1", [a.id])).rows[0];
  assert.doesNotMatch(last.summary, /hireDate/);
});

test('without employee.write the hire date cannot be changed', async function () {
  var ro = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (p) { return p !== 'employee.write' && boss.can(p); } });
  await assert.rejects(employees.update(ro, ids[0], { hireDate: '2018-01-01' }), /employee.write/);
});
