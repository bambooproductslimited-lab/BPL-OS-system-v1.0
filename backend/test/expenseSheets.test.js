// Officers' expense sheets (migration 0141): finance opens a sheet; the
// officer records money received and spent, the balance running line by
// line; the supervisor checks it up to a date, which locks it; top-ups;
// the report and the export; and an officer's old workbook brought in.
// On throwaway employees of its own, with a fake workbook.
var test = require('node:test');
var assert = require('node:assert/strict');
var ExcelJS = require('exceljs');
var { pool } = require('../src/db/pool');
var sheets = require('../src/services/expenseSheets.service');
var sheetImport = require('../src/services/expenseSheetImport.service');
var { buildContext } = require('../src/services/context.service');

var finance, officer, boss, stranger, other, ids = [], sheetId, otherSheet;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function as(base, emp, perms) {
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    employee: Object.assign({}, base.employee, emp), can: function (p) { return (perms || []).indexOf(p) >= 0; }
  });
}

test.before(async function () {
  finance = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [finance.employee.id])).rows[0].department_id;
  async function person(code, first) {
    var id = (await pool.query(
      "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status) VALUES ($1,'Zq',$2,$3,$4,'Officer','permanent',CURRENT_DATE,'active') RETURNING id",
      [code, first, code.toLowerCase() + '@example.com', dept])).rows[0].id;
    ids.push(id);
    return id;
  }
  var o = await person('ZQE-1', 'Officer'), b = await person('ZQE-2', 'Boss'), s = await person('ZQE-3', 'Stranger'), w = await person('ZQE-4', 'Workbook');
  officer = as(finance, { id: o, first_name: 'Zq', last_name: 'Officer' });
  boss = as(finance, { id: b, first_name: 'Zq', last_name: 'Boss' });
  stranger = as(finance, { id: s, first_name: 'Zq', last_name: 'Stranger' });
  other = as(finance, { id: w, first_name: 'Zq', last_name: 'Workbook' });
});
test.after(async function () {
  await pool.query('DELETE FROM expense_sheets WHERE employee_id = ANY($1)', [ids]);
  await pool.query("DELETE FROM expense_sheet_lists WHERE name LIKE 'Zq%'");
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [ids]);
  await pool.end();
});

test('finance opens a sheet; only its officer, supervisor and finance see it', async function () {
  await assert.rejects(sheets.create(officer, { employeeId: officer.employee.id }), /finance/i);
  var s = await sheets.create(finance, { employeeId: officer.employee.id, supervisorId: boss.employee.id, floatLimit: 1500 });
  sheetId = s.id;
  assert.equal(s.supervisor.id, boss.employee.id);
  assert.equal(s.floatLimit, 1500);
  await assert.rejects(sheets.create(finance, { employeeId: officer.employee.id }), /already has/);
  assert.deepEqual((await sheets.list(officer)).map(function (x) { return x.id; }), [sheetId]);
  assert.equal((await sheets.list(boss))[0].supervising, true);
  assert.equal((await sheets.list(stranger)).length, 0);
  await assert.rejects(sheets.get(stranger, sheetId), /not found/);
  assert.equal((await sheets.mine(officer)).sheetId, sheetId);
});

test('money in and out, a running balance, one spelling for a payee', async function () {
  await sheets.addLine(officer, sheetId, { kind: 'funding', date: day(-5), amount: 1000, payee: 'Zq Finance' });
  await sheets.addLine(officer, sheetId, { date: day(-4), amount: 100, qty: 2, note: 'Taxi to the site', payee: 'Uber', category: 'travel expense', costCentre: 'Zq Site A' });
  var l = await sheets.addLine(officer, sheetId, { date: day(-3), amount: 60, payee: 'uber', category: 'Travel Expense' });
  assert.equal(l.payee, 'Uber', 'the spelling already on the sheet');
  assert.equal(l.unitPrice, 60);
  await assert.rejects(sheets.addLine(officer, sheetId, { date: day(1), amount: 5, category: 'Travel Expense' }), /future/);
  await assert.rejects(sheets.addLine(officer, sheetId, { date: day(-1), amount: 5 }), /category/);
  await assert.rejects(sheets.addLine(officer, sheetId, { date: day(-1), amount: -20, category: 'IOU' }), /coming back/);
  await sheets.addLine(officer, sheetId, { date: day(-2), amount: -20, category: 'IOU', note: 'Loan repaid' });
  var g = await sheets.get(officer, sheetId);
  assert.deepEqual(g.lines.map(function (x) { return x.balance; }), [1000, 900, 840, 860]);
  assert.equal(g.balance, 860);
  assert.equal(g.lines[1].category, 'Travel Expense', 'the list\'s spelling');
  assert.equal(g.lines[1].unitPrice, 50);
  assert.equal(g.can.check, false);
  assert.ok(g.suggestions.payees.indexOf('Uber') >= 0);
  await assert.rejects(sheets.addLine(stranger, sheetId, { date: day(-1), amount: 5, category: 'Travel Expense' }), /not found/);
});

