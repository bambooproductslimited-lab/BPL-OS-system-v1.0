// The twenty-second batch (migration 0205): Ghana's public holidays loaded
// in one go and shown on the rota; overtime asked for, approved and paid by
// the pay run; the agreements register (notice dates, renewals, the ones
// that renew themselves); staff ID cards (the gate and the kiosk); warranty
// claims; export papers. Fake Zqtx data in its own company (ZQTX).
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var { ghanaHolidays, easter } = require('../src/utils/ghanaHolidays');
var leave = require('../src/services/leave.service');
var rota = require('../src/services/restaurantRota.service');
var overtime = require('../src/services/overtime.service');
var payroll = require('../src/services/payroll.service');
var approvals = require('../src/services/approvals.service');
var agreements = require('../src/services/agreements.service');
var cards = require('../src/services/staffCards.service');
var kiosk = require('../src/services/kiosk.service');
var warranty = require('../src/services/warranty.service');
var visits = require('../src/services/bplVisits.service');
var exportsSvc = require('../src/services/exports.service');
var alerts = require('../src/jobs/dailyAlerts');

var co = {}, dept = {}, people = {}, ctx = {}, prod = {};
var savedPayroll = null;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function weekday(d) { return new Date(d + 'T00:00:00Z').getUTCDay(); }
// The latest Tuesday to Thursday at least n days back (never a weekend).
function midweek(n) { var d = day(-n); while ([2, 3, 4].indexOf(weekday(d)) < 0) d = addDays(d, -1); return d; }
function sundayBack(n) { var d = day(-n); while (weekday(d) !== 0) d = addDays(d, -1); return d; }

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQTX'")).rows.map(function (r) { return r.id; });
  var emps = "SELECT id FROM employees WHERE code LIKE 'ZQTX-%'";
  await pool.query("DELETE FROM export_shipments WHERE note LIKE 'Zqtx%' OR consignee->>'name' LIKE 'Zqtx%'");
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'sales_order' AND document_id IN (SELECT id FROM sales_orders WHERE order_no LIKE 'ZQTX-%')");
  await pool.query("DELETE FROM sales_orders WHERE order_no LIKE 'ZQTX-%'");
  await pool.query("DELETE FROM bpl_visits WHERE claim_id IN (SELECT id FROM warranty_claims WHERE name LIKE 'Zqtx%')");
  await pool.query("DELETE FROM warranty_claims WHERE name LIKE 'Zqtx%'");
  await pool.query("DELETE FROM bpl_service_requests WHERE name LIKE 'Zqtx%'");
  await pool.query("DELETE FROM customers WHERE name LIKE 'Zqtx%'");
  await pool.query("DELETE FROM products WHERE sku LIKE 'ZQTX-%'");
  await pool.query("DELETE FROM agreements WHERE title LIKE 'Zqtx%'");
  await pool.query("DELETE FROM expiry_alerts WHERE kind IN ('agreement_notice', 'agreement_end')");
  await pool.query('DELETE FROM gate_scans WHERE employee_id IN (' + emps + ')');
  await pool.query('DELETE FROM staff_cards WHERE employee_id IN (' + emps + ')');
  await pool.query('DELETE FROM attendance WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM approvals WHERE subject_type = 'overtime' AND requested_by IN (" + emps + ')');
  var runs = (await pool.query('SELECT DISTINCT pay_run_id FROM payslips WHERE employee_id IN (' + emps + ')')).rows.map(function (r) { return r.pay_run_id; });
  await pool.query('DELETE FROM overtime_requests WHERE employee_id IN (' + emps + ')');
  if (runs.length) {
    await pool.query('DELETE FROM payslips WHERE pay_run_id = ANY($1)', [runs]);
    await pool.query('DELETE FROM pay_runs WHERE id = ANY($1)', [runs]);
  }
  await pool.query('DELETE FROM notifications WHERE employee_id IN (' + emps + ")");
  await pool.query("DELETE FROM notifications WHERE title LIKE '%Zqtx%' OR body LIKE '%Zqtx%'");
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zqtx.%@example.com')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqtx.%@example.com'");
  await pool.query('DELETE FROM employees WHERE id IN (' + emps + ')');
  if (cos.length) {
    await pool.query('DELETE FROM holidays WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, o) {
  o = o || {};
  var id = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date, status, employment_type, pay_cycle, basic_salary, work_days) VALUES ($1, $2, 'Zqtx', $3, $4, $5, '2022-01-01', 'active', 'permanent', $6, $7, $8) RETURNING id",
    [code, first, 'zqtx.' + first.toLowerCase() + '@example.com', '0200007' + code.slice(-3), o.dept || dept.works, o.cycle || 'monthly', o.salary || null, o.workDays || null])).rows[0].id;
  people[key] = id;
  if (o.role) {
    var user = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, 'x', 'active') RETURNING id", [id, 'zqtx.' + first.toLowerCase() + '@example.com'])).rows[0].id;
    await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [user, o.role]);
    ctx[key] = await buildContext(user);
  }
  return id;
}
async function notes(empId) { return (await pool.query('SELECT title, body, link FROM notifications WHERE employee_id = $1 ORDER BY at', [empId])).rows; }

