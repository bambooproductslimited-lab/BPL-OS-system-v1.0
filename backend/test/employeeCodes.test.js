// Employee IDs (employeeCodes.service.js): the next automatic ID follows the
// highest in use, an ID can be given or changed by hand and must be free,
// and a pasted list of IDs and names is matched to people and applied.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var employees = require('../src/services/employees.service');
var codes = require('../src/services/employeeCodes.service');
var { buildContext } = require('../src/services/context.service');

var boss, dept, P = {};
async function cleanup() {
  await pool.query("DELETE FROM employees WHERE email LIKE 'zqc.%'");
}
async function emp(key, code, first, last, status) {
  P[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type) VALUES ($1,$2,$3,$4,$5,'2024-01-01',$6,'permanent') RETURNING id",
    [code, first, last, 'zqc.' + key + '@example.com', dept, status || 'active'])).rows[0].id;
}
async function codeOf(id) { return (await pool.query('SELECT code FROM employees WHERE id = $1', [id])).rows[0].code; }
async function rejects(p, re) { await assert.rejects(p, function (e) { assert.match(e.message, re); return true; }); }

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await cleanup();
  dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0].id;
  await emp('high', 'BPL-9000', 'Zqc', 'Highest');
  await emp('pris', 'ZQC-A1', 'Priscillazq', 'Abrokwahzq');
  await emp('james', 'ZQC-A2', 'Jameszq', '—');
  await emp('ag1', 'ZQC-A3', 'Agneszq', 'Cornuzq');
  await emp('ag2', 'ZQC-A4', 'Agneszq', 'Oforizq');
  await emp('tw1', 'ZQC-A5', 'Twinzq', 'Samezq');
  await emp('tw2', 'ZQC-A6', 'Twinzq', 'Samezq');
  await emp('left', 'ZQC-A7', 'Leftzq', 'Gonezq', 'terminated');
  await emp('holder', 'ZQC-9', 'Holderzq', 'Keepszq');
});
test.after(async function () { await cleanup(); await pool.end(); });

test('a new person gets the next ID after the highest, or the one given', async function () {
  assert.equal(await codes.next(), 'BPL-9001');
  var base = { lastName: 'Newzq', departmentId: dept, positionTitle: 'Zqc tester' };
  var a = await employees.create(boss, Object.assign({ firstName: 'Autozq', email: 'zqc.auto@example.com' }, base));
  assert.equal(a.code, 'BPL-9001');
  var b = await employees.create(boss, Object.assign({ firstName: 'Givenzq', email: 'zqc.given@example.com', code: '  zqc-77 ' }, base));
  assert.equal(b.code, 'ZQC-77');
  await rejects(employees.create(boss, Object.assign({ firstName: 'Clashzq', email: 'zqc.clash@example.com', code: 'zqc-77' }, base)), /already Givenzq Newzq's/);
  await rejects(employees.create(boss, Object.assign({ firstName: 'Badzq', email: 'zqc.bad@example.com', code: 'ZQ C/1' }, base)), /letters, numbers and dashes/);
});

test('an ID can be changed on the record, but not to someone else\'s', async function () {
  var r = await employees.update(boss, P.holder, { code: 'zqc-10' });
  assert.equal(r.code, 'ZQC-10');
  await rejects(employees.update(boss, P.holder, { code: 'ZQC-A1' }), /already Priscillazq Abrokwahzq's/);
  await employees.update(boss, P.holder, { code: 'ZQC-9' });
});

test('a pasted list is matched name by name', async function () {
  var text = [
    'Employee ID\tName',
    '9101\tAbrokwahzq Priscillazq', // surname first
    '9102 Jameszq', // one name, and "—" as the last name
    'Agneszq, 9103', // name first; two Agnes: a maybe
    '9104\tNobodyzq Herezq',
    '9105\tTwinzq Samezq', // two with the same name
    '9106\tLeftzq Gonezq', // terminated: not offered
    'ZQC-9\tAgneszq Cornuzq' // an ID someone else holds
  ].join('\n');
  var p = await codes.preview(boss, text);
  assert.deepEqual(p.skipped, ['Employee ID\tName']);
  var by = {};
  p.rows.forEach(function (r) { by[r.code] = r; });
  assert.equal(by['9101'].status, 'match');
  assert.equal(by['9101'].candidates[0].id, P.pris);
  assert.equal(by['9102'].status, 'match');
  assert.equal(by['9102'].candidates[0].id, P.james);
  // Agnes Cornu is matched exactly by the ZQC-9 line, so only Agnes Ofori is a maybe here.
  assert.equal(by['9103'].status, 'maybe');
  assert.deepEqual(by['9103'].candidates.map(function (c) { return c.id; }), [P.ag2]);
  assert.equal(by['9104'].status, 'none');
  assert.equal(by['9105'].status, 'several');
  assert.equal(by['9105'].candidates.length, 2);
  assert.equal(by['9106'].status, 'none');
  assert.equal(by['ZQC-9'].status, 'match');
  assert.equal(by['ZQC-9'].holder.id, P.holder);
});

test('applying sets IDs together, swaps included, and keeps others\' IDs safe', async function () {
  var r = await codes.apply(boss, [{ employeeId: P.pris, code: '9101' }, { employeeId: P.james, code: '9102' }]);
  assert.deepEqual(r, { updated: 2, unchanged: 0 });
  assert.equal(await codeOf(P.pris), '9101');
  // Two people swap IDs in one go.
  await codes.apply(boss, [{ employeeId: P.pris, code: '9102' }, { employeeId: P.james, code: '9101' }]);
  assert.equal(await codeOf(P.pris), '9102');
  assert.equal(await codeOf(P.james), '9101');
  // An ID held by someone not in the batch stays theirs; nothing is changed.
  await rejects(codes.apply(boss, [{ employeeId: P.ag1, code: '9103' }, { employeeId: P.ag2, code: 'ZQC-9' }]), /already Holderzq Keepszq's/);
  assert.equal(await codeOf(P.ag1), 'ZQC-A3');
  await rejects(codes.apply(boss, [{ employeeId: P.ag1, code: '9107' }, { employeeId: P.ag2, code: '9107' }]), /given to two people/);
  await rejects(codes.apply(boss, [{ employeeId: P.left, code: '9108' }]), /has left/);
  var audited = (await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND summary LIKE 'Employee ID of %'", [P.pris])).rows[0].n;
  assert.equal(audited, 2);
});

test('only people who can edit employees can set IDs', async function () {
  var plain = await buildContext((await pool.query("SELECT u.id FROM users u WHERE u.email = 'faith.wanjiru@bplghana.com'")).rows[0].id);
  assert.equal(plain.can('employee.write'), false);
  await rejects(codes.preview(plain, '1 Zq Name'), /employee.write/);
  await rejects(codes.apply(plain, [{ employeeId: P.pris, code: '1' }]), /employee.write/);
});
