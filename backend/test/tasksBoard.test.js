// Tasks: the list carries each assignee's name and photo and their
// companies; completing a task records when (and reopening clears it); the
// task's creator hears when someone else sends it for review or completes
// it; people newly added to a task hear about it.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var tasks = require('../src/services/tasks.service');
var { buildContext } = require('../src/services/context.service');

var boss, worker, taskId, bossId, workerId, helperId;

async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function notes(employeeId, title) {
  return (await pool.query('SELECT title, body FROM notifications WHERE employee_id = $1 AND title = $2 AND body LIKE $3', [employeeId, title, '%Tbq%'])).rows;
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  worker = await ctxFor('samuel.kiptoo@bplghana.com');
  bossId = boss.employee.id; workerId = worker.employee.id;
  helperId = (await pool.query("SELECT id FROM employees WHERE email = 'faith.wanjiru@bplghana.com'")).rows[0].id;
  await pool.query("UPDATE employees SET photo_key = 'db:00000000-0000-0000-0000-00000000000b', photo_updated_at = '2031-07-08T09:10:11Z' WHERE id = $1", [workerId]);
});
test.after(async function () {
  if (taskId) await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
  await pool.query("DELETE FROM notifications WHERE body LIKE '%Tbq%' OR title LIKE '%Tbq%'");
  await pool.query('UPDATE employees SET photo_key = NULL, photo_updated_at = NULL WHERE id = $1', [workerId]);
  await pool.end();
});

test('assignees come with photos and companies; completing records when and tells the creator', async function () {
  var created = await tasks.create(boss, { title: 'Tbq check the kiln', assigneeIds: [workerId], dueDate: '2031-01-10', priority: 'high' });
  taskId = created.id;
  assert.equal(created.assignees[0].id, workerId);
  assert.equal(created.createdByName.split(' ')[0], 'Kelvin');

  var row = (await tasks.list(boss, { scope: 'all' })).find(function (t) { return t.id === taskId; });
  assert.equal(row.assignees[0].photo, new Date('2031-07-08T09:10:11Z').getTime());
  assert.deepEqual(row.companyCodes, ['BPL']);
  assert.equal(row.departmentIds.length, 1);
  assert.equal(row.completedAt, null);

  await tasks.setStatus(worker, taskId, 'under_review');
  assert.equal((await notes(bossId, 'Task ready for review')).length, 1);

  var done = await tasks.setStatus(worker, taskId, 'completed');
  assert.ok(done.completedAt);
  assert.equal((await notes(bossId, 'Task completed')).length, 1);

  var reopened = await tasks.setStatus(boss, taskId, 'in_progress');
  assert.equal(reopened.completedAt, null);
});

test('people newly added to a task are told', async function () {
  var t = await tasks.get(boss, taskId);
  await tasks.update(boss, taskId, { title: t.title, projectId: t.projectId, assigneeIds: [workerId, helperId], priority: t.priority, dueDate: t.dueDate, description: t.description });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND title = 'New task assigned' AND body = 'Tbq check the kiln'", [helperId])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND title = 'New task assigned' AND body = 'Tbq check the kiln'", [workerId])).rows[0].n, 1);
});
