// Routines on the marketing calendar and their reminders (mkRoutines.service.js
// upcoming/remind, migration 0150): the requests a routine will make show on
// the day each will be needed, until made; a heads-up before it comes round
// and a reminder before a request it made is needed (and on the day) while
// it isn't done — once each, from 07:00, to the lead and team, as a text too
// (faked here). In 2031, on throwaway ZRR data, so the real schedule and the
// other routine tests are not touched.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var routines = require('../src/services/mkRoutines.service');
var home = require('../src/services/mkHome.service');
var sms = require('../src/services/sms.service');

var boss, staff, zq;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function at(day, hour) { return new Date(day + 'T' + String(hour).padStart(2, '0') + ':00:00Z'); }
async function cleanup() {
  await pool.query("DELETE FROM notifications WHERE link IN (SELECT '/mkrequests?open=' || id FROM marketing_requests WHERE title LIKE 'ZRR%') " +
    "OR link IN (SELECT '/mkrequests?routine=' || id FROM marketing_request_routines WHERE title LIKE 'ZRR%')");
  await pool.query("DELETE FROM marketing_requests WHERE title LIKE 'ZRR%'");
  await pool.query("DELETE FROM marketing_request_routines WHERE title LIKE 'ZRR%'");
  await pool.query("DELETE FROM employees WHERE code = 'ZRR-1'");
}
async function told(who, link) {
  return (await pool.query('SELECT title, body FROM notifications WHERE employee_id = $1 AND link = $2 ORDER BY at', [who, link])).rows;
}
async function reminders(col, id) {
  return (await pool.query("SELECT kind, to_char(for_day, 'YYYY-MM-DD') AS d, people, texts FROM marketing_routine_reminders WHERE " + col + ' = $1 ORDER BY for_day', [id])).rows;
}
async function requestFor(rt, on) {
  return (await pool.query("SELECT id, number, to_char(due_on, 'YYYY-MM-DD') AS due FROM marketing_requests WHERE routine_id = $1 AND routine_on = $2", [rt, on])).rows[0];
}
// 2031-03-03 is a Monday.
function routine(title, extra) {
  return routines.create(boss, Object.assign({ company: 'BPL', title: 'ZRR ' + title, kind: 'social_post', every: 'week', weekdays: [1], startsOn: '2031-03-03', dueAfterDays: 2 }, extra || {}));
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = await ctxFor('alice.kamau@bplghana.com');
  await cleanup();
  var dept = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [boss.employee.id])).rows[0].department_id;
  zq = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, position_title, employment_type, hire_date, status) VALUES ('ZRR-1','Zq','Reminder','zrr-1@example.com','0200000002',$1,'Designer','permanent',CURRENT_DATE,'active') RETURNING id",
    [dept])).rows[0].id;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the reminder settings: on by default, each can be turned off, kept when not sent, checked', async function () {
  var rt = await routine('Defaults');
  assert.deepEqual([rt.remindAheadDays, rt.remindDueDays, rt.remindBySms], [1, 1, true]);
  rt = await routines.update(boss, rt.id, { title: rt.title, every: 'week', weekdays: [1], startsOn: rt.startsOn, dueAfterDays: 2, remindAheadDays: null, remindDueDays: 0, remindBySms: false });
  assert.deepEqual([rt.remindAheadDays, rt.remindDueDays, rt.remindBySms], [null, 0, false]);
  rt = await routines.update(boss, rt.id, { title: rt.title, every: 'week', weekdays: [1], startsOn: rt.startsOn, dueAfterDays: 2 });
  assert.deepEqual([rt.remindAheadDays, rt.remindDueDays, rt.remindBySms], [null, 0, false], 'kept when not sent');
  await assert.rejects(routine('Bad', { remindAheadDays: 9 }), /from 1 to 7/);
  await assert.rejects(routine('Bad', { remindDueDays: 5 }), /from 0 to 3/);
});