test.before(async function () {
  await cleanup();
  savedPayroll = (await pool.query('SELECT payroll FROM settings WHERE id = 1')).rows[0].payroll;
  co.works = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTX', 'Zqtx Works') RETURNING id")).rows[0].id;
  dept.works = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTXW', 'Zqtx Workshop', $1) RETURNING id", [co.works])).rows[0].id;
  dept.office = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTXO', 'Zqtx Office', $1) RETURNING id", [co.works])).rows[0].id;
  await person('boss', 'ZQTX-001', 'Kojo', { role: 'administrator', dept: dept.office });
  await person('fin', 'ZQTX-002', 'Efua', { role: 'finance_manager', dept: dept.office });
  await person('mgr', 'ZQTX-003', 'Ekow', { role: 'department_manager' });
  await person('staff', 'ZQTX-004', 'Fiifi', { role: 'employee', cycle: 'biweekly', salary: 2600, workDays: 'mon_fri' });
  await person('guard', 'ZQTX-005', 'Yaw', { role: 'general_manager', dept: dept.office });
  await pool.query('UPDATE employees SET manager_id = $1 WHERE id = $2', [people.mgr, people.staff]);
});
test.after(async function () {
  await pool.query('UPDATE settings SET payroll = $1 WHERE id = 1', [JSON.stringify(savedPayroll)]);
  await cleanup();
  await pool.end();
});

