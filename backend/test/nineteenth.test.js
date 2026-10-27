// The nineteenth batch (migration 0200): discipline and grievances; quality
// inspections; staff voice — pulse surveys and the ideas box; goals; uniforms
// and PPE. Fake Zqni data in its own companies (ZQNI, ZQNJ).
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var discipline = require('../src/services/discipline.service');
var quality = require('../src/services/quality.service');
var voice = require('../src/services/voice.service');
var goals = require('../src/services/goals.service');
var ppe = require('../src/services/ppe.service');
var onboarding = require('../src/services/onboarding.service');
var alerts = require('../src/jobs/dailyAlerts');

var co = {}, dept = {}, people = {}, ctx = {};
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function months(n) { var d = new Date(day(0) + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
var PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code IN ('ZQNI', 'ZQNJ')")).rows.map(function (r) { return r.id; });
  var emps = "SELECT id FROM employees WHERE code LIKE 'ZQNI-%' OR email LIKE 'zqni.%@example.com'";
  await pool.query('DELETE FROM discipline_cases WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM qc_inspections WHERE lot_ref LIKE 'ZQNI%' OR batch_id IN (SELECT id FROM production_batches WHERE batch_no LIKE 'ZQNI-%')");
  await pool.query("DELETE FROM qc_checklists WHERE name LIKE 'Zqni%'");
  await pool.query("DELETE FROM production_batches WHERE batch_no LIKE 'ZQNI-%'");
  await pool.query("DELETE FROM products WHERE sku LIKE 'ZQNI-%'");
  await pool.query("DELETE FROM voice_surveys WHERE title LIKE 'Zqni%'");
  await pool.query("DELETE FROM voice_ideas WHERE title LIKE 'Zqni%'");
  await pool.query("DELETE FROM goal_objectives WHERE title LIKE 'Zqni%'");
  await pool.query("DELETE FROM ppe_items WHERE name LIKE 'Zqni%'");
  await pool.query('DELETE FROM ppe_sizes WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM expiry_alerts WHERE kind IN ('discipline_reply', 'discipline_hearing', 'discipline_warning', 'qc_hold', 'voice_survey', 'goal_checkin', 'ppe_due', 'ppe_low')");
  await pool.query('DELETE FROM onboard_lists WHERE employee_id IN (' + emps + ')');
  await pool.query('DELETE FROM notifications WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zqni.%@example.com')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqni.%@example.com'");
  await pool.query('DELETE FROM employees WHERE id IN (' + emps + ')');
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, o) {
  o = o || {};
  var id = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date, status, employment_type, pay_cycle, manager_id) VALUES ($1, $2, 'Zqni', $3, $4, $5, '2022-01-01', 'active', 'permanent', 'monthly', $6) RETURNING id",
    [code, first, 'zqni.' + first.toLowerCase() + '@example.com', '0200004' + code.slice(-3), o.dept || dept.works, o.manager || null])).rows[0].id;
  people[key] = id;
  if (o.role) {
    var user = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, 'x', 'active') RETURNING id", [id, 'zqni.' + first.toLowerCase() + '@example.com'])).rows[0].id;
    await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [user, o.role]);
    ctx[key] = await buildContext(user);
  }
  return id;
}
async function notes(empId) { return (await pool.query('SELECT title, body, link FROM notifications WHERE employee_id = $1 ORDER BY at', [empId])).rows; }

