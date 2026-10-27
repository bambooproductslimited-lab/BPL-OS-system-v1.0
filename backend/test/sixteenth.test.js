// The sixteenth batch (migration 0197): customer statements and credit
// limits; the cash flow forecast; salary advances repaid from payroll; the
// supplier price watch on a restaurant's till; vehicles and fuel. Fake Zqsx
// data, its own companies (staff active only while their own pay runs are
// made, so the other payroll tests never pick them up).
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var statements = require('../src/services/statements.service');
var invoices = require('../src/services/invoices.service');
var creditNotes = require('../src/services/creditNotes.service');
var cashflow = require('../src/services/cashflow.service');
var advances = require('../src/services/advances.service');
var payroll = require('../src/services/payroll.service');
var prices = require('../src/services/restaurantPrices.service');
var vehicles = require('../src/services/vehicles.service');
var bills = require('../src/services/bills.service');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var mail = require('../src/services/mail.service');
var alerts = require('../src/jobs/dailyAlerts');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { mgr: '7891' };
var IP = '10.16.0.';
var PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
var co = {}, dept = {}, people = {}, ctx = {}, tok = {}, sent = [];
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code IN ('ZQSX', 'ZQSR')")).rows.map(function (r) { return r.id; });
  var emps = "SELECT id FROM employees WHERE code LIKE 'ZQSX-%'";
  await pool.query("DELETE FROM statement_links WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqsx %')");
  await pool.query("DELETE FROM credit_notes WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqsx %')");
  await pool.query("DELETE FROM receipts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqsx %')");
  await pool.query("DELETE FROM payments WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqsx %')");
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN (SELECT id FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqsx %'))");
  await pool.query("DELETE FROM document_shares WHERE document_type = 'invoice' AND document_id IN (SELECT id FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqsx %'))");
  await pool.query("DELETE FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zqsx %')");
  await pool.query("DELETE FROM customers WHERE name LIKE 'Zqsx %'");
  await pool.query("DELETE FROM salary_advance_repayments WHERE advance_id IN (SELECT id FROM salary_advances WHERE employee_id IN (" + emps + '))');
  await pool.query('DELETE FROM salary_advances WHERE employee_id IN (' + emps + ')');
  await pool.query('DELETE FROM payslips WHERE employee_id IN (' + emps + ')');
  await pool.query('DELETE FROM pay_runs WHERE company_id = ANY($1)', [cos]);
  await pool.query("DELETE FROM vehicles WHERE name LIKE 'Zqsx %'");
  await pool.query("DELETE FROM expiry_alerts WHERE kind LIKE 'vehicle_%' AND ref_id NOT IN (SELECT id FROM vehicles)");
  await pool.query('DELETE FROM supplier_bills WHERE company_id = ANY($1)', [cos]);
  await pool.query('DELETE FROM cashflow_items WHERE company_id = ANY($1)', [cos]);
  for (var q of ['DELETE FROM restaurant_purchase_orders WHERE company_id = ANY($1)', 'DELETE FROM restaurant_stock_moves WHERE company_id = ANY($1)', 'DELETE FROM restaurant_ingredients WHERE company_id = ANY($1)',
    'DELETE FROM restaurant_suppliers WHERE company_id = ANY($1)', 'DELETE FROM restaurant_more_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)',
    'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', 'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]).catch(function (e) { if (e.code !== '42P01') throw e; });
  await pool.query('DELETE FROM notifications WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zqsx.%@example.com')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqsx.%@example.com'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQSX-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
  await pool.query("UPDATE settings SET advances = '{}', cashflow = '{}' WHERE id = 1");
}
async function person(key, code, first, o) {
  o = o || {};
  var id = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date, status, employment_type, pay_cycle, basic_salary, allowance, kiosk_pin_hash) VALUES ($1, $2, 'Zqsx', $3, $4, $5, '2022-01-01', $6, 'permanent', 'monthly', $7, $8, $9) RETURNING id",
    [code, first, 'zqsx.' + first.toLowerCase() + '@example.com', '0200001' + code.slice(-3).replace(/\D/g, '0'), o.dept || dept.office, o.status || 'active', o.basic == null ? null : o.basic, o.allowance || 0, o.pin ? pinAuth.hashPin(o.pin) : null])).rows[0].id;
  people[key] = id;
  if (o.role) {
    var user = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, 'x', 'active') RETURNING id", [id, 'zqsx.' + first.toLowerCase() + '@example.com'])).rows[0].id;
    await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [user, o.role]);
    ctx[key] = await buildContext(user);
  }
  return id;
}
async function notes(empId) { return (await pool.query('SELECT title, body, link FROM notifications WHERE employee_id = $1 ORDER BY at', [empId])).rows; }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  co.office = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQSX', 'Zqsx Works') RETURNING id")).rows[0].id;
  co.rest = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQSR', 'Zqsx Kitchen') RETURNING id")).rows[0].id;
  dept.office = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQSXO', 'Zqsx Office', $1) RETURNING id", [co.office])).rows[0].id;
  dept.rest = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQSXK', 'Zqsx Kitchen', $1) RETURNING id", [co.rest])).rows[0].id;
  await person('fin', 'ZQSX-001', 'Adwoa', { role: 'finance_manager' });
  await person('boss', 'ZQSX-002', 'Kofi', { role: 'administrator' });
  await person('staff', 'ZQSX-003', 'Yaa', { role: 'employee', basic: 3000, allowance: 600, status: 'inactive' });
  await person('driver', 'ZQSX-004', 'Kwaku', { role: 'employee' });
  await person('mgr', 'ZQSX-005', 'Ekow', { dept: dept.rest, pin: PINS.mgr });
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager')", [co.rest, people.mgr]);
  await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqsx stew', 'Zqsx Mains', 50, true)", [co.rest]);
  tok.mgr = (await pos.login(PINS.mgr, IP + '1', 'till')).token;
  mail.setTransportForTests({ sendMail: async function (m) { sent.push(m); return { messageId: 'zqsx-' + sent.length }; } });
});
test.after(async function () { mail.setTransportForTests(null); await cleanup(); await pool.end(); });