test('a check confirms the balance and locks everything up to its date', async function () {
  await assert.rejects(sheets.check(officer, sheetId, { uptoDate: day(-3) }), /supervisor or finance/);
  var c = await sheets.check(boss, sheetId, { uptoDate: day(-3), counted: 830 });
  assert.deepEqual([c.kind, c.balance, c.counted, c.code, c.byInitials], ['supervisor', 840, 830, 'C01', 'ZB']);
  var g = await sheets.get(officer, sheetId);
  assert.deepEqual(g.lines.map(function (x) { return x.locked; }), [true, true, true, false]);
  await assert.rejects(sheets.addLine(officer, sheetId, { date: day(-3), amount: 5, category: 'Travel Expense' }), /checked up to/);
  await assert.rejects(sheets.updateLine(officer, g.lines[1].id, { amount: 99 }), /checked up to/);
  await assert.rejects(sheets.removeLine(officer, g.lines[0].id), /checked up to/);
  await sheets.updateLine(officer, g.lines[3].id, { note: 'Loan repaid in cash' });
  await assert.rejects(sheets.check(boss, sheetId, { uptoDate: day(-4) }), /already checked/);
  await assert.rejects(sheets.undoCheck(boss, c.id), /finance/i);
  var c2 = await sheets.check(finance, sheetId, { kind: 'accountant', uptoDate: day(-2) });
  assert.equal(c2.code, 'C02');
  await assert.rejects(sheets.undoCheck(finance, c.id), /latest/);
  await sheets.undoCheck(finance, c2.id);
  await sheets.undoCheck(finance, c.id);
  assert.equal((await sheets.get(officer, sheetId)).lockedUntil, null);
});

test('top-ups: asked by the officer, approved into the sheet by finance', async function () {
  await assert.rejects(sheets.requestTopup(boss, sheetId, { amount: 300 }), /officer/);
  var t = await sheets.requestTopup(officer, sheetId, { amount: 500, reason: 'Fuel for the week' });
  assert.ok((await sheets.pendingTopups(finance)).some(function (x) { return x.id === t.id; }));
  await assert.rejects(sheets.pendingTopups(officer), /finance/i);
  await assert.rejects(sheets.decideTopup(officer, t.id, { approve: true }), /finance/i);
  var d = await sheets.decideTopup(finance, t.id, { approve: true, amount: 400 });
  assert.equal(d.status, 'approved');
  assert.equal(d.amount, 400);
  var g = await sheets.get(officer, sheetId);
  var line = g.lines.filter(function (x) { return x.id === d.lineId; })[0];
  assert.deepEqual([line.kind, line.amount, line.source], ['funding', 400, 'topup']);
  assert.equal(g.balance, 1260);
  var t2 = await sheets.requestTopup(officer, sheetId, { amount: 50 });
  await sheets.cancelTopup(officer, t2.id);
  await assert.rejects(sheets.decideTopup(finance, t2.id, { approve: true }), /already/);
});