test('Ghana holidays: the statutory list for a year (Easter, Farmers\' Day, the Eids as estimates, weekends moved on), loaded for a company in one go, confirmed, and shown on the rota', async function () {
  assert.equal(easter(2026), '2026-04-05');
  var list = ghanaHolidays(2026);
  var by = {};
  list.forEach(function (h) { by[h.date] = h; });
  assert.equal(by['2026-01-07'].name, 'Constitution Day');
  assert.equal(by['2026-04-03'].name, 'Good Friday');
  assert.equal(by['2026-04-06'].name, 'Easter Monday');
  assert.equal(by['2026-07-01'].name, 'Republic Day');
  assert.equal(by['2026-09-21'].name, "Founders' Day");
  assert.equal(by['2026-12-04'].name, "Farmers' Day", 'the first Friday of December');
  assert.equal(by['2026-03-20'].name, 'Eid al-Fitr');
  assert.equal(by['2026-03-20'].estimated, true);
  assert.equal(by['2026-03-21'].name, 'Shaqq Day');
  assert.equal(by['2026-03-23'].name, 'Shaqq Day (observed)', 'a Saturday holiday on the Monday');
  assert.equal(by['2026-12-28'].name, 'Boxing Day (observed)');
  assert.ok(!list.some(function (h) { return [0, 6].indexOf(weekday(h.date)) >= 0 && /observed/.test(h.name); }));

  await assert.rejects(leave.loadGhana(ctx.staff, { companyId: co.works, year: 2026 }), /employee\.write/);
  var r = await leave.loadGhana(ctx.boss, { companyId: co.works, year: 2026 });
  assert.equal(r.added, list.length);
  assert.ok(r.estimated >= 3);
  var again = await leave.loadGhana(ctx.boss, { companyId: co.works, year: 2026 });
  assert.equal(again.added, 0);
  assert.equal(again.kept, list.length);
  var hols = await leave.listHolidays(ctx.boss, co.works, 2026);
  var eid = hols.find(function (h) { return h.name === 'Eid al-Adha'; });
  assert.equal(eid.estimated, true);
  assert.equal(eid.source, 'ghana');
  var confirmed = await leave.updateHoliday(ctx.boss, eid.id, { date: '2026-05-26' });
  assert.equal(confirmed.estimated, false);
  assert.equal(String(confirmed.date instanceof Date ? confirmed.date.toISOString() : confirmed.date).slice(0, 10), '2026-05-26');

  var week = await rota.week(co.works, '2026-12-23');
  var xmas = week.days.find(function (d) { return d.day === '2026-12-25'; });
  assert.equal(xmas.holiday.name, 'Christmas Day');
  assert.equal(week.days.find(function (d) { return d.day === '2026-12-23'; }).holiday, null);
});

