// Maintenance and IT work orders (migration 0214): a job asked for by
// anyone, planned and given to someone by a work order manager, moved along
// by whoever does it, the sheet's sums (days open, days taken, late), the
// Billing tab's audit tick, the dashboard; routines that come round every so
// many days; and the import of the team's Google Sheet — its WO Data, RT
// Data and Arc RT tabs, names and places matched, nothing brought in twice,
// a row changed in the OS since kept as the OS has it.
var test = require('node:test');
var assert = require('node:assert/strict');
var ExcelJS = require('exceljs');
var { pool } = require('../src/db/pool');
var mwo = require('../src/services/maintenanceWorkOrders.service');
var mwoImport = require('../src/services/maintenanceWoImport.service');
var { buildContext } = require('../src/services/context.service');

var boss, worker, reader, nobody;

async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function rejects(p, code) { await assert.rejects(p, function (e) { return e.code === code; }); }
// A photo of the finished work, as the phone sends it (a tiny PNG here).
var PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  worker = await ctxFor('samuel.kiptoo@bplghana.com');
  reader = await ctxFor('alice.kamau@bplghana.com'); // sees work orders, plans none
  // Someone with no work order rights at all.
  nobody = Object.assign({}, await ctxFor('faith.wanjiru@bplghana.com'));
  nobody.can = function (p) { return p !== 'task.read' && p !== 'task.manage'; };
});
async function cleanUp() {
  // The photos of finished Zq jobs, kept in the database here (no R2 in tests).
  await pool.query("DELETE FROM stored_files WHERE ('db:' || id) IN (SELECT p->>'key' FROM maint_work_orders w, jsonb_array_elements(w.done_photos) p WHERE w.description LIKE '%Zq%' " +
    "UNION SELECT p->>'key' FROM maint_routine_log l JOIN maint_routines r ON r.id = l.routine_id, jsonb_array_elements(l.photos) p WHERE r.name LIKE 'Zq%')");
  await pool.query("DELETE FROM maint_work_orders WHERE description LIKE '%Zq%'");
  await pool.query("DELETE FROM maint_routines WHERE name LIKE 'Zq%'");
  await pool.query("DELETE FROM notifications WHERE title LIKE '%Zq%' OR body LIKE '%Zq%'");
  await pool.query("DELETE FROM crm_name_aliases WHERE name_key LIKE 'zq%'");
  if (worker) {
    await pool.query("DELETE FROM notifications WHERE employee_id = $1 AND link = '/myjobs'", [worker.employee.id]);
    await pool.query('DELETE FROM maint_morning_sent WHERE employee_id = $1', [worker.employee.id]);
  }
}
test.after(async function () { await cleanUp(); await pool.end(); });

test('anyone asks for a job; the managers hear; it is tied to our company by its place', async function () {
  await cleanUp();
  var asked = await mwo.create(reader, { description: 'Zq kitchen tap leaking', location: 'Star Bar', category: 'plumbing', priority: 'high', assignedToId: worker.employee.id, status: 'completed' });
  assert.match(asked.ref, /^WO-\d{4,}$/);
  assert.ok(Number(asked.ref.slice(3)) > 1000, 'numbers carry on from the sheet’s WO-1001');
  assert.equal(asked.status, 'new', 'someone who does not plan jobs only asks');
  assert.equal(asked.assignedTo, null, 'and cannot give it to anyone');
  assert.equal(asked.requestedBy.id, reader.employee.id);
  assert.equal(asked.companyCode, 'SBR', '"Star Bar" is Star Bar Restaurant');
  assert.equal(asked.priority, 'high');
  assert.equal(asked.daysOpen, 0);
  var heard = await pool.query("SELECT link FROM notifications WHERE employee_id = $1 AND title LIKE '%Job asked for: ' || $2 || '%'", [boss.employee.id, asked.ref]);
  assert.equal(heard.rows[0].link, '/tasks?side=maint&job=' + asked.id);
  await rejects(mwo.update(reader, asked.id, { priority: 'low' }), 'forbidden');

  // Someone with no work order rights sees only what they asked for.
  var mine = await mwo.create(nobody, { description: 'Zq socket sparks', location: 'Zq House', category: 'electrical' });
  assert.equal(mine.companyId, null, 'a house is a place of its own');
  var seen = await mwo.list(nobody, {});
  assert.ok(seen.orders.some(function (o) { return o.id === mine.id; }));
  assert.ok(!seen.orders.some(function (o) { return o.id === asked.id; }));
  assert.equal(seen.can.manage, false);
  await rejects(mwo.get(nobody, asked.id), 'notfound');
  // They may call off a job they asked for while it waits to be planned.
  assert.equal((await mwo.setStatus(nobody, mine.id, { status: 'cancelled' })).status, 'cancelled');
});

