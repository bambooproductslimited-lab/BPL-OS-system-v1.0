// The eighteenth batch (migration 0199): joiners and leavers; health and
// safety; statutory returns; asset depreciation and disposals; visitors and
// gate passes. Fake Zqty data in its own companies (ZQTY, ZQTZ).
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var onboarding = require('../src/services/onboarding.service');
var safety = require('../src/services/safety.service');
var returns = require('../src/services/returns.service');
var depreciation = require('../src/services/depreciation.service');
var visitors = require('../src/services/visitors.service');
var assets = require('../src/services/assets.service');
var invoices = require('../src/services/invoices.service');
var alerts = require('../src/jobs/dailyAlerts');

var co = {}, dept = {}, people = {}, ctx = {};
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function lastMonth() { var d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); }
var PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
var PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% zqty receipt\n').toString('base64');

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code IN ('ZQTY', 'ZQTZ')")).rows.map(function (r) { return r.id; });
  var emps = "SELECT id FROM employees WHERE code LIKE 'ZQTY-%' OR email LIKE 'zqty.%@example.com'";
  await pool.query('DELETE FROM onboard_lists WHERE employee_id IN (' + emps + ')');
  await pool.query('DELETE FROM onboard_templates WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM incidents WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM tax_returns WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM visitors WHERE company_id = ANY($1) OR host_id IN (' + emps + ')', [cos]);
  await pool.query('DELETE FROM gate_passes WHERE company_id = ANY($1)', [cos]);
  await pool.query("DELETE FROM expiry_alerts WHERE kind IN ('onboard', 'safety', 'gatepass') OR (kind LIKE 'return_%' AND ref_id = ANY($1))", [cos]);
  await pool.query("DELETE FROM assets WHERE description LIKE 'Zqty %'");
  await pool.query("DELETE FROM it_devices WHERE device_tag LIKE 'ZQTY-%'");
  await pool.query("DELETE FROM tool_room_items WHERE code LIKE 'ZQTY-%'");
  await pool.query('DELETE FROM salary_advances WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM payments WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqty %')");
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN (SELECT id FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqty %'))");
  await pool.query("DELETE FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqty %')");
  await pool.query("DELETE FROM customers WHERE name LIKE 'Zqty %'");
  await pool.query('DELETE FROM restaurant_orders WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM payslips WHERE employee_id IN (' + emps + ')');
  await pool.query('DELETE FROM pay_runs WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM attendance WHERE employee_id IN (' + emps + ')');
  await pool.query('DELETE FROM notifications WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zqty.%@example.com')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqty.%@example.com'");
  await pool.query('DELETE FROM employees WHERE id IN (' + emps + ')');
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
  await pool.query("UPDATE settings SET depreciation = '{}' WHERE id = 1");
}
async function person(key, code, first, o) {
  o = o || {};
  var id = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date, status, employment_type, pay_cycle, basic_salary, manager_id, ssnit_number, tin) VALUES ($1, $2, 'Zqty', $3, $4, $5, $6, 'active', 'permanent', 'monthly', 3000, $7, $8, $9) RETURNING id",
    [code, first, 'zqty.' + first.toLowerCase() + '@example.com', '0200003' + code.slice(-3), o.dept || dept.works, o.hired || '2022-01-01', o.manager || null, 'C0' + code.slice(-3) + '12345', 'P00' + code.slice(-3) + '9'])).rows[0].id;
  people[key] = id;
  if (o.role) {
    var user = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, 'x', 'active') RETURNING id", [id, 'zqty.' + first.toLowerCase() + '@example.com'])).rows[0].id;
    await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [user, o.role]);
    ctx[key] = await buildContext(user);
  }
  return id;
}
async function notes(empId) { return (await pool.query('SELECT title, body, link FROM notifications WHERE employee_id = $1 ORDER BY at', [empId])).rows; }

