// The seventeenth batch (migration 0198): bank reconciliation; budgets
// against what was spent; staff performance reviews; recruitment with the
// public jobs page; staff training and certificates. Fake Zqtx data in its
// own companies (ZQTX, ZQTR).
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var bank = require('../src/services/bank.service');
var budgets = require('../src/services/budgets.service');
var reviews = require('../src/services/reviews.service');
var recruitment = require('../src/services/recruitment.service');
var training = require('../src/services/training.service');
var invoices = require('../src/services/invoices.service');
var bills = require('../src/services/bills.service');
var vehicles = require('../src/services/vehicles.service');
var alerts = require('../src/jobs/dailyAlerts');

var co = {}, dept = {}, people = {}, ctx = {};
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
var PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% zqtx curriculum vitae\n').toString('base64');
var PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code IN ('ZQTX', 'ZQTR')")).rows.map(function (r) { return r.id; });
  var emps = "SELECT id FROM employees WHERE code LIKE 'ZQTX-%' OR email LIKE 'zqtx.%@example.com'";
  await pool.query('DELETE FROM bank_accounts WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM budgets WHERE company_id = ANY($1)', [cos]);
  await pool.query("DELETE FROM expiry_alerts WHERE kind IN ('budget', 'cert') AND ref_id NOT IN (SELECT id FROM budgets UNION SELECT id FROM staff_certs)");
  await pool.query("DELETE FROM payments WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqtx %')");
  await pool.query("DELETE FROM receipts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqtx %')");
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN (SELECT id FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqtx %'))");
  await pool.query("DELETE FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqtx %')");
  await pool.query("DELETE FROM customers WHERE name LIKE 'Zqtx %'");
  await pool.query('DELETE FROM supplier_bills WHERE company_id = ANY($1)', [cos]);
  await pool.query("DELETE FROM vehicles WHERE name LIKE 'Zqtx %'");
  await pool.query('DELETE FROM payslips WHERE employee_id IN (' + emps + ')');
  await pool.query('DELETE FROM pay_runs WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM expense_sheets WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM review_rounds WHERE name LIKE 'Zqtx %'");
  await pool.query('DELETE FROM job_openings WHERE company_id = ANY($1)', [cos]);
  await pool.query("DELETE FROM trainings WHERE title LIKE 'Zqtx %'");
  await pool.query("DELETE FROM cert_types WHERE name LIKE 'Zqtx %'");
  await pool.query('DELETE FROM notifications WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zqtx.%@example.com')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqtx.%@example.com'");
  await pool.query('DELETE FROM employees WHERE id IN (' + emps + ')');
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
  await pool.query("UPDATE settings SET budgets = '{}' WHERE id = 1");
}
async function person(key, code, first, o) {
  o = o || {};
  var id = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date, status, employment_type, pay_cycle, basic_salary, manager_id) VALUES ($1, $2, 'Zqtx', $3, $4, $5, '2022-01-01', 'active', 'permanent', 'monthly', 3000, $6) RETURNING id",
    [code, first, 'zqtx.' + first.toLowerCase() + '@example.com', '0200002' + code.slice(-3), o.dept || dept.office, o.manager || null])).rows[0].id;
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
  co.office = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTX', 'Zqtx Works') RETURNING id")).rows[0].id;
  co.rest = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTR', 'Zqtx Kitchen') RETURNING id")).rows[0].id;
  dept.office = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTXO', 'Zqtx Office', $1) RETURNING id", [co.office])).rows[0].id;
  dept.rest = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTXK', 'Zqtx Kitchen', $1) RETURNING id", [co.rest])).rows[0].id;
  await person('boss', 'ZQTX-001', 'Kofi', { role: 'administrator' });
  await person('fin', 'ZQTX-002', 'Adwoa', { role: 'finance_manager' });
  await person('mgr', 'ZQTX-003', 'Ekow', { role: 'department_manager' });
  await pool.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [people.mgr, dept.office]);
  await person('staff', 'ZQTX-004', 'Yaa', { role: 'employee' });
  await person('cook', 'ZQTX-005', 'Esi', { role: 'employee', dept: dept.rest, manager: people.mgr });
});
test.after(async function () { await cleanup(); await pool.end(); });