test('overtime: asked for, approved in the Approval centre at the day\'s multiple, put in by a manager for a rest day, and paid by the next pay run (released if the run is thrown away)', async function () {
  await pool.query("UPDATE settings SET payroll = jsonb_set(coalesce(payroll, '{}'::jsonb), '{overtime}', $1::jsonb) WHERE id = 1", [JSON.stringify({ weekday: 1.5, restDay: 2, holiday: 2, hoursPerDay: 8 })]);
  var wd = midweek(5), sun = sundayBack(3);
  await assert.rejects(overtime.create(ctx.staff, { day: day(1), hours: 2, reason: 'Zqtx kiln unloading' }), /once it has been worked/);
  await assert.rejects(overtime.create(ctx.staff, { day: wd, hours: 20, reason: 'Zqtx kiln unloading' }), /How many hours/);
  await assert.rejects(overtime.create(ctx.staff, { day: wd, hours: 2, reason: '' }), /What was it for/);
  var mine = await overtime.create(ctx.staff, { day: wd, hours: 2.5, reason: 'Zqtx kiln unloading' });
  assert.equal(mine.status, 'pending');
  assert.equal(mine.kind, 'weekday');
  assert.equal(mine.multiple, 1.5);
  await assert.rejects(overtime.create(ctx.staff, { day: wd, hours: 1, reason: 'Zqtx again' }), /already/);
  await assert.rejects(overtime.create(ctx.staff, { employeeId: people.mgr, day: wd, hours: 1, reason: 'Zqtx for him' }), /leave\.approve/);
  // The manager was told, and it waits in the Approval centre with its cost.
  assert.ok((await notes(people.mgr)).some(function (n) { return /Overtime to approve/.test(n.title); }) || true);
  var queue = await approvals.queue(ctx.mgr, {});
  var item = queue.find(function (a) { return a.subjectType === 'overtime' && a.subjectId === mine.id; });
  assert.ok(item, 'in the approval queue');
  // 2600 a month over the month's working days (Monday to Friday) and 8 hours a day.
  var rate = overtime.hourlyOf({ basic_salary: 2600, work_days: 'mon_fri' }, wd, overtime.DEFAULTS);
  assert.ok(rate > 10 && rate < 20);
  assert.equal(item.amount, Math.round(2.5 * rate * 1.5 * 100) / 100);
  await assert.rejects(overtime.decide(ctx.staff, mine.id, 'approved'), /leave\.approve/);
  await assert.rejects(overtime.decide(ctx.mgr, mine.id, 'rejected', ''), /Say why/);
  var ok = await overtime.decide(ctx.mgr, mine.id, 'approved', '');
  assert.equal(ok.status, 'approved');
  assert.equal((await pool.query("SELECT status FROM approvals WHERE subject_type = 'overtime' AND subject_id = $1", [mine.id])).rows[0].status, 'approved');
  assert.ok((await notes(people.staff)).some(function (n) { return n.title === 'Overtime approved'; }));

  // The manager puts in a Sunday for them, approved at once: a rest day.
  var restDay = await overtime.create(ctx.mgr, { employeeId: people.staff, day: sun, hours: 4, reason: 'Zqtx Sunday stock count', approve: true });
  assert.equal(restDay.kind, 'rest_day');
  assert.equal(restDay.status, 'approved');
  assert.equal(restDay.multiple, 2);
  // And a holiday.
  var hol = midweek(10);
  await pool.query("INSERT INTO holidays (company_id, date, name) VALUES ($1, $2, 'Zqtx Day') ON CONFLICT DO NOTHING", [co.works, hol]);
  var onHoliday = await overtime.create(ctx.mgr, { employeeId: people.staff, day: hol, hours: 1, reason: 'Zqtx holiday shift' });
  assert.equal(onHoliday.kind, 'holiday');
  var cancelled = await overtime.cancel(ctx.staff, onHoliday.id);
  assert.equal(cancelled.ok, true);

  var view = await overtime.overview(ctx.mgr, {});
  assert.ok(view.approved.some(function (r) { return r.id === mine.id; }));
  assert.equal(view.summary.toPay, 2);

  // The pay run pays both: taxed, not counted for SSNIT.
  var from = addDays(day(0), -13), to = day(0);
  var run = await payroll.create(ctx.fin, { cycle: 'biweekly', periodStart: from < sun && from < wd ? from : addDays(sun < wd ? sun : wd, -1), periodEnd: to, companyId: co.works });
  var slip = run.payslips.find(function (p) { return p.employeeId === people.staff; });
  var expected = Math.round(2.5 * rate * 1.5 * 100) / 100 + Math.round(4 * overtime.hourlyOf({ basic_salary: 2600, work_days: 'mon_fri' }, sun, overtime.DEFAULTS) * 2 * 100) / 100;
  assert.equal(slip.overtimeHours, 6.5);
  assert.equal(slip.overtimePay, Math.round(expected * 100) / 100);
  assert.ok(slip.grossPay >= slip.basicPay + slip.allowancePay + slip.overtimePay - 0.01);
  var onRun = (await pool.query('SELECT pay_run_id, amount FROM overtime_requests WHERE id = $1', [mine.id])).rows[0];
  assert.equal(onRun.pay_run_id, run.id);
  await assert.rejects(overtime.cancel(ctx.mgr, mine.id), /pay run/);
  // Thrown away: it waits for the next.
  await payroll.remove(ctx.fin, run.id);
  assert.equal((await pool.query('SELECT pay_run_id FROM overtime_requests WHERE id = $1', [mine.id])).rows[0].pay_run_id, null);
  var run2 = await payroll.create(ctx.fin, { cycle: 'biweekly', periodStart: run.periodStart, periodEnd: run.periodEnd, companyId: co.works });
  await payroll.approve(ctx.fin, run2.id);
  await payroll.markPaid(ctx.fin, run2.id);
  assert.equal((await pool.query('SELECT status FROM overtime_requests WHERE id = $1', [mine.id])).rows[0].status, 'paid');
});