test.before(async function () {
  await cleanup();
  co.works = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTY', 'Zqty Works') RETURNING id")).rows[0].id;
  co.kitchen = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTZ', 'Zqty Kitchen') RETURNING id")).rows[0].id;
  dept.works = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTYW', 'Zqty Workshop', $1) RETURNING id", [co.works])).rows[0].id;
  dept.kitchen = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTYK', 'Zqty Kitchen', $1) RETURNING id", [co.kitchen])).rows[0].id;
  await person('boss', 'ZQTY-001', 'Kojo', { role: 'administrator' });
  await person('hr', 'ZQTY-002', 'Abena', { role: 'hr_manager' });
  await person('fin', 'ZQTY-003', 'Kwesi', { role: 'finance_manager' });
  await person('it', 'ZQTY-004', 'Selorm', { role: 'it_manager' });
  await person('mgr', 'ZQTY-005', 'Ekua', { role: 'department_manager' });
  await pool.query('UPDATE departments SET manager_id = $1 WHERE id IN ($2, $3)', [people.mgr, dept.works, dept.kitchen]);
  await person('staff', 'ZQTY-006', 'Fiifi', { role: 'employee' });
  await person('cook', 'ZQTY-007', 'Dzifa', { role: 'employee', dept: dept.kitchen });
});
test.after(async function () { await cleanup(); await pool.end(); });