test('bank: a statement read whatever its columns, imported once, matched to what was recorded, the rest explained, reconciled', async function () {
  // The reader on its own.
  assert.deepEqual(['02/03/2019', '2019-03-04', '05-Mar-2019', 'Mar 6, 2019', '31/02/2019'].map(bank.parseDay), ['2019-03-02', '2019-03-04', '2019-03-05', '2019-03-06', null]);
  assert.deepEqual(['1,250.00', '(300.00)', '45.10 DR', 'GHS 12', '-', ''].map(bank.parseAmount), [1250, -300, -45.1, 12, null, null]);
  assert.deepEqual(bank.parseCsv('a;b;"c;d"\n1;2;3\n'), [['a', 'b', 'c;d'], ['1', '2', '3']]);

  await assert.rejects(bank.overview(ctx.staff), /bank\.manage/);
  var acc = (await bank.saveAccount(ctx.fin, { companyId: co.office, name: 'Zqtx Ecobank current', kind: 'bank', bankName: 'Zqtx Ecobank', last4: '1234' })).account;
  // What the OS recorded: a customer paid an invoice, a bill was paid.
  var cust = (await pool.query("INSERT INTO customers (name, email, phone, category, company_id) VALUES ('Zqtx Lodge', 'zqtx.lodge@example.com', '0200002999', 'active', $1) RETURNING id", [co.office])).rows[0].id;
  var inv = await invoices.createManual(ctx.fin, { customerId: cust, items: [{ description: 'Zqtx chairs', qty: 1, unitPrice: 5000 }], dueDate: '2019-03-30' });
  await pool.query("UPDATE invoices SET issued_at = '2019-02-20', company_id = $2 WHERE id = $1", [inv.id, co.office]);
  await invoices.recordPayment(ctx.fin, inv.id, { amount: 2500, method: 'bank_transfer', date: '2019-03-01', reference: 'ZQ-TRF-9' });
  var bill = await bills.save(ctx.fin, { companyId: co.office, supplierName: 'Zqtx Timber', reference: 'ZT-1', category: 'stock', amount: 1500, billDate: '2019-02-25', dueDate: '2019-03-10' });
  await bills.pay(ctx.fin, bill.id, { amount: 1500, method: 'bank', reference: 'CHQ 0091', paidOn: '2019-03-04' });

  var csv = 'Zqtx Ecobank statement\nAccount: ****1234\n\nDate,Description,Reference,Debit,Credit,Balance\n' +
    '02/03/2019,TRANSFER FROM ZQTX LODGE,ZQ-TRF-9,,"2,500.00","12,500.00"\n' +
    '04/03/2019,CHEQUE ZQTX TIMBER,CHQ 0091,"1,500.00",,"11,000.00"\n' +
    '05-Mar-2019,BANK CHARGES,,25.00,,"10,975.00"\n' +
    '06/03/2019,MOMO TRANSFER IN,MM-55,,800.00,"11,775.00"\n';
  var pv = await bank.preview(ctx.fin, acc.id, { csv: csv });
  assert.equal(pv.found, true);
  assert.deepEqual([pv.mapping.date, pv.mapping.description, pv.mapping.reference, pv.mapping.debit, pv.mapping.credit, pv.mapping.balance], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(pv.lines.map(function (l) { return l.amount; }), [2500, -1500, -25, 800]);

  var got = await bank.importCsv(ctx.fin, acc.id, { csv: csv, filename: 'zqtx-march.csv' });
  assert.deepEqual([got.done.added, got.done.duplicates, got.done.matched], [4, 0, 2], 'the payment by its reference, the bill payment the only one that day');
  var again = await bank.importCsv(ctx.fin, acc.id, { csv: csv, filename: 'zqtx-march.csv' });
  assert.deepEqual([again.done.added, again.done.duplicates], [0, 4], 'the same statement twice adds nothing');
  var lines = got.lines;
  var by = function (desc) { return lines.find(function (l) { return l.description === desc; }); };
  assert.equal(by('TRANSFER FROM ZQTX LODGE').match.ref, inv.invoiceNo);
  assert.equal(by('CHEQUE ZQTX TIMBER').match.who, 'Zqtx Timber');
  assert.equal(by('BANK CHARGES').status, 'open');

  // Not reconciled while something is open.
  await assert.rejects(bank.reconcile(ctx.fin, acc.id, { until: '2019-03-06' }), /still open/);
  await assert.rejects(bank.explain(ctx.fin, by('BANK CHARGES').id, { category: 'other' }), /what it is/);
  var ex = await bank.explain(ctx.fin, by('BANK CHARGES').id, { category: 'bank_charges', note: 'Zqtx: monthly fee' });
  assert.equal(ex.status, 'explained');
  // The MoMo money: recorded afterwards, then found.
  var momo = by('MOMO TRANSFER IN');
  assert.equal((await bank.candidates(ctx.fin, momo.id)).candidates.length, 0);
  await invoices.recordPayment(ctx.fin, inv.id, { amount: 800, method: 'mobile_money', date: '2019-03-07', reference: 'MM-55' });
  var cand = await bank.candidates(ctx.fin, momo.id);
  assert.equal(cand.candidates.length, 1);
  var m = await bank.match(ctx.fin, momo.id, { type: cand.candidates[0].type, id: cand.candidates[0].id });
  assert.equal(m.status, 'matched');
  await assert.rejects(bank.match(ctx.fin, momo.id, { type: cand.candidates[0].type, id: cand.candidates[0].id }), /undo it first/);
  // Undo and match again; then reconcile, with the bank's own balance.
  await bank.undo(ctx.fin, momo.id);
  await bank.rematch(ctx.fin, acc.id);
  await assert.rejects(bank.reconcile(ctx.fin, acc.id, { until: '2019-03-06', balance: 11000 }), /shows GHS 11,775\.00/);
  var rec = await bank.reconcile(ctx.fin, acc.id, { until: '2019-03-06', balance: 11775 });
  assert.deepEqual([rec.account.reconciledUntil, rec.account.reconciledBalance, rec.account.open], ['2019-03-06', 11775, 0]);
  await assert.rejects(bank.undo(ctx.fin, momo.id), /reconciled period/);
  // The lines by status, month and words (the employees joined have a status too).
  assert.deepEqual((await bank.get(ctx.fin, acc.id, { status: 'explained' })).lines.map(function (l) { return l.description; }), ['BANK CHARGES']);
  assert.equal((await bank.get(ctx.fin, acc.id, { status: 'matched', month: '2019-03', q: 'zqtx' })).lines.length, 2);
  assert.equal((await bank.get(ctx.fin, acc.id, { status: 'open' })).lines.length, 0);
  var ov = await bank.overview(ctx.fin);
  assert.ok(ov.accounts.some(function (a) { return a.id === acc.id && a.matchedPct === 100; }));
});

test('budgets: a month planned by category, against bills, payroll, expenses and fuel; finance told past the warning, once', async function () {
  await assert.rejects(budgets.save(ctx.staff, { companyId: co.office, month: '2019-04', amounts: { stock: 1 } }), /report\.manage/);
  var v = await budgets.save(ctx.fin, { companyId: co.office, month: '2019-04', through: '2019-06', amounts: { stock: 5000, payroll: 9000, fuel: 600, expenses: 400, rent: '' } });
  assert.equal(v.rows.find(function (r) { return r.category === 'stock'; }).budget, 5000);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM budgets WHERE company_id = $1", [co.office])).rows[0].n, 12, 'four categories, three months');
  // What was spent in April 2019.
  await bills.save(ctx.fin, { companyId: co.office, supplierName: 'Zqtx Timber', category: 'stock', amount: 4800, billDate: '2019-04-10', dueDate: '2019-04-30' });
  await bills.save(ctx.fin, { companyId: co.office, supplierName: 'Zqtx Power', category: 'utilities', amount: 700, billDate: '2019-04-12', dueDate: '2019-04-30' });
  var run = (await pool.query("INSERT INTO pay_runs (run_no, cycle, period_start, period_end, pay_date, status, created_by, company_id) VALUES ('PR-ZQTX-04', 'monthly', '2019-04-01', '2019-04-30', '2019-04-30', 'paid', $1, $2) RETURNING id", [people.boss, co.office])).rows[0].id;
  await pool.query("INSERT INTO payslips (pay_run_id, employee_id, days_worked, daily_rate, gross_pay, ssnit_employee, ssnit_employer, taxable_income, paye_tax, net_pay, paye_by_company, pay_basis, basic_pay, allowance_pay) VALUES ($1, $2, 22, 0, 9500, 522.5, 1235, 8977.5, 900, 8077.5, false, 'salary', 9500, 0)", [run, people.staff]);
  var sheet = (await pool.query('INSERT INTO expense_sheets (employee_id) VALUES ($1) RETURNING id', [people.staff])).rows[0].id;
  await pool.query("INSERT INTO expense_sheet_lines (sheet_id, kind, seq, date, amount, note) VALUES ($1, 'expense', 1, '2019-04-03', 250, 'Zqtx taxi'), ($1, 'funding', 2, '2019-04-01', 1000, 'Zqtx float')", [sheet]);
  var van = await vehicles.save(ctx.boss, { companyId: co.office, name: 'Zqtx van', kind: 'van', fuel: 'diesel' });
  await vehicles.logFuel(ctx.boss, van.id, { day: '2019-04-08', litres: 40, amount: 520, fullTank: true });
  v = await budgets.view(ctx.fin, { company: co.office, month: '2019-04' });
  var row = function (c) { return v.rows.find(function (r) { return r.category === c; }); };
  assert.deepEqual([row('stock').actual, row('stock').state, row('stock').pct], [4800, 'near', 96]);
  assert.deepEqual([row('payroll').actual, row('payroll').state], [10735, 'over'], 'gross and the employer\'s SSNIT');
  assert.deepEqual([row('expenses').actual, row('fuel').actual, row('utilities').state], [250, 520, 'none'], 'spending without a budget is shown');
  assert.equal(v.year.find(function (y) { return y.month === '2019-04'; }).budget, 15000);
  var sp = await budgets.spent(ctx.fin, { company: co.office, month: '2019-04', category: 'fuel' });
  assert.deepEqual([sp.items.length, sp.total], [1, 520]);
  // This month: over on fuel, told once.
  await budgets.save(ctx.fin, { companyId: co.office, month: day(0).slice(0, 7), amounts: { fuel: 100 } });
  await vehicles.logFuel(ctx.boss, van.id, { day: day(0), litres: 10, amount: 150, fullTank: true });
  var over = await budgets.overruns();
  assert.ok(over.some(function (o) { return o.companyId === co.office && o.category === 'fuel' && o.over; }));
  var sent = await alerts.budgetAlerts(null);
  assert.ok(sent >= 1);
  assert.ok((await notes(people.fin)).some(function (n) { return /Over budget — fuel, Zqtx Works/.test(n.title); }));
  assert.equal(await alerts.budgetAlerts(null), 0, 'once');
});

test('reviews: a round for a company, the self-review, the manager\'s scores and goals, signed; who may read what', async function () {
  await assert.rejects(reviews.openRound(ctx.mgr, { name: 'Zqtx H1' }), /review\.manage/);
  var l = await reviews.openRound(ctx.boss, { name: 'Zqtx first half', periodStart: '2026-01-01', periodEnd: '2026-06-30', selfDue: day(7), dueOn: day(21), companyIds: [co.office, co.rest], questions: ['quality', 'teamwork', 'reliability'], custom: ['Zqtx: keeps the workshop tidy'] });
  var mine = function (who) { return l.reviews.find(function (r) { return r.employee.id === people[who]; }); };
  assert.equal(l.reviews.length, 5, 'everyone active in the two companies');
  assert.equal(mine('staff').reviewer.id, people.mgr, 'the department\'s manager');
  assert.equal(mine('cook').reviewer.id, people.mgr, 'their own manager');
  assert.equal(mine('mgr').reviewer, null, 'never themselves');
  assert.equal(mine('staff').questions.length, 4);
  assert.ok((await notes(people.staff)).some(function (n) { return /Your review: Zqtx first half/.test(n.title); }));
  var id = mine('staff').id;
  await assert.rejects(reviews.get(ctx.cook, id), /not yours/);
  await assert.rejects(reviews.selfReview(ctx.staff, id, { scores: { quality: 4 }, comment: 'Zqtx: a good half' }), /every point/);
  var scores = { quality: 4, teamwork: 5, reliability: 3, custom1: 4 };
  var r = await reviews.selfReview(ctx.staff, id, { scores: scores, comment: 'Zqtx: a good half, more orders finished on time.' });
  assert.deepEqual([r.status, r.self.average, r.manager], ['manager', 4, null], 'the manager\'s part hidden from the person until done');
  assert.ok((await notes(people.mgr)).some(function (n) { return n.link === '/reviews?open=' + id; }));
  await assert.rejects(reviews.managerReview(ctx.mgr, id, { scores: scores, strengths: 'Zqtx: careful work' }), /at least one goal/);
  r = await reviews.managerReview(ctx.mgr, id, { scores: { quality: 4, teamwork: 4, reliability: 4, custom1: 5 }, strengths: 'Zqtx: careful work', improve: 'Zqtx: time-keeping', goals: ['Zqtx: lead the finishing line', 'Zqtx: first aid course'] });
  assert.deepEqual([r.status, r.manager.overall, r.manager.goals.length], ['done', 4.3, 2]);
  var seen = await reviews.get(ctx.staff, id);
  assert.equal(seen.manager.strengths, 'Zqtx: careful work', 'the person reads it once it is done');
  r = await reviews.sign(ctx.staff, id, { comment: 'Zqtx: thank you' });
  assert.equal(r.status, 'signed');
  await assert.rejects(reviews.sign(ctx.staff, id, {}), /signed it already/);
  // Their manager is reviewed by someone HR names.
  var m = await reviews.setReviewer(ctx.boss, mine('mgr').id, { reviewerId: people.boss });
  assert.equal(m.reviewer.id, people.boss);
  var list = await reviews.list(ctx.mgr, {});
  assert.deepEqual(list.reviews.map(function (x) { return x.employee.id; }).sort(), [people.boss, people.fin, people.cook, people.staff].sort(), 'a reviewer sees the ones they review: their department, and the cook they manage');
  var me = await reviews.mine(ctx.staff);
  assert.equal(me.reviews[0].status, 'signed');
});

test('recruitment: a job posted, applied for on the jobs page with a CV, interviewed, hired into the staff', async function () {
  await assert.rejects(recruitment.overview(ctx.staff), /recruit\.manage/);
  var o = (await recruitment.saveOpening(ctx.boss, { companyId: co.office, departmentId: dept.office, title: 'Zqtx furniture finisher', location: 'Zqtx Tema', kind: 'full_time', description: 'Zqtx: sand, stain and lacquer bamboo furniture in the workshop.', requirements: 'Zqtx: two years in a workshop', status: 'open', closesOn: day(30) })).opening;
  assert.ok(/^zqtx-furniture-finisher-[0-9a-f]{6}$/.test(o.slug));
  var pub = await recruitment.publicList();
  assert.ok(pub.jobs.some(function (j) { return j.slug === o.slug; }));
  var job = await recruitment.publicJob(o.slug);
  assert.deepEqual([job.title, job.company, job.open], ['Zqtx furniture finisher', 'Zqtx Works', true]);
  assert.equal(job.id, undefined, 'no ids on the public page');
  await assert.rejects(recruitment.apply(o.slug, { name: 'Zqtx', email: 'x', phone: '1', cv: PDF }, '10.17.0.1'), /full name/);
  await assert.rejects(recruitment.apply(o.slug, { name: 'Akua Zqtx', email: 'zqtx.akua@example.com', phone: '0200002111' }, '10.17.0.1'), /Add your CV/);
  await assert.rejects(recruitment.apply(o.slug, { name: 'Akua Zqtx', email: 'zqtx.akua@example.com', phone: '0200002111', cv: 'data:text/plain;base64,aGVsbG8=' }, '10.17.0.1'), /PDF, a Word document or a photo/);
  var ok = await recruitment.apply(o.slug, { name: 'Akua Zqtx', email: 'zqtx.akua@example.com', phone: '0200002111', note: 'Zqtx: I finish chairs at a small workshop now.', cv: PDF, cvName: 'akua.pdf' }, '10.17.0.1');
  assert.equal(ok.ok, true);
  await assert.rejects(recruitment.apply(o.slug, { name: 'Akua Zqtx', email: 'zqtx.akua@example.com', phone: '0200002111', cv: PDF }, '10.17.0.1'), /applied for this job already/);
  assert.deepEqual(await recruitment.apply(o.slug, { name: 'Robot Zqtx', email: 'zqtx.bot@example.com', phone: '0200002112', cv: PDF, website: 'http://spam' }, '10.17.0.1'), { ok: true }, 'the hidden field: quietly dropped');
  assert.ok((await notes(people.boss)).some(function (n) { return /New applicant: Akua Zqtx/.test(n.title); }));
  // A walk-in, without a CV.
  await recruitment.addApplicant(ctx.boss, { openingId: o.id, name: 'Kwesi Zqtx', phone: '0200002113', source: 'walk_in' });
  var view = await recruitment.opening(ctx.boss, o.id);
  assert.deepEqual([view.applicants.length, view.opening.byStage.new], [2, 2]);
  var akua = view.applicants.find(function (a) { return a.name === 'Akua Zqtx'; });
  assert.deepEqual([akua.cv.type, akua.source], ['application/pdf', 'website']);
  await assert.rejects(recruitment.updateApplicant(ctx.boss, akua.id, { stage: 'interview' }), /When is the interview/);
  var a = await recruitment.updateApplicant(ctx.boss, akua.id, { stage: 'interview', interviewAt: day(3) + 'T10:00:00Z', interviewerId: people.mgr, rating: 4 });
  assert.deepEqual([a.stage, a.rating, a.interviewer.id], ['interview', 4, people.mgr]);
  assert.ok((await notes(people.mgr)).some(function (n) { return /Interview: Akua Zqtx/.test(n.title); }));
  a = await recruitment.addNote(ctx.boss, akua.id, { text: 'Zqtx: strong on finishing, slow on sanding' });
  assert.equal(a.notes.length, 1);
  var kwesi = view.applicants.find(function (x) { return x.name === 'Kwesi Zqtx'; });
  await assert.rejects(recruitment.updateApplicant(ctx.boss, kwesi.id, { stage: 'rejected' }), /Why not/);
  await recruitment.updateApplicant(ctx.boss, kwesi.id, { stage: 'rejected', rejectReason: 'Zqtx: no workshop experience' });
  await assert.rejects(recruitment.hire(ctx.boss, kwesi.id, {}), /email address first/);
  var hired = await recruitment.hire(ctx.boss, akua.id, { positionTitle: 'Zqtx finisher', hireDate: day(14) });
  assert.equal(hired.stage, 'hired');
  var emp = (await pool.query('SELECT first_name, last_name, email, department_id, position_title, status FROM employees WHERE id = $1', [hired.employee.id])).rows[0];
  assert.deepEqual([emp.first_name, emp.last_name, emp.email, emp.department_id, emp.position_title], ['Akua', 'Zqtx', 'zqtx.akua@example.com', dept.office, 'Zqtx finisher']);
  // Closed: off the jobs page, no more applications.
  await recruitment.saveOpening(ctx.boss, { id: o.id, companyId: co.office, title: o.title, description: o.description, status: 'closed' });
  await assert.rejects(recruitment.apply(o.slug, { name: 'Late Zqtx', email: 'zqtx.late@example.com', phone: '0200002114', cv: PDF }, '10.17.0.2'), /closed now/);
});

test('training: certificates each company needs, missing and running out at a glance; a training gives those who came theirs; reminded once', async function () {
  await assert.rejects(training.overview(ctx.staff), /training\.manage/);
  await training.saveType(ctx.boss, { name: 'Zqtx hygiene', validMonths: 12, requiredFor: [co.rest] });
  await training.saveType(ctx.boss, { name: 'Zqtx machine safety', validMonths: 24, requiredFor: [co.office] });
  var types = (await training.overview(ctx.boss, {})).types;
  var hyg = types.find(function (t) { return t.name === 'Zqtx hygiene'; }), mach = types.find(function (t) { return t.name === 'Zqtx machine safety'; });
  // The cook's hygiene certificate: issued almost a year ago, runs out soon.
  var issued = new Date(); issued.setUTCMonth(issued.getUTCMonth() - 12); issued.setUTCDate(issued.getUTCDate() + 10);
  var p = await training.saveCert(ctx.boss, { employeeId: people.cook, typeId: hyg.id, number: 'ZQ-H-1', issuedOn: issued.toISOString().slice(0, 10), photo: PNG });
  assert.deepEqual([p.certs[0].state, p.certs[0].verified, p.certs[0].hasPhoto], ['soon', true, true]);
  var ov = await training.overview(ctx.boss, { company: co.rest });
  var cook = ov.people.find(function (x) { return x.id === people.cook; });
  assert.equal(cook.cells[hyg.id].state, 'soon');
  ov = await training.overview(ctx.boss, { company: co.office });
  assert.equal(ov.people.find(function (x) { return x.id === people.staff; }).cells[mach.id].state, 'missing');
  // The staff member adds their own from My space: it waits for a check.
  var mine = await training.saveCert(ctx.staff, { typeId: mach.id, issuedOn: day(-30), number: 'ZQ-M-7' });
  assert.deepEqual([mine.certs[0].verified, mine.certs[0].expiresOn > day(600)], [false, true]);
  await assert.rejects(training.saveCert(ctx.staff, { employeeId: people.cook, typeId: mach.id, issuedOn: day(-1) }), /training\.manage/);
  assert.ok((await notes(people.boss)).some(function (n) { return /Check Yaa Zqtx's Zqtx machine safety/.test(n.title); }));
  await training.verify(ctx.boss, mine.certs[0].id);
  await assert.rejects(training.saveCert(ctx.staff, { id: mine.certs[0].id, typeId: mach.id, issuedOn: day(-2) }), /checked/);
  // A training on machine safety: the manager came, gets the certificate.
  var s = await training.saveSession(ctx.boss, { title: 'Zqtx machine safety refresher', typeId: mach.id, companyId: co.office, day: day(0), starts: '09:00', hours: 3, trainer: 'Zqtx Safety Co', employeeIds: [people.mgr, people.staff] });
  assert.equal(s.attendees.length, 2);
  s = await training.attendance(ctx.boss, s.id, { marks: { [people.mgr]: 'attended', [people.staff]: 'missed' } });
  assert.deepEqual([s.came, s.given], [1, 1]);
  var mgrCerts = (await training.person(ctx.boss, people.mgr)).certs;
  assert.deepEqual([mgrCerts[0].type, mgrCerts[0].issuer, mgrCerts[0].verified], ['Zqtx machine safety', 'Zqtx Safety Co', true]);
  // Reminded: the cook and whoever records training, once.
  var n = await alerts.certAlerts(day(0), null);
  assert.ok(n >= 2);
  assert.ok((await notes(people.cook)).some(function (x) { return /Zqtx hygiene runs out/.test(x.title); }));
  assert.equal(await alerts.certAlerts(day(0), null), 0, 'once');
  var my = await training.mine(ctx.cook);
  assert.equal(my.certs.length, 1);
});
