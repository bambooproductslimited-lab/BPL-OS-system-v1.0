// Staff records from an HR sheet (employeeRecords.service.js): names in
// the first, unheaded columns, then SSNIT ID, GH Card and SSNIT (the
// amount paid each month). The preview says who each row is and what
// changes; N/A and #N/A leave a field as it is; odd numbers are listed and
// left out. Apply sets the salary for SSNIT (amount over 5.5%), the SSNIT
// number and the Ghana Card. On throwaway employees and a fake sheet.
var test = require('node:test');
var assert = require('node:assert/strict');
var ExcelJS = require('exceljs');
var { pool } = require('../src/db/pool');
var records = require('../src/services/employeeRecords.service');
var employees = require('../src/services/employees.service');
var { buildContext } = require('../src/services/context.service');

var boss, ids = {};
async function cleanup() { await pool.query("DELETE FROM employees WHERE code LIKE 'ZQR-%'"); }
async function person(code, first, last, extra) {
  var dept = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [boss.employee.id])).rows[0].department_id;
  return (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, pay_cycle, ghana_card) VALUES ($1,$2,$3,lower($1) || '@example.com',$4,'2020-01-01','active','permanent','monthly',$5) RETURNING id",
    [code, first, last, dept, (extra && extra.ghanaCard) || null])).rows[0].id;
}
async function sheet(rows) {
  var wb = new ExcelJS.Workbook();
  var ws = wb.addWorksheet('Sheet1');
  ws.addRow([null, null, 'SSNT ID', 'GH Card', 'SSNIT']);
  rows.forEach(function (r) { ws.addRow(r); });
  return { buffer: await wb.xlsx.writeBuffer(), originalname: 'staff.xlsx' };
}

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await cleanup();
  ids.rexa = await person('ZQR-1', 'Zq', 'Rexa');
  ids.bonsu = await person('ZQR-2', 'Kwame', 'Zqbonsu');
  ids.twinA = await person('ZQR-3', 'Zq', 'Twin');
  ids.twinB = await person('ZQR-4', 'Zq', 'Twin');
  ids.zero = await person('ZQR-5', 'Zq', 'Nought');
  ids.other = await person('ZQR-6', 'Zq', 'Holder', { ghanaCard: 'GHA-555555555-5' });
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the preview: who each row is, the salary for SSNIT, and what is left out', async function () {
  var file = await sheet([
    ['Zq', 'Rexa', 'N/A', 'GHA-123456789-1', 32.45],          // first name and surname in two columns
    [null, 'Zqbonsu Kwame', 'C012345678901', 'GHA- 987654321-2', 31.35],   // the full name, either order
    [null, 'Zq Nobody Here', 'N/A', 'N/A', '#N/A'],
    [null, 'Zq Twin', null, null, 33],
    [null, 'Zq Nought', null, 'GHA- 12345678-9', 0]             // 8 digits: not a Ghana Card
  ]);
  var p = await records.preview(boss, file);
  assert.deepEqual(p.columns.sort(), ['ghanaCard', 'ssnitAmount', 'ssnitNumber']);
  assert.equal(p.rows.length, 5);
  var r = function (n) { return p.rows.find(function (x) { return x.name === n; }); };

  var rexa = r('Zq Rexa');
  assert.equal(rexa.status, 'match');
  assert.equal(rexa.candidates[0].id, ids.rexa);
  assert.deepEqual(rexa.values, { ghanaCard: 'GHA-123456789-1', ssnitAmount: 32.45, ssnitSalary: 590 });

  var bonsu = r('Zqbonsu Kwame');
  assert.equal(bonsu.status, 'match');
  assert.deepEqual(bonsu.values, { ssnitNumber: 'C012345678901', ghanaCard: 'GHA-987654321-2', ssnitAmount: 31.35, ssnitSalary: 570 });

  assert.equal(r('Zq Nobody Here').status, 'none');
  assert.deepEqual(r('Zq Nobody Here').values, {}, 'N/A and #N/A leave everything as it is');
  assert.equal(r('Zq Twin').status, 'several');
  assert.equal(r('Zq Twin').candidates.length, 2);

  var nought = r('Zq Nought');
  assert.deepEqual(nought.values, { ssnitAmount: 0, ssnitSalary: 0 }, 'no SSNIT: a salary for SSNIT of 0');
  assert.deepEqual(nought.problems.map(function (x) { return [x.field, x.why]; }), [['ghanaCard', 'format']]);
});

test('apply: the salary for SSNIT, SSNIT number and Ghana Card are set; again, nothing changes', async function () {
  await assert.rejects(records.apply(Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (x) { return x !== 'payroll.manage' && boss.can(x); } }), [{ employeeId: ids.rexa, ssnitSalary: 590 }]), /payroll.manage/);
  var changes = [
    { employeeId: ids.rexa, ghanaCard: 'GHA-123456789-1', ssnitSalary: 590 },
    { employeeId: ids.bonsu, ssnitNumber: 'C012345678901', ghanaCard: 'GHA-987654321-2', ssnitSalary: 570 },
    { employeeId: ids.zero, ssnitSalary: 0 }
  ];
  var r = await records.apply(boss, changes);
  assert.deepEqual([r.updated, r.unchanged], [3, 0]);
  var row = (await pool.query('SELECT ssnit_number, ghana_card, ssnit_salary FROM employees WHERE id = $1', [ids.bonsu])).rows[0];
  assert.deepEqual([row.ssnit_number, row.ghana_card, Number(row.ssnit_salary)], ['C012345678901', 'GHA-987654321-2', 570]);
  assert.equal(Number((await pool.query('SELECT ssnit_salary FROM employees WHERE id = $1', [ids.zero])).rows[0].ssnit_salary), 0);
  var again = await records.apply(boss, changes);
  assert.deepEqual([again.updated, again.unchanged], [0, 3]);

  // A Ghana Card already on someone else's record.
  await assert.rejects(records.apply(boss, [{ employeeId: ids.twinA, ghanaCard: 'GHA-555555555-5' }]), /already on Zq Holder/);
  // The same number for two people in one go.
  await assert.rejects(records.apply(boss, [{ employeeId: ids.twinA, ssnitNumber: 'C099999999999' }, { employeeId: ids.twinB, ssnitNumber: 'C099999999999' }]), /two people/);
});

test('the employee record: a Ghana Card number, payroll.manage only, written GHA-123456789-0', async function () {
  await assert.rejects(employees.update(boss, ids.twinA, { ghanaCard: 'GHA-1234' }), /GHA-123456789-0/);
  await employees.update(boss, ids.twinA, { ghanaCard: 'gha- 111222333-4' });
  assert.equal((await employees.get(boss, ids.twinA)).ghanaCard, 'GHA-111222333-4');
  var hr = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (x) { return x !== 'payroll.manage' && boss.can(x); } });
  await assert.rejects(employees.update(hr, ids.twinA, { ghanaCard: '' }), /payroll.manage/);
});
