// An employee's hire date can be fixed after they are added: people added
// from a list or the clock got the day they were added.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var employees = require('../src/services/employees.service');
var { buildContext } = require('../src/services/context.service');

var boss, dept, ids = [];
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0].id;
});
test.after(async function () {
  await pool.query('DELETE FROM leave_balances WHERE employee_id = ANY($1::uuid[])', [ids]).catch(function () {});
  await pool.query('DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])', [ids]).catch(function () {});
  await pool.query('DELETE FROM employees WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

test('the hire date can be changed, checked, and is noted in the audit log', async function () {
  var a = await employees.create(boss, { firstName: 'Zqh', lastName: 'One', email: 'zqh.one@example.com', departmentId: dept, positionTitle: 'Zq weaver', employmentType: 'permanent' });
  ids.push(a.id);
  assert.equal(String(a.hireDate).slice(0, 10), new Date().toISOString().slice(0, 10), 'left out, it is the day they were added');

  var b = await employees.update(boss, a.id, { hireDate: '2019-03-11' });
  assert.equal(String(b.hireDate).slice(0, 10), '2019-03-11');
  var row = (await pool.query('SELECT hire_date FROM employees WHERE id = $1', [a.id])).rows[0];
  assert.equal(String(row.hire_date).slice(0, 10), '2019-03-11');
  var log = (await pool.query("SELECT summary FROM audit_logs WHERE entity_id = $1 AND action = 'employee.update' ORDER BY at DESC LIMIT 1", [a.id])).rows[0];
  assert.match(log.summary, /hireDate/);

  await assert.rejects(employees.update(boss, a.id, { hireDate: '' }), /Hire date is required/);
  await assert.rejects(employees.update(boss, a.id, { hireDate: '2019-02-30' }), /valid date/);
  await assert.rejects(employees.update(boss, a.id, { hireDate: '1919-03-11' }), /check the year/);
  var farAhead = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  await assert.rejects(employees.update(boss, a.id, { hireDate: farAhead }), /check the year/);
  await assert.rejects(employees.create(boss, { firstName: 'Zqh', lastName: 'Two', email: 'zqh.two@example.com', departmentId: dept, positionTitle: 'Zq weaver', hireDate: '2091-01-01' }), /check the year/);

  // Saving the form unchanged leaves it alone.
  await employees.update(boss, a.id, { hireDate: '2019-03-11', firstName: 'Zqh' });
  var last = (await pool.query("SELECT summary FROM audit_logs WHERE entity_id = $1 AND action = 'employee.update' ORDER BY at DESC LIMIT 1", [a.id])).rows[0];
  assert.doesNotMatch(last.summary, /hireDate/);
});

test('without employee.write the hire date cannot be changed', async function () {
  var ro = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (p) { return p !== 'employee.write' && boss.can(p); } });
  await assert.rejects(employees.update(ro, ids[0], { hireDate: '2018-01-01' }), /employee.write/);
});

// ── hire dates from a pasted list ─────────────────────────────────────
var hireList = require('../src/services/employeeHireDates.service');

test('a pasted list: dates read in any common form, people by ID or name, all or nothing', async function () {
  var mk = async function (first, last) {
    var e = await employees.create(boss, { firstName: first, lastName: last, email: (first + '.' + last).toLowerCase().replace(/\s+/g, '') + '@example.com', departmentId: dept, positionTitle: 'Zq weaver' });
    ids.push(e.id); return e;
  };
  var a = await mk('Zqh', 'Abena Ofori'), b = await mk('Zqh', 'Kwame Ntim'), c = await mk('Zqh', 'Esi Dapaah');
  await mk('Zqh', 'Yaa Asante');
  var p = await hireList.preview(boss, [
    a.code + '\t25/12/2018',                 // by ID, day first (25 can only be a day)
    'Ntim Kwame Zqh, 2019-03-11',            // by name, any order, ISO
    'Zqh Esi Dapaah\t11 Mar 2020',           // a month name
    'Zqh Nobody Here\t01/02/2017',           // not in the OS
    'Zqh Yaa\t3 April 2016',                 // a close name: a maybe
    'just some words',                       // no date
    'Zqh Abena Ofori 31/02/2019'             // not a real date
  ].join('\n'));
  assert.equal(p.order, 'dmy');
  var row = function (i) { return p.rows[i]; };
  assert.equal(row(0).status, 'match'); assert.equal(row(0).by, 'id'); assert.equal(row(0).candidates[0].id, a.id); assert.equal(row(0).date, '2018-12-25');
  assert.equal(row(1).status, 'match'); assert.equal(row(1).candidates[0].id, b.id); assert.equal(row(1).date, '2019-03-11');
  assert.equal(row(2).status, 'match'); assert.equal(row(2).date, '2020-03-11');
  assert.equal(row(3).status, 'none');
  assert.equal(row(4).status, 'maybe');
  assert.deepEqual(p.skipped.map(function (s) { return s.why; }), ['no-date', 'bad-date']);

  // Month first when the list shows it; or when asked.
  assert.equal((await hireList.preview(boss, 'Zqh Kwame Ntim\t12/25/2018')).order, 'mdy');
  var asked = await hireList.preview(boss, 'Zqh Kwame Ntim\t03/04/2019', 'mdy');
  assert.equal(asked.ambiguous, true);
  assert.equal(asked.rows[0].date, '2019-03-04');
  // The same person twice is flagged.
  assert.equal((await hireList.preview(boss, 'Zqh Kwame Ntim 01/01/2019\n' + b.code + ' 02/02/2019')).rows[0].repeated, true);

  var r = await hireList.apply(boss, [{ employeeId: a.id, hireDate: '2018-12-25' }, { employeeId: b.id, hireDate: '2019-03-11' }, { employeeId: c.id, hireDate: String(c.hireDate).slice(0, 10) }]);
  assert.deepEqual(r, { updated: 2, unchanged: 1 });
  var now = (await pool.query('SELECT id, hire_date FROM employees WHERE id = ANY($1::uuid[])', [[a.id, b.id]])).rows;
  assert.deepEqual(now.map(function (x) { return String(x.hire_date).slice(0, 10); }).sort(), ['2018-12-25', '2019-03-11']);
  var log = (await pool.query("SELECT summary FROM audit_logs WHERE entity_id = $1 ORDER BY at DESC LIMIT 1", [a.id])).rows[0];
  assert.match(log.summary, /from a list/);

  // A bad date anywhere stops the lot.
  await assert.rejects(hireList.apply(boss, [{ employeeId: a.id, hireDate: '2015-01-01' }, { employeeId: b.id, hireDate: '1900-01-01' }]), /check the year/);
  assert.equal(String((await pool.query('SELECT hire_date FROM employees WHERE id = $1', [a.id])).rows[0].hire_date).slice(0, 10), '2018-12-25');
  await assert.rejects(hireList.apply(boss, [{ employeeId: a.id, hireDate: '2015-01-01' }, { employeeId: a.id, hireDate: '2016-01-01' }]), /chosen twice/);
  var ro = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (q) { return q !== 'employee.write' && boss.can(q); } });
  await assert.rejects(hireList.preview(ro, a.code + ' 01/01/2019'), /employee.write/);
  await assert.rejects(hireList.apply(ro, [{ employeeId: a.id, hireDate: '2015-01-01' }]), /employee.write/);
});