test('joiners and leavers: a first-day list with steps for each team; a leaver hands back what they hold, an exit interview, marked as left', async function () {
  await assert.rejects(onboarding.overview(ctx.staff), /onboard\.manage/);
  var newbie = await person('newbie', 'ZQTY-008', 'Esinam', { role: 'employee', hired: day(3) });
  var l = await onboarding.start(ctx.hr, { employeeId: newbie, kind: 'join', day: day(3) });
  assert.equal(l.steps.length, onboarding.DEFAULTS.join.length);
  var by = function (list, t) { return list.steps.find(function (s) { return s.title === t; }); };
  assert.equal(by(l, 'Read the staff handbook').assignee.id, newbie, 'the person\'s own steps');
  assert.equal(by(l, 'A buddy for the first weeks').assignee.id, people.mgr, 'their manager\'s');
  assert.equal(by(l, 'Contract signed and filed').dueOn, day(0), 'three days before they start');
  assert.ok((await notes(newbie)).some(function (n) { return /Starting .*Esinam Zqty/.test(n.title) && /2 steps/.test(n.body); }));
  assert.ok((await notes(people.it)).some(function (n) { return /2 steps/.test(n.body); }), 'IT: the account and the laptop');
  await assert.rejects(onboarding.start(ctx.hr, { employeeId: newbie, kind: 'join' }), /open already/);
  // The newcomer sees their first days in My space and ticks their own.
  var mine = await onboarding.mine(ctx.newbie);
  assert.equal(mine.own.steps.length, 2);
  await onboarding.tick(ctx.newbie, mine.own.steps[0].id, { done: true });
  await assert.rejects(onboarding.tick(ctx.newbie, by(l, 'Contract signed and filed').id, {}), /not yours/);
  // IT ticks theirs, from My space.
  var itSteps = (await onboarding.mine(ctx.it)).steps;
  assert.equal(itSteps.filter(function (s) { return s.owner === 'it' && s.listId === l.id; }).length, 2);
  await onboarding.tick(ctx.it, by(l, 'Email and OS account set up').id, { done: true });
  var again = await onboarding.get(ctx.hr, l.id);
  assert.equal(again.done, 2);

  // A leaver with a laptop, a drill and a generator, and an advance still owed.
  var dev = (await pool.query("INSERT INTO it_devices (device_tag, category, brand, model, assigned_employee_id, status, assigned_at) VALUES ('ZQTY-LT-1', 'laptop', 'Zqty', 'Book 14', $1, 'in_use', now()) RETURNING id", [people.cook])).rows[0].id;
  var tool = (await pool.query("INSERT INTO tool_room_items (code, name, kind, checked_out_to, status, checked_out_at) VALUES ('ZQTY-DR-1', 'Zqty cordless drill', 'tool', $1, 'checked_out', now()) RETURNING id", [people.cook])).rows[0].id;
  var gen = await assets.create(ctx.boss, { category: 'Generator', description: 'Zqty kitchen generator', purchasePrice: 9000, purchaseDate: '2024-03-01', assignedEmployeeId: people.cook, companyId: co.kitchen });
  await pool.query("INSERT INTO salary_advances (number, employee_id, amount, months, instalment, reason, status, repaid, paid_at) VALUES (90001, $1, 600, 3, 200, 'Zqty: rent', 'paid', 200, now())", [people.cook]);
  var leave = await onboarding.start(ctx.hr, { employeeId: people.cook, kind: 'leave', day: day(10), reason: 'resigned' });
  var hand = leave.steps.filter(function (s) { return /^Hand back/.test(s.title); });
  assert.deepEqual(hand.map(function (s) { return s.kind; }).sort(), ['asset', 'device', 'tool']);
  assert.equal(leave.finalPay.advanceOwed, 400);
  await onboarding.tick(ctx.it, hand.find(function (s) { return s.kind === 'device'; }).id, { done: true });
  assert.equal((await pool.query('SELECT assigned_employee_id, status FROM it_devices WHERE id = $1', [dev])).rows[0].status, 'in_storage');
  await onboarding.tick(ctx.mgr, hand.find(function (s) { return s.kind === 'tool'; }).id, { done: true });
  assert.equal((await pool.query('SELECT status FROM tool_room_items WHERE id = $1', [tool])).rows[0].status, 'available');
  await onboarding.tick(ctx.mgr, hand.find(function (s) { return s.kind === 'asset'; }).id, { done: true });
  assert.equal((await pool.query('SELECT assigned_employee_id FROM assets WHERE id = $1', [gen.id])).rows[0].assigned_employee_id, null);
  await assert.rejects(onboarding.tick(ctx.hr, leave.steps.find(function (s) { return s.kind === 'exit_interview'; }).id, {}), /exit interview first/);
  var ex = await onboarding.exitInterview(ctx.hr, leave.id, { reason: 'Zqty: moving to Kumasi', rating: 4, rehire: true, comments: 'Zqty: good team, long commute.' });
  assert.equal(ex.steps.find(function (s) { return s.kind === 'exit_interview'; }).done, true);
  // Every other step, then the last: marked as left.
  for (var i = 0; i < ex.steps.length; i++) if (!ex.steps[i].done && ex.steps[i].kind !== 'mark_left') await onboarding.tick(ctx.boss, ex.steps[i].id, { done: true });
  await onboarding.tick(ctx.hr, ex.steps.find(function (s) { return s.kind === 'mark_left'; }).id, { done: true });
  var final = await onboarding.get(ctx.hr, leave.id);
  assert.equal(final.status, 'done');
  assert.equal((await pool.query('SELECT status FROM employees WHERE id = $1', [people.cook])).rows[0].status, 'terminated');
  await pool.query("UPDATE employees SET status = 'active' WHERE id = $1", [people.cook]);
  // Steps due and late are chased, once.
  await pool.query("UPDATE onboard_steps SET due_on = current_date - 4 WHERE list_id = $1 AND done_at IS NULL AND title = 'A buddy for the first weeks'", [l.id]);
  var sent = await alerts.onboardingAlerts(day(0), null);
  assert.ok(sent >= 1);
  assert.ok((await notes(people.mgr)).some(function (n) { return /^Late: A buddy for the first weeks/.test(n.title); }));
  // A company's own steps replace the built-in ones.
  var ov = await onboarding.saveTemplate(ctx.hr, { kind: 'join', companyId: co.kitchen, steps: [{ title: 'Zqty: food handler\'s certificate', owner: 'person', days: 0 }, { title: 'Zqty: kitchen safety walk', owner: 'manager', days: 1 }, { title: 'x', owner: 'hr' }] });
  assert.equal(ov.templates.byCompany[co.kitchen].join.length, 2);
});

