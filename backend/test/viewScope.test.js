/*
 * Who a manager can see (viewScope.service.js + rbac.visibleEmployee):
 * the departments and people HR ticks for them, plus the people who report
 * to them. Uses the seeded staff; every manager's ticks are put back to
 * their own department afterwards (as the seed leaves them).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var employees = require('../src/services/employees.service');
var attendance = require('../src/services/attendance.service');
var viewScope = require('../src/services/viewScope.service');

async function ctxOf(email) {
  var u = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
  return buildContext(u.id);
}
async function idOf(code) { return (await pool.query('SELECT id FROM employees WHERE code = $1', [code])).rows[0].id; }
async function deptOf(code) { return (await pool.query('SELECT id FROM departments WHERE code = $1', [code])).rows[0].id; }
function codes(list) { return list.map(function (e) { return e.code; }).sort(); }

var hr, samuel, isreal, alice, frank;
var ids = {};

test.before(async function () {
  hr = await ctxOf('albert.awini@bplghana.com');
  samuel = await ctxOf('samuel.kiptoo@bplghana.com');
  isreal = await ctxOf('isreal.omozuafo@bplghana.com');
  alice = await ctxOf('alice.kamau@bplghana.com');
  frank = await ctxOf('frank.kampewu@bplghana.com');
  for (var c of ['BPL-006', 'BPL-007', 'BPL-010', 'BPL-011', 'BPL-013', 'BPL-015', 'BPL-016', 'BPL-018']) ids[c] = await idOf(c);
});

test.after(async function () {
  // Back to the seed's state: each manager sees their own department.
  await pool.query('DELETE FROM employee_view_scopes WHERE company_id IS NOT NULL');
  await pool.query("DELETE FROM employees WHERE code LIKE 'VST-%'");
  for (var e of [samuel, isreal]) {
    await pool.query('DELETE FROM employee_view_scopes WHERE viewer_id = $1', [e.employee.id]);
    await pool.query('INSERT INTO employee_view_scopes (viewer_id, department_id) VALUES ($1, $2)', [e.employee.id, e.employee.department_id]);
  }
  await pool.end();
});

test('a manager starts out seeing their own department (as before), and HR sees why', async function () {
  var list = codes(await employees.list(samuel, {}));
  assert.ok(list.includes('BPL-015'), 'Lydia, Factory, not his report');
  assert.ok(list.includes('BPL-007'));
  assert.ok(!list.includes('BPL-018'), 'Victor is in Sales');

  var s = await viewScope.get(hr, samuel.employee.id);
  assert.equal(s.seesAll, false);
  assert.equal(s.managerial, true);
  assert.deepEqual(s.departments.map(function (d) { return d.name; }), ['Factory']);
  assert.equal(s.people.length, 0);
  assert.equal(s.teamCount, 1, 'Moses reports to him');
  assert.equal(s.canEdit, true);
});

test('HR narrows a manager to hand-picked people: directory, records and attendance follow', async function () {
  var s = await viewScope.set(hr, samuel.employee.id, { departmentIds: [], employeeIds: [ids['BPL-018'], samuel.employee.id] });
  assert.equal(s.departments.length, 0);
  assert.deepEqual(s.people.map(function (p) { return p.code; }), ['BPL-018'], 'himself is never a tick');
  assert.equal(s.visibleCount, 2, 'Moses (team) + Victor');

  var fresh = await ctxOf('samuel.kiptoo@bplghana.com');
  assert.deepEqual(codes(await employees.list(fresh, {})), ['BPL-006', 'BPL-016', 'BPL-018']);
  await assert.rejects(employees.get(fresh, ids['BPL-015']), /do not have access/);
  assert.equal((await employees.get(fresh, ids['BPL-018'])).code, 'BPL-018');

  var att = await attendance.list(fresh, {});
  assert.deepEqual(att.rows.map(function (r) { return r.code; }).sort(), ['BPL-006', 'BPL-016', 'BPL-018']);
});

test('a ticked department shows everyone in it; the reporting line goes all the way down', async function () {
  await viewScope.set(hr, isreal.employee.id, { departmentIds: [], employeeIds: [] });
  var fresh = await ctxOf('isreal.omozuafo@bplghana.com');
  // Kevin and Alice report to him; John reports to Kevin.
  assert.deepEqual(codes(await employees.list(fresh, {})), ['BPL-011', 'BPL-012', 'BPL-013', 'BPL-014']);

  await viewScope.set(hr, isreal.employee.id, { departmentIds: [await deptOf('FCTY')] });
  fresh = await ctxOf('isreal.omozuafo@bplghana.com');
  var list = codes(await employees.list(fresh, {}));
  ['BPL-006', 'BPL-007', 'BPL-010', 'BPL-015', 'BPL-016'].forEach(function (c) { assert.ok(list.includes(c), c); });
  assert.ok(!list.includes('BPL-018'));
});

test('roles that see everyone are unaffected', async function () {
  var s = await viewScope.get(hr, frank.employee.id);
  assert.equal(s.seesAll, true);
  assert.equal(s.visibleCount, s.totalCount);
  assert.ok(codes(await employees.list(frank, {})).includes('BPL-018'));
});

test('only HR changes it; anyone can look at their own', async function () {
  await assert.rejects(viewScope.set(samuel, samuel.employee.id, { departmentIds: [] }), /employee\.write/);
  await assert.rejects(viewScope.get(alice, samuel.employee.id), /employee\.write/);
  var mine = await viewScope.get(alice, alice.employee.id);
  assert.equal(mine.managerial, false);
  assert.equal(mine.canEdit, false);
  assert.equal(mine.visibleCount, 0);
  await assert.rejects(viewScope.set(hr, samuel.employee.id, { departmentIds: ['00000000-0000-0000-0000-000000000000'] }), /no longer exists/);
  await assert.rejects(viewScope.set(hr, samuel.employee.id, { employeeIds: 'x' }), /must be a list/);
});


// ---- By company -----------------------------------------------------------

async function companyId(code) { return (await pool.query('SELECT id FROM companies WHERE code = $1', [code])).rows[0].id; }

test('someone who sees everyone can be limited to one company, and to nothing outside it', async function () {
  var admin = await ctxOf('kelvin.duho@bplghana.com');
  var sbr = await companyId('SBR');
  var dept = (await pool.query("SELECT id FROM departments WHERE company_id = $1 ORDER BY name LIMIT 1", [sbr])).rows[0].id;
  var waiter = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status) " +
    "VALUES ('VST-1', 'Vst', 'Waiter', 'vst.waiter@example.com', $1, 'Waiter', 'permanent', '2026-01-01', 'active') RETURNING id", [dept])).rows[0].id;

  var s = await viewScope.set(hr, frank.employee.id, { companyIds: [sbr] });
  assert.equal(s.seesAll, true);
  assert.equal(s.companiesLimited, true);
  assert.deepEqual(s.companies.map(function (c) { return c.name; }), ['Star Bar Restaurant']);

  var gm = await ctxOf('frank.kampewu@bplghana.com');
  var list = codes(await employees.list(gm, {}));
  assert.ok(list.includes('VST-1'), 'Star Bar staff');
  assert.ok(list.includes('BPL-005'), 'himself');
  assert.ok(list.includes('BPL-007'), 'Faith reports to him');
  assert.ok(!list.includes('BPL-018'), 'not Bamboo Products staff outside his team');
  assert.equal(s.visibleCount, list.length - 1);
  var att = await attendance.list(gm, {});
  assert.ok(!att.rows.some(function (r) { return r.code === 'BPL-018'; }));
  assert.ok(att.rows.some(function (r) { return r.code === 'VST-1'; }));

  // Not just hidden: actions on people outside are refused too.
  await assert.rejects(employees.update(gm, ids['BPL-018'], { phone: '0200000009' }), /outside the companies/);
  await employees.update(gm, waiter, { phone: '0200000009' });

  // An administrator can change it; nobody changes their own.
  await assert.rejects(viewScope.set(hr, hr.employee.id, { companyIds: [sbr] }), /cannot change who you can see yourself/);
  assert.equal((await viewScope.get(hr, hr.employee.id)).canEdit, false);
  await viewScope.set(admin, frank.employee.id, { companyIds: [] });
  gm = await ctxOf('frank.kampewu@bplghana.com');
  assert.ok(codes(await employees.list(gm, {})).includes('BPL-018'), 'no companies ticked: every company again');
});

test('someone limited to a company cannot hand out more than they see', async function () {
  var admin = await ctxOf('kelvin.duho@bplghana.com');
  var sbr = await companyId('SBR'), bpl = await companyId('BPL');
  await viewScope.set(admin, hr.employee.id, { companyIds: [sbr] });
  var limitedHr = await ctxOf('albert.awini@bplghana.com');

  var waiter = await idOf('VST-1');
  await assert.rejects(viewScope.set(limitedHr, waiter, { companyIds: [bpl] }), /companies and departments you can see yourself/);
  await assert.rejects(viewScope.set(limitedHr, waiter, { departmentIds: [await deptOf('FCTY')] }), /companies and departments you can see yourself/);
  await assert.rejects(viewScope.set(limitedHr, waiter, { employeeIds: [ids['BPL-018']] }), /people you can see yourself/);
  assert.equal((await viewScope.set(limitedHr, waiter, { companyIds: [sbr] })).companies.length, 1, 'within her own company is fine');
  // Isreal is Bamboo Products — outside what she sees now.
  await assert.rejects(viewScope.get(limitedHr, isreal.employee.id), /outside the companies/);
  // A Star Bar manager whose role sees everyone: "nothing ticked" would
  // mean every company, more than she can see.
  var uid = (await pool.query(
    "INSERT INTO users (employee_id, email, password_hash, status, must_change_password) VALUES ($1, 'vst.waiter@example.com', 'x', 'active', false) RETURNING id", [waiter])).rows[0].id;
  await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'general_manager'", [uid]);
  await assert.rejects(viewScope.set(limitedHr, waiter, { companyIds: [] }), /Tick the companies/);
  await pool.query('DELETE FROM users WHERE id = $1', [uid]);
  await viewScope.set(admin, hr.employee.id, { companyIds: [] });
});
