// Bringing in a newer copy of an officer's workbook when the OS already has
// lines: a row corrected or deleted on the workbook since the last import
// leaves its old line in the OS, and a line typed in the OS may also be on
// the workbook. The preview lists what is in the OS but not on the workbook
// and what the balance would be without it; the import can take those out
// so the sheet matches the workbook — never in a period checked in the OS —
// and a line typed in the OS is not added a second time. On a throwaway
// employee and fake workbooks.
var test = require('node:test');
var assert = require('node:assert/strict');
var ExcelJS = require('exceljs');
var { pool } = require('../src/db/pool');
var sheets = require('../src/services/expenseSheets.service');
var sheetImport = require('../src/services/expenseSheetImport.service');
var { buildContext } = require('../src/services/context.service');

var finance, empId, sheetId;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function at(n) { return new Date(day(n) + 'T00:00:00Z'); }

test.before(async function () {
  finance = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [finance.employee.id])).rows[0].department_id;
  await pool.query("DELETE FROM expense_sheets WHERE employee_id IN (SELECT id FROM employees WHERE code = 'ZQM-1')");
  await pool.query("DELETE FROM employees WHERE code = 'ZQM-1'");
  empId = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status) VALUES ('ZQM-1','Zq','Matcher','zqm-1@example.com',$1,'Officer','permanent',CURRENT_DATE,'active') RETURNING id",
    [dept])).rows[0].id;
  sheetId = (await sheets.create(finance, { employeeId: empId })).id;
});
test.after(async function () {
  await pool.query('DELETE FROM expense_sheets WHERE employee_id = $1', [empId]);
  await pool.query("DELETE FROM expense_sheet_lists WHERE name LIKE 'Zq%'");
  await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
  await pool.end();
});

// rows: [daysAgo, amount, note]
async function workbook(funding, spending) {
  var wb = new ExcelJS.Workbook();
  var f = wb.addWorksheet('Data Funding');
  f.addRow(['Date', 'Amt', 'Note', 'Payee', 'SEQ', 'Supervisor Audit', 'Balance']);
  funding.forEach(function (r, i) { f.addRow([at(r[0]), r[1], r[2], 'Zq Boss', i + 1]); });
  var e = wb.addWorksheet('Data Exp');
  e.addRow(['Date', 'Amt', 'Qty', 'UnitPrice', 'Note', 'Project', 'Asset', 'Payee', 'Category', 'No', 'Supervisor Audit', 'Balance']);
  spending.forEach(function (r, i) { e.addRow([at(r[0]), r[1], 1, r[1], r[2], 'Zq Yard', null, 'Zq Shop', 'Zq Supplies', i + 1]); });
  return { buffer: await wb.xlsx.writeBuffer(), originalname: 'zq.xlsx' };
}

test('a newer workbook: what is no longer on it is listed and can be taken out; a line typed in the OS is not added twice', async function () {
  var v1 = await workbook([[-20, 1000, 'Zq float']], [[-15, 200, 'Zq paint'], [-12, 300, 'Zq cement'], [-10, 150, 'Zq nails']]);
  await sheetImport.run(finance, sheetId, v1);
  assert.equal((await sheets.get(finance, sheetId)).balance, 350);
  // Typed in the OS, and later also written on the workbook.
  await sheets.addLine(finance, sheetId, { kind: 'expense', date: day(-5), amount: 40, note: 'Zq bus fare', category: 'Zq Supplies' });

  // Since then on the workbook: the cement corrected to 250, the nails
  // deleted, the bus fare written in, a new line.
  var v2 = await workbook([[-20, 1000, 'Zq float']], [[-15, 200, 'Zq paint'], [-12, 250, 'Zq cement'], [-5, 40, 'Zq bus fare'], [-3, 60, 'Zq glue']]);
  var p = await sheetImport.preview(finance, sheetId, v2);
  assert.equal(p.already, 2, 'the float and the paint');
  assert.equal(p.sameAsTyped, 1, 'the bus fare typed in the OS is the same line');
  assert.deepEqual([p.expenses.lines, p.expenses.total], [2, 310], 'the corrected cement and the glue');
  assert.deepEqual([p.notOnWorkbook.imported.lines, p.notOnWorkbook.imported.spent, p.notOnWorkbook.imported.removable], [2, 450, 2], 'the old cement and the nails');
  assert.deepEqual(p.notOnWorkbook.imported.list.map(function (l) { return l.note; }).sort(), ['Zq cement', 'Zq nails']);
  assert.equal(p.notOnWorkbook.typed.lines, 0);
  assert.equal(p.balance.onWorkbook, null);
  assert.equal(p.balance.afterImport, 1000 - 200 - 300 - 150 - 40 - 250 - 60, 'kept: the sheet would be 450 short');
  assert.equal(p.balance.removingImported, 1000 - 200 - 250 - 40 - 60, 'taken out: the workbook\'s balance');

  var r = await sheetImport.run(finance, sheetId, v2, 'imported');
  assert.deepEqual([r.added, r.removed], [2, 2]);
  assert.equal((await sheets.get(finance, sheetId)).balance, 450);
  var again = await sheetImport.run(finance, sheetId, v2, 'imported');
  assert.deepEqual([again.added, again.removed], [0, 0], 'the sheet now matches the workbook');
});

test('lines typed in the OS that the workbook does not have are kept unless asked; a period checked in the OS is never touched', async function () {
  await sheets.addLine(finance, sheetId, { kind: 'expense', date: day(-4), amount: 25, note: 'Zq extra typed', category: 'Zq Supplies' });
  var v2 = await workbook([[-20, 1000, 'Zq float']], [[-15, 200, 'Zq paint'], [-12, 250, 'Zq cement'], [-5, 40, 'Zq bus fare'], [-3, 60, 'Zq glue']]);
  var p = await sheetImport.preview(finance, sheetId, v2);
  assert.deepEqual([p.notOnWorkbook.typed.lines, p.notOnWorkbook.typed.spent], [1, 25]);
  assert.equal(p.balance.removingImported, 425, 'typed lines stay with "imported"');
  assert.equal(p.balance.removingAll, 450);

  // A check made in the OS up to day -4: the typed line is in it and stays.
  await pool.query("INSERT INTO expense_sheet_checks (sheet_id, kind, upto_date, balance, code, source) VALUES ($1, 'supervisor', $2, 425, 'C90', 'os')", [sheetId, day(-4)]);
  p = await sheetImport.preview(finance, sheetId, v2);
  assert.deepEqual([p.notOnWorkbook.typed.lines, p.notOnWorkbook.typed.removable, p.notOnWorkbook.typed.locked], [1, 0, 1]);
  var r = await sheetImport.run(finance, sheetId, v2, 'all');
  assert.equal(r.removed, 0);
  assert.equal((await sheets.get(finance, sheetId)).balance, 425);
});