test('health and safety: anyone reports with photos, safety investigates and sets actions, closes once they are done; days since the last lost-time injury', async function () {
  await assert.rejects(safety.overview(ctx.staff), /safety\.manage/);
  var near = await safety.report(ctx.staff, { kind: 'near_miss', location: 'Zqty saw bench', description: 'Zqty: offcut flew past my face when the guard was up.', photos: [PNG] });
  assert.deepEqual([near.kind, near.severity, near.photos, near.status], ['near_miss', 'low', 1, 'new']);
  assert.ok((await notes(people.hr)).some(function (n) { return /^🟡 Near miss reported — HS-\d{4}$/.test(n.title); }));
  var inj = await safety.report(ctx.staff, { kind: 'injury', location: 'Zqty yard', description: 'Zqty: slipped on wet boards, twisted an ankle.', injuredId: people.staff, injury: 'Zqty: left ankle', treatment: 'clinic', lostDays: 2, occurredAt: new Date().toISOString() });
  assert.equal(inj.lostTime, true);
  assert.ok((await notes(people.hr)).some(function (n) { return /^🚨 Injury reported/.test(n.title); }), 'lost time: flagged');
  await assert.rejects(safety.get(ctx.cook, inj.id), /not yours/);
  assert.equal((await safety.get(ctx.staff, inj.id)).id, inj.id, 'the reporter follows their report');
  var ov = await safety.overview(ctx.hr, { company: co.works });
  var counter = ov.counters.find(function (c) { return c.companyId === co.works; });
  assert.deepEqual([counter.days, ov.summary.injuries, ov.summary.nearMisses, ov.summary.nearPerInjury, ov.summary.lostDays], [0, 1, 1, 1, 2]);
  assert.equal(ov.months.length, 12);
  // Investigation, an action already late, closing.
  var u = await safety.update(ctx.hr, inj.id, { severity: 'medium', investigatorId: people.mgr, rootCause: 'Zqty: no drainage by the wash bay; boards stay wet.' });
  assert.equal(u.status, 'investigating');
  await assert.rejects(safety.addAction(ctx.hr, inj.id, { title: 'Zqty: mats', ownerId: people.mgr }), /By when/);
  var a = await safety.addAction(ctx.hr, inj.id, { title: 'Zqty: lay anti-slip mats by the wash bay', ownerId: people.mgr, dueOn: day(-1) });
  assert.equal(a.actionList.length, 1);
  assert.ok((await notes(people.mgr)).some(function (n) { return /Safety action for you/.test(n.title); }));
  await assert.rejects(safety.close(ctx.hr, inj.id), /1 action is still open/);
  assert.ok(await alerts.safetyAlerts(day(0), null) >= 1);
  assert.ok((await notes(people.mgr)).some(function (n) { return /^Late safety action/.test(n.title); }));
  assert.equal(await alerts.safetyAlerts(day(0), null), 0, 'once');
  await assert.rejects(safety.doneAction(ctx.staff, a.actionList[0].id, {}), /not yours/);
  assert.deepEqual(await safety.doneAction(ctx.mgr, a.actionList[0].id, { note: 'Zqty: six mats down' }), { ok: true });
  var closed = await safety.close(ctx.hr, inj.id);
  assert.equal(closed.status, 'closed');
  assert.ok((await notes(people.staff)).some(function (n) { return /is closed$/.test(n.title); }));
  var mine = await safety.mine(ctx.staff);
  assert.equal(mine.reports.length, 2);
  assert.equal((await safety.photoKey(ctx.hr, near.id, 0)).type, 'image/png');
});

