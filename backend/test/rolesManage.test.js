// Roles: members and last change listed for role managers, a new role can
// start from another's permissions, custom roles can be renamed (built-in
// ones keep their names), a whole group of permissions can be granted or
// revoked at once, and the latest changes come from the audit log.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var roles = require('../src/services/roles.service');
var { buildContext } = require('../src/services/context.service');

var kelvin, alice;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function cleanup() {
  await pool.query("DELETE FROM audit_logs WHERE entity = 'role' AND summary LIKE '%Zqr%'");
  await pool.query("DELETE FROM roles WHERE name LIKE 'Zqr%'");
}
test.before(async function () { await cleanup(); kelvin = await ctxFor('kelvin.duho@bplghana.com'); alice = await ctxFor('alice.kamau@bplghana.com'); });
test.after(async function () { await cleanup(); await pool.end(); });
function byName(list, n) { return list.find(function (r) { return r.name === n; }); }

test('members and the sensitive permissions are listed for role managers', async function () {
  var list = await roles.list(kelvin);
  var admin = list.find(function (r) { return r.key === 'administrator'; });
  assert.ok(admin.members.some(function (m) { return m.email === 'kelvin.duho@bplghana.com' && m.name && m.status === 'active'; }));
  assert.equal(admin.members.length, admin.userCount);
  var cat = await roles.permissionCatalogue();
  assert.equal(cat.find(function (p) { return p.key === 'role.manage'; }).sensitive, true);
  assert.equal(cat.find(function (p) { return p.key === 'task.read'; }).sensitive, false);
});

test('copy, rename, bulk grant and revoke, and the change history', async function () {
  var sup = (await roles.list(kelvin)).find(function (r) { return r.key === 'supervisor'; }) || (await roles.list(kelvin)).find(function (r) { return !r.isSystem || r.key !== 'administrator'; });
  var copy = await roles.create(kelvin, { name: 'Zqr Night supervisor', description: 'Zqr covers nights', copyFrom: sup.id });
  assert.deepEqual(copy.permissions.slice().sort(), sup.permissions.slice().sort());
  await assert.rejects(roles.create(kelvin, { name: 'Zqr Bad copy', copyFrom: '00000000-0000-0000-0000-000000000000' }), /copy from was not found/);

  var renamed = await roles.update(kelvin, copy.id, { name: 'Zqr Night lead' });
  assert.equal(renamed.name, 'Zqr Night lead');
  assert.equal(renamed.description, 'Zqr covers nights');
  await assert.rejects(roles.update(kelvin, sup.id, { name: 'Zqr Supervisors' }), /keep their names/);
  var desc = await roles.update(kelvin, sup.id, { description: sup.description });
  assert.equal(desc.name, sup.name);
  var other = await roles.create(kelvin, { name: 'Zqr Other' });
  await assert.rejects(roles.update(kelvin, other.id, { name: 'zqr night LEAD' }), /already exists/);

  var group = ['poki.read', 'poki.manage'];
  var granted = await roles.setPermission(kelvin, other.id, group, true);
  assert.deepEqual(granted.permissions.slice().sort(), group.slice().sort());
  var revoked = await roles.setPermission(kelvin, other.id, ['poki.manage'], false);
  assert.deepEqual(revoked.permissions, ['poki.read']);
  await assert.rejects(roles.setPermission(kelvin, other.id, ['poki.read', 'zqr.fake'], true), /Unknown permission/);
  var admin = (await roles.list(kelvin)).find(function (r) { return r.key === 'administrator'; });
  await assert.rejects(roles.setPermission(kelvin, admin.id, ['poki.read'], false), /locked/);

  var ch = await roles.changes(kelvin);
  assert.match(ch[0].summary, /Revoked poki\.manage from Zqr Other/);
  assert.ok(ch.some(function (c) { return /Renamed role "Zqr Night supervisor" to "Zqr Night lead"/.test(c.summary); }));
  assert.ok(ch.some(function (c) { return /Created role "Zqr Night supervisor" from/.test(c.summary); }));
  await assert.rejects(roles.changes(alice), /role.manage/);
  assert.equal(byName(await roles.list(alice), 'Zqr Other') ? byName(await roles.list(alice), 'Zqr Other').members : null, null);
});
