// My Jobs signed in with a kiosk code (myJobsAccess.service.js,
// routes/myJobs.routes.js): the team code first, then the kiosk code; the
// person's own jobs only; a new team code or a changed kiosk code signs the
// phone out; wrong codes count against the per-address limit.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var pinAuth = require('../src/lib/pinAuth');
var access = require('../src/services/myJobsAccess.service');
var mwo = require('../src/services/maintenanceWorkOrders.service');
var { buildContext } = require('../src/services/context.service');

var server, base, boss, worker, reader, workerPinWas, WRONG;
var PIN = '7302';
var PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function rejects(p, code) { await assert.rejects(p, function (e) { return e.code === code; }); }
async function call(method, path, body, token) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  var res = await fetch(base + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
  var text = await res.text();
  var data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data: data };
}
async function cleanUp() {
  await pool.query("DELETE FROM stored_files WHERE ('db:' || id) IN (SELECT p->>'key' FROM maint_work_orders w, jsonb_array_elements(w.done_photos) p WHERE w.description LIKE 'Zqpin%')");
  await pool.query("DELETE FROM maint_work_orders WHERE description LIKE 'Zqpin%'");
  await pool.query("DELETE FROM maint_routines WHERE name LIKE 'Zqpin%'");
  await pool.query('DELETE FROM myjobs_sessions');
  await pool.query('DELETE FROM myjobs_links');
}

test.before(async function () {
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
  boss = await ctxFor('kelvin.duho@bplghana.com');
  worker = await ctxFor('samuel.kiptoo@bplghana.com');
  reader = await ctxFor('alice.kamau@bplghana.com');
  workerPinWas = (await pool.query('SELECT kiosk_pin_hash FROM employees WHERE id = $1', [worker.employee.id])).rows[0].kiosk_pin_hash;
  // The test's kiosk code is the worker's alone.
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = $1', [pinAuth.hashPin(PIN)]);
  await pool.query('UPDATE employees SET kiosk_pin_hash = $2 WHERE id = $1', [worker.employee.id, pinAuth.hashPin(PIN)]);
  // A kiosk code nobody has.
  var used = new Set((await pool.query('SELECT kiosk_pin_hash FROM employees WHERE kiosk_pin_hash IS NOT NULL')).rows.map(function (r) { return r.kiosk_pin_hash; }));
  WRONG = ['0491', '5837', '6624', '3159', '8076'].find(function (p) { return !used.has(pinAuth.hashPin(p)); });
  await cleanUp();
});
test.after(async function () {
  await cleanUp();
  await pool.query('UPDATE employees SET kiosk_pin_hash = $2 WHERE id = $1', [worker.employee.id, workerPinWas]);
  server.close();
  await pool.end();
});