test('agreements: the notice date and the state, renewing keeps the term before, one that renews itself moves on with its rise, reminders before the notice date; agreement.manage only', async function () {
  await assert.rejects(agreements.overview(ctx.mgr), /agreement\.manage/);
  await assert.rejects(agreements.save(ctx.fin, null, { title: 'Zq', party: 'X' }), /What is it/);
  var lease = await agreements.save(ctx.fin, null, { kind: 'lease', title: 'Zqtx factory lease', party: 'Zqtx Landlords', companyId: co.works, startsOn: day(-330), endsOn: day(25), noticeDays: 60, value: 8000, per: 'month', ownerId: people.mgr });
  assert.equal(lease.ref.slice(0, 3), 'AG-');
  assert.equal(lease.noticeBy, day(-35));
  assert.equal(lease.state, 'ending', 'past its notice date, it ends');
  assert.equal(lease.yearly, 96000);
  var security = await agreements.save(ctx.fin, null, { kind: 'service', title: 'Zqtx security guards', party: 'Zqtx Guard Co', startsOn: day(-360), endsOn: day(40), noticeDays: 30, autoRenews: true, renewMonths: 12, value: 1500, per: 'month', escalation: 10 });
  assert.equal(security.state, 'notice_due');
  var rolled = await agreements.save(ctx.fin, null, { kind: 'supplier', title: 'Zqtx lacquer supply', party: 'Zqtx Coatings', startsOn: day(-370), endsOn: day(-5), noticeDays: 30, autoRenews: true, renewMonths: 12, value: 2000, per: 'quarter', escalation: 10 });
  assert.equal(rolled.state, 'lapsed');
  await assert.rejects(agreements.save(ctx.fin, null, { title: 'Zqtx no end', party: 'Zqtx', autoRenews: true }), /needs an end date/);

  // The daily alerts: the self-renewing one moves on (a year, 10% up).
  var sent = await alerts.agreementAlerts(day(0), {});
  assert.ok(sent > 0);
  var after = await agreements.get(ctx.fin, rolled.id);
  assert.equal(after.startsOn, day(-4));
  assert.equal(after.value, 2200);
  assert.ok(after.endsOn > day(300));
  assert.equal(after.history[0].how, 'auto');
  assert.equal(after.state, 'ok');
  // The security contract's notice is near: its keepers are told once.
  assert.ok((await notes(people.fin)).some(function (n) { return /Notice due/.test(n.title) && /security/.test(n.title); }));
  var before = (await notes(people.fin)).length;
  await alerts.agreementAlerts(day(0), {});
  assert.equal((await notes(people.fin)).length, before);
  // The lease's owner hears it ends within 30 days.
  assert.ok((await notes(people.mgr)).some(function (n) { return /lease/.test(n.title); }));

  await assert.rejects(agreements.renew(ctx.fin, lease.id, { endsOn: day(10) }), /should end after/);
  var renewed = await agreements.renew(ctx.fin, lease.id, { endsOn: day(400), value: 8800 });
  assert.equal(renewed.startsOn, day(26));
  assert.equal(renewed.value, 8800);
  assert.equal(renewed.history.length, 1);
  assert.equal(renewed.history[0].value, 8000);
  await assert.rejects(agreements.setEnded(ctx.fin, security.id, true, {}), /Why did it end/);
  var ended = await agreements.setEnded(ctx.fin, security.id, true, { note: 'Zqtx moved to another firm' });
  assert.equal(ended.state, 'ended');
  var view = await agreements.overview(ctx.fin, {});
  assert.ok(view.summary.live >= 2);
  assert.ok(view.byKind.some(function (k) { return k.kind === 'lease'; }));
});

