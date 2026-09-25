// The audit log: narrowed by words, group of areas, person, dates, removals
// or after-hours actions, paged newest first, and summarised over 30 days.
// Test rows use the Z9AL prefix in their summary.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var auditLog = require('../src/services/audit.service');
var { buildContext } = require('../src/services/context.service');

var kelvin, alice;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function add(action, summary, at, actor) {
  await pool.query('INSERT INTO audit_logs (at, actor_user_id, actor_name, action, entity, entity_id, summary) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [at, actor ? actor.user.id : null, actor ? actor.employee.first_name + ' ' + actor.employee.last_name : 'System', action, 'z9al', 'z9al', summary]);
}
test.before(async function () {
  await pool.query("DELETE FROM audit_logs WHERE summary LIKE 'Z9AL%'");
  kelvin = await ctxFor('kelvin.duho@bplghana.com');
  alice = await ctxFor('alice.kamau@bplghana.com');
  await add('role.permission', 'Z9AL granted a permission', '2021-01-10T10:00:00Z', kelvin);
  await add('invoice.void', 'Z9AL voided an invoice', '2021-01-10T21:30:00Z', kelvin);
  await add('leave.request', 'Z9AL asked for leave', '2021-01-11T09:00:00Z', alice);
  await add('system.cleanup', 'Z9AL nightly tidy', '2021-01-12T02:00:00Z', null);
});
test.after(async function () { await pool.query("DELETE FROM audit_logs WHERE summary LIKE 'Z9AL%'"); await pool.end(); });
function sums(rows) { return rows.filter(function (r) { return /^Z9AL/.test(r.summary); }).map(function (r) { return r.summary; }); }

test('filters, newest first, with the area and group of each action', async function () {
  var all = await auditLog.list(kelvin, { q: 'z9al' });
  assert.deepEqual(sums(all), ['Z9AL nightly tidy', 'Z9AL asked for leave', 'Z9AL voided an invoice', 'Z9AL granted a permission']);
  assert.deepEqual([all[0].group, all[1].group, all[2].group, all[3].group], ['settings', 'people', 'money', 'access']);
  assert.equal(all[3].area, 'role');
  assert.equal(all[3].actorEmployeeId, kelvin.employee.id);
  assert.deepEqual(sums(await auditLog.list(kelvin, { q: 'z9al', group: 'access' })), ['Z9AL granted a permission']);
  assert.deepEqual(sums(await auditLog.list(kelvin, { q: 'z9al', actorId: alice.user.id })), ['Z9AL asked for leave']);
  assert.deepEqual(sums(await auditLog.list(kelvin, { q: 'z9al', actorId: 'system' })), ['Z9AL nightly tidy']);
  assert.deepEqual(sums(await auditLog.list(kelvin, { q: 'z9al', from: '2021-01-11', to: '2021-01-11' })), ['Z9AL asked for leave']);
  assert.deepEqual(sums(await auditLog.list(kelvin, { q: 'z9al', kind: 'removals' })), ['Z9AL voided an invoice']);
  assert.deepEqual(sums(await auditLog.list(kelvin, { q: 'z9al', kind: 'afterhours' })), ['Z9AL nightly tidy', 'Z9AL voided an invoice']);
  assert.deepEqual(sums(await auditLog.list(kelvin, { q: 'z9al', before: '2021-01-11T09:00:00Z' })), ['Z9AL voided an invoice', 'Z9AL granted a permission']);
  // The old call with just the words still works.
  assert.equal(sums(await auditLog.list(kelvin, 'z9al')).length, 4);
  await assert.rejects(auditLog.list(alice, {}), /audit.read/);
});

test('the 30-day summary', async function () {
  await add('user.setStatus', 'Z9AL switched an account off', new Date().toISOString(), kelvin);
  var s = await auditLog.summary(kelvin);
  assert.equal(s.days.length, 30);
  assert.ok(s.days[29].n >= 1);
  assert.ok(s.accessChanges >= 1);
  assert.ok(s.removals >= 0);
  assert.equal(s.latestAccess.summary, 'Z9AL switched an account off');
  assert.ok(s.people.some(function (p) { return p.id === kelvin.user.id && p.n >= 1; }));
  assert.ok(s.actors.some(function (a) { return a.id === 'system'; }));
  assert.ok(s.groups.find(function (g) { return g.group === 'access'; }).n >= 1);
  await assert.rejects(auditLog.summary(alice), /audit.read/);
});
