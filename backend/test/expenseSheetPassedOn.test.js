// Money an officer passed on out of their float (payroll cash handed to
// staff, money returned) is written on the workbook's funding tab below
// zero. It comes in as money passed on: it lowers the balance and is not
// spending. The accountant's large "Staged" copies of the tabs are skipped
// without being kept in memory. On a throwaway employee and a fake workbook.
var test = require('node:test');
var assert = require('node:assert/strict');
var ExcelJS = require('exceljs');
var { pool } = require('../src/db/pool');
var sheets = require('../src/services/expenseSheets.service');
var sheetImport = require('../src/services/expenseSheetImport.service');
var { buildContext } = require('../src/services/context.service');

var finance, empId, sheetId, emp2, sheet2;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function at(n) { return new Date(day(n) + 'T00:00:00Z'); }

test.before(async function () {
  finance = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [finance.employee.id])).rows[0].department_id;
  empId = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status) VALUES ('ZQP-1','Zq','Passer','zqp-1@example.com',$1,'Officer','permanent',CURRENT_DATE,'active') RETURNING id",
    [dept])).rows[0].id;
  sheetId = (await sheets.create(finance, { employeeId: empId })).id;
  emp2 = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status) VALUES ('ZQP-2','Zq','Again','zqp-2@example.com',$1,'Officer','permanent',CURRENT_DATE,'active') RETURNING id",
    [dept])).rows[0].id;
  sheet2 = (await sheets.create(finance, { employeeId: emp2 })).id;
});
test.after(async function () {
  await pool.query('DELETE FROM expense_sheets WHERE employee_id = ANY($1)', [[empId, emp2]]);
  await pool.query("DELETE FROM expense_sheet_lists WHERE name LIKE 'Zq%'");
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [[empId, emp2]]);
  await pool.end();
});

async function workbook() {
  var wb = new ExcelJS.Workbook();
  var f = wb.addWorksheet('Data Funding');
  f.addRow(['Date', 'Amt', 'Note', 'Payee', 'SEQ', 'Supervisor Audit', 'Balance']);
  f.addRow([at(-10), 1000, 'Zq for biweekly payroll', 'Zq Boss', 1]);
  f.addRow([at(-9), -600, 'Zq for biweekly payroll', 'Zq Staff', 2]);
  var e = wb.addWorksheet('Data Exp');
  e.addRow(['Date', 'Amt', 'Qty', 'UnitPrice', 'Note', 'Project', 'Asset', 'Payee', 'Category', 'No', 'Supervisor Audit', 'Balance']);
  e.addRow([at(-8), 100, 1, 100, 'Zq fuel', 'Zq Yard', null, 'Zq Station', 'Zq Fuel', 1]);
  // The accountant's copy: thousands of rows the import never reads.
  var s = wb.addWorksheet('Staged Funding');
  s.addRow(['ExpAcc', 'Date', 'Amt', 'Note', 'Project', 'Payee', 'Category', 'Balance', 'No']);
  for (var i = 0; i < 3000; i++) s.addRow(['Zq', at(-5), 999, 'Zq staged', 'Funding', 'Zq Boss', 'IOU', 999, i]);
  return { buffer: await wb.xlsx.writeBuffer(), originalname: 'zq.xlsx' };
}

test('money passed on comes in below zero: it lowers the balance and is not spending', async function () {
  var file = await workbook();
  var p = await sheetImport.preview(finance, sheetId, file);
  assert.deepEqual([p.funding.lines, p.funding.total], [1, 1000], 'money received');
  assert.deepEqual([p.passedOn.lines, p.passedOn.total], [1, 600], 'money passed on');
  assert.deepEqual([p.expenses.lines, p.expenses.total], [1, 100], 'the staged copy is not read');
  assert.equal(p.balance.afterImport, 300);
  var r = await sheetImport.run(finance, sheetId, file);
  assert.equal(r.added, 3);
  var g = await sheets.get(finance, sheetId);
  assert.equal(g.balance, 300);
  var passed = g.lines.find(function (l) { return l.amount < 0; });
  assert.equal(passed.kind, 'funding');
  assert.equal(passed.amount, -600);
  assert.equal(g.report.categories.reduce(function (s, c) { return s + c.total; }, 0), 100, 'only the fuel is spending');
});