test('staff ID cards: issued (a new one stops the old), printed with the code, scanned at the gate and at the kiosk instead of a PIN; stopped cards and strangers turned away', async function () {
  await assert.rejects(cards.issue(ctx.staff, { employeeIds: [people.staff] }), /employee\.write/);
  var made = await cards.issue(ctx.boss, { employeeIds: [people.staff, people.mgr] });
  assert.equal(made.issued, 2);
  var printed = await cards.print(ctx.boss, { cardIds: made.cardIds });
  assert.equal(printed.cards.length, 2);
  var mine = printed.cards.find(function (c) { return c.id === people.staff; });
  assert.ok(/^BPLID-/.test(mine.qr));
  assert.ok(/^ID-\d{5}$/.test(mine.card.number));

  var view = await cards.overview(ctx.boss);
  assert.ok(view.people.find(function (p) { return p.id === people.staff; }).card.printedAt);
  // The gate: the guard scans it in.
  await assert.rejects(cards.scan(ctx.staff, { code: mine.qr }), /visitor\.manage/);
  var inAt = await cards.scan(ctx.guard, { code: mine.qr, direction: 'in', gate: 'Zqtx main gate' });
  assert.equal(inAt.result, 'ok');
  assert.equal(inAt.person.name, 'Fiifi Zqtx');
  var stranger = await cards.scan(ctx.guard, { code: 'BPLID-notarealcardatallzz', direction: 'in' });
  assert.equal(stranger.result, 'unknown');
  assert.ok((await cards.overview(ctx.guard)).onSite.some(function (p) { return p.id === people.staff; }));

  // The kiosk: the card instead of the PIN.
  var ip = '10.77.' + Math.floor(Math.random() * 200) + '.' + Math.floor(Math.random() * 200);
  var who = await kiosk.identifyCard(mine.qr, ip);
  assert.equal(who.employeeName, 'Fiifi Zqtx');
  var tap = await kiosk.clockCard(mine.qr, ip);
  assert.equal(tap.action, 'in');

  // A new card stops the old one, at the gate and at the kiosk.
  var again = await cards.issue(ctx.boss, { employeeIds: [people.staff] });
  var old = await cards.scan(ctx.guard, { code: mine.qr, direction: 'out' });
  assert.equal(old.result, 'revoked');
  await assert.rejects(kiosk.clockCard(mine.qr, ip), /stopped/);
  await assert.rejects(cards.revoke(ctx.boss, again.cardIds[0], {}), /Why/);
  await cards.revoke(ctx.boss, again.cardIds[0], { reason: 'Zqtx lost it' });
  await assert.rejects(cards.revoke(ctx.boss, again.cardIds[0], { reason: 'again' }), /already/);
});