test('planned and given to someone, moved along by them, done: the sheet’s sums and the audit tick', async function () {
  var wo = await mwo.create(boss, {
    description: 'Zq replace breaker in the bar', location: 'BG', category: 'electrical', priority: 'urgent',
    requestedOn: addDays(today(), -5), assignedToId: worker.employee.id, scheduledOn: addDays(today(), -2), estimatedCost: '450', currency: 'usd'
  });
  assert.equal(wo.status, 'scheduled', 'a job with a day is scheduled');
  assert.equal(wo.companyCode, 'BGN', '"BG" is Bamboo Garden');
  assert.equal(wo.currency, 'USD');
  assert.equal(wo.estimatedCost, 450);
  assert.equal(wo.daysOpen, 5);
  assert.equal(wo.overdue, true, 'still open after its planned day');
  // The assignee hears, but the boss gave it so nobody else.
  var told = await pool.query("SELECT link FROM notifications WHERE employee_id = $1 AND body LIKE 'Zq replace breaker%'", [worker.employee.id]);
  assert.equal(told.rows.length, 1);

  // Whoever it is given to moves it along; others who don't plan jobs can't.
  await rejects(mwo.setStatus(reader, wo.id, { status: 'in_progress' }), 'forbidden');
  var started = await mwo.setStatus(worker, wo.id, { status: 'on_hold', note: 'waiting for the Zq part' });
  assert.equal(started.status, 'on_hold');
  assert.match(started.notes, /waiting for the Zq part/);
  await rejects(mwo.setAudited(boss, wo.id, true), 'invalid');
  await rejects(mwo.setStatus(worker, wo.id, { status: 'completed', completedOn: addDays(today(), 1) }), 'invalid');
  // Done only with a photo of the finished work.
  await assert.rejects(mwo.setStatus(worker, wo.id, { status: 'completed', completedOn: today() }), function (e) { return e.code === 'invalid' && /photo of the finished work/.test(e.message); });
  await rejects(mwo.setStatus(worker, wo.id, { status: 'completed', completedOn: today(), photos: ['data:image/png;base64,bm90IGEgcGhvdG8='] }), 'invalid');
  var done = await mwo.setStatus(worker, wo.id, { status: 'completed', completedOn: today(), actualCost: '480.50', photos: [PHOTO] });
  assert.equal(done.completedOn, today());
  assert.equal(done.donePhotos.length, 1);
  var shot = await mwo.photoOf(worker, wo.id, 0);
  assert.match(shot.name, /^wo-\d+-done-1\.png$/);
  await rejects(mwo.photoOf(nobody, wo.id, 0), 'notfound');
  await rejects(mwo.photoOf(worker, wo.id, 1), 'notfound');
  // A note on a job already done needs no new photo.
  assert.match((await mwo.setStatus(worker, wo.id, { status: 'completed', note: 'Zq all tested' })).notes, /Zq all tested/);
  assert.equal(done.daysTaken, 2, 'planned two days ago, done today');
  assert.equal(done.daysOpen, 5);
  assert.equal(done.overdue, false);
  assert.equal(done.actualCost, 480.5);

  var checked = await mwo.setAudited(boss, wo.id, true);
  assert.equal(checked.audited, true);
  assert.ok(checked.auditedBy);
  // Back open: no longer done.
  var reopened = await mwo.update(boss, wo.id, { status: 'in_progress' });
  assert.equal(reopened.completedOn, null);

  // The dashboard the sheet kept by hand.
  var all = await mwo.list(boss, {});
  var s = all.summary;
  assert.ok(s.total >= 2 && s.open >= 2);
  assert.ok(s.openByPriority.urgent >= 1);
  assert.ok(s.byStatus.in_progress >= 1);
  assert.ok(s.estimated.USD >= 450);
  assert.ok(s.byCategory.some(function (c) { return c.key === 'electrical'; }));
  assert.ok(s.byPerson.some(function (p) { return p.id === worker.employee.id && p.open >= 1; }));
  assert.ok(all.options.places.indexOf('BG') >= 0, 'places used before are offered');
  await mwo.remove(boss, wo.id);
  await rejects(mwo.get(boss, wo.id), 'notfound');
});