test('statutory returns: PAYE and SSNIT from the pay runs, VAT from invoices and tills less input VAT; due dates; filed and paid; schedules; reminders', async function () {
  await assert.rejects(returns.view(ctx.staff, {}), /returns\.manage/);
  var m = lastMonth();
  var end = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
  var run = (await pool.query("INSERT INTO pay_runs (run_no, cycle, period_start, period_end, pay_date, status, created_by, company_id) VALUES ('PR-ZQTY-1', 'monthly', $1, $2, $2, 'paid', $3, $4) RETURNING id", [m + '-01', end, people.boss, co.works])).rows[0].id;
  var slip = "INSERT INTO payslips (pay_run_id, employee_id, days_worked, daily_rate, gross_pay, ssnit_employee, ssnit_employer, taxable_income, paye_tax, net_pay, paye_by_company, pay_basis, basic_pay, allowance_pay) VALUES ($1, $2, 22, 0, $3, $4, $5, $6, $7, $8, false, 'salary', $3, 0)";
  await pool.query(slip, [run, people.staff, 3000, 165, 390, 2835, 300, 2535]);
  await pool.query(slip, [run, people.mgr, 2000, 110, 260, 1890, 150, 1740]);
  var cust = (await pool.query("INSERT INTO customers (name, email, phone, category, company_id) VALUES ('Zqty Lodge', 'zqty.lodge@example.com', '0200003999', 'active', $1) RETURNING id", [co.works])).rows[0].id;
  var inv = await invoices.createManual(ctx.boss, { customerId: cust, items: [{ description: 'Zqty chairs', qty: 1, unitPrice: 1000 }], dueDate: day(10), taxRate: 25 });
  await pool.query('UPDATE invoices SET issued_at = $2, company_id = $3 WHERE id = $1', [inv.id, m + '-10', co.works]);
  await pool.query("INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, tax_total, status, created_at) VALUES ($1, 'ZQTY-1', $2, 200, 250, 50, 'completed', $3)", [co.works, people.cook, m + '-12T12:00:00Z']);
  var v = await returns.view(ctx.fin, { company: co.works });
  var cell = function (k) { return v.cells[k].find(function (c) { return c.period === m; }); };
  assert.deepEqual([cell('paye').amount, cell('ssnit').amount, cell('vat').amount, cell('wht').amount], [450, 925, 300, null]);
  assert.equal(cell('paye').due, returns.dueOn('paye', m));
  assert.ok(['due', 'overdue'].indexOf(cell('paye').state) >= 0);
  assert.equal(v.cells.paye.find(function (c) { return c.period === v.months[0]; }).state, 'before', 'nothing before the OS had data');
  // What makes them up; the schedules.
  var paye = await returns.detail(ctx.fin, { company: co.works, kind: 'paye', period: m });
  assert.deepEqual([paye.people.length, paye.totals.paye, paye.missing], [2, 450, 0]);
  var ssnit = await returns.detail(ctx.fin, { company: co.works, kind: 'ssnit', period: m });
  assert.deepEqual([ssnit.tiers.tier1, ssnit.tiers.tier2], [675, 250]);
  var csv = (await returns.schedule(ctx.fin, { company: co.works, kind: 'ssnit', period: m })).csv;
  assert.ok(/^Staff code,Name,SSNIT number/.test(csv) && /Tier 1 \(13\.5%\),,,,,,675\.00/.test(csv));
  var vat = await returns.detail(ctx.fin, { company: co.works, kind: 'vat', period: m });
  assert.deepEqual(vat.sources.map(function (s) { return [s.key, s.tax]; }), [['invoices', 250], ['till', 50]]);
  // Input VAT; filed; paid with a receipt.
  var saved = await returns.save(ctx.fin, { companyId: co.works, kind: 'vat', period: m, inputVat: 80, filedOn: day(0), filedRef: 'ZQTY-GRA-1' });
  assert.deepEqual([saved.amount, saved.state], [220, 'filed']);
  saved = await returns.save(ctx.fin, { companyId: co.works, kind: 'vat', period: m, paidOn: day(0), paidAmount: 220, paidRef: 'ZQTY-PAY-1', receipt: PDF });
  assert.deepEqual([saved.state, saved.receipt], ['paid', true]);
  await assert.rejects(returns.save(ctx.fin, { companyId: co.works, kind: 'wht', period: m, filedOn: day(0) }), /How much withholding/);
  await assert.rejects(returns.save(ctx.fin, { companyId: co.works, kind: 'paye', period: m, paidOn: day(1) }), /today or before/);
  v = await returns.view(ctx.fin, { company: co.works });
  assert.equal(v.tiles.paidYear, 220);
  assert.equal((await returns.receiptOf(ctx.fin, { company: co.works, kind: 'vat', period: m })).type, 'application/pdf');
  // Reminded once each, PAYE and SSNIT only once they are close.
  await alerts.returnsAlerts(day(0), null);
  var fin = (await notes(people.fin)).filter(function (n) { return /Zqty Works/.test(n.title); });
  assert.ok(fin.every(function (n) { return !/^VAT/.test(n.title); }), 'paid: no reminder');
  assert.equal(await alerts.returnsAlerts(day(0), null), 0, 'once');
});

