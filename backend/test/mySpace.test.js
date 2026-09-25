// My space: the signed-in person's own day, leave, work, money and account
// — only theirs. Test rows use Zqm and far dates; draft pay runs stay out.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var mySpace = require('../src/services/mySpace.service');
var { buildContext } = require('../src/services/context.service');

var alice, kelvin, taskId, otherTaskId, runs = [];
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function cleanup() {
  await pool.query("DELETE FROM tasks WHERE title LIKE 'Zqm%'");
  await pool.query("DELETE FROM expenses WHERE description LIKE 'Zqm%'");
  await pool.query("DELETE FROM payslips WHERE pay_run_id IN (SELECT id FROM pay_runs WHERE run_no LIKE 'ZQM%')");
  await pool.query("DELETE FROM pay_runs WHERE run_no LIKE 'ZQM%'");
}
test.before(async function () {
  await cleanup();
  alice = await ctxFor('alice.kamau@bplghana.com');
  kelvin = await ctxFor('kelvin.duho@bplghana.com');
  taskId = (await pool.query("INSERT INTO tasks (title, priority, due_date, status, created_by) VALUES ('Zqm sort the offcuts', 'high', '2020-01-02', 'in_progress', $1) RETURNING id", [kelvin.employee.id])).rows[0].id;
  await pool.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1,$2)', [taskId, alice.employee.id]);
  otherTaskId = (await pool.query("INSERT INTO tasks (title, priority, status, created_by) VALUES ('Zqm not hers', 'low', 'not_started', $1) RETURNING id", [kelvin.employee.id])).rows[0].id;
  await pool.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1,$2)', [otherTaskId, kelvin.employee.id]);
  await pool.query("INSERT INTO expenses (requester_id, category, amount, date, description, status) VALUES ($1, 'Zqm Fuel', 55, '2020-01-03', 'Zqm fuel', 'approved')", [alice.employee.id]);
  for (var st of ['draft', 'paid']) {
    var r = (await pool.query("INSERT INTO pay_runs (run_no, cycle, period_start, period_end, pay_date, status, created_by) VALUES ($1, 'monthly', '2019-12-01', '2019-12-31', '2020-01-02', $2, $3) RETURNING id", ['ZQM-' + st, st, kelvin.employee.id])).rows[0];
    await pool.query('INSERT INTO payslips (pay_run_id, employee_id, days_worked, daily_rate, gross_pay, ssnit_employee, ssnit_employer, taxable_income, paye_tax, net_pay) VALUES ($1,$2,20,50,1000,55,130,945,40,' + (st === 'draft' ? 999 : 905) + ')', [r.id, alice.employee.id]);
  }
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the overview holds only the person\'s own things', async function () {
  var o = await mySpace.overview(alice);
  assert.equal(o.profile.id, alice.employee.id);
  assert.equal(o.account.email, 'alice.kamau@bplghana.com');
  assert.deepEqual(Object.keys(o.account.twoStep).sort(), ['app', 'email', 'sms']);
  var t = o.tasks.find(function (x) { return x.title === 'Zqm sort the offcuts'; });
  assert.ok(t);
  assert.equal(t.dueDate, '2020-01-02');
  assert.ok(!o.tasks.some(function (x) { return x.title === 'Zqm not hers'; }));
  assert.ok(o.claims.some(function (c) { return c.category === 'Zqm Fuel' && c.amount === 55 && c.status === 'approved'; }));
  var slips = o.payslips.filter(function (p) { return /^ZQM/.test(p.runNo); });
  assert.deepEqual(slips.map(function (p) { return [p.runNo, p.net]; }), [['ZQM-paid', 905]]);
  assert.equal(typeof o.month.hours, 'number');
  assert.ok(Array.isArray(o.recent));
  assert.ok(o.balances.every(function (b) { return typeof b.pending === 'number' && b.left === b.entitled - b.used; }));
  assert.equal(o.approvalsWaiting, 0);
  assert.ok(!(await mySpace.overview(kelvin)).claims.some(function (c) { return c.category === 'Zqm Fuel'; }));
});
