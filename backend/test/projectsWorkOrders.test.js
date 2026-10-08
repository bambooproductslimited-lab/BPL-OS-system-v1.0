// Projects and work orders: who a project is for (one of our companies, a
// customer on file, or a name); how its work orders went (completed, on
// time, days to close, labour); and work orders put into a project, or
// taken out of it, several at once.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var projects = require('../src/services/projects.service');
var tasks = require('../src/services/tasks.service');
var { buildContext } = require('../src/services/context.service');

var boss, alice, deptId, projIds = [], woIds = [], customerId;

async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  alice = await ctxFor('alice.kamau@bplghana.com');
  deptId = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0].id;
  customerId = (await pool.query("INSERT INTO customers (name) VALUES ('Zqpw Riverside Hotel') RETURNING id")).rows[0].id;
});
test.after(async function () {
  if (woIds.length) await pool.query('DELETE FROM tasks WHERE id = ANY($1)', [woIds]);
  if (projIds.length) await pool.query('DELETE FROM projects WHERE id = ANY($1)', [projIds]);
  await pool.query('DELETE FROM customers WHERE id = $1', [customerId]);
  await pool.query("DELETE FROM notifications WHERE body LIKE '%Zqpw%'");
  await pool.end();
});

test('a project says who it is for: our company, a customer on file, or a name', async function () {
  var poki = (await pool.query("SELECT id FROM companies WHERE code = 'PKI'")).rows[0].id;
  var a = await projects.create(boss, { name: 'Zqpw Poki fit-out', departmentId: deptId, forCompanyId: poki, startDate: '2031-01-01', deadline: '2031-03-01' });
  var b = await projects.create(boss, { name: 'Zqpw Hotel pergola', departmentId: deptId, customerName: 'zqpw riverside hotel', startDate: '2031-01-01', deadline: '2031-03-01' });
  var c = await projects.create(boss, { name: 'Zqpw Lodge', departmentId: deptId, customerName: 'Zqpw Coastal Lodge', startDate: '2031-01-01', deadline: '2031-03-01' });
  projIds.push(a.id, b.id, c.id);
  assert.notEqual(a.code, b.code);
  var list = await projects.list(boss, {});
  function row(id) { return list.find(function (p) { return p.id === id; }); }
  assert.equal(row(a.id).requestedFor, 'Poki');
  assert.equal(row(a.id).forCompanyId, poki);
  assert.equal(row(b.id).customerId, customerId);                 // matched to the customer on file
  assert.equal(row(b.id).requestedFor, 'Zqpw Riverside Hotel');
  assert.equal(row(c.id).customerId, null);                        // no such customer: kept as written
  assert.equal(row(c.id).requestedFor, 'Zqpw Coastal Lodge');

  // Editing without mentioning it keeps it; naming a customer replaces the company.
  var kept = await projects.update(boss, a.id, { name: 'Zqpw Poki fit-out, phase 1' });
  assert.equal(kept.requestedFor, 'Poki');
  var moved = await projects.update(boss, a.id, { name: 'Zqpw Poki fit-out, phase 1', forCompanyId: null, customerName: 'Zqpw Riverside Hotel' });
  assert.equal(moved.forCompanyId, null);
  assert.equal(moved.customerId, customerId);
  await assert.rejects(projects.update(boss, a.id, { name: 'x', forCompanyId: '00000000-0000-0000-0000-000000000000' }), /company was not found/);
});

test('work orders go into a project several at once, and its figures say how they went', async function () {
  var proj = projIds[1];
  var w1 = await tasks.create(boss, { title: 'Zqpw cut the poles', issuedOn: '2031-01-05', dueDate: '2031-01-07', workers: 2, workDays: 1.5 });
  var w2 = await tasks.create(boss, { title: 'Zqpw build the frame', issuedOn: '2031-01-05', dueDate: '2031-01-06' });
  var w3 = await tasks.create(boss, { title: 'Zqpw varnish', issuedOn: '2031-01-08', dueDate: '2031-01-10' });
  woIds.push(w1.id, w2.id, w3.id);
  await pool.query('UPDATE tasks SET workers = 2, work_days = 1.5 WHERE id = $1', [w1.id]);
  await pool.query('UPDATE tasks SET workers = 3, work_days = 2 WHERE id = $1', [w2.id]);

  // Only someone who may issue WOs, and only real WOs and projects.
  await assert.rejects(tasks.setProject(alice, [w1.id], proj), /not allow/);
  await assert.rejects(tasks.setProject(boss, [], proj), /Pick the work orders/);
  await assert.rejects(tasks.setProject(boss, [w1.id, '00000000-0000-0000-0000-000000000000'], proj), /not found/);
  await assert.rejects(tasks.setProject(boss, [w1.id], '00000000-0000-0000-0000-000000000000'), /project was not found/);

  var r = await tasks.setProject(boss, [w1.id, w2.id, w3.id], proj);
  assert.equal(r.updated, 3);
  assert.equal(r.project.id, proj);
  assert.equal((await tasks.get(boss, w1.id)).projectId, proj);
  assert.equal((await tasks.setProject(boss, [w1.id], proj)).updated, 0);   // already there

  // w1 on time in 2 days, w2 a day late in 2 days; w3 still open.
  await pool.query("UPDATE tasks SET status = 'completed', completed_at = '2031-01-07T15:00:00Z' WHERE id = ANY($1)", [[w1.id, w2.id]]);
  var p = await projects.get(boss, proj);
  assert.equal(p.figures.completed, 2);
  assert.equal(p.figures.onTimePct, 50);
  assert.equal(p.figures.avgDaysToClose, 2);
  assert.equal(p.figures.personDays, 9);                                     // 2 × 1.5 + 3 × 2
  assert.equal(p.figures.labourWos, 2);
  assert.equal(p.tasks.length, 3);
  var listed = (await projects.list(boss, {})).find(function (x) { return x.id === proj; });
  assert.deepEqual(listed.figures, p.figures);

  // Out of the project again.
  assert.equal((await tasks.setProject(boss, [w3.id], null)).updated, 1);
  assert.equal((await tasks.get(boss, w3.id)).projectId, null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'task.project' AND summary LIKE '%Zqpw Hotel pergola%'")).rows[0].n, 1);
});