var cust, inv = [];
test('a statement: brought forward, every invoice, payment and credit note, the running balance, how old it is; a link, a PDF, an email; credit limits', async function () {
  cust = (await pool.query("INSERT INTO customers (name, contact_person, email, phone, category, company_id) VALUES ('Zqsx Lodge', 'Ama Zqsx', 'zqsx.lodge@example.com', '0200001999', 'active', $1) RETURNING id", [co.office])).rows[0].id;
  var make = async function (amount, issued, due) {
    var i = await invoices.createManual(ctx.fin, { customerId: cust, items: [{ description: 'Zqsx bamboo chairs', qty: 1, unitPrice: amount }], dueDate: due });
    await pool.query('UPDATE invoices SET issued_at = $2, due_date = $3, company_id = $4 WHERE id = $1', [i.id, issued, due, co.office]);
    return i;
  };
  inv.push(await make(1000, day(-200), day(-170)));
  inv.push(await make(2500, day(-50), day(-20)));
  inv.push(await make(800, day(-5), day(25)));
  await invoices.recordPayment(ctx.fin, inv[0].id, { amount: 1000, method: 'bank_transfer', date: day(-160), reference: 'ZQ-TRF-1' });
  await invoices.recordPayment(ctx.fin, inv[1].id, { amount: 500, method: 'mobile_money', date: day(-10), reference: 'MM-77' });
  await creditNotes.create(ctx.fin, inv[1].id, { amount: 200, reason: 'Zqsx: one chair scratched' });

  var st = await statements.get(ctx.fin, cust, { from: day(-60) });
  assert.equal(st.opening, 0, 'the first invoice and its payment before the start');
  assert.deepEqual(st.lines.map(function (l) { return l.kind; }), ['invoice', 'payment', 'invoice', 'credit'], 'by date: the credit note is today');
  assert.deepEqual(st.lines.map(function (l) { return l.balance; }), [2500, 2000, 2800, 2600]);
  assert.equal(st.closing, 2600, '2500 + 800 - 500 - 200');
  assert.equal(st.owed, 2600);
  assert.deepEqual([st.ageing.current, st.ageing.d1to30, st.overdue], [800, 1800, 1800]);
  var all = await statements.get(ctx.fin, cust, { from: day(-365) });
  assert.equal(all.lines.length, 6);
  assert.equal(all.closing, 2600);

  // The overview: who owes, the most overdue first.
  var o = await statements.overview(ctx.fin, { q: 'Zqsx' });
  var row = o.customers.find(function (c) { return c.id === cust; });
  assert.deepEqual([row.owed, row.overdue, row.open], [2600, 1800, 2]);

  // A link of its own, the customer's page, the PDF.
  var l = await statements.link(ctx.fin, cust, {});
  assert.match(l.url, /\/statement\/[\w-]{20,}$/);
  var pub = await statements.publicView(l.token);
  assert.equal(pub.owed, 2600);
  assert.equal(pub.open.length, 2);
  assert.ok(pub.open.every(function (x) { return /\/share\//.test(x.url) && !x.id; }), 'each open invoice can be paid online');
  assert.equal(pub.customer.id, undefined);
  assert.equal(pub.credit, undefined);
  var pdf = await statements.publicPdf(l.token);
  assert.equal(pdf.buffer.slice(0, 4).toString(), '%PDF');
  await assert.rejects(statements.publicView('nope-not-a-token'), /invalid/);

  // Emailed, with its PDF; on WhatsApp, a link to send.
  var e = await statements.send(ctx.fin, cust, { via: 'email' });
  assert.equal(e.to, 'zqsx.lodge@example.com');
  var m = sent[sent.length - 1];
  assert.match(m.subject, /Statement of account — Zqsx Lodge \(GHS 2,600\.00 owed\)/);
  assert.equal(m.attachments[0].contentType, 'application/pdf');
  var w = await statements.send(ctx.fin, cust, { via: 'whatsapp' });
  assert.match(w.whatsappUrl, /^https:\/\/wa\.me\/233200001999\?text=/);

  // A credit limit: an invoice over it needs a second yes.
  await assert.rejects(statements.saveCustomer(ctx.staff, cust, { creditLimit: 3000 }), /invoice\.manage/);
  var saved = await statements.saveCustomer(ctx.fin, cust, { creditLimit: 3000, statementMonthly: true });
  assert.deepEqual([saved.customer.creditLimit, saved.credit.available, saved.customer.statementMonthly], [3000, 400, true]);
  await assert.rejects(invoices.createManual(ctx.fin, { customerId: cust, items: [{ description: 'Zqsx table', qty: 1, unitPrice: 900 }] }), function (err) {
    return err.code === 'creditLimit' && /would owe GHS 3500\.00 with this invoice, over their credit limit of GHS 3000\.00/.test(err.message);
  });
  var over = await invoices.createManual(ctx.fin, { customerId: cust, items: [{ description: 'Zqsx table', qty: 1, unitPrice: 900 }], overCreditOk: true });
  await pool.query('UPDATE invoices SET company_id = $2 WHERE id = $1', [over.id, co.office]);
  var trail = (await pool.query("SELECT summary FROM audit_logs WHERE entity_id = $1 AND action = 'invoice.create'", [over.id])).rows[0];
  assert.match(trail.summary, /Over the credit limit/);
  assert.equal((await statements.creditOf(cust)).over, true);

  // Every month, once, for those who asked.
  var before = sent.length;
  var n = await statements.monthly(day(0).slice(0, 8) + '02');
  assert.ok(n >= 1);
  assert.equal(sent.length - before, n);
  assert.equal(await statements.monthly(day(0).slice(0, 8) + '03'), 0, 'once a month');
  assert.equal(await statements.monthly(day(0).slice(0, 8) + '20'), 0, 'only in the first days');
});

test('the cash flow: what is in hand, money due in and out week by week, payroll on pay day, the short weeks flagged', async function () {
  await assert.rejects(cashflow.forecast(ctx.staff, { company: co.office }), /report\.read/);
  await cashflow.saveBalance(ctx.fin, { companyId: co.office, amount: 2000, floor: 1000, payDay: 25 });
  await bills.save(ctx.fin, { companyId: co.office, supplierName: 'Zqsx Timber', amount: 1500, billDate: day(0), dueDate: day(8) });
  await cashflow.addItem(ctx.fin, { companyId: co.office, direction: 'out', label: 'Zqsx loan repayment', amount: 300, startsOn: day(1), repeat: 'weekly', endsOn: day(30) });
  await assert.rejects(cashflow.addItem(ctx.fin, { companyId: co.office, direction: 'sideways', label: 'x', amount: 1, startsOn: day(1) }), /in or money out/);
  await pool.query("UPDATE employees SET status = 'active' WHERE id = $1", [people.staff]);
  var f;
  try { f = await cashflow.forecast(ctx.fin, { company: co.office }); } finally { await pool.query("UPDATE employees SET status = 'inactive' WHERE id = $1", [people.staff]); }
  assert.equal(f.weeks.length, 13);
  assert.deepEqual([f.opening.amount, f.opening.set, f.floor, f.payDay], [2000, true, 1000, 25]);
  var items = [].concat.apply([], f.weeks.map(function (w) { return w.items; }));
  assert.ok(items.some(function (x) { return x.source === 'invoice' && x.late && x.amount === 1800; }), 'the overdue invoice, this week, marked late');
  assert.ok(items.some(function (x) { return x.source === 'invoice' && x.amount === 800 && !x.late; }));
  assert.ok(items.some(function (x) { return x.source === 'bill' && x.amount === 1500; }));
  assert.equal(items.filter(function (x) { return x.source === 'manual'; }).length, 5, 'weekly for a month');
  var pay = items.filter(function (x) { return x.source === 'payroll'; });
  assert.ok(pay.length >= 2 && pay.every(function (x) { return x.date.slice(8) === '25'; }), 'payroll on the 25th');
  assert.ok(pay[0].amount > 3600, 'basic, allowance and the employer\'s SSNIT');
  assert.equal(f.weeks[0].opening, 2000);
  assert.equal(f.weeks[12].closing, f.totals.end);
  assert.equal(Math.round((2000 + f.totals.in - f.totals.out) * 100) / 100, f.totals.end);
  assert.ok(f.shortWeeks >= 1 && f.weeks.some(function (w) { return w.short; }), 'a week under the minimum');
  await cashflow.removeItem(ctx.fin, f.manual[0].id);
});

test('a salary advance: asked within the rules, approved for less, paid out, repaid off two payslips', async function () {
  await advances.saveSettings(ctx.fin, { open: true, maxPercent: 50, maxMonths: 3 });
  var mine = await advances.mine(ctx.staff);
  assert.deepEqual([mine.allowance.monthlyPay, mine.allowance.max], [3600, 1800]);
  await assert.rejects(advances.request(ctx.staff, { amount: 2000, months: 2, reason: 'Zqsx: school fees' }), /At most GHS 1,800\.00/);
  await assert.rejects(advances.request(ctx.staff, { amount: 1000, months: 6, reason: 'Zqsx: school fees' }), /1 to 3 months/);
  var a = await advances.request(ctx.staff, { amount: 1500, months: 3, reason: 'Zqsx: school fees' });
  assert.deepEqual([a.status, a.instalment, a.ref.slice(0, 3)], ['requested', 500, 'SA-']);
  assert.ok((await notes(people.fin)).some(function (x) { return /Yaa Zqsx asks for a salary advance · GHS 1,500\.00/.test(x.title) && x.link === '/advances?open=' + a.id; }));
  await assert.rejects(advances.request(ctx.staff, { amount: 100, months: 1, reason: 'Zqsx: more' }), /waiting already/);
  await assert.rejects(advances.decide(ctx.staff, a.id, { approve: true }), /advance\.manage/);
  a = await advances.decide(ctx.fin, a.id, { approve: true, amount: 1200, months: 2 });
  assert.deepEqual([a.status, a.amount, a.instalment, a.decidedBy], ['approved', 1200, 600, 'Adwoa Zqsx']);
  assert.ok((await notes(people.staff)).some(function (x) { return /approved · GHS 1,200\.00/.test(x.title); }));
  a = await advances.pay(ctx.fin, a.id, { method: 'mobile_money', reference: 'MM-SA-1' });
  assert.deepEqual([a.status, a.left], ['paid', 1200]);

  var run = async function (start, end) {
    await pool.query("UPDATE employees SET status = 'active' WHERE id = $1", [people.staff]);
    try { return await payroll.create(ctx.fin, { cycle: 'monthly', periodStart: start, periodEnd: end, payDate: end, companyId: co.office }); }
    finally { await pool.query("UPDATE employees SET status = 'inactive' WHERE id = $1", [people.staff]); }
  };
  var r1 = await run('2018-01-01', '2018-01-31');
  var slip = r1.payslips.find(function (s) { return s.employeeId === people.staff; });
  var r1b = await payroll.editSlip(ctx.fin, r1.id, people.staff, 22);
  slip = r1b.payslips.find(function (s) { return s.employeeId === people.staff; });
  assert.equal(slip.advanceDeduction, 600);
  assert.equal(slip.netPay, Math.round((slip.grossPay - slip.ssnitEmployee - slip.payeTax - 600) * 100) / 100, 'off the take-home pay');
  await payroll.approve(ctx.fin, r1.id);
  await payroll.markPaid(ctx.fin, r1.id);
  a = await advances.get(ctx.fin, a.id);
  assert.deepEqual([a.repaid, a.left, a.status, a.repayments.length, a.repayments[0].kind], [600, 600, 'paid', 1, 'payroll']);
  var r2 = await payroll.editSlip(ctx.fin, (await run('2018-02-01', '2018-02-28')).id, people.staff, 20);
  await payroll.approve(ctx.fin, r2.id);
  await payroll.markPaid(ctx.fin, r2.id);
  a = await advances.get(ctx.fin, a.id);
  assert.deepEqual([a.repaid, a.left, a.status], [1200, 0, 'repaid']);
  var r3 = await payroll.editSlip(ctx.fin, (await run('2018-03-01', '2018-03-31')).id, people.staff, 20);
  assert.equal(r3.payslips.find(function (s) { return s.employeeId === people.staff; }).advanceDeduction, 0, 'nothing left to take');

  // Declined with a reason; cancelled by the person.
  var b = await advances.request(ctx.staff, { amount: 300, months: 1, reason: 'Zqsx: transport' });
  await assert.rejects(advances.decide(ctx.fin, b.id, { approve: false }), /Why is it declined/);
  b = await advances.decide(ctx.fin, b.id, { approve: false, reason: 'Zqsx: one at a time this quarter' });
  assert.equal(b.status, 'declined');
  var c = await advances.request(ctx.staff, { amount: 200, months: 1, reason: 'Zqsx: phone' });
  c = await advances.cancel(ctx.staff, c.id);
  assert.equal(c.status, 'cancelled');
  var l = await advances.list(ctx.fin, { status: 'all' });
  assert.ok(l.advances.filter(function (x) { return x.employee.id === people.staff; }).length === 3);
  await advances.saveSettings(ctx.fin, { open: false, maxPercent: 50, maxMonths: 3 });
  await assert.rejects(advances.request(ctx.staff, { amount: 100, months: 1, reason: 'Zqsx: again' }), /not open/);
});

test('the price watch: a purchase order dearer than before tells the managers; the history, the cheaper supplier, the dishes', async function () {
  var sup1 = (await pool.query("INSERT INTO restaurant_suppliers (company_id, name) VALUES ($1, 'Zqsx Farm A') RETURNING id", [co.rest])).rows[0].id;
  var sup2 = (await pool.query("INSERT INTO restaurant_suppliers (company_id, name) VALUES ($1, 'Zqsx Farm B') RETURNING id", [co.rest])).rows[0].id;
  var oil = (await pool.query("INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, reorder_level, unit_cost, active, supplier_id) VALUES ($1, 'Zqsx palm oil', 'litres', 5, 2, 0, true, $2) RETURNING id", [co.rest, sup1])).rows[0].id;
  var stew = (await pool.query("SELECT id FROM restaurant_menu_items WHERE company_id = $1", [co.rest])).rows[0].id;
  await pool.query('INSERT INTO restaurant_recipes (company_id, menu_item_id, ingredient_id, qty) VALUES ($1, $2, $3, 0.2)', [co.rest, stew, oil]);
  var buy = async function (supplierId, cost) {
    var o = (await access.purchasing(tok.mgr, { action: 'draft', order: { supplierId: supplierId, lines: [{ type: 'ingredient', id: oil, qty: 10, unitCost: cost }] } }, IP + '2')).done.order;
    return (await access.purchasing(tok.mgr, { action: 'receive', id: o.id, paidAtDoor: true }, IP + '2')).done.order;
  };
  await buy(sup1, 20);
  await buy(sup2, 18);
  await prices.tab(tok.mgr, { action: 'settings', alertPercent: 10 }, IP + '3');
  await buy(sup1, 22);
  assert.equal((await notes(people.mgr)).filter(function (x) { return /costs/.test(x.title); }).length, 1, 'from 18 to 22 is over 10%; 20 was the first price');
  var n = (await notes(people.mgr)).find(function (x) { return /costs/.test(x.title); });
  assert.match(n.title, /Zqsx palm oil costs 22\.2% more/);
  assert.match(n.body, /18\.00 → 22\.00/);
  var line = (await pool.query("SELECT l.previous_cost FROM restaurant_purchase_order_lines l JOIN restaurant_purchase_orders o ON o.id = l.po_id WHERE o.company_id = $1 ORDER BY o.number DESC LIMIT 1", [co.rest])).rows[0];
  assert.equal(Number(line.previous_cost), 18);
  var v = await prices.tab(tok.mgr, { action: 'list' }, IP + '3');
  var it = v.items.find(function (x) { return x.id === oil; });
  assert.deepEqual([it.last.cost, it.prev.cost, it.change, it.rose, it.min90, it.max90, it.points.length], [22, 18, 22.2, true, 18, 22, 3]);
  assert.deepEqual(it.suppliers.map(function (s) { return [s.name, s.avg, !!s.cheapest]; }), [['Zqsx Farm B', 18, true], ['Zqsx Farm A', 21, false]]);
  assert.deepEqual(it.dishes, ['Zqsx stew']);
  assert.deepEqual([v.settings.alertPercent, v.summary.rises, v.summary.biggest.name, v.summary.cheaperElsewhere], [10, 1, 'Zqsx palm oil', 1], 'Farm B sold it for 18 on average, the last was 22');
  // A price in pesewas comes in too (it was once taken for a whole number).
  await buy(sup2, 21.75);
  assert.equal(Number((await pool.query('SELECT unit_cost FROM restaurant_ingredients WHERE id = $1', [oil])).rows[0].unit_cost), 21.75);
});

test('vehicles and fuel: added with their papers and driver, fuel logged by the driver, km per litre and cost per km, papers reminded once', async function () {
  await assert.rejects(vehicles.save(ctx.driver, { companyId: co.office, name: 'Zqsx van' }), /vehicle\.manage/);
  var v = await vehicles.save(ctx.boss, { companyId: co.office, name: 'Zqsx white van', plate: 'gt 1234-zq', kind: 'van', fuel: 'diesel', driverId: people.driver, odometer: 10000,
    insuranceUntil: day(6), roadworthyUntil: day(90), serviceEveryKm: 5000, lastServiceKm: 9000 });
  assert.deepEqual([v.plate, v.driver.name, v.serviceAt, v.serviceIn], ['GT 1234-ZQ', 'Kwaku Zqsx', 14000, 4000]);
  assert.deepEqual(v.papers.map(function (p) { return p.state; }), ['soon', 'ok']);
  await assert.rejects(vehicles.save(ctx.boss, { companyId: co.office, name: 'Zqsx other', plate: 'GT 1234-ZQ' }), /on another vehicle/);
  // The driver logs fuel; full tank to full tank.
  var mine = await vehicles.list(ctx.driver, {});
  assert.deepEqual(mine.mine, [v.id]);
  await vehicles.logFuel(ctx.driver, v.id, { day: day(-20), litres: 40, amount: 600, odometer: 10000, fullTank: true, station: 'Zqsx Fuel Spintex' });
  await assert.rejects(vehicles.logFuel(ctx.driver, v.id, { litres: 40, amount: 6, odometer: 10100 }), /a litre\? Check/);
  await assert.rejects(vehicles.logFuel(ctx.driver, v.id, { litres: 30, amount: 450, odometer: 9000 }), /read 10000 km already/);
  await vehicles.logFuel(ctx.driver, v.id, { day: day(-10), litres: 20, amount: 300, odometer: 10200, fullTank: false });
  var g = await vehicles.logFuel(ctx.driver, v.id, { day: day(-1), litres: 30, amount: 480, odometer: 10500, fullTank: true, paidWith: 'mobile_money', photo: PNG });
  assert.equal(g.kmPerLitre, 10, '500 km on 20 + 30 litres');
  assert.equal(g.costPerKm, 1.56, '(300 + 480) / 500');
  assert.equal(g.odometer, 10500);
  assert.equal(g.fills[0].hasPhoto, true);
  assert.equal((await vehicles.photoKey(ctx.driver, g.fills[0].id)).name, 'fuel-receipt.png');
  var other = await buildContext((await pool.query("SELECT u.id FROM users u WHERE u.email = 'zqsx.yaa@example.com'")).rows[0].id);
  await assert.rejects(vehicles.get(other, v.id), /not a vehicle you drive/);
  var all = await vehicles.list(ctx.boss, {});
  assert.ok(all.summary.papersSoon >= 1);
  // Papers: reminded to the keepers and the driver, once.
  await alerts.vehicleAlerts(day(0), {});
  var dn = (await notes(people.driver)).filter(function (x) { return /Insurance runs out in 6 days — Zqsx white van/.test(x.title); });
  assert.equal(dn.length, 1);
  await alerts.vehicleAlerts(day(0), {});
  assert.equal((await notes(people.driver)).filter(function (x) { return /Insurance/.test(x.title); }).length, 1, 'once');
  var s = await vehicles.serviced(ctx.boss, v.id, { odometer: 10600 });
  assert.deepEqual([s.lastServiceKm, s.serviceAt], [10600, 15600]);
});
