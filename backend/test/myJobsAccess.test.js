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

var server, base, boss, worker, reader, workerPinWas, bossPinWas, WRONG;
var PIN = '7302', BOSS_PIN = '7304';
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
  await pool.query('DELETE FROM myjobs_rights');
  await pool.query("DELETE FROM notifications WHERE link = '/myjobs' AND title LIKE '%My Jobs%'");
}

test.before(async function () {
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
  boss = await ctxFor('kelvin.duho@bplghana.com');
  // A technician: no right to give out work orders (task.manage).
  worker = await ctxFor('alice.kamau@bplghana.com');
  assert.equal(worker.can('task.manage'), false);
  reader = worker;
  workerPinWas = (await pool.query('SELECT kiosk_pin_hash FROM employees WHERE id = $1', [worker.employee.id])).rows[0].kiosk_pin_hash;
  bossPinWas = (await pool.query('SELECT kiosk_pin_hash FROM employees WHERE id = $1', [boss.employee.id])).rows[0].kiosk_pin_hash;
  // The test's kiosk codes are theirs alone.
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [[pinAuth.hashPin(PIN), pinAuth.hashPin(BOSS_PIN)]]);
  await pool.query('UPDATE employees SET kiosk_pin_hash = $2 WHERE id = $1', [worker.employee.id, pinAuth.hashPin(PIN)]);
  await pool.query('UPDATE employees SET kiosk_pin_hash = $2 WHERE id = $1', [boss.employee.id, pinAuth.hashPin(BOSS_PIN)]);
  // A kiosk code nobody has.
  var used = new Set((await pool.query('SELECT kiosk_pin_hash FROM employees WHERE kiosk_pin_hash IS NOT NULL')).rows.map(function (r) { return r.kiosk_pin_hash; }));
  WRONG = ['0491', '5837', '6624', '3159', '8076'].find(function (p) { return !used.has(pinAuth.hashPin(p)); });
  await cleanUp();
});
test.after(async function () {
  await cleanUp();
  await pool.query('UPDATE employees SET kiosk_pin_hash = $2 WHERE id = $1', [worker.employee.id, workerPinWas]);
  await pool.query('UPDATE employees SET kiosk_pin_hash = $2 WHERE id = $1', [boss.employee.id, bossPinWas]);
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
  assert.deepEqual(r.data.can, { manage: false, seeAll: false, seeTeam: false });

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

  // Photos with what they add: of the problem, of what a routine looks after.
  r = await call('POST', '/api/myjobs/jobs', { description: 'Zqpin socket burnt in the store', photos: [PHOTO, PHOTO] }, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.photos.length, 2);
  var burnt = r.data.id;
  shot = await fetch(base + '/api/myjobs/jobs/' + burnt + '/report-photos/1', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(shot.status, 200);
  assert.match(shot.headers.get('content-type'), /^image\/png/);
  assert.equal((await fetch(base + '/api/myjobs/jobs/' + burnt + '/report-photos/5', { headers: { Authorization: 'Bearer ' + token } })).status, 404);
  r = await call('POST', '/api/myjobs/routines', { name: 'Zqpin check the fire extinguishers', everyDays: 90, photos: [PHOTO] }, token);
  assert.equal(r.data.photos.length, 1);
  var fire = r.data.id;
  assert.equal((await fetch(base + '/api/myjobs/routines/' + fire + '/photos/0', { headers: { Authorization: 'Bearer ' + token } })).status, 200);
  assert.equal((await fetch(base + '/api/maint-work-orders/routines/' + fire + '/photos/0')).status, 401, 'not without signing in');
  // The routine's photos go with the job it becomes.
  var made = await mwo.routineOrder(boss, fire, {});
  assert.equal(made.photos.length, 1);
  assert.ok(await mwo.reportPhotoOf(worker, made.id, 0));
  // Changed: one taken out, two added; four at most.
  r = await call('PATCH', '/api/myjobs/routines/' + fire, { dropPhotos: [0], photos: [PHOTO, PHOTO, PHOTO, PHOTO, PHOTO] }, token);
  assert.equal(r.data.photos.length, 4);
  // Someone who neither sees every job nor does this routine: not theirs to see.
  var outsider = Object.assign({}, await ctxFor('faith.wanjiru@bplghana.com'));
  outsider.can = function (p) { return p !== 'task.read' && p !== 'task.manage'; };
  await rejects(mwo.routineRefPhotoOf(outsider, fire, 0), 'notfound');

  // Signed out: the token is no good.
  assert.equal((await call('POST', '/api/myjobs/sign-out', {}, token)).status, 200);
  assert.equal((await call('GET', '/api/myjobs/mine', undefined, token)).status, 401);
});

test('a manager or supervisor signed in with their kiosk code gives jobs and routines out', async function () {
  var team = (await access.teamCode(boss)).code;
  var token = (await call('POST', '/api/myjobs/sign-in', { team: team, pin: BOSS_PIN })).data.token;
  var r = await call('GET', '/api/myjobs/mine', undefined, token);
  assert.deepEqual(r.data.can, { manage: true, seeAll: true, seeTeam: true });
  assert.ok(r.data.options.everyone.some(function (p) { return p.id === worker.employee.id; }), 'anyone can be picked');
  assert.ok(Array.isArray(r.data.given.jobs));

  // A job for the technician: theirs, and they hear of it.
  r = await call('POST', '/api/myjobs/jobs', { description: 'Zqpin change the bulb in the store', assignedToId: worker.employee.id, photos: [PHOTO] }, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.assignedTo.id, worker.employee.id);
  assert.equal(r.data.status, 'scheduled');
  var told = (await pool.query('SELECT title FROM notifications WHERE employee_id = $1 AND link = $2', [worker.employee.id, '/myjobs?job=' + r.data.id])).rows;
  assert.equal(told.length, 1, 'the technician is told, with a link to the job in My Jobs');
  var mineNow = await mwo.mine(worker);
  assert.ok(mineNow.todo.some(function (o) { return o.id === r.data.id; }), 'on the technician\'s list');

  // A routine for the technician; changed and stopped by the one who gave it.
  r = await call('POST', '/api/myjobs/routines', { name: 'Zqpin clean the A/C filters', everyDays: 30, assignedToId: worker.employee.id }, token);
  assert.equal(r.data.assignedTo.id, worker.employee.id);
  var rid = r.data.id;
  r = await call('GET', '/api/myjobs/mine', undefined, token);
  assert.ok(r.data.given.jobs.some(function (o) { return /change the bulb/.test(o.description); }), 'in what they gave out');
  assert.ok(r.data.given.routines.some(function (x) { return x.id === rid; }));
  assert.equal((await call('PATCH', '/api/myjobs/routines/' + rid, { everyDays: 14 }, token)).data.everyDays, 14);
  assert.equal((await call('POST', '/api/myjobs/routines/' + rid + '/stop', {}, token)).status, 200);

  // Where it is: the phone's GPS position, or a Google Maps link read for its position.
  r = await call('POST', '/api/myjobs/jobs', { description: 'Zqpin fence down by the gate', assignedToId: worker.employee.id, placeLat: 5.6037, placeLng: -0.187 }, token);
  assert.deepEqual([r.data.map.lat, r.data.map.lng], [5.6037, -0.187]);
  assert.match(r.data.map.mapUrl, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=5\.6037%2C-0\.187$/);
  r = await call('POST', '/api/myjobs/jobs', { description: 'Zqpin pump at the farm', placeLink: 'https://www.google.com/maps/place/Farm/@6.6885,-1.6244,17z' }, token);
  assert.deepEqual([r.data.map.lat, r.data.map.lng], [6.6885, -1.6244]);
  r = await call('POST', '/api/myjobs/jobs', { description: 'Zqpin roof at the depot', placeLink: 'https://maps.app.goo.gl/Zq1234' }, token);
  assert.equal(r.data.map.lat, null);
  assert.equal(r.data.map.mapUrl, 'https://maps.app.goo.gl/Zq1234', 'a short link is kept as it is');
  assert.equal((await call('POST', '/api/myjobs/jobs', { description: 'Zqpin nope', placeLink: 'javascript:alert(1)' }, token)).status, 400);
  assert.equal((await call('POST', '/api/myjobs/jobs', { description: 'Zqpin nope', placeLat: 95, placeLng: 0 }, token)).status, 400);
  r = await call('POST', '/api/myjobs/routines', { name: 'Zqpin check the borehole', everyDays: 7, placeLink: '5.55, -0.2' }, token);
  assert.deepEqual([r.data.map.lat, r.data.map.lng, r.data.map.link], [5.55, -0.2, '']);
  var bore = await mwo.routineOrder(boss, r.data.id, {});
  assert.deepEqual([bore.map.lat, bore.map.lng], [5.55, -0.2], 'the routine\'s place goes with its job');
  r = await call('GET', '/api/myjobs/mine', undefined, token);
  assert.ok(r.data.allJobs.some(function (o) { return o.assignedTo && o.assignedTo.id === worker.employee.id; }), 'the whole team\'s jobs');
  assert.ok(r.data.given.jobs.some(function (o) { return /pump at the farm/.test(o.description); }), 'created by them, nobody on it yet');

  // A technician cannot give work out.
  var wt = (await call('POST', '/api/myjobs/sign-in', { team: team, pin: PIN })).data.token;
  var techMine = (await call('GET', '/api/myjobs/mine', undefined, wt)).data;
  assert.equal(techMine.given, null);
  assert.equal(techMine.allJobs, null, 'nor see everyone\'s jobs');
  assert.equal((await call('POST', '/api/myjobs/jobs', { description: 'Zqpin nope', assignedToId: boss.employee.id }, wt)).status, 403);
  assert.equal((await call('POST', '/api/myjobs/routines', { name: 'Zqpin nope', everyDays: 7, assignedToId: boss.employee.id }, wt)).status, 403);
});

test('the MD creates and gives out jobs, and sees the whole team\'s', async function () {
  var md = await ctxFor('andy.chou@bplghana.com');
  assert.equal(md.can('task.manage'), true, 'Executive (MD) may create and assign work orders');
  var job = await mwo.addJob(md, { description: 'Zqpin MD: repaint the reception', assignedToId: worker.employee.id });
  assert.equal(job.assignedTo.id, worker.employee.id);
  var m = await mwo.mine(md);
  assert.ok(m.given.jobs.some(function (o) { return o.id === job.id; }));
  assert.ok(m.allJobs.some(function (o) { return o.id === job.id; }));
});

test('the two switches: someone sees and works on every job; then gives jobs out', async function () {
  var team = (await access.teamCode(boss)).code;
  var other = await mwo.create(boss, { description: 'Zqpin the boss\'s own job', location: 'BPL', assignedToId: boss.employee.id, scheduledOn: new Date().toISOString().slice(0, 10) });
  var wt = (await call('POST', '/api/myjobs/sign-in', { team: team, pin: PIN })).data.token;
  assert.equal((await call('GET', '/api/myjobs/jobs/' + other.id, undefined, wt)).status, 404, 'not theirs: not there');
  assert.equal((await call('POST', '/api/myjobs/jobs/' + other.id + '/status', { status: 'in_progress' }, wt)).status, 404);

  // Only the managers see and set the switches.
  await rejects(mwo.myJobsRights(worker), 'forbidden');
  await rejects(mwo.setMyJobsRight(worker, worker.employee.id, { everyJob: true }), 'forbidden');
  var list = await mwo.myJobsRights(boss);
  var row = list.find(function (x) { return x.id === worker.employee.id; });
  assert.deepEqual([row.everyJob, row.giveOut, row.manages], [false, false, false]);
  assert.equal(list.find(function (x) { return x.id === boss.employee.id; }).manages, true, 'a manager needs no switch');

  // Switch 1: every job.
  row = await mwo.setMyJobsRight(boss, worker.employee.id, { everyJob: true });
  assert.deepEqual([row.everyJob, row.giveOut, row.changedBy], [true, false, boss.employee.first_name + ' ' + boss.employee.last_name]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND link = '/myjobs' AND title LIKE '👀%'", [worker.employee.id])).rows[0].n, 1, 'they are told');
  var r = await call('GET', '/api/myjobs/mine', undefined, wt);
  assert.deepEqual(r.data.can, { manage: false, seeAll: false, seeTeam: true });
  assert.ok(r.data.allJobs.some(function (o) { return o.id === other.id; }), 'the Team tab has every job');
  assert.equal(r.data.given, null, 'giving out is the other switch');
  assert.equal((await call('GET', '/api/myjobs/jobs/' + other.id, undefined, wt)).status, 200);
  r = await call('POST', '/api/myjobs/jobs/' + other.id + '/status', { status: 'in_progress', note: 'Zqpin on my way' }, wt);
  assert.equal(r.status, 200, 'they work on it');
  assert.equal(r.data.status, 'in_progress');
  assert.equal((await call('POST', '/api/myjobs/jobs/' + other.id + '/status', { status: 'cancelled' }, wt)).status, 403, 'but do not call it off');
  assert.equal((await call('POST', '/api/myjobs/jobs/' + other.id + '/status', { status: 'completed' }, wt)).status, 400, 'done still needs a photo');
  assert.equal((await call('POST', '/api/myjobs/jobs', { description: 'Zqpin nope', assignedToId: boss.employee.id }, wt)).status, 403);
  assert.equal((await call('POST', '/api/myjobs/jobs/' + other.id + '/give', { assignedToId: worker.employee.id }, wt)).status, 403);

  // Switch 2: gives jobs out too.
  row = await mwo.setMyJobsRight(boss, worker.employee.id, { giveOut: true });
  assert.deepEqual([row.everyJob, row.giveOut], [true, true]);
  r = await call('GET', '/api/myjobs/mine', undefined, wt);
  assert.deepEqual(r.data.can, { manage: true, seeAll: false, seeTeam: true });
  assert.ok(r.data.options.everyone.length > 0 && Array.isArray(r.data.given.jobs));
  r = await call('POST', '/api/myjobs/jobs', { description: 'Zqpin given out by the supervisor', assignedToId: boss.employee.id }, wt);
  assert.equal(r.status, 200);
  assert.equal(r.data.assignedTo.id, boss.employee.id);
  // Handing a job to someone else.
  r = await call('POST', '/api/myjobs/jobs/' + other.id + '/give', { assignedToId: worker.employee.id }, wt);
  assert.equal(r.status, 200);
  assert.equal(r.data.assignedTo.id, worker.employee.id);
  r = await mwo.giveJob(boss, other.id, { assignedToId: boss.employee.id });
  assert.equal(r.assignedTo.id, boss.employee.id, 'a manager hands it on from My Jobs too');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND link = $2", [worker.employee.id, '/myjobs?job=' + other.id])).rows[0].n, 0, 'the one who took it is not told of their own move');
  await rejects(mwo.giveJob(boss, other.id, { assignedToId: 'nope' }), 'invalid');

  // Every job off turns both off; the plain view is back.
  row = await mwo.setMyJobsRight(boss, worker.employee.id, { everyJob: false });
  assert.deepEqual([row.everyJob, row.giveOut], [false, false]);
  r = await call('GET', '/api/myjobs/mine', undefined, wt);
  assert.deepEqual(r.data.can, { manage: false, seeAll: false, seeTeam: false });
  assert.equal(r.data.allJobs, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM myjobs_rights')).rows[0].n, 0);
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