test('the team code: made for the managers, renewed by them, nobody else', async function () {
  await rejects(access.teamCode(reader), 'forbidden');
  var t = await access.teamCode(boss);
  assert.match(t.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal((await access.teamCode(boss)).code, t.code, 'the same code until renewed');
  // Through the tracker's routes too.
  await rejects(access.renewTeamCode(reader), 'forbidden');
  var fresh = await access.renewTeamCode(boss);
  assert.notEqual(fresh.code, t.code);
  await rejects(access.checkTeam(t.code, 'zq-ip-1'), 'invalid');
  assert.deepEqual(await access.checkTeam(fresh.code.toLowerCase().replace('-', ' '), 'zq-ip-1'), { ok: true }, 'typed any old way');
});

test('signed in with a kiosk code: own jobs only, no permissions; done needs a photo', async function () {
  var team = (await access.teamCode(boss)).code;
  var mine = await mwo.create(boss, { description: 'Zqpin fix the fan', location: 'BPL', assignedToId: worker.employee.id, scheduledOn: new Date().toISOString().slice(0, 10) });
  var notMine = await mwo.create(boss, { description: 'Zqpin someone else\'s job', location: 'BPL', assignedToId: boss.employee.id });

  // Over HTTP, as the phone does.
  var r = await call('POST', '/api/myjobs/sign-in', { team: 'WRONGCOD', pin: PIN });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /team code/);
  r = await call('POST', '/api/myjobs/sign-in', { team: team, pin: WRONG });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/myjobs/sign-in', { team: team, pin: PIN });
  assert.equal(r.status, 200);
  var token = r.data.token;
  assert.match(token, /^[0-9a-f]{64}$/);

  r = await call('GET', '/api/myjobs/mine', undefined, token);
  assert.equal(r.status, 200);
  assert.ok(r.data.todo.some(function (o) { return o.id === mine.id; }));
  assert.ok(!r.data.todo.some(function (o) { return o.id === notMine.id; }));
  assert.equal(r.data.me.id, worker.employee.id);
  assert.deepEqual(r.data.can, { manage: false, seeAll: false });

  assert.equal((await call('GET', '/api/myjobs/jobs/' + notMine.id, undefined, token)).status, 404, 'someone else\'s job is not there');
  assert.equal((await call('GET', '/api/myjobs/mine')).status, 401, 'no sign-in, nothing');
  assert.equal((await call('GET', '/api/myjobs/mine', undefined, 'f'.repeat(64))).status, 401);
  r = await call('POST', '/api/myjobs/jobs/' + mine.id + '/status', { status: 'completed' }, token);
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /photo of the finished work/);
  r = await call('POST', '/api/myjobs/jobs/' + mine.id + '/status', { status: 'completed', photos: [PHOTO], note: 'Zqpin done' }, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'completed');
  assert.equal(r.data.donePhotos.length, 1);
  var shot = await fetch(base + '/api/myjobs/jobs/' + mine.id + '/photos/0', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(shot.status, 200);
  assert.match(shot.headers.get('content-type'), /^image\/png/);
  assert.equal((await call('POST', '/api/myjobs/jobs/' + notMine.id + '/status', { status: 'in_progress' }, token)).status, 404);
  var audited = (await pool.query("SELECT actor_name FROM audit_logs WHERE action = 'myjobs.sign_in' AND entity_id = $1 ORDER BY at DESC LIMIT 1", [worker.employee.id])).rows[0];
  assert.ok(audited, 'the sign-in is on the record');

  // Adding a job and a routine of their own from the phone.
  r = await call('POST', '/api/myjobs/jobs', { description: 'Zqpin tap dripping in the canteen', location: 'BPL', category: 'plumbing' }, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.assignedTo.id, worker.employee.id);
  r = await call('POST', '/api/myjobs/routines', { name: 'Zqpin clean the gutters', everyDays: 30 }, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.assignedTo.id, worker.employee.id);
  var rid = r.data.id;
  assert.equal((await call('PATCH', '/api/myjobs/routines/' + rid, { everyDays: 45 }, token)).data.everyDays, 45);
  assert.equal((await call('POST', '/api/myjobs/routines/' + rid + '/stop', {}, token)).status, 200);
  assert.equal((await call('POST', '/api/myjobs/jobs', { description: 'Zqpin no sign-in' })).status, 401);

  // Signed out: the token is no good.
  assert.equal((await call('POST', '/api/myjobs/sign-out', {}, token)).status, 200);
  assert.equal((await call('GET', '/api/myjobs/mine', undefined, token)).status, 401);
});

test('a new team code or a changed kiosk code signs the phone out', async function () {
  var team = (await access.teamCode(boss)).code;
  var a = await access.signIn(team, PIN, 'zq-ip-2', 'zq phone');
  assert.equal((await access.contextOf(a.token)).employee.id, worker.employee.id);
  await access.renewTeamCode(boss);
  await rejects(access.contextOf(a.token), 'auth');
  await rejects(access.signIn(team, PIN, 'zq-ip-2'), 'invalid');

  var team2 = (await access.teamCode(boss)).code;
  var b = await access.signIn(team2, PIN, 'zq-ip-2');
  assert.ok(await access.contextOf(b.token));
  await pool.query('UPDATE employees SET kiosk_pin_hash = $2 WHERE id = $1', [worker.employee.id, pinAuth.hashPin('7303')]);
  await rejects(access.contextOf(b.token), 'auth');
  await pool.query('UPDATE employees SET kiosk_pin_hash = $2 WHERE id = $1', [worker.employee.id, pinAuth.hashPin(PIN)]);
});

test('wrong codes count: five, then a wait', async function () {
  var team = (await access.teamCode(boss)).code;
  var ip = 'zq-ip-3';
  await rejects(access.signIn('ABCDEFGH', PIN, ip), 'invalid');
  await rejects(access.checkTeam('ABCDEFGH', ip), 'invalid');
  for (var i = 0; i < 3; i++) await rejects(access.signIn(team, WRONG, ip), 'auth');
  await rejects(access.signIn(team, PIN, ip), 'ratelimited', 'even the right codes wait');
});
