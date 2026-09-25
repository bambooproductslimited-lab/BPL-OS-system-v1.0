// Projects: the list carries people with photos, the company code and task
// health; a project opens with its people and the tasks the viewer may see;
// managers can edit it, and people newly added are told.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var projects = require('../src/services/projects.service');
var tasks = require('../src/services/tasks.service');
var { buildContext } = require('../src/services/context.service');

var boss, projId, taskIds = [], memberId, newMemberId;

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  memberId = (await pool.query("SELECT id FROM employees WHERE email = 'samuel.kiptoo@bplghana.com'")).rows[0].id;
  newMemberId = (await pool.query("SELECT id FROM employees WHERE email = 'faith.wanjiru@bplghana.com'")).rows[0].id;
  var dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0];
  var p = await projects.create(boss, { name: 'Pjq Kiln upgrade', departmentId: dept.id, memberIds: [memberId], startDate: '2031-01-01', deadline: '2031-06-30', budget: 5000 });
  projId = p.id;
  var a = await tasks.create(boss, { title: 'Pjq order parts', projectId: projId, assigneeIds: [memberId], dueDate: '2020-01-01' });
  var b = await tasks.create(boss, { title: 'Pjq fit parts', projectId: projId, assigneeIds: [memberId], dueDate: '2031-03-01' });
  taskIds = [a.id, b.id];
  await tasks.setStatus(boss, b.id, 'completed');
});
test.after(async function () {
  await pool.query('DELETE FROM tasks WHERE id = ANY($1)', [taskIds]);
  await pool.query('DELETE FROM project_members WHERE project_id = $1', [projId]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projId]);
  await pool.query("DELETE FROM notifications WHERE body LIKE '%Pjq%'");
  await pool.end();
});

test('the list carries people, company and task health', async function () {
  var p = (await projects.list(boss, {})).find(function (x) { return x.id === projId; });
  assert.equal(p.companyCode, 'BPL');
  assert.deepEqual(p.members.map(function (m) { return m.id; }), [memberId]);
  assert.equal(p.taskCount, 2);
  assert.equal(p.doneCount, 1);
  assert.equal(p.overdueTaskCount, 1);
  assert.equal(p.nextTaskDue, '2020-01-01');
  assert.equal(p.budget, 5000);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND title = 'Added to a project' AND body LIKE '%Pjq Kiln upgrade%'", [memberId])).rows[0].n, 1);
});

test('a project opens with its tasks and can be edited', async function () {
  var p = await projects.get(boss, projId);
  assert.equal(p.tasks.length, 2);
  assert.equal(p.tasks.find(function (t) { return t.title === 'Pjq order parts'; }).overdue, true);
  assert.equal(p.tasks.find(function (t) { return t.title === 'Pjq fit parts'; }).status, 'completed');

  var u = await projects.update(boss, projId, { name: 'Pjq Kiln upgrade phase 1', memberIds: [memberId, newMemberId], deadline: '2031-07-31', budget: 6500, description: 'Fans and belts' });
  assert.equal(u.name, 'Pjq Kiln upgrade phase 1');
  assert.equal(u.deadline, '2031-07-31');
  assert.equal(u.budget, 6500);
  assert.equal(u.members.length, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND title = 'Added to a project'", [newMemberId])).rows[0].n >= 1, true);
  await assert.rejects(function () { return projects.update(boss, projId, { name: 'x', startDate: '2031-05-01', deadline: '2031-04-01' }); }, /deadline/);
});
