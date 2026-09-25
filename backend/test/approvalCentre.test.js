// The Approval centre: each waiting request carries the facts needed to
// decide it (leave dates, balance left and who else is away; purchase item
// and cost; claim amount and receipt), nobody sees their own, and the
// history lists what was decided lately with who decided, the note given
// and how long it waited. Test data uses the Zqa prefix and 2031 dates.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var approvals = require('../src/services/approvals.service');
var expenses = require('../src/services/expenses.service');
var procurement = require('../src/services/procurement.service');
var { buildContext } = require('../src/services/context.service');

var kelvin, alice, colleague, typeId;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function cleanup() {
  var ids = "SELECT id FROM leave_requests WHERE reason LIKE 'Zqa%' UNION SELECT id FROM expenses WHERE description LIKE 'Zqa%' UNION SELECT id FROM procurement_requests WHERE item LIKE 'Zqa%'";
  await pool.query('DELETE FROM approvals WHERE subject_id IN (' + ids + ')');
  await pool.query("DELETE FROM leave_requests WHERE reason LIKE 'Zqa%'");
  await pool.query("DELETE FROM expenses WHERE description LIKE 'Zqa%'");
  await pool.query("DELETE FROM procurement_requests WHERE item LIKE 'Zqa%'");
  await pool.query("DELETE FROM notifications WHERE body LIKE '%Zqa%'");
}
async function leave(emp, start, end, days, status, reason) {
  var lr = (await pool.query(
    'INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [emp.id, typeId, start, end, days, reason, status])).rows[0];
  if (status === 'pending') {
    await pool.query("INSERT INTO approvals (subject_type, subject_id, title, requested_by, assignee_permission, department_id, created_at) VALUES ('leave_request', $1, 'Leave request', $2, 'leave.approve', $3, now() - interval '50 hours')", [lr.id, emp.id, emp.department_id]);
  }
  return lr;
}
test.before(async function () {
  await cleanup();
  kelvin = await ctxFor('kelvin.duho@bplghana.com');
  alice = await ctxFor('alice.kamau@bplghana.com');
  colleague = (await pool.query('SELECT * FROM employees WHERE department_id = $1 AND id <> $2 LIMIT 1', [alice.employee.department_id, alice.employee.id])).rows[0];
  typeId = (await pool.query('SELECT id FROM leave_types WHERE active ORDER BY name LIMIT 1')).rows[0].id;
});
test.after(async function () { await cleanup(); await pool.end(); });
function find(list, subjectId) { return list.find(function (x) { return x.subjectId === subjectId; }); }

test('the queue carries the facts to decide each kind of request', async function () {
  var lr = await leave(alice.employee, '2031-03-03', '2031-03-05', 3, 'pending', 'Zqa family visit');
  if (colleague) await leave(colleague, '2031-03-05', '2031-03-07', 3, 'approved', 'Zqa colleague away');
  var claim = await expenses.create(alice, { category: 'Zqa Fuel', amount: 75, description: 'Zqa trip to the farm' });
  var pr = await procurement.create(alice, { item: 'Zqa machete', quantity: 4, estimatedPrice: 320, reason: 'Zqa harvest', priority: 'high', requiredDate: '2031-04-01' });

  var q = await approvals.queue(kelvin, {});
  var l = find(q, lr.id);
  assert.equal(l.requesterName, alice.employee.first_name + ' ' + alice.employee.last_name);
  assert.equal(l.reason, 'Zqa family visit');
  assert.equal(l.facts.days, 3);
  assert.equal(l.facts.startDate, '2031-03-03');
  if (colleague) assert.deepEqual(l.facts.awayThen.map(function (x) { return [x.name, x.status]; }), [[colleague.first_name + ' ' + colleague.last_name, 'approved']]);
  assert.ok(new Date(l.createdAt) < new Date(Date.now() - 49 * 36e5));

  var c = find(q, claim.id);
  assert.deepEqual([c.facts.category, c.facts.amount, c.amount, c.currency, c.facts.receipt], ['Zqa Fuel', 75, 75, 'GHS', null]);
  var p = find(q, pr.id);
  assert.deepEqual([p.facts.item, p.facts.quantity, p.facts.estimatedPrice, p.facts.priority, p.facts.requiredDate], ['Zqa machete', 4, 320, 'high', '2031-04-01']);

  // Oldest first, and nobody sees their own requests.
  var times = q.map(function (x) { return new Date(x.createdAt).getTime(); });
  assert.deepEqual(times, times.slice().sort(function (a, b) { return a - b; }));
  var own = await expenses.create(kelvin, { category: 'Zqa Meals', amount: 30, description: 'Zqa own lunch' });
  assert.equal(find(await approvals.queue(kelvin, {}), own.id), undefined);
  // Narrowing by another company's department leaves them out.
  var other = (await pool.query('SELECT id FROM departments WHERE id <> $1 LIMIT 1', [alice.employee.department_id])).rows[0];
  assert.equal(find(await approvals.queue(kelvin, { departmentId: other.id }), claim.id), undefined);
  // An employee without approval.act has no queue.
  await assert.rejects(approvals.queue(alice, {}), /approval.act/);
});

test('history: decided lately, by whom, with the note and time taken', async function () {
  var claim = await expenses.create(alice, { category: 'Zqa Travel', amount: 60, description: 'Zqa bus fare' });
  await pool.query("UPDATE approvals SET created_at = now() - interval '5 hours' WHERE subject_id = $1", [claim.id]);
  await expenses.decide(kelvin, claim.id, 'rejected', 'Zqa no receipt');
  var h = await approvals.history(kelvin, {});
  var row = find(h, claim.id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.note, 'Zqa no receipt');
  assert.equal(row.byMe, true);
  assert.equal(row.decidedByName, kelvin.employee.first_name + ' ' + kelvin.employee.last_name);
  assert.equal(row.hoursToDecide, 5);
  assert.equal(find(await approvals.queue(kelvin, {}), claim.id), undefined);
  await assert.rejects(approvals.history(alice, {}), /approval.act/);
});
