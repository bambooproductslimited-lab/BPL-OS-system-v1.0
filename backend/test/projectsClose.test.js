// Closing projects: one set to close itself does so once all its work
// orders are done (none open, at least one completed) and reopens when one
// is open again or a new one is added; one set to close by hand never
// closes itself; closing by hand can cancel the work orders still open,
// and a project closed by hand stays closed.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var projects = require('../src/services/projects.service');
var tasks = require('../src/services/tasks.service');
var { buildContext } = require('../src/services/context.service');

var boss, alice, deptId, ownerId, projIds = [];

async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function project(name, extra) {
  var p = await projects.create(boss, Object.assign({ name: name, departmentId: deptId, ownerId: ownerId, startDate: '2031-01-01', deadline: '2031-06-30' }, extra || {}));
  projIds.push(p.id);
  await projects.setStatus(boss, p.id, 'active');
  return p;
}
async function wo(title, projectId) { return tasks.create(boss, { title: title, projectId: projectId, issuedOn: '2031-01-02', dueDate: '2031-01-09' }); }
async function statusOf(id) { return (await pool.query('SELECT status, closed_auto, closed_by, closed_at FROM projects WHERE id = $1', [id])).rows[0]; }
async function told(title, like) {
  return (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND title = $2 AND body LIKE $3', [ownerId, title, '%' + like + '%'])).rows[0].n;
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  alice = await ctxFor('alice.kamau@bplghana.com');
  ownerId = (await pool.query("SELECT id FROM employees WHERE email = 'faith.wanjiru@bplghana.com'")).rows[0].id;
  deptId = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0].id;
});
test.after(async function () {
  if (projIds.length) {
    await pool.query('DELETE FROM tasks WHERE project_id = ANY($1)', [projIds]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1)', [projIds]);
  }
  await pool.query("DELETE FROM tasks WHERE title LIKE 'Zqcl %'");
  await pool.query("DELETE FROM notifications WHERE body LIKE '%Zqcl%'");
  await pool.end();
});

test('a project closes itself when its work orders are done, and reopens when work starts again', async function () {
  var p = await project('Zqcl Bar refit');
  assert.equal(p.autoClose, true);                                  // new projects close themselves
  var a = await wo('Zqcl counter', p.id), b = await wo('Zqcl stools', p.id);

  var first = await tasks.setStatus(boss, a.id, 'completed');
  assert.deepEqual(first.projectChanges, []);
  assert.equal((await statusOf(p.id)).status, 'active');           // one still open

  var last = await tasks.setStatus(boss, b.id, 'cancelled');        // none open, one completed
  assert.equal(last.projectChanges.length, 1);
  assert.equal(last.projectChanges[0].change, 'closed');
  var closed = await statusOf(p.id);
  assert.equal(closed.status, 'completed');
  assert.equal(closed.closed_auto, true);
  assert.ok(closed.closed_at);
  assert.equal(await told('Project completed', 'Zqcl Bar refit'), 1);
  var shown = await projects.get(boss, p.id);
  assert.equal(shown.closedAuto, true);
  assert.equal(shown.closedByName, null);

  // Work starts again: it reopens.
  var again = await tasks.setStatus(boss, a.id, 'in_progress');
  assert.equal(again.projectChanges[0].change, 'reopened');
  assert.equal((await statusOf(p.id)).status, 'active');
  assert.equal(await told('Project reopened', 'Zqcl Bar refit'), 1);

  // Done again, then a new work order for it: closed, then open again.
  await tasks.setStatus(boss, a.id, 'completed');
  assert.equal((await statusOf(p.id)).status, 'completed');
  var c = await wo('Zqcl menu boards', p.id);
  assert.equal(c.projectChanges[0].change, 'reopened');
  // Deleting the one left open closes it.
  var gone = await tasks.remove(boss, c.id);
  assert.equal(gone.projectChanges[0].change, 'closed');
  // Moving an open work order into it reopens it; moving it out closes it.
  var d = await wo('Zqcl spare', null);
  var moved = await tasks.setProject(boss, [d.id], p.id);
  assert.equal(moved.projectChanges[0].change, 'reopened');
  var out = await tasks.setProject(boss, [d.id], null);
  assert.equal(out.projectChanges[0].change, 'closed');
});

test('a project set to close by hand waits; closing it can cancel what is still open, and it stays closed', async function () {
  var p = await project('Zqcl Pergola', { autoClose: false });
  assert.equal(p.autoClose, false);
  var a = await wo('Zqcl poles', p.id), b = await wo('Zqcl roof', p.id), c = await wo('Zqcl varnish', p.id);
  await tasks.setStatus(boss, a.id, 'completed');
  await tasks.setStatus(boss, b.id, 'completed');
  await tasks.setStatus(boss, c.id, 'completed');
  assert.equal((await statusOf(p.id)).status, 'active');           // all done, but it waits to be closed
  var listed = (await projects.list(boss, {})).find(function (x) { return x.id === p.id; });
  assert.equal(listed.taskCount, listed.doneCount);                 // the screen shows it ready to close

  // Turning "close by itself" on closes it at once.
  var on = await projects.update(boss, p.id, { name: 'Zqcl Pergola', autoClose: true });
  assert.equal(on.status, 'completed');
  assert.equal(on.projectChanges[0].change, 'closed');

  // Closing by hand, with work orders still open.
  var q = await project('Zqcl Showroom', { autoClose: false });
  var x = await wo('Zqcl shelves', q.id), y = await wo('Zqcl lights', q.id), z = await wo('Zqcl sign', q.id);
  await tasks.setStatus(boss, x.id, 'completed');
  await assert.rejects(projects.close(alice, q.id, {}), /not allow/);
  var closed = await projects.close(boss, q.id, { cancelOpen: true });
  assert.equal(closed.status, 'completed');
  assert.equal(closed.cancelledWorkOrders, 2);
  assert.equal(closed.closedAuto, false);
  assert.equal(closed.closedBy, boss.employee.id);
  assert.equal(closed.closedByName.split(' ')[0], 'Kelvin');
  assert.equal((await tasks.get(boss, y.id)).status, 'cancelled');
  assert.equal((await tasks.get(boss, z.id)).status, 'cancelled');
  assert.equal(await told('Project completed', 'Zqcl Showroom was closed by'), 1);
  await assert.rejects(projects.close(boss, q.id, {}), /already closed/);

  // Closed by hand, so opening a work order in it again does not reopen it.
  var reopened = await tasks.setStatus(boss, y.id, 'in_progress');
  assert.deepEqual(reopened.projectChanges, []);
  assert.equal((await statusOf(q.id)).status, 'completed');

  // Closing by hand leaving the open ones as they are.
  var r = await project('Zqcl Kiosk', { autoClose: false });
  var k = await wo('Zqcl kiosk roof', r.id);
  var left = await projects.close(boss, r.id, { cancelOpen: false });
  assert.equal(left.cancelledWorkOrders, 0);
  assert.equal((await tasks.get(boss, k.id)).status, 'not_started');
  // Reopened by hand through its status: no longer closed.
  var back = await projects.setStatus(boss, r.id, 'active');
  assert.equal(back.closedAt, null);
});