test('routines come round every so many days; a work order made from one marks it done', async function () {
  var last = addDays(today(), -80);
  var rt = await mwo.saveRoutine(boss, null, { name: 'Zq A/C cleaning', description: 'Zq office units', location: 'BPL', category: 'hvac', everyDays: 84, lastDoneOn: last, assignedToId: worker.employee.id });
  assert.match(rt.ref, /^RT-\d{3,}$/);
  assert.equal(rt.nextOn, addDays(last, 84));
  assert.equal(rt.dueIn, 4);
  assert.equal(rt.late, false);

  var wo = await mwo.routineOrder(boss, rt.id, {});
  assert.equal(wo.status, 'scheduled');
  assert.equal(wo.scheduledOn, rt.nextOn, 'planned for its next day');
  assert.equal(wo.routineName, 'Zq A/C cleaning');
  await rejects(mwo.routineOrder(boss, rt.id, {}), 'conflict');
  // Its work order open: the routine is done by finishing that.
  await rejects(mwo.routineDone(worker, rt.id, { photos: [PHOTO] }), 'conflict');
  await mwo.setStatus(worker, wo.id, { status: 'completed', photos: [PHOTO] });
  var after = (await mwo.list(boss, {})).routines.find(function (r) { return r.id === rt.id; });
  assert.equal(after.lastDoneOn, today());
  assert.equal(after.nextOn, addDays(today(), 84));
  assert.equal(after.openOrderId, null);
  assert.equal(after.timesDone, 1);

  // Marked done by hand by whoever does it; a late record of an earlier
  // time does not move the dates back.
  await rejects(mwo.routineDone(worker, rt.id, { on: addDays(today(), -10) }), 'invalid');
  await mwo.routineDone(worker, rt.id, { on: addDays(today(), -10), photos: [PHOTO, PHOTO] });
  var still = (await mwo.list(boss, {})).routines.find(function (r) { return r.id === rt.id; });
  assert.equal(still.lastDoneOn, today());
  assert.equal(still.timesDone, 2);
  // The routine's record keeps the photos: the work order's, and the two taken by hand.
  var log = (await mwo.get(boss, wo.id)).routineLog;
  assert.deepEqual(log.map(function (l) { return l.photos; }).sort(), [1, 2]);
  var byHand = log.find(function (l) { return l.photos === 2; });
  assert.match((await mwo.routinePhotoOf(worker, byHand.id, 1)).name, /^rt-\d+-done-2\.png$/);
  await rejects(mwo.routinePhotoOf(nobody, byHand.id, 0), 'notfound');
  await rejects(mwo.routineDone(reader, rt.id, {}), 'forbidden');
  // Every so many days changed: the next day follows.
  assert.equal((await mwo.saveRoutine(boss, rt.id, { everyDays: 30 })).nextOn, addDays(today(), 30));
  assert.equal((await mwo.archiveRoutine(boss, rt.id, true)).archived, true);
  await mwo.removeRoutine(boss, rt.id);
});

// A workbook laid out like the team's sheet (made-up rows).
test('My Jobs: my own jobs, late first; my routines; nobody else\'s', async function () {
  var late = await mwo.create(boss, { description: 'Zq gate light out', location: 'BPL', category: 'electrical', priority: 'medium', assignedToId: worker.employee.id, scheduledOn: addDays(today(), -2) });
  var urgent = await mwo.create(boss, { description: 'Zq router down', location: 'BPL', category: 'it', priority: 'urgent', assignedToId: worker.employee.id, scheduledOn: today() });
  var later = await mwo.create(boss, { description: 'Zq repaint door', location: 'BPL', category: 'facilities', assignedToId: worker.employee.id, scheduledOn: addDays(today(), 4) });
  var other = await mwo.create(boss, { description: 'Zq not mine', location: 'BPL', assignedToId: boss.employee.id, scheduledOn: today() });
  var finished = await mwo.create(boss, { description: 'Zq fixed yesterday', location: 'BPL', assignedToId: worker.employee.id, scheduledOn: addDays(today(), -1) });
  await mwo.setStatus(worker, finished.id, { status: 'completed', photos: [PHOTO] });
  var rt = await mwo.saveRoutine(boss, null, { name: 'Zq generator service', location: 'BPL', category: 'electrical', everyDays: 30, lastDoneOn: addDays(today(), -5), assignedToId: worker.employee.id });

  var m = await mwo.mine(worker);
  var ids = m.todo.map(function (o) { return o.id; });
  assert.ok(ids.indexOf(late.id) >= 0 && ids.indexOf(urgent.id) >= 0 && ids.indexOf(later.id) >= 0);
  assert.ok(ids.indexOf(other.id) < 0, 'only the jobs given to me');
  assert.ok(ids.indexOf(late.id) < ids.indexOf(urgent.id) && ids.indexOf(urgent.id) < ids.indexOf(later.id), 'late first, then today, then later');
  assert.ok(m.done.some(function (o) { return o.id === finished.id && o.donePhotos.length === 1; }));
  assert.ok(m.routines.some(function (r) { return r.id === rt.id && r.nextOn === addDays(today(), 25); }));
  assert.ok(m.counts.late >= 1 && m.counts.today >= 1 && m.counts.later >= 1);
  assert.equal(m.me.id, worker.employee.id);
});