test('the calendar shows the requests a routine will make on the day each is needed, until made; paused, none', async function () {
  var rt = await routine('On the calendar', { assignedTo: boss.employee.id });
  var cal = await home.calendar(boss, { company: 'BPL', from: '2031-03-01', to: '2031-03-31' });
  var mine = cal.items.filter(function (i) { return i.kind === 'routine' && i.id === rt.id; });
  assert.deepEqual(mine.map(function (i) { return [i.comesOn, i.start]; }), [['2031-03-03', '2031-03-05'], ['2031-03-10', '2031-03-12'], ['2031-03-17', '2031-03-19'], ['2031-03-24', '2031-03-26']],
    'Mondays, needed 2 days later; the 31st is needed in April');
  assert.equal(mine[0].title, 'ZRR On the calendar');

  await routines._makeDue(rt.id, '2031-03-03');
  var made = await requestFor(rt.id, '2031-03-03');
  cal = await home.calendar(boss, { company: 'BPL', from: '2031-03-01', to: '2031-03-31' });
  mine = cal.items.filter(function (i) { return i.kind === 'routine' && i.id === rt.id; });
  assert.deepEqual(mine.map(function (i) { return i.start; }), ['2031-03-12', '2031-03-19', '2031-03-26'], 'the made one is a request now');
  var req = cal.items.find(function (i) { return i.kind === 'request' && i.id === made.id; });
  assert.equal(req.start, '2031-03-05');
  assert.equal(req.fromRoutine, true);

  await routines.setPaused(boss, rt.id, { paused: true });
  cal = await home.calendar(boss, { company: 'BPL', from: '2031-03-01', to: '2031-03-31' });
  assert.equal(cal.items.filter(function (i) { return i.kind === 'routine' && i.id === rt.id; }).length, 0);
  await assert.rejects(home.calendar(staff, { company: 'BPL' }), /marketing/);
});

test('a heads-up before it comes round: from 07:00, to the lead and team, once; several days in one message', async function () {
  var rt = await routine('Heads-up', { assignedTo: boss.employee.id, teamIds: [zq] });
  var link = '/mkrequests?routine=' + rt.id;
  assert.deepEqual(await routines.remind(at('2031-03-02', 6)), { ahead: 0, due: 0 }, 'not before 07:00');
  await routines.remind(at('2031-03-02', 8));
  var z = await told(zq, link);
  assert.equal(z.length, 1);
  assert.equal(z[0].title, 'Coming up tomorrow: ZRR Heads-up');
  assert.match(z[0].body, /comes round on Mon 3 Mar, needed by Wed 5 Mar/);
  assert.equal((await told(boss.employee.id, link)).length, 1, 'the lead too');
  assert.deepEqual((await reminders('routine_id', rt.id)).map(function (r) { return [r.kind, r.d, r.people]; }), [['ahead', '2031-03-03', 2]]);
  await routines.remind(at('2031-03-02', 9));
  assert.equal((await told(zq, link)).length, 1, 'once');

  // Three days ahead on Mondays and Tuesdays: both days, one message.
  var two = await routine('Two days', { weekdays: [1, 2], remindAheadDays: 3, teamIds: [zq] });
  await routines.remind(at('2031-03-01', 8));
  var t = await told(zq, '/mkrequests?routine=' + two.id);
  assert.equal(t.length, 1);
  assert.equal(t[0].title, 'Coming up Mon 3 Mar and Tue 4 Mar: ZRR Two days');
  assert.equal((await reminders('routine_id', two.id)).length, 2);

  // Turned off: nothing.
  var off = await routine('No heads-up', { remindAheadDays: null, teamIds: [zq] });
  await routines.remind(at('2031-03-02', 10));
  assert.equal((await reminders('routine_id', off.id)).length, 0);
});