test('the report across sheets and the export', async function () {
  var r = await sheets.report(finance, new Date().getUTCFullYear());
  var mine = r.officers.filter(function (o) { return o.sheetId === sheetId; })[0];
  assert.deepEqual([mine.spent, mine.funded, mine.balance], [140, 1400, 1260]);
  assert.ok(r.categories.some(function (c) { return c.name === 'Travel Expense' && c.total >= 160; }));
  await assert.rejects(sheets.report(officer), /expensesheet/);
  var csv = await sheets.exportCsv(officer, { sheet: sheetId });
  var lines = csv.trim().split('\n');
  assert.match(lines[0], /^Officer,Date,Kind,Amount/);
  assert.equal(lines.length, 6);
  assert.match(lines[2], /Taxi to the site/);
  assert.match(lines[2], /,900,/, 'the running balance');
  assert.equal((await sheets.exportCsv(stranger, {})).trim().split('\n').length, 1);
});

async function workbook() {
  var wb = new ExcelJS.Workbook();
  wb.addWorksheet('Zq').getRow(1).values = ['Zq Workbook', 'Expense Report Handle'];
  var f = wb.addWorksheet('Data Funding');
  f.addRow(['Date', 'Amt', 'Note', 'Payee', 'SEQ', 'Supervisor Audit', 'Balance']);
  f.addRow([new Date(day(-20) + 'T00:00:00Z'), 0, null, 'Zq Boss', 1]);
  f.addRow([new Date(day(-19) + 'T00:00:00Z'), 500, null, 'Zq Boss', 2, 'aw']);
  var e = wb.addWorksheet('Data Exp');
  e.addRow(['Date', 'Amt', 'Qty', 'UnitPrice', 'Note', 'Project', 'Asset', 'Payee', 'Category', 'No', 'Supervisor Audit', 'Balance']);
  e.addRow([new Date(day(-18) + 'T00:00:00Z'), 80, 2, 40, 'Zq bus to the yard', 'Zq Yard', null, 'public transport', 'Travel Expense', 1]);
  e.addRow([new Date(day(-17) + 'T00:00:00Z'), 40, 1, 40, 'Zq data bundle', 'Zq Yard', null, 'Public transport', 'Communication', 2, 'ZB, 380, C01']);
  e.addRow([new Date(day(-16) + 'T00:00:00Z'), 30, 1, 25, 'Zq airtime', 'Zq Yard', null, 'Zq Telco', 'Zqcomms', 3]);
  e.addRow([new Date(day(-15) + 'T00:00:00Z')]);
  e.addRow([new Date(day(2) + 'T00:00:00Z')]);
  return { buffer: await wb.xlsx.writeBuffer(), originalname: 'zq.xlsx' };
}

test('an officer\'s old workbook comes in once, with its supervisor\'s stamp', async function () {
  otherSheet = (await sheets.create(finance, { employeeId: other.employee.id })).id;
  var file = await workbook();
  await assert.rejects(sheetImport.preview(stranger, otherSheet, file), /not found/);
  var p = await sheetImport.preview(finance, otherSheet, file);
  assert.equal(p.officerOnWorkbook, 'Zq Workbook');
  assert.deepEqual([p.funding.lines, p.funding.total, p.expenses.lines, p.expenses.total, p.skippedBlank], [1, 500, 3, 150, 3]);
  assert.deepEqual(p.payeesMerged, [{ from: ['public transport', 'Public transport'], to: 'Public transport' }]);
  assert.equal(p.unitPriceDiffs.length, 1);
  assert.deepEqual(p.checks.map(function (c) { return [c.kind, c.date, c.initials, c.stamped, c.agrees]; }), [['supervisor', day(-17), 'ZB', 380, true]]);
  assert.deepEqual(p.newCategories, ['Zqcomms']);
  assert.equal(p.balance.afterImport, 350);
  var r = await sheetImport.run(finance, otherSheet, file);
  assert.deepEqual([r.added, r.checksAdded], [4, 1]);
  var g = await sheets.get(finance, otherSheet);
  assert.equal(g.balance, 350);
  assert.equal(g.lockedUntil, day(-17));
  assert.deepEqual(g.lines.map(function (l) { return l.payee; }).slice(1, 3), ['Public transport', 'Public transport']);
  assert.equal(g.lines[1].costCentre, 'Zq Yard');
  var again = await sheetImport.run(finance, otherSheet, file);
  assert.deepEqual([again.added, again.already, again.checksAdded], [0, 4, 0]);
});
