// A team on a marketing request (mkRequests.service.js, migration 0147):
// marketing adds anyone on staff besides the one leading it; they see the
// request in theirs, are told when added, hear the comments and the asker's
// answer; taken off, they no longer see it. Added, they get a text too
// (sms.service faked: nothing is sent). On throwaway ZMT requests.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var requests = require('../src/services/mkRequests.service');

var boss, staff, helper;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function cleanup() {
  await pool.query("DELETE FROM notifications WHERE link LIKE '/mkrequests%' AND link IN (SELECT '/mkrequests?open=' || id FROM marketing_requests WHERE title LIKE 'ZMT%')");
  await pool.query("DELETE FROM marketing_requests WHERE title LIKE 'ZMT%'");
}
async function told(who, id) {
  return (await pool.query('SELECT title FROM notifications WHERE employee_id = $1 AND link = $2 ORDER BY at', [who, '/mkrequests?open=' + id])).rows.map(function (n) { return n.title; });
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = await ctxFor('alice.kamau@bplghana.com');
  helper = await ctxFor('john.sitati@bplghana.com');
  await cleanup();
});
test.after(async function () { await cleanup(); await pool.end(); });

test('marketing puts a team on a request; they see it, are told, and hear what happens', async function () {
  var r = await requests.create(staff, { company: 'BPL', title: 'ZMT Cars for sale', kind: 'other', brief: 'Two cars' });
  r = await requests.update(boss, r.id, { title: r.title, kind: r.kind, brief: r.brief, assignedTo: boss.employee.id });
  await assert.rejects(requests.get(helper, r.id), /not yours/);
  await assert.rejects(requests.setTeam(staff, r.id, { employeeIds: [helper.employee.id] }), /marketing.manage/);
  await assert.rejects(requests.setTeam(boss, r.id, { employeeIds: ['00000000-0000-0000-0000-000000000000'] }), /staff list/);
  await assert.rejects(requests.setTeam(boss, r.id, {}), /who is on the team/);

  // The one leading it is left out of the team; the helper is added and told.
  r = await requests.setTeam(boss, r.id, { employeeIds: [helper.employee.id, boss.employee.id, helper.employee.id] });
  assert.deepEqual(r.team.map(function (m) { return m.id; }), [helper.employee.id]);
  assert.ok(r.team[0].name);
  assert.deepEqual(await told(helper.employee.id, r.id), ['You are on the team for ' + r.ref]);

  // They see it, in their own requests too.
  assert.equal((await requests.get(helper, r.id)).id, r.id);
  assert.ok((await requests.list(helper, {})).requests.some(function (x) { return x.id === r.id && x.team.length === 1; }));

  // The asker's comment reaches the team; a team member's reaches the asker and the lead.
  await requests.comment(staff, r.id, { body: 'ZMT Both are silver' });
  assert.ok((await told(helper.employee.id, r.id)).indexOf('New comment on ' + r.ref) >= 0);
  await requests.comment(helper, r.id, { body: 'ZMT Photos on Friday' });
  assert.ok((await told(staff.employee.id, r.id)).indexOf('New comment on ' + r.ref) >= 0);
  assert.ok((await told(boss.employee.id, r.id)).indexOf('New comment on ' + r.ref) >= 0);

  // The asker's answer on the finished work reaches the team.
  await requests.setStatus(boss, r.id, { status: 'in_progress' });
  await requests.setStatus(boss, r.id, { status: 'review' });
  await requests.setStatus(staff, r.id, { status: 'done' });
  assert.ok((await told(helper.employee.id, r.id)).indexOf(r.ref + ' is done') >= 0);

  // Made the lead, they leave the team list; taken off, they no longer see it.
  r = await requests.update(boss, r.id, { title: r.title, kind: r.kind, brief: r.brief, assignedTo: helper.employee.id });
  assert.deepEqual(r.team, []);
  r = await requests.update(boss, r.id, { title: r.title, kind: r.kind, brief: r.brief, assignedTo: boss.employee.id });
  r = await requests.setTeam(boss, r.id, { employeeIds: [helper.employee.id] });
  r = await requests.setTeam(boss, r.id, { employeeIds: [] });
  assert.deepEqual(r.team, []);
  await assert.rejects(requests.get(helper, r.id), /not yours/);
});