test('money passed on can be written in the OS too, with what it was for', async function () {
  await assert.rejects(sheets.addLine(finance, sheetId, { kind: 'funding', date: day(-1), amount: -50, note: '' }), /passed on was for/);
  var l = await sheets.addLine(finance, sheetId, { kind: 'funding', date: day(-1), amount: -50, note: 'Zq returned to the office' });
  var g = await sheets.get(finance, sheetId);
  assert.equal(g.balance, 250);
  assert.equal(g.lines.find(function (x) { return x.id === l.id; }).amount, -50);
});

// The workbook as an earlier import saw it: the line below zero left out,
// the supervisor's stamp (balance 300 on day -8) taken as a check at the
// balance the lines gave then (900).
async function stamped(withPassedOn, extra) {
  var wb = new ExcelJS.Workbook();
  var f = wb.addWorksheet('Data Funding');
  f.addRow(['Date', 'Amt', 'Note', 'Payee', 'SEQ', 'Supervisor Audit', 'Balance']);
  f.addRow([at(-10), 1000, 'Zq for biweekly payroll', 'Zq Boss', 1]);
  if (withPassedOn) f.addRow([at(-9), -600, 'Zq for biweekly payroll', 'Zq Staff', 2]);
  var e = wb.addWorksheet('Data Exp');
  e.addRow(['Date', 'Amt', 'Qty', 'UnitPrice', 'Note', 'Project', 'Asset', 'Payee', 'Category', 'No', 'Supervisor Audit', 'Balance']);
  e.addRow([at(-8), 100, 1, 100, 'Zq fuel', 'Zq Yard', null, 'Zq Station', 'Zq Fuel', 1, 'ZB, 300, C01']);
  if (extra) e.addRow([at(-3), 20, 1, 20, 'Zq water', 'Zq Yard', null, 'Zq Shop', 'Zq Fuel', 2]);
  return { buffer: await wb.xlsx.writeBuffer(), originalname: 'zq.xlsx' };
}

test('importing the workbook again brings in what an earlier import left out and redoes its checks', async function () {
  await sheetImport.run(finance, sheet2, await stamped(false));
  var before = await sheets.get(finance, sheet2);
  assert.equal(before.balance, 900, 'the earlier import, without the money passed on');
  assert.equal(before.checks[0].balance, 900);
  assert.equal(before.lockedUntil, day(-8));

  var full = await stamped(true);
  var p = await sheetImport.preview(finance, sheet2, full);
  assert.deepEqual([p.passedOn.lines, p.inCheckedPeriod, p.intoImportedChecks, p.checksAgain], [1, 0, 1, 1]);
  assert.equal(p.checks[0].agrees, true, 'the stamp now agrees with the lines');
  assert.equal(p.balance.afterImport, 300);
  var r = await sheetImport.run(finance, sheet2, full);
  assert.deepEqual([r.added, r.checksAdded, r.checksUpdated], [1, 0, 1]);
  var g = await sheets.get(finance, sheet2);
  assert.equal(g.balance, 300);
  assert.equal(g.checks.length, 1);
  assert.equal(g.checks[0].balance, 300);
  assert.doesNotMatch(g.checks[0].note, /Workbook said/);

  // A check made in the OS still closes its period to the workbook.
  await sheets.check(finance, sheet2, { uptoDate: day(-2) });
  var later = await sheetImport.preview(finance, sheet2, await stamped(true, true));
  assert.deepEqual([later.inCheckedPeriod, later.expenses.lines, later.intoImportedChecks], [1, 0, 0]);
});