test('depreciation: straight line or reducing balance, a category\'s life, book values as at a day, the year by month, a disposal with its gain or loss', async function () {
  await assert.rejects(depreciation.view(ctx.staff, {}), /asset\.read/);
  var a = await assets.create(ctx.boss, { category: 'Computer', description: 'Zqty laptop', purchasePrice: 3600, purchaseDate: '2024-01-15', companyId: co.works });
  var row = function (v) { return v.assets.find(function (x) { return x.id === a.id; }); };
  var v = await depreciation.view(ctx.boss, { company: co.works, asOf: '2025-01-31' });
  assert.deepEqual([row(v).method, row(v).months, row(v).source, row(v).monthly, row(v).accumulated, row(v).book], ['straight', 36, 'usual', 100, 1200, 2400]);
  assert.equal((await depreciation.view(ctx.boss, { company: co.works, asOf: '2025-01-30' })).assets.find(function (x) { return x.id === a.id; }).accumulated, 1100, 'only whole months');
  // Reducing balance: a year takes exactly the rate.
  await depreciation.setPolicy(ctx.boss, a.id, { method: 'reducing', rate: 25 });
  v = await depreciation.view(ctx.boss, { company: co.works, asOf: '2025-01-31' });
  assert.deepEqual([row(v).accumulated, row(v).book], [900, 2700]);
  // Back to the category's life, set in Settings.
  await depreciation.setPolicy(ctx.boss, a.id, {});
  await depreciation.saveSettings(ctx.boss, { byCategory: { Computer: { method: 'straight', months: 24 } } });
  v = await depreciation.view(ctx.boss, { company: co.works, asOf: '2025-01-31', year: '2024' });
  assert.deepEqual([row(v).source, row(v).monthly, row(v).accumulated, row(v).thisYear], ['category', 150, 1800, 1650]);
  assert.deepEqual(v.months.slice(0, 3).map(function (x) { return x.charge; }), [0, 150, 150], 'from the month after it was bought');
  var sch = await depreciation.schedule(ctx.boss, a.id);
  assert.deepEqual(sch.years.map(function (y) { return [y.year, y.charge]; }), [[2024, 1650], [2025, 1800], [2026, 150]]);
  // Sold in March 2025: its book value then, the loss.
  await assert.rejects(depreciation.dispose(ctx.boss, a.id, { on: '2025-03-10', kind: 'sold' }), /For how much/);
  var d = await depreciation.dispose(ctx.boss, a.id, { on: '2025-03-10', kind: 'sold', amount: 1000, note: 'Zqty: sold to a staff member' });
  assert.deepEqual([d.disposal.book, d.disposal.gain, d.status], [1650, -650, 'retired']);
  v = await depreciation.view(ctx.boss, { company: co.works, asOf: '2025-12-31', year: '2025' });
  assert.deepEqual([row(v).accumulated, row(v).book, v.disposals.length, v.totals.gain], [1950, 0, 1, -650]);
  assert.equal((await depreciation.view(ctx.boss, { company: co.works, asOf: '2026-01-31', year: '2026' })).assets.some(function (x) { return x.id === a.id; }), false, 'gone from later years');
  await depreciation.undoDisposal(ctx.boss, a.id);
  assert.equal((await pool.query('SELECT status, disposed_on FROM assets WHERE id = $1', [a.id])).rows[0].status, 'in_use');
  assert.ok((await depreciation.exportCsv(ctx.boss, { company: co.works, asOf: '2025-01-31' })).csv.indexOf(a.assetNo) > 0);
});

