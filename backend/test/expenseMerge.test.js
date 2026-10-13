// Expense sheets as the one place for spending (migration 0142): a float
// top-up waits in the Approval centre and is decided there or on the sheet;
// the dashboard counts top-ups and sheets to check; My space shows the
// officer's sheet; someone with no sheet records what they paid and a
// no-float sheet opens for them, which finance pays back.
// On throwaway employees of its own.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var sheets = require('../src/services/expenseSheets.service');
var approvals = require('../src/services/approvals.service');
var { buildContext } = require('../src/services/context.service');

var finance, officer, boss, walker, ids = [], sheetId;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function as(base, emp, perms) {
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    employee: Object.assign({}, base.employee, emp), can: function (p) { return (perms || []).indexOf(p) >= 0; }
  });
}
var STAFF = ['expense.request'];

test.before(async function () {
  finance = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [finance.employee.id])).rows[0].department_id;
  async function person(code, first, managerId) {
    var id = (await pool.query(
      "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status, manager_id) VALUES ($1,'Zq',$2,$3,$4,'Officer','permanent',CURRENT_DATE,'active',$5) RETURNING id",
      [code, first, code.toLowerCase() + '@example.com', dept, managerId || null])).rows[0].id;
    ids.push(id);
    return id;
  }
  var b = await person('ZQM-2', 'Boss');
  var o = await person('ZQM-1', 'Officer', b), w = await person('ZQM-3', 'Walker', b);
  officer = as(finance, { id: o, first_name: 'Zq', last_name: 'Officer' }, STAFF);
  boss = as(finance, { id: b, first_name: 'Zq', last_name: 'Boss' }, STAFF);
  walker = as(finance, { id: w, first_name: 'Zq', last_name: 'Walker' }, STAFF);
  sheetId = (await sheets.create(finance, { employeeId: o, supervisorId: b, floatLimit: 1000 })).id;
});
test.after(async function () {
  await pool.query("DELETE FROM approvals WHERE subject_type = 'expense_topup' AND requested_by = ANY($1)", [ids]);
  await pool.query('DELETE FROM expense_sheets WHERE employee_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [ids]);
  await pool.end();
});

test('a top-up waits in the Approval centre and is decided there', async function () {
  var t = await sheets.requestTopup(officer, sheetId, { amount: 400, reason: 'Zq fuel for the week' });
  var row = (await pool.query("SELECT * FROM approvals WHERE subject_type = 'expense_topup' AND subject_id = $1", [t.id])).rows[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.assignee_permission, 'expensesheet.manage');
  assert.equal(row.requested_by, officer.employee.id);

  var q = (await approvals.queue(finance, {})).find(function (a) { return a.subjectId === t.id; });
  assert.ok(q, 'finance sees it in the queue');
  assert.equal(q.subjectType, 'expense_topup');
  assert.equal(q.amount, 400);
  assert.equal(q.facts.sheetId, sheetId);
  assert.equal(q.facts.floatLimit, 1000);
  assert.equal(q.reason, 'Zq fuel for the week');

  await assert.rejects(sheets.decideFromApprovals(boss, t.id, { decision: 'approved' }), /finance|manage|not found/i);
  await assert.rejects(sheets.decideFromApprovals(finance, t.id, { decision: 'maybe' }), /Decision/);
  await sheets.decideFromApprovals(finance, t.id, { decision: 'approved', note: 'Zq ok' });
  row = (await pool.query("SELECT * FROM approvals WHERE subject_type = 'expense_topup' AND subject_id = $1", [t.id])).rows[0];
  assert.equal(row.status, 'approved');
  assert.equal(row.comment, 'Zq ok');
  var s = await sheets.get(finance, sheetId);
  assert.equal(s.balance, 400);
  assert.ok(s.lines.some(function (l) { return l.source === 'topup' && l.amount === 400; }));
  assert.ok(!(await approvals.queue(finance, {})).some(function (a) { return a.subjectId === t.id; }), 'no longer waiting');

  // Decided on the sheet or cancelled by the officer, the approval follows.
  var t2 = await sheets.requestTopup(officer, sheetId, { amount: 50 });
  await sheets.decideTopup(finance, t2.id, { approve: false, note: 'Zq not now' });
  assert.equal((await pool.query("SELECT status FROM approvals WHERE subject_type = 'expense_topup' AND subject_id = $1", [t2.id])).rows[0].status, 'rejected');
  var t3 = await sheets.requestTopup(officer, sheetId, { amount: 60 });
  await sheets.cancelTopup(officer, t3.id);
  assert.equal((await pool.query("SELECT status FROM approvals WHERE subject_type = 'expense_topup' AND subject_id = $1", [t3.id])).rows[0].status, 'cancelled');
});

test('the dashboard counts top-ups and sheets to check; My space shows the sheet', async function () {
  await sheets.addLine(officer, sheetId, { kind: 'expense', date: day(0), amount: 75, category: 'Auto Fuel', note: 'Zq fuel' });
  await sheets.requestTopup(officer, sheetId, { amount: 300 });
  var mine = await sheets.todo(boss, null, false);
  assert.equal(mine.sheetsToCheck, 1, 'the supervisor has the sheet to check');
  assert.ok(mine.linesToCheck >= 2);
  assert.equal(mine.topupsWaiting, null, 'top-ups are for finance');
  var fin = await sheets.todo(finance, null, false);
  assert.ok(fin.topupsWaiting >= 1);
  assert.ok(fin.topupsWaitingTotal >= 300);
  assert.equal(await sheets.todo(walker, null, false), null, 'nothing for someone who neither runs nor checks sheets');

  var b = await sheets.brief(officer.employee.id);
  assert.equal(b.id, sheetId);
  assert.equal(b.balance, 325);
  assert.equal(b.floatLimit, 1000);
  assert.equal(b.topupWaiting, 300);
  assert.ok(b.uncheckedLines >= 2);
  assert.equal(await sheets.brief(walker.employee.id), null);
});

test('someone with no sheet records what they paid; finance pays it back', async function () {
  await assert.rejects(sheets.startOwn(officer, { date: day(0), amount: 10, category: 'Auto Fuel' }), /already have/);
  await assert.rejects(sheets.startOwn(walker, { date: day(0), amount: 10 }), /category/i);
  await assert.rejects(sheets.startOwn(as(walker, {}, []), { date: day(0), amount: 10, category: 'Auto Fuel' }), /expense\.request/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM expense_sheets WHERE employee_id = $1', [walker.employee.id])).rows[0].n, 0, 'nothing opened on a refused try');

  var s = await sheets.startOwn(walker, { date: day(0), amount: 120, qty: 2, category: 'Office Supplies', payee: 'Zq Stationers', note: 'Zq ink' });
  assert.equal(s.employee.id, walker.employee.id);
  assert.equal(s.floatLimit, 0);
  assert.equal(s.supervisor.id, boss.employee.id, 'checked by their manager');
  assert.equal(s.balance, -120, 'the company owes them');
  assert.ok(s.newLineId);
  assert.equal(s.lines.length, 1);
  await assert.rejects(sheets.startOwn(walker, { date: day(0), amount: 5, category: 'Auto Fuel' }), /already have/);
  // From then on they use the sheet like any officer.
  await sheets.addLine(walker, s.id, { kind: 'expense', date: day(0), amount: 30, category: 'Auto Fuel', note: 'Zq taxi' });

  await assert.rejects(sheets.payBack(walker, s.id, {}), /finance|manage/i);
  var l = await sheets.payBack(finance, s.id, { note: 'Zq cash' });
  assert.equal(l.amount, 150, 'everything owed by default');
  assert.equal(l.kind, 'funding');
  assert.equal(l.source, 'payback');
  assert.equal((await sheets.get(finance, s.id)).balance, 0);
  await assert.rejects(sheets.payBack(finance, s.id, {}), /owes this officer nothing/);
});