test.before(async function () {
  await cleanup();
  co.works = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQNI', 'Zqni Works') RETURNING id")).rows[0].id;
  co.kitchen = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQNJ', 'Zqni Kitchen') RETURNING id")).rows[0].id;
  dept.works = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQNIW', 'Zqni Workshop', $1) RETURNING id", [co.works])).rows[0].id;
  dept.kitchen = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQNIK', 'Zqni Kitchen', $1) RETURNING id", [co.kitchen])).rows[0].id;
  await person('boss', 'ZQNI-001', 'Kojo', { role: 'administrator' });
  await person('hr', 'ZQNI-002', 'Abena', { role: 'hr_manager' });
  await person('mgr', 'ZQNI-003', 'Ekua', { role: 'department_manager' });
  await person('sup', 'ZQNI-004', 'Yaw', { role: 'supervisor' });
  await person('staff', 'ZQNI-005', 'Fiifi', { role: 'employee', manager: null });
  await person('mate', 'ZQNI-006', 'Akos', { role: 'employee' });
  await person('cook', 'ZQNI-007', 'Dzifa', { role: 'employee', dept: dept.kitchen });
  await pool.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [people.mgr, dept.works]);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('discipline: a query answered from My space, a hearing, a warning that runs six months, an appeal reduces it; confidential throughout', async function () {
  await assert.rejects(discipline.overview(ctx.staff), /discipline\.manage/);
  await assert.rejects(discipline.open(ctx.hr, { employeeId: people.hr, title: 'Zqni: late', category: 'lateness' }), /Someone else/);
  var c = await discipline.open(ctx.hr, { employeeId: people.staff, category: 'lateness', title: 'Zqni: late four times this month', details: 'Zqni: clock-in after 08:30 on four days.', occurredOn: day(-2) });
  assert.equal(c.ref.slice(0, 3), 'DC-');
  assert.equal(c.status, 'open');
  // Nothing in their My space until a letter reaches them.
  assert.equal((await discipline.mine(ctx.staff)).cases.length, 0);
  await assert.rejects(discipline.get(ctx.staff, c.id), /not yours/);
  await assert.rejects(discipline.query(ctx.hr, c.id, { text: 'Too short', replyDue: day(2) }), /Write the query/);
  c = await discipline.query(ctx.hr, c.id, { text: 'Zqni: you clocked in after 08:30 on four days this month. Please explain in writing.', replyDue: day(2) });
  assert.equal(c.status, 'awaiting_reply');
  assert.ok((await notes(people.staff)).some(function (n) { return /needs your reply/.test(n.title); }));
  var mine = await discipline.mine(ctx.staff);
  assert.equal(mine.cases.length, 1);
  assert.ok(mine.cases[0].canReply);
  assert.equal(mine.cases[0].details, '', 'HR\'s notes are not theirs to read');
  await discipline.note(ctx.hr, c.id, { body: 'Zqni: supervisor says the bus route changed.' });
  assert.ok(!(await discipline.get(ctx.staff, c.id)).events.some(function (e) { return e.kind === 'note'; }), 'notes stay with HR');
  await assert.rejects(discipline.get(ctx.mate, c.id), /not yours/);
  assert.deepEqual(await discipline.reply(ctx.staff, c.id, { text: 'Zqni: the trotro route changed; I now leave home earlier.' }), { ok: true });
  assert.ok((await notes(people.hr)).some(function (n) { return /replied/.test(n.title); }));
  // A hearing tomorrow, with the manager on the panel: both reminded the day before.
  var at = day(1) + 'T10:00:00Z';
  c = await discipline.hearing(ctx.hr, c.id, { at: at, place: 'Zqni meeting room', panelIds: [people.mgr, people.staff] });
  assert.equal(c.status, 'hearing');
  assert.equal(c.hearing.panel.length, 1, 'not the person themselves');
  assert.ok((await notes(people.mgr)).some(function (n) { return /hearing panel/.test(n.title); }));
  var sent = await alerts.disciplineAlerts(day(0), null);
  assert.ok(sent >= 3, 'the person, the panel and whoever handles it');
  assert.equal(await alerts.disciplineAlerts(day(0), null), 0, 'once');
  // A written warning: six months; it can be appealed for ten days.
  await assert.rejects(discipline.decide(ctx.hr, c.id, { outcome: 'upheld', note: 'Zqni: not for a discipline case.' }), /What was decided/);
  c = await discipline.decide(ctx.hr, c.id, { outcome: 'written_warning', note: 'Zqni: lateness after a verbal reminder; a written warning.' });
  assert.equal(c.outcome.warningUntil, months(6));
  assert.ok(c.outcome.active);
  var theirs = await discipline.get(ctx.staff, c.id);
  assert.ok(theirs.canAppeal);
  assert.deepEqual(await discipline.appeal(ctx.staff, c.id, { text: 'Zqni: the bus route was outside my control.' }), { ok: true });
  await assert.rejects(discipline.appeal(ctx.staff, c.id, { text: 'Zqni: again please.' }), /cannot be appealed/);
  await assert.rejects(discipline.appealResult(ctx.hr, c.id, { result: 'reduced', outcome: 'final_warning', note: 'Zqni: no, higher.' }), /Reduced to what/);
  c = await discipline.appealResult(ctx.hr, c.id, { result: 'reduced', outcome: 'verbal_warning', note: 'Zqni: the route change is accepted; a verbal warning.' });
  assert.equal(c.status, 'closed');
  assert.equal(c.outcome.outcome, 'verbal_warning');
  assert.equal(c.outcome.warningUntil, months(3));
  // A second case: the next step up from the warning still running.
  var c2 = await discipline.open(ctx.hr, { employeeId: people.staff, category: 'absence', title: 'Zqni: absent without leave on Monday' });
  assert.equal(c2.history.length, 1);
  assert.equal(c2.suggested, 'written_warning');
  // A reply not given by its day: whoever handles it is told.
  await discipline.query(ctx.hr, c2.id, { text: 'Zqni: you were absent on Monday without leave. Please explain.', replyDue: day(1) });
  await pool.query('UPDATE discipline_cases SET reply_due = $2 WHERE id = $1', [c2.id, day(-1)]);
  assert.ok(await alerts.disciplineAlerts(day(0), null) >= 1);
  assert.ok((await notes(people.hr)).some(function (n) { return /^No reply yet/.test(n.title); }));
  var ov = await discipline.overview(ctx.hr, { status: 'all' });
  assert.equal(ov.summary.lateReplies, 1);
  assert.ok(ov.warnings.some(function (w) { return w.person.id === people.staff && w.outcome === 'verbal_warning'; }));
});

test('grievances: raised from My space, never seen by the person they are about, even one who handles cases', async function () {
  await assert.rejects(discipline.grievance(ctx.staff, { title: 'Zqni: pay', details: 'short' }), /what happened/);
  var g = await discipline.grievance(ctx.staff, { category: 'treatment', title: 'Zqni: shouted at in front of customers', details: 'Zqni: on Friday, in the showroom, in front of two customers.', againstId: people.hr });
  assert.equal(g.ref.slice(0, 3), 'GR-');
  assert.equal(g.role, 'person');
  await assert.rejects(discipline.get(ctx.hr, g.id), /not yours/, 'HR, who it is about, does not see it');
  assert.ok(!(await discipline.overview(ctx.hr, { status: 'all' })).cases.some(function (c) { return c.id === g.id; }));
  assert.ok(!(await notes(people.hr)).some(function (n) { return /grievance/.test(n.title); }));
  assert.ok((await notes(people.boss)).some(function (n) { return /A grievance/.test(n.title); }));
  var seen = await discipline.get(ctx.boss, g.id);
  assert.equal(seen.role, 'hr');
  g = await discipline.decide(ctx.boss, g.id, { outcome: 'partly_upheld', note: 'Zqni: spoken to; an apology given; training on feedback booked.' });
  assert.equal(g.outcome.warningUntil, null);
  assert.ok((await discipline.mine(ctx.staff)).cases.some(function (c) { return c.id === g.id && c.outcome && c.outcome.outcome === 'partly_upheld'; }));
  await assert.rejects(discipline.setStatus(ctx.mate, g.id, 'withdrawn', {}), /discipline\.manage/);
});

test('quality: a checklist with a critical measure; pass, hold and fail; settling a lot; first-pass yield and the top defects', async function () {
  var product = (await pool.query("INSERT INTO products (sku, name, category, unit, cost_price, selling_price, description) VALUES ('ZQNI-CH1', 'Zqni Lounge chair', 'Furniture', 'pcs', 400, 900, '') RETURNING id")).rows[0].id;
  var batch = (await pool.query("INSERT INTO production_batches (batch_no, date, production_line, output_product_id, input_qty, output_qty, supervisor_id) VALUES ('ZQNI-B1', current_date, 'Line 1', $1, 60, 50, $2) RETURNING id", [product, people.sup])).rows[0].id;
  await assert.rejects(quality.overview(ctx.staff), /production\.read/);
  await assert.rejects(quality.saveChecklist(ctx.sup, null, { name: 'Zqni chairs', points: [{ label: 'Moisture', kind: 'measure' }] }), /min, a max/);
  var lists = await quality.saveChecklist(ctx.sup, null, { name: 'Zqni chairs — final', stage: 'final', productId: product, points: [
    { label: 'Finish smooth, no drips', kind: 'check' }, { label: 'Joints tight', kind: 'check' }, { label: 'Moisture content', kind: 'measure', min: 8, max: 12, unit: '%', critical: true }] });
  var list = lists.find(function (l) { return l.name === 'Zqni chairs — final'; });
  assert.equal(list.points.length, 3);
  await assert.rejects(quality.inspect(ctx.sup, { checklistId: list.id, batchId: batch, results: [{ ok: true }] }), /every point/);
  // A pass first time.
  var a = await quality.inspect(ctx.sup, { checklistId: list.id, batchId: batch, sampleSize: 8, results: [{ ok: true }, { ok: true }, { value: 10 }] });
  assert.equal(a.verdict, 'pass');
  assert.ok(a.firstPass);
  assert.equal(a.disposition, 'release');
  // A lot with a joint not tight: on hold; production told.
  var b = await quality.inspect(ctx.sup, { checklistId: list.id, lotRef: 'ZQNI-LOT-2', lotQty: 30, results: [{ ok: true }, { ok: false, note: 'two loose' }, { value: 11 }], defects: [{ type: 'joint', qty: 2, severity: 'major', photo: PNG }, { type: 'finish', qty: 1 }] });
  assert.equal(b.verdict, 'hold');
  assert.equal(b.defectList.length, 2);
  assert.ok(b.defectList[0].photo);
  assert.ok((await notes(people.mgr)).some(function (n) { return /is on hold/.test(n.title); }));
  // Too wet: the critical measure fails it.
  var c = await quality.inspect(ctx.sup, { checklistId: list.id, batchId: batch, lotQty: 50, results: [{ ok: true }, { ok: true }, { value: 15 }], defects: [{ type: 'moisture', qty: 6, severity: 'critical' }] });
  assert.equal(c.verdict, 'fail');
  assert.equal(c.firstPass, false, 'the batch was inspected before');
  assert.equal(c.others.length, 1);
  await assert.rejects(quality.settle(ctx.sup, c.id, { disposition: 'release', note: 'Zqni: fine' }), /not released/);
  await assert.rejects(quality.settle(ctx.sup, c.id, { disposition: 'scrap', scrapQty: 80, note: 'Zqni: too wet' }), /More than the lot/);
  c = await quality.settle(ctx.sup, c.id, { disposition: 'rework', reworkQty: 44, scrapQty: 6, note: 'Zqni: back to the kiln two days; six cracked.' });
  assert.equal(c.open, false);
  assert.equal(c.reworkQty, 44);
  // The hold left three days: chased once.
  await pool.query("UPDATE qc_inspections SET inspected_at = now() - interval '3 days' WHERE id = $1", [b.id]);
  assert.ok(await alerts.qualityAlerts(day(0), null) >= 1);
  assert.equal(await alerts.qualityAlerts(day(0), null), 0, 'once');
  var ov = await quality.overview(ctx.mgr, {});
  assert.ok(ov.summary.onHold >= 1);
  assert.ok(ov.topDefects.length >= 3);
  assert.equal(ov.topDefects[0].type, 'moisture', 'the defect that came up most');
  assert.equal(quality.verdictOf([{ ok: true }], [{ severity: 'minor' }], ''), 'pass_notes');
});

test('staff voice: an anonymous survey shown only once five have answered; one answer each; reminders; ideas with votes and an answer', async function () {
  await assert.rejects(voice.saveSurvey(ctx.staff, null, { title: 'Zqni pulse', questions: [{ kind: 'scale', text: 'How was your week?' }] }), /voice\.manage/);
  var s = await voice.saveSurvey(ctx.hr, null, { title: 'Zqni pulse, October', intro: 'Two minutes.', companyId: co.works, questions: [
    { kind: 'scale', text: 'I have what I need to do my job well' }, { kind: 'enps', text: 'Would you recommend working here to a friend?' },
    { kind: 'choice', text: 'The best day for the team meeting', options: ['Monday', 'Friday'] }, { kind: 'text', text: 'One thing we should change' }] });
  assert.equal(s.status, 'draft');
  s = await voice.setSurvey(ctx.hr, s.id, 'open');
  assert.equal(s.invited, 6, 'everyone at Zqni Works');
  assert.ok((await notes(people.staff)).some(function (n) { return /Zqni pulse/.test(n.title); }));
  await assert.rejects(voice.answer(ctx.cook, s.id, { answers: { q1: 4, q2: 9, q3: 'Monday' } }), /not for you/);
  await assert.rejects(voice.answer(ctx.staff, s.id, { answers: { q1: 7, q2: 9, q3: 'Monday' } }), /1 to 5/);
  var answers = [[ctx.staff, 4, 9, 'Monday', 'Zqni: more fans in the workshop'], [ctx.mate, 5, 10, 'Monday', ''], [ctx.mgr, 3, 6, 'Friday', 'Zqni: earlier pay day'], [ctx.sup, 4, 8, 'Monday', ''], [ctx.boss, 2, 4, 'Friday', '']];
  for (var i = 0; i < 4; i++) await voice.answer(answers[i][0], s.id, { answers: { q1: answers[i][1], q2: answers[i][2], q3: answers[i][3], q4: answers[i][4] } });
  await assert.rejects(voice.answer(ctx.staff, s.id, { answers: { q1: 4, q2: 9, q3: 'Monday' } }), /answered it already/);
  var r = await voice.survey(ctx.hr, s.id);
  assert.ok(r.hidden, 'four answers: too few to show');
  assert.ok(r.results.every(function (q) { return q.hidden; }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM voice_responses WHERE survey_id = $1 AND employee_id IS NOT NULL', [s.id])).rows[0].n, 0, 'no names kept');
  await voice.answer(answers[4][0], s.id, { answers: { q1: answers[4][1], q2: answers[4][2], q3: answers[4][3] } });
  r = await voice.survey(ctx.hr, s.id);
  assert.equal(r.hidden, false);
  assert.equal(r.results[0].average, 3.6);
  assert.equal(r.results[1].enps.score, 0, '2 promoters, 2 detractors of 5');
  assert.deepEqual(r.results[2].options.map(function (o) { return o.count; }), [3, 2]);
  assert.equal(r.results[3].answers.length, 2);
  // Closing tomorrow: whoever has not answered is reminded, once.
  await pool.query('UPDATE voice_surveys SET closes_on = current_date + 1 WHERE id = $1', [s.id]);
  assert.equal(await alerts.voiceAlerts(day(0), null), 1, 'HR has not answered');
  assert.equal(await alerts.voiceAlerts(day(0), null), 0);
  await pool.query('UPDATE voice_surveys SET closes_on = current_date - 1 WHERE id = $1', [s.id]);
  await alerts.voiceAlerts(day(0), null);
  assert.equal((await voice.survey(ctx.hr, s.id)).status, 'closed');
  // The ideas box.
  var idea = await voice.shareIdea(ctx.staff, { title: 'Zqni: a water cooler by the kilns', body: 'Zqni: it gets very hot by the drying kilns.', category: 'wellbeing', anonymous: true });
  assert.equal(idea.votes, 1, 'its author votes for it');
  assert.equal(idea.author, null);
  idea = await voice.vote(ctx.cook, idea.id, { on: true });
  assert.equal(idea.votes, 2);
  var ov = await voice.overview(ctx.hr, {});
  var seen = ov.ideas.find(function (x) { return x.id === idea.id; });
  assert.equal(seen.author, null, 'anonymous, even to whoever runs it');
  assert.equal(seen.mine, false);
  await assert.rejects(voice.answerIdea(ctx.hr, idea.id, { status: 'planned' }), /what happens next/);
  await voice.answerIdea(ctx.hr, idea.id, { status: 'planned', response: 'Zqni: one is ordered for November.' });
  assert.ok((await notes(people.staff)).some(function (n) { return /Your idea/.test(n.title) && /planned/.test(n.title); }));
  var my = await voice.mine(ctx.staff);
  assert.ok(my.ideas.some(function (x) { return x.id === idea.id && x.mine; }));
});

test('goals: a company objective, a team one lined up under it; check-ins move the progress; off track tells the owner; a week without a check-in is chased', async function () {
  await assert.rejects(goals.create(ctx.staff, { title: 'Zqni: grow', keyResults: [] }), /goals\.manage/);
  var period = goals.periodOf();
  await assert.rejects(goals.create(ctx.boss, { title: 'Zqni: sell more chairs this quarter', keyResults: [] }), /at least one key result/);
  var o = await goals.create(ctx.boss, { period: period, title: 'Zqni: sell more chairs, with fewer rejects', why: 'Zqni: the hotels are buying.', keyResults: [
    { title: 'Zqni: chairs sold', kind: 'number', unit: 'chairs', start: 100, target: 200, ownerId: people.staff },
    { title: 'Zqni: rejects at final inspection', kind: 'percent', start: 12, target: 8, ownerId: people.mgr }] });
  assert.equal(o.keyResults.length, 2);
  assert.ok((await notes(people.staff)).some(function (n) { return /A goal for/.test(n.title); }));
  await assert.rejects(goals.create(ctx.mgr, { level: 'team', title: 'Zqni: workshop part', keyResults: [{ title: 'Zqni: kiln days', start: 0, target: 10 }] }), /Which team/);
  var t = await goals.create(ctx.mgr, { level: 'team', departmentId: dept.works, parentId: o.id, period: period, title: 'Zqni: workshop: dry it right first time', keyResults: [{ title: 'Zqni: lots passing moisture first time', kind: 'percent', start: 70, target: 95 }] });
  assert.equal(t.parent.id, o.id);
  await assert.rejects(goals.checkIn(ctx.cook, o.keyResults[0].id, { value: 150, confidence: 'on_track' }), /not yours/);
  o = await goals.checkIn(ctx.staff, o.keyResults[0].id, { value: 150, confidence: 'on_track', note: 'Zqni: two hotel orders in.' });
  assert.equal(o.keyResults[0].progress, 50);
  o = await goals.checkIn(ctx.mgr, o.keyResults[1].id, { value: 10, confidence: 'off_track', note: 'Zqni: the kiln is down a week.' });
  assert.equal(o.keyResults[1].progress, 50, 'from 12 down to 10 of the way to 8');
  assert.equal(o.progress, 50);
  assert.equal(o.confidence, 'off_track');
  assert.ok((await notes(people.boss)).some(function (n) { return /^🔴 Off track/.test(n.title); }));
  assert.equal(o.children.length, 1);
  var ov = await goals.overview(ctx.staff, { period: period });
  assert.ok(ov.company.some(function (x) { return x.id === o.id && x.aligned === 1; }));
  assert.equal(ov.mine.length, 1);
  assert.equal((await goals.mine(ctx.mgr)).keyResults.length, 2, 'their own and the team\'s');
  // The team key result never checked in: its owner hears, once a week.
  assert.ok(await alerts.goalAlerts(day(0), null) >= 1);
  assert.equal(await alerts.goalAlerts(day(0), null), 0);
  assert.equal(goals.shiftPeriod('2026-Q4', 1), '2027-Q1');
});

test('uniforms and PPE: stock by size, a request from My space issued from the store, who lacks what their team needs, replacements and low stock chased, handed back on leaving', async function () {
  await assert.rejects(ppe.overview(ctx.staff), /ppe\.manage/);
  var ov = await ppe.saveItem(ctx.hr, null, { name: 'Zqni Safety boots', kind: 'ppe', sizes: ['41', '42', '43'], lifeMonths: 12, unitCost: 180, requiredFor: [dept.works], minQty: { '42': 2 } });
  var boots = ov.items.find(function (i) { return i.name === 'Zqni Safety boots'; });
  assert.equal(boots.stock.length, 3);
  ov = await ppe.receive(ctx.hr, { itemId: boots.id, size: '42', qty: 4 });
  assert.equal(ov.items.find(function (i) { return i.id === boots.id; }).total, 4);
  assert.equal(ov.gaps.filter(function (g) { return g.itemId === boots.id; }).length, 6, 'everyone in the workshop');
  await assert.rejects(ppe.request(ctx.staff, { itemId: boots.id, size: '45' }), /Which size/);
  var rq = await ppe.request(ctx.staff, { itemId: boots.id, size: '42', reason: 'new', note: 'Zqni: mine are trainers' });
  await assert.rejects(ppe.request(ctx.staff, { itemId: boots.id, size: '42' }), /already/);
  assert.ok((await notes(people.hr)).some(function (n) { return /needs Zqni Safety boots/.test(n.title); }));
  assert.equal((await ppe.mine(ctx.staff)).sizes[boots.id], '42', 'the size remembered');
  var s = await ppe.issue(ctx.hr, { employeeId: people.staff, itemId: boots.id, size: '42', requestId: rq.id });
  assert.equal(s.dueOn, months(12));
  assert.equal(s.cost, 180);
  assert.ok((await notes(people.staff)).some(function (n) { return /Zqni Safety boots \(42\) for you/.test(n.title); }));
  await assert.rejects(ppe.issue(ctx.hr, { employeeId: people.mate, itemId: boots.id, size: '43' }), /Not enough in the store/);
  var mine = await ppe.mine(ctx.staff);
  assert.equal(mine.held.length, 1);
  assert.equal(mine.missing.length, 0);
  assert.ok((await ppe.mine(ctx.mate)).missing.some(function (m) { return m.id === boots.id; }));
  // Down to the minimum, and a replacement due within the week.
  await ppe.issue(ctx.hr, { employeeId: people.mate, itemId: boots.id, size: '42' });
  await pool.query('UPDATE ppe_issues SET due_on = $2 WHERE id = $1', [s.id, day(3)]);
  var sent = await alerts.ppeAlerts(day(0), null);
  assert.ok(sent >= 2, 'the person, and whoever keeps the store');
  assert.ok((await notes(people.staff)).some(function (n) { return /Time for a new Zqni Safety boots/.test(n.title); }));
  assert.ok((await notes(people.hr)).some(function (n) { return /Running low: Zqni Safety boots/.test(n.title); }));
  assert.equal(await alerts.ppeAlerts(day(0), null), 0, 'once');
  // Leaving: the boots are on their checklist; ticking hands them back.
  var l = await onboarding.start(ctx.hr, { employeeId: people.staff, kind: 'leave', day: day(5), reason: 'resigned' });
  var step = l.steps.find(function (x) { return x.kind === 'ppe'; });
  assert.equal(step.title, 'Hand back Zqni Safety boots (42)');
  await onboarding.tick(ctx.hr, step.id, { done: true });
  assert.equal((await ppe.mine(ctx.staff)).held.length, 0);
  var p = await ppe.person(ctx.hr, people.staff);
  assert.equal(p.issues[0].status, 'returned');
});