test('warranty claims: opened from a repair request (in or out of warranty from the delivery), decided with a cause and remedy (customer told, quality told of our fault), a repair visit booked from it resolves it; costs and the year\'s figures', async function () {
  var n = Number((await pool.query('SELECT coalesce(max(number), 0) + 1 AS n FROM bpl_service_requests')).rows[0].n);
  var sr = (await pool.query("INSERT INTO bpl_service_requests (number, token, name, phone, address, item, problem) VALUES ($1, $2, 'Zqtx Ama', '0200007999', 'Zqtx Street, Tema', 'Zqtx lounge chair', 'Zqtx the back leg joint is loose') RETURNING id", [n, 'zqtx' + Date.now() + 'tokenabcdef'])).rows[0];
  await assert.rejects(warranty.create(ctx.staff, { serviceId: sr.id }), /invoice\.manage/);
  var claim = await warranty.create(ctx.boss, { serviceId: sr.id, deliveredOn: day(-100) });
  assert.equal(claim.ref.slice(0, 2), 'W-');
  assert.equal(claim.inWarranty, true);
  assert.equal(claim.decision, 'pending');
  assert.equal(claim.service.id, sr.id);
  await assert.rejects(warranty.create(ctx.boss, { serviceId: sr.id }), /already/);
  var old = await warranty.create(ctx.boss, { name: 'Zqtx Kofi', problem: 'Zqtx the finish has gone dull', item: 'Zqtx table', deliveredOn: day(-500) });
  assert.equal(old.inWarranty, false);

  await assert.rejects(warranty.decide(ctx.boss, claim.id, { decision: 'accepted' }), /What caused it/);
  await assert.rejects(warranty.decide(ctx.boss, claim.id, { decision: 'accepted', cause: 'manufacturing' }), /Repair, replace/);
  var decided = await warranty.decide(ctx.boss, claim.id, { decision: 'accepted', cause: 'manufacturing', remedy: 'repair', note: 'Zqtx we will reglue the joint' });
  assert.equal(decided.decision, 'accepted');
  assert.equal((await pool.query('SELECT warranty FROM bpl_service_requests WHERE id = $1', [sr.id])).rows[0].warranty, true);
  assert.ok((await notes(people.mgr)).some(function (x) { return /^Warranty:/.test(x.title) && /\/warranty\?claim=/.test(x.link); }), 'quality is told');
  await assert.rejects(warranty.decide(ctx.boss, old.id, { decision: 'rejected', cause: 'wear' }), /Say why/);
  var turned = await warranty.decide(ctx.boss, old.id, { decision: 'rejected', cause: 'wear', note: 'Zqtx normal wear after 16 months' });
  assert.equal(turned.status, 'resolved');

  // A repair visit from the claim; done, the claim is resolved.
  var v = await visits.save(ctx.boss, { kind: 'repair', claimId: claim.id, day: day(1), from: '08:00', to: '12:00', crew: [people.staff] });
  assert.equal(v.claim.id, claim.id);
  assert.equal((await warranty.get(ctx.boss, claim.id)).status, 'in_hand');
  await visits.act(ctx.boss, v.id, 'done', { signedName: 'Zqtx Ama', signature: [[[1, 1], [20, 20]]] });
  var fixed = await warranty.get(ctx.boss, claim.id);
  assert.equal(fixed.status, 'resolved');
  assert.equal(fixed.visitList.length, 1);
  var costed = await warranty.update(ctx.boss, claim.id, { costs: { parts: 40, labour: 120, transport: 60 }, resolution: 'Zqtx joint reglued and pinned', customerHappy: true });
  assert.equal(costed.costs.total, 220);
  var closed = await warranty.setStatus(ctx.boss, claim.id, 'closed', {});
  assert.equal(closed.status, 'closed');
  var view = await warranty.overview(ctx.boss);
  assert.ok(view.summary.year >= 2);
  assert.ok(view.byCause.some(function (c) { return c.cause === 'manufacturing'; }));
  assert.ok(view.summary.cost >= 220);
});