test('a reminder before a request it made is needed, and on the day, while it is not done; a missed one goes late', async function () {
  var rt = await routine('Due', { dueAfterDays: 3, remindDueDays: 1, remindAheadDays: null, assignedTo: boss.employee.id, teamIds: [zq] });
  await routines._makeDue(rt.id, '2031-03-03');
  var req = await requestFor(rt.id, '2031-03-03');
  assert.equal(req.due, '2031-03-06');
  var link = '/mkrequests?open=' + req.id;
  var before = (await told(zq, link)).length; // told when it was made
  await routines.remind(at('2031-03-04', 8));
  assert.equal((await told(zq, link)).length, before, 'two days before: nothing yet');
  await routines.remind(at('2031-03-05', 8));
  var z = await told(zq, link);
  assert.equal(z.length, before + 1);
  var ref = 'MR-' + String(req.number).padStart(4, '0');
  assert.equal(z[z.length - 1].title, 'Needed tomorrow: ' + ref + ' ZRR Due');
  assert.match(z[z.length - 1].body, /not taken on yet\. From the routine "ZRR Due"/);
  await routines.remind(at('2031-03-05', 12));
  assert.equal((await told(zq, link)).length, before + 1, 'once a day');
  await routines.remind(at('2031-03-06', 8));
  z = await told(zq, link);
  assert.equal(z[z.length - 1].title, 'Needed today: ' + ref + ' ZRR Due');
  assert.deepEqual((await reminders('request_id', req.id)).map(function (r) { return r.d; }), ['2031-03-05', '2031-03-06']);

  // Done: no more reminders.
  await routines._makeDue(rt.id, '2031-03-10');
  var done = await requestFor(rt.id, '2031-03-10');
  await pool.query("UPDATE marketing_requests SET status = 'done' WHERE id = $1", [done.id]);
  await routines.remind(at('2031-03-12', 8));
  assert.equal((await reminders('request_id', done.id)).length, 0);

  // Two days before: missed while the server was off, it goes the next day.
  var late = await routine('Late', { dueAfterDays: 3, remindDueDays: 2, remindAheadDays: null, teamIds: [zq] });
  await routines._makeDue(late.id, '2031-03-03');
  var lr = await requestFor(late.id, '2031-03-03');
  await routines.remind(at('2031-03-05', 8));
  assert.deepEqual((await reminders('request_id', lr.id)).map(function (r) { return r.d; }), ['2031-03-04']);

  // Needed the day it is made: they were just told, so no reminder that day.
  var same = await routine('Same day', { dueAfterDays: 0, remindDueDays: 1, remindAheadDays: null, teamIds: [zq] });
  await routines._makeDue(same.id, '2031-03-03');
  var sr = await requestFor(same.id, '2031-03-03');
  await routines.remind(at('2031-03-03', 9));
  assert.equal((await reminders('request_id', sr.id)).length, 0);
});

test('reminders go as a text too when the routine wants it (faked here); not when it does not', async function () {
  var real = { configured: sms.configured, send: sms.send };
  var sent = [];
  sms.configured = function () { return true; };
  sms.send = async function (o) { sent.push(o); return { id: null, to: o.to }; };
  try {
    var rt = await routine('Texted', { dueAfterDays: 2, remindDueDays: 1, teamIds: [zq] });
    await routines.remind(at('2031-03-02', 8));
    var mine = sent.filter(function (o) { return o.to === '0200000002' && /ZRR Texted/.test(o.message); });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].purpose, 'auto_routine_reminder');
    assert.match(mine[0].message, /^Bamboo OS: coming up Mon 3 Mar, ZRR Texted \(a routine request\), needed by Wed 5 Mar\./);
    assert.equal((await reminders('routine_id', rt.id))[0].texts, 1);

    await routines._makeDue(rt.id, '2031-03-03');
    var req = await requestFor(rt.id, '2031-03-03');
    await routines.remind(at('2031-03-04', 8));
    mine = sent.filter(function (o) { return o.to === '0200000002' && o.refId === req.id && o.purpose === 'auto_routine_reminder'; });
    assert.equal(mine.length, 1);
    assert.match(mine[0].message, /^Bamboo OS reminder: MR-\d{4} ZRR Texted is needed tomorrow \(Wed 5 Mar\) and isn't done yet\./);

    var quiet = await routine('Not texted', { remindBySms: false, teamIds: [zq] });
    await routines.remind(at('2031-03-02', 11));
    assert.equal(sent.filter(function (o) { return /ZRR Not texted/.test(o.message); }).length, 0);
    assert.equal((await reminders('routine_id', quiet.id)).length, 1, 'still reminded in the OS');
  } finally {
    sms.configured = real.configured; sms.send = real.send;
  }
});