test('routines become work orders by themselves when close; the morning list once a day', async function () {
  await cleanUp();
  // Next in 1 day, every 84: made (2 days ahead). Next in 5 days: not yet.
  var soon = await mwo.saveRoutine(boss, null, { name: 'Zq A/C filters', location: 'BPL', category: 'hvac', everyDays: 84, lastDoneOn: addDays(today(), -83), assignedToId: worker.employee.id });
  var notYet = await mwo.saveRoutine(boss, null, { name: 'Zq roof check', location: 'BPL', category: 'facilities', everyDays: 90, lastDoneOn: addDays(today(), -85), assignedToId: worker.employee.id });
  // Daily: made on the day itself, not the day before.
  var dailyTomorrow = await mwo.saveRoutine(boss, null, { name: 'Zq daily backup check', location: 'BPL', category: 'it', everyDays: 1, lastDoneOn: today(), assignedToId: worker.employee.id });
  var dailyToday = await mwo.saveRoutine(boss, null, { name: 'Zq daily server check', location: 'BPL', category: 'it', everyDays: 1, lastDoneOn: addDays(today(), -1), assignedToId: worker.employee.id });
  // Late and given to nobody: made, and the managers hear.
  var nobodys = await mwo.saveRoutine(boss, null, { name: 'Zq pump service', location: 'BPL', category: 'plumbing', everyDays: 60, lastDoneOn: addDays(today(), -70) });
  assert.equal(mwo.leadOf(84), 2);
  assert.equal(mwo.leadOf(2), 1);
  assert.equal(mwo.leadOf(1), 0);

  await mwo.runDue();
  var all = await mwo.list(boss, {});
  var rt = function (r) { return all.routines.find(function (x) { return x.id === r.id; }); };
  assert.ok(rt(soon).openOrderId, 'close: a work order');
  assert.equal(rt(notYet).openOrderId, null, 'five days off: not yet');
  assert.equal(rt(dailyTomorrow).openOrderId, null, 'a daily one not the day before');
  assert.ok(rt(dailyToday).openOrderId, 'a daily one on its day');
  assert.ok(rt(nobodys).openOrderId);
  var wo = all.orders.find(function (o) { return o.id === rt(soon).openOrderId; });
  assert.equal(wo.status, 'scheduled');
  assert.equal(wo.scheduledOn, addDays(today(), 1), 'planned for the routine\'s day');
  assert.equal(wo.assignedTo.id, worker.employee.id);
  assert.equal(wo.autoMade, true);
  var late = all.orders.find(function (o) { return o.id === rt(nobodys).openOrderId; });
  assert.equal(late.overdue, true, 'a late routine is a late job');
  var told = (await pool.query("SELECT link FROM notifications WHERE employee_id = $1 AND title LIKE '🔁 Routine job%' AND body LIKE '%Zq A/C filters%'", [worker.employee.id])).rows;
  assert.equal(told.length, 1);
  assert.equal(told[0].link, '/myjobs?job=' + wo.id);
  var managers = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE title LIKE '🔁 Routine job with nobody on it%' AND body LIKE '%Zq pump service%'")).rows[0].n;
  assert.ok(managers >= 1, 'the managers hear of one with nobody on it');

  // Run again: nothing twice.
  var before = (await pool.query("SELECT count(*)::int AS n FROM maint_work_orders WHERE description LIKE 'Zq%' AND auto_made")).rows[0].n;
  await mwo.runDue();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM maint_work_orders WHERE description LIKE 'Zq%' AND auto_made")).rows[0].n, before);

  // Done with a photo: the routine moves on and has nothing open until it is close again.
  await mwo.setStatus(worker, wo.id, { status: 'completed', photos: [PHOTO] });
  await mwo.runDue();
  var after = (await mwo.list(boss, {})).routines.find(function (x) { return x.id === soon.id; });
  assert.equal(after.nextOn, addDays(today(), 84));
  assert.equal(after.openOrderId, null);

  // The morning list: not before 06:00; then once, opening My Jobs.
  assert.equal(await mwo.morning(new Date(today() + 'T05:30:00Z')), 0);
  await mwo.morning(new Date(today() + 'T06:30:00Z'));
  var morning = (await pool.query("SELECT title, link FROM notifications WHERE employee_id = $1 AND link = '/myjobs'", [worker.employee.id])).rows;
  assert.equal(morning.length, 1);
  assert.match(morning[0].title, /jobs? for you today/);
  await mwo.morning(new Date(today() + 'T09:00:00Z'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND link = '/myjobs'", [worker.employee.id])).rows[0].n, 1, 'once a day');
});

test('My Jobs: adding a job for oneself or for the managers; routines of one\'s own, changed and stopped', async function () {
  // A technician: no right to give work out (task.manage) — the managers hear of what they add.
  var tech = Object.assign({}, worker, { can: function (p) { return p !== 'task.manage' && worker.can(p); } });
  await rejects(mwo.addJob(tech, { description: '' }), 'invalid');
  var mineJob = await mwo.addJob(tech, { description: 'Zq loose socket in the store', location: 'BPL', category: 'electrical', priority: 'high' });
  assert.equal(mineJob.assignedTo.id, worker.employee.id, 'given to whoever added it');
  assert.equal(mineJob.status, 'scheduled');
  assert.equal(mineJob.scheduledOn, today());
  assert.equal(mineJob.requestedBy.id, worker.employee.id);
  assert.ok((await mwo.mine(tech)).todo.some(function (o) { return o.id === mineJob.id; }), 'on their list at once');
  var told = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE title LIKE '%added a job%' AND body LIKE '%Zq loose socket%'")).rows[0].n;
  assert.ok(told >= 1, 'the managers hear of it');

  var asked = await mwo.addJob(tech, { description: 'Zq roof leaking over the kiln', location: 'BPL', forMe: false });
  assert.equal(asked.assignedTo, null);
  assert.equal(asked.status, 'new');
  assert.ok(!(await mwo.mine(tech)).todo.some(function (o) { return o.id === asked.id; }), 'not on their list');

  await rejects(mwo.saveMyRoutine(tech, null, { name: 'Zq check the pumps', everyDays: 0 }), 'invalid');
  await rejects(mwo.saveMyRoutine(tech, null, { name: 'Zq check the pumps', everyDays: 7, nextOn: addDays(today(), -1) }), 'invalid');
  var rt = await mwo.saveMyRoutine(tech, null, { name: 'Zq check the pumps', location: 'BPL', category: 'plumbing', everyDays: 7, nextOn: addDays(today(), 3), scheduleNote: 'Monday morning' });
  assert.equal(rt.assignedTo.id, worker.employee.id);
  assert.equal(rt.nextOn, addDays(today(), 3));
  assert.equal(rt.everyDays, 7);
  assert.equal(rt.addedByMe, true);
  var m = await mwo.mine(tech);
  assert.ok(m.routines.some(function (r) { return r.id === rt.id && r.addedByMe; }));
  assert.ok(m.options.categories.indexOf('plumbing') >= 0);
  var changed = await mwo.saveMyRoutine(tech, rt.id, { everyDays: 14 });
  assert.equal(changed.everyDays, 14);
  assert.equal(changed.name, 'Zq check the pumps', 'what is not sent stays');

  // A routine the managers gave them is not theirs to change or stop here.
  var given = await mwo.saveRoutine(boss, null, { name: 'Zq generator oil', everyDays: 30, lastDoneOn: today(), assignedToId: worker.employee.id });
  await rejects(mwo.saveMyRoutine(tech, given.id, { everyDays: 60 }), 'forbidden');
  await rejects(mwo.stopMyRoutine(tech, given.id), 'forbidden');
  assert.equal((await mwo.mine(tech)).routines.find(function (r) { return r.id === given.id; }).addedByMe, false);
  // Nor someone else's own.
  await rejects(mwo.saveMyRoutine(reader, rt.id, { everyDays: 3 }), 'forbidden');

  assert.deepEqual(await mwo.stopMyRoutine(tech, rt.id), { ok: true });
  assert.ok(!(await mwo.mine(tech)).routines.some(function (r) { return r.id === rt.id; }), 'stopped: off their list');
  await rejects(mwo.saveMyRoutine(tech, rt.id, { everyDays: 5 }), 'conflict');
});

async function sheet(opts) {
  opts = opts || {};
  var wb = new ExcelJS.Workbook();
  var wo = wb.addWorksheet('WO Data');
  wo.addRow([]);
  wo.addRow(['Work Order ID', 'Request Date', 'Requested By', 'Customer', 'Location', 'Category', 'Description', 'Priority', 'Status', 'Assigned To',
    'Scheduled Date', 'Completed Date', 'Days', 'Estimated Cost', 'Actual Cost', 'Days Open', 'Notes']);
  var d = function (s) { return new Date(s + 'T00:00:00Z'); };
  var r1 = wo.addRow(['WO-1001', d('2030-02-03'), 'Zqboss', '', 'BPL', 'IT', 'Zq 3 tablet screens replaced', 'Medium', 'Completed', 'Samuel Kiptoo',
    d('2030-02-10'), d('2030-02-11'), { formula: 'L3-K3', result: 1 }, 450, 450, { formula: 'L3-B3', result: 8 }, '']);
  r1.getCell(14).numFmt = '$#,##0.00'; r1.getCell(15).numFmt = '$#,##0.00';
  wo.addRow(['WO-1002', d('2030-02-04'), 'Zqboss', '', 'Star Bar', 'Plumbing', 'Zq fix leaking sink', '', opts.secondStatus || 'On Hold', 'Zqfixer',
    null, null, null, null, null, { formula: 'TODAY()-B4', result: 9 }, 'Zq waiting for the part']);
  wo.addRow(['WO-1002', d('2030-02-04'), 'Zqboss', '', 'Zq House', 'Mason', 'Zq patch the wall', 'Urgent', 'Scheduled', 'Zqfixer', d('2030-02-20')]);
  wo.addRow(['', '', '', '', '', '', '', '', '', '', '', '', { formula: 'L7-K7', result: 0 }]); // an empty line with formulas only
  var rt = wb.addWorksheet('RT Data');
  rt.addRow(['Index', 'Routine Name', 'Location', 'RT Scheduled', 'Description', 'who', 'Frequency (days)', 'Next Scheduled Date', 'Last Completion Date', 'Notes/Comments', 'Links']);
  rt.addRow(['RT-902', 'Zq fan cleaning', 'SB', 'Wed. morning', 'Zq bar fans', 'Zqfixer', 84, { formula: 'I2+G2', result: d('2030-04-26') }, d('2030-02-01'), '', '']);
  rt.addRow(['', 'Zq water tank wash', '', '', 'Zq tanks', 'Zqfixer', '-', { formula: 'I3+G3', result: { error: '#VALUE!' } }, d('2030-01-01'), 'yet to be done', '']);
  var arc = wb.addWorksheet('Arc RT Zq');
  arc.addRow(['Index', 'Routine Name', 'Description', 'who', 'Frequency (days)', 'Next Scheduled Date', 'Last Completion Date', 'Notes/Comments', 'Links']);
  arc.addRow(['A NOTE ACROSS THE SHEET']);
  arc.addRow(['RT-911', 'Zq weekly post', 'Zq post on the page', 'Zqposter', '-', null, d('2030-01-05')]);
  var billing = wb.addWorksheet('Billing'); // worked out from WO Data: left alone
  billing.addRow(['Completed Date', 'Location', 'Description', 'Category', 'Assigned To', 'Actual Days', 'Audit']);
  billing.addRow([d('2030-02-11'), 'BPL', 'Zq 3 tablet screens replaced', 'IT', 'Zqfixer', 1, '']);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}

test('the team’s sheet comes in: work orders, routines, put-away routines; nothing twice; the OS’s changes kept', async function () {
  await rejects(mwoImport.preview(reader, await sheet()), 'forbidden');
  var p = await mwoImport.preview(boss, await sheet());
  assert.deepEqual(p.sheets.map(function (s) { return s.kind; }), ['orders', 'routines', 'archived']);
  assert.deepEqual(p.orders, { add: 3, update: 0, same: 0, kept: 0 }, 'the same number twice with different words is two jobs');
  assert.deepEqual(p.routines, { add: 3, update: 0, same: 0, kept: 0 });
  assert.deepEqual(p.byStatus, { completed: 1, on_hold: 1, scheduled: 1 });
  assert.ok(p.names.some(function (n) { return n.name === 'Samuel Kiptoo' && n.matched; }));
  assert.ok(p.names.some(function (n) { return n.name === 'Zqfixer' && !n.matched; }));
  assert.ok(p.places.some(function (x) { return x.location === 'Zq House' && !x.ours; }));
  // Saying who a name on the sheet is: the preview reads it so.
  var told = await mwoImport.preview(boss, await sheet(), { aliases: JSON.stringify({ Zqfixer: worker.employee.id }) });
  assert.ok(told.names.some(function (n) { return n.name === 'Zqfixer' && n.matched && n.employeeId === worker.employee.id; }));

  var done = await mwoImport.run(boss, await sheet());
  assert.equal(done.orders.added, 3);
  assert.equal(done.routines.added, 3);
  var all = await mwo.list(boss, {});
  var tablets = all.orders.find(function (o) { return o.description === 'Zq 3 tablet screens replaced'; });
  assert.equal(tablets.ref, 'WO-1001');
  assert.equal(tablets.status, 'completed');
  assert.equal(tablets.currency, 'USD', 'the cost’s $ format says dollars');
  assert.equal(tablets.actualCost, 450);
  assert.equal(tablets.daysTaken, 1);
  assert.equal(tablets.daysOpen, 8);
  assert.equal(tablets.assignedTo.id, worker.employee.id, 'a full name in the directory is that person');
  assert.equal(tablets.companyCode, 'BPL');
  assert.equal(tablets.fromSheet, true);
  var sink = all.orders.find(function (o) { return o.description === 'Zq fix leaking sink'; });
  assert.equal(sink.status, 'on_hold');
  assert.equal(sink.priority, 'medium', 'no priority on the sheet reads as medium');
  assert.equal(sink.assignedTo.name, 'Zqfixer', 'a name not in the directory is kept as written');
  assert.equal(sink.requestedBy.name, 'Zqboss');
  assert.equal(all.orders.find(function (o) { return o.description === 'Zq patch the wall'; }).category, 'mason');
  var fans = all.routines.find(function (r) { return r.name === 'Zq fan cleaning'; });
  assert.equal(fans.everyDays, 84);
  assert.equal(fans.nextOn, '2030-04-26');
  assert.equal(fans.scheduleNote, 'Wed. morning');
  assert.equal(fans.companyName, 'Star Bar Restaurant', '"SB" is Star Bar');
  var tank = all.routines.find(function (r) { return r.name === 'Zq water tank wash'; });
  assert.equal(tank.everyDays, null, '"-" is not repeating yet');
  assert.equal(tank.nextOn, null, '#VALUE! says nothing');
  assert.equal(all.routines.find(function (r) { return r.name === 'Zq weekly post'; }).archived, true, 'an Arc tab’s routines are put away');

  // The same workbook again: nothing new.
  var again = await mwoImport.preview(boss, await sheet());
  assert.deepEqual(again.orders, { add: 0, update: 0, same: 3, kept: 0 });
  assert.deepEqual(again.routines, { add: 0, update: 0, same: 3, kept: 0 });

  // The sheet moves on: the job done there is brought up to date…
  var moved = await mwoImport.preview(boss, await sheet({ secondStatus: 'Completed' }));
  assert.equal(moved.orders.update, 1);
  // …unless it was changed in the OS since: then the OS keeps what it has.
  await new Promise(function (r) { setTimeout(r, 2100); });
  await mwo.update(boss, sink.id, { notes: 'Zq part ordered' });
  var kept = await mwoImport.preview(boss, await sheet({ secondStatus: 'Completed' }));
  assert.equal(kept.orders.update, 0);
  assert.equal(kept.orders.kept, 1);
  var ran = await mwoImport.run(boss, await sheet({ secondStatus: 'Completed' }));
  assert.equal(ran.orders.added, 0);
  assert.equal((await mwo.get(boss, sink.id)).status, 'on_hold');

  await rejects(mwoImport.preview(boss, { buffer: Buffer.from('not a workbook') }), 'invalid');
});