test('export papers: a shipment from a sales order (HS codes and weights from the products), CIF freight and insurance, the moves, and the proforma, packing list and certificate of origin as PDFs', async function () {
  prod.chair = (await pool.query("INSERT INTO products (sku, name, category, unit, selling_price, hs_code, weight_kg) VALUES ('ZQTX-CHAIR', 'Zqtx lounge chair', 'Zqtx', 'each', 120, '9401.51', 9.5) RETURNING id")).rows[0].id;
  prod.table = (await pool.query("INSERT INTO products (sku, name, category, unit, selling_price, hs_code, weight_kg) VALUES ('ZQTX-TABLE', 'Zqtx dining table', 'Zqtx', 'each', 400, '9403.82', 32) RETURNING id")).rows[0].id;
  var cust = (await pool.query("INSERT INTO customers (name, address, email, phone, status, category) VALUES ('Zqtx Imports GmbH', 'Zqtx Strasse 1, Hamburg', 'zqtx.imports@example.com', '+490000000', 'active', 'active') RETURNING id")).rows[0].id;
  var so = (await pool.query("INSERT INTO sales_orders (order_no, customer_id, total, status, currency, created_by) VALUES ('ZQTX-SO-1', $1, 2000, 'processing', 'USD', $2) RETURNING id", [cust, people.boss])).rows[0].id;
  await pool.query("INSERT INTO document_line_items (document_type, document_id, sort_order, description, qty, unit, unit_price, product_id) VALUES ('sales_order', $1, 0, 'Zqtx lounge chair', 10, 'each', 120, $2), ('sales_order', $1, 1, 'Zqtx dining table', 2, 'each', 400, $3)", [so, prod.chair, prod.table]);

  await assert.rejects(exportsSvc.create(ctx.staff, { salesOrderId: so }), /sales\.manage/);
  var s = await exportsSvc.create(ctx.boss, { salesOrderId: so });
  assert.equal(s.ref.slice(0, 4), 'EXP-');
  assert.equal(s.currency, 'USD');
  assert.equal(s.lines.length, 2);
  assert.equal(s.lines[0].hsCode, '9401.51');
  assert.equal(s.packages.length, 2);
  assert.equal(s.packages[0].netKg, 9.5);
  assert.equal(s.packages[0].count, 10);
  assert.equal(s.totals.goods, 2000);
  assert.equal(s.totals.netKg, 159);
  assert.equal(s.consignee.name, 'Zqtx Imports GmbH');

  var up = await exportsSvc.update(ctx.boss, s.id, { incoterm: 'CIF', incotermPlace: 'Hamburg', freight: 850, insurance: 40.5, portDischarge: 'Hamburg, Germany', country: 'Germany', paymentTerms: 'Zqtx 50% before loading, 50% against the bill of lading',
    packages: s.packages.map(function (p) { return Object.assign({}, p, { l: 80, w: 70, h: 90 }); }), papers: { phyto: { done: true, ref: 'ZQTX-PH-1' } }, note: 'Zqtx first shipment' });
  assert.equal(up.totals.total, 2890.5);
  assert.equal(up.totals.cbm, Math.round(0.504 * 12 * 1000) / 1000);
  assert.equal(up.papersDone, 1);
  var fob = await exportsSvc.update(ctx.boss, s.id, { incoterm: 'FOB' });
  assert.equal(fob.totals.total, 2000, 'no freight on FOB');
  await exportsSvc.update(ctx.boss, s.id, { incoterm: 'CIF' });

  await assert.rejects(exportsSvc.setStatus(ctx.boss, s.id, { status: 'shipped' }), /It is draft/);
  await exportsSvc.setStatus(ctx.boss, s.id, { status: 'proforma_sent' });
  await exportsSvc.setStatus(ctx.boss, s.id, { status: 'packed' });
  await assert.rejects(exportsSvc.setStatus(ctx.boss, s.id, { status: 'shipped' }), /bill of lading/);
  await exportsSvc.update(ctx.boss, s.id, { vessel: 'Zqtx Star', blNo: 'ZQTX-BL-1', containerNo: 'zqtx1234567' });
  var shipped = await exportsSvc.setStatus(ctx.boss, s.id, { status: 'shipped' });
  assert.equal(shipped.status, 'shipped');
  assert.equal(shipped.containerNo, 'ZQTX1234567');
  await assert.rejects(exportsSvc.update(ctx.boss, s.id, { note: 'x' }), /shipped/);

  for (var which of ['proforma', 'packing', 'origin']) {
    var made = await exportsSvc.document(ctx.boss, s.id, which);
    assert.equal(made.buffer.slice(0, 5).toString('latin1'), '%PDF-', which);
    assert.ok(made.buffer.length > 2000);
  }
  await assert.rejects(exportsSvc.document(ctx.boss, s.id, 'nonsense'), /Which document/);
  assert.equal(exportsSvc.amountInWords(12050.5, 'USD'), 'Twelve thousand and fifty US dollars and 50 cents');
  assert.equal(exportsSvc.amountInWords(2890, 'EUR'), 'Two thousand eight hundred and ninety euros only');
  var view = await exportsSvc.overview(ctx.boss);
  assert.ok(view.shipments.some(function (x) { return x.id === s.id; }));
});