test('visitors and gate passes: expected and walked in, the host told, signed out; who is on site; goods out on an approved pass, back in, chased when late', async function () {
  await assert.rejects(visitors.desk(ctx.staff, {}), /visitor\.manage/);
  var tomorrow = new Date(Date.now() + 86400000); tomorrow.setUTCHours(10, 0, 0, 0);
  var exp = await visitors.expect(ctx.staff, { name: 'Akosua Zqty Mensah', phone: '0200003111', fromOrg: 'Zqty Interiors', purpose: 'meeting', expectedAt: tomorrow.toISOString() });
  assert.deepEqual([exp.status, exp.host.id, exp.code.length], ['expected', people.staff, 6]);
  var pass = await visitors.pass(exp.code.toLowerCase());
  assert.deepEqual([pass.name, pass.host, pass.phone], ['Akosua Zqty Mensah', 'Fiifi Zqty', undefined], 'the pass: no phone');
  var desk = await visitors.desk(ctx.hr, { company: co.works });
  assert.equal(desk.upcoming.filter(function (x) { return x.id === exp.id; }).length, 1);
  var inn = await visitors.signIn(ctx.hr, { id: exp.id, badge: 'V-07' });
  assert.deepEqual([inn.status, inn.badge], ['in', 'V-07']);
  assert.ok((await notes(people.staff)).some(function (n) { return n.title === '🛎️ Akosua Zqty Mensah is at reception'; }));
  await assert.rejects(visitors.signIn(ctx.hr, { name: 'Kofi Zqty', purpose: 'meeting' }), /Who are they here to see/);
  var walk = await visitors.signIn(ctx.hr, { name: 'Kofi Zqty Asare', purpose: 'contractor', hostId: people.mgr, fromOrg: 'Zqty Electrical', vehicle: 'GR 1-ZQ' });
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1, current_date, now() - interval '3 hours', 'present', 'manual')", [people.mgr]);
  var roll = await visitors.rollCall(ctx.hr, { company: co.works });
  assert.deepEqual([roll.visitors.length, roll.staff.map(function (s) { return s.id; })], [2, [people.mgr]]);
  await visitors.signOut(ctx.hr, walk.id);
  await assert.rejects(visitors.signOut(ctx.hr, walk.id), /not signed in/);
  var later = await visitors.expect(ctx.staff, { name: 'Yaw Zqty', purpose: 'interview', expectedAt: tomorrow.toISOString() });
  await assert.rejects(visitors.cancel(ctx.cook, later.id), /not yours/);
  await visitors.cancel(ctx.staff, later.id);
  await assert.rejects(visitors.pass(later.code), /not valid/);
  assert.equal((await visitors.mine(ctx.staff)).visitors.length, 1);

  // A laptop out for repair: asked, approved, out, late, back.
  await assert.rejects(visitors.requestPass(ctx.staff, { items: [{ what: 'Zqty laptop', qty: 1 }] }), /gatepass/);
  var gp = await visitors.requestPass(ctx.it, { companyId: co.works, items: [{ what: 'Zqty laptop', qty: 1 }, { what: 'x', qty: 2 }], reason: 'repair', returnable: true, backBy: day(2), carrier: 'Zqty Repairs', vehicle: 'GE 22-ZQ' });
  assert.deepEqual([gp.status, gp.items.length, /^GP-\d{4}$/.test(gp.ref)], ['requested', 1, true]);
  assert.ok((await notes(people.mgr)).some(function (n) { return /^🚪 Gate pass to approve/.test(n.title); }));
  await assert.rejects(visitors.gate(ctx.hr, gp.id, false), /not approved yet/);
  await assert.rejects(visitors.decide(ctx.it, gp.id, { approve: true }), /gatepass\.approve/);
  gp = await visitors.decide(ctx.mgr, gp.id, { approve: true });
  assert.equal(gp.status, 'approved');
  gp = await visitors.gate(ctx.hr, gp.id, false);
  assert.equal(gp.status, 'out');
  await pool.query('UPDATE gate_passes SET back_by = current_date - 2 WHERE id = $1', [gp.id]);
  assert.ok(await alerts.gatePassAlerts(day(0), null) >= 2);
  assert.ok((await notes(people.it)).some(function (n) { return /^Not back yet: GP-/.test(n.title); }));
  assert.equal(await alerts.gatePassAlerts(day(0), null), 0, 'once');
  gp = await visitors.gate(ctx.hr, gp.id, true);
  assert.equal(gp.status, 'back');
  // A manager's own pass is approved as it is asked for.
  var own = await visitors.requestPass(ctx.mgr, { companyId: co.works, items: [{ what: 'Zqty offcuts', qty: 12 }], reason: 'disposal' });
  assert.equal(own.status, 'approved');
});