test('someone put on a team gets a text too (faked here): the request, its date and a link; not without a phone, or with texts off', async function () {
  var sms = require('../src/services/sms.service');
  var real = { configured: sms.configured, send: sms.send };
  var sent = [];
  var phone = (await pool.query('SELECT phone FROM employees WHERE id = $1', [helper.employee.id])).rows[0].phone;
  var messaging = (await pool.query('SELECT messaging FROM settings WHERE id = 1')).rows[0].messaging;
  sms.configured = function () { return true; };
  sms.send = async function (o) { sent.push(o); return { id: null, to: o.to }; };
  try {
    await pool.query("UPDATE employees SET phone = '0200000001' WHERE id = $1", [helper.employee.id]);
    var r = await requests.create(staff, { company: 'BPL', title: 'ZMT Banner for the gate', kind: 'banner', dueOn: '2031-03-14' });
    r = await requests.setTeam(boss, r.id, { employeeIds: [helper.employee.id] });
    assert.deepEqual(r.texts, { sent: 1, noPhone: 0, failed: 0 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '0200000001');
    assert.equal(sent[0].purpose, 'auto_request_team');
    assert.match(sent[0].message, new RegExp('^Bamboo OS: you are on the team for ' + r.ref + ' ZMT Banner for the gate, needed by Fri 14 Mar\\.'));
    assert.match(sent[0].message, new RegExp('/mkrequests\\?open=' + r.id + '$'));
    assert.equal(r.team.length, 1, 'the text never changes who is on the team');

    // Saving the same team again sends nothing; taken off and put back, they are texted again.
    r = await requests.setTeam(boss, r.id, { employeeIds: [helper.employee.id] });
    assert.equal(r.texts, null);
    assert.equal(sent.length, 1);

    // No phone on their record: told in the OS only.
    await requests.setTeam(boss, r.id, { employeeIds: [] });
    await pool.query("UPDATE employees SET phone = '' WHERE id = $1", [helper.employee.id]);
    r = await requests.setTeam(boss, r.id, { employeeIds: [helper.employee.id] });
    assert.deepEqual(r.texts, { sent: 0, noPhone: 1, failed: 0 });
    assert.equal(sent.length, 1);

    // Texts for request teams turned off in Company settings.
    await requests.setTeam(boss, r.id, { employeeIds: [] });
    await pool.query("UPDATE employees SET phone = '0200000001' WHERE id = $1", [helper.employee.id]);
    await pool.query('UPDATE settings SET messaging = $1 WHERE id = 1', [JSON.stringify(Object.assign({}, messaging || {}, { requestTeamBySms: false }))]);
    r = await requests.setTeam(boss, r.id, { employeeIds: [helper.employee.id] });
    assert.equal(r.texts, null);
    assert.equal(sent.length, 1);
    assert.equal(r.team.length, 1);
  } finally {
    sms.configured = real.configured; sms.send = real.send;
    await pool.query('UPDATE employees SET phone = $2 WHERE id = $1', [helper.employee.id, phone]);
    await pool.query('UPDATE settings SET messaging = $1 WHERE id = 1', [JSON.stringify(messaging || {})]);
  }
});

test('the people who can be put on a team: everyone active, marketing marked; marketing.manage only', async function () {
  var all = await requests.people(boss);
  assert.ok(all.length > 2);
  assert.ok(all.some(function (p) { return p.id === helper.employee.id; }));
  assert.ok(all.some(function (p) { return p.id === boss.employee.id && p.marketing; }));
  assert.ok(all.every(function (p) { return 'firstName' in p && 'positionTitle' in p; }));
  await assert.rejects(requests.people(staff), /marketing.manage/);
});
