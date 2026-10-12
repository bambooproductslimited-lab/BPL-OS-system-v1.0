// The Companies page overview: for each company and department, who is in
// today and still in now, on leave today, joined this year, the average
// years with us, the newest and longest-serving person, and a few faces.
// Runs on a throwaway company of its own.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var companies = require('../src/services/companies.service');
var { buildContext } = require('../src/services/context.service');

var boss, coId, deptId, emptyId, ids = [];
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  coId = (await pool.query("INSERT INTO companies (code, name, status) VALUES ('ZQO', 'Zqo Workshop', 'active') RETURNING id")).rows[0].id;
  deptId = (await pool.query("INSERT INTO departments (name, code, company_id, status) VALUES ('Zqo Makers', 'ZQOM', $1, 'active') RETURNING id", [coId])).rows[0].id;
  emptyId = (await pool.query("INSERT INTO departments (name, code, company_id, status) VALUES ('Zqo Empty', 'ZQOE', $1, 'active') RETURNING id", [coId])).rows[0].id;
  var year = new Date().getUTCFullYear();
  var people = [['ZQO-1', 'Ama', '2018-03-01'], ['ZQO-2', 'Kofi', '2022-06-15'], ['ZQO-3', 'Esi', year + '-01-02']];
  for (var i = 0; i < people.length; i++) {
    ids.push((await pool.query(
      "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status) VALUES ($1,$2,'Zqo',$3,$4,'Maker','permanent',$5,'active') RETURNING id",
      [people[i][0], 'Zq ' + people[i][1], people[i][0].toLowerCase() + '@example.com', deptId, people[i][2]])).rows[0].id);
  }
  await pool.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [ids[0], deptId]);
  // Kofi is in now; Ama came and went; Esi is on leave.
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status) VALUES ($1, CURRENT_DATE, '08:00', 'present')", [ids[1]]);
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status) VALUES ($1, CURRENT_DATE, '07:00', '07:30', 'present')", [ids[0]]);
  var type = (await pool.query('SELECT id FROM leave_types LIMIT 1')).rows[0].id;
  await pool.query("INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, status) VALUES ($1, $2, CURRENT_DATE - 1, CURRENT_DATE + 2, 4, 'approved')", [ids[2], type]);
});
test.after(async function () {
  await pool.query('DELETE FROM attendance WHERE employee_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM leave_requests WHERE employee_id = ANY($1)', [ids]);
  await pool.query('UPDATE departments SET manager_id = NULL WHERE id = $1', [deptId]);
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [ids]);
  await pool.query('DELETE FROM departments WHERE company_id = $1', [coId]);
  await pool.query('DELETE FROM companies WHERE id = $1', [coId]);
  await pool.end();
});

test('each company and department says who is in, on leave, new and how long people have been with us', async function () {
  var o = await companies.overview(boss);
  assert.equal(o.canSeeAttendance, true);
  var co = o.companies.find(function (c) { return c.code === 'ZQO'; });
  assert.deepEqual([co.people, co.inToday, co.inNow, co.onLeave, co.newThisYear], [3, 2, 1, 1, 1]);
  assert.ok(co.averageYears > 3 && co.averageYears < 6, 'average years ' + co.averageYears);
  assert.equal(co.newest.name, 'Zq Esi Zqo');
  assert.equal(co.longestServing.name, 'Zq Ama Zqo');
  var d = co.departments.find(function (x) { return x.id === deptId; });
  assert.deepEqual([d.headcount, d.inToday, d.inNow, d.onLeave, d.newThisYear, d.faces.length, d.hiddenPeople], [3, 2, 1, 1, 1, 3, 0]);
  assert.equal(d.managerName, 'Zq Ama Zqo');
  var e = co.departments.find(function (x) { return x.id === emptyId; });
  assert.deepEqual([e.headcount, e.faces.length, e.averageYears, e.inToday], [0, 0, null, 0]);
  assert.ok(o.totals.people >= 3 && o.totals.companies >= 1 && o.totals.departments >= 2);
});

test('without attendance.read.all nobody\'s day shows; without employee.read nothing does', async function () {
  var o = await companies.overview(limited(boss, ['attendance.read.all']));
  var co = o.companies.find(function (c) { return c.code === 'ZQO'; });
  assert.equal(o.canSeeAttendance, false);
  assert.deepEqual([co.inToday, co.inNow, co.people, co.onLeave], [null, null, 3, 1]);
  await assert.rejects(companies.overview(limited(boss, ['employee.read'])), /employee.read/);
});
