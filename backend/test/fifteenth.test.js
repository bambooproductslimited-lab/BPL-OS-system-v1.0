// The fifteenth batch (migration 0196): bills to pay (entered in the OS or
// on a restaurant's till, made by themselves from a purchase order received
// and not paid at the door; approved over a limit; paid in parts; their
// files; reminders before and after they are due); equipment (a problem
// reported on the till or by anyone in the OS, out of use until fixed;
// fixed, serviced, planned on the till's back office; services due
// reminded); and the owner's view (money, staff on shift, events, what needs
// looking at). Fake Zqfv data.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var bills = require('../src/services/bills.service');
var maintenance = require('../src/services/maintenance.service');
var equipment = require('../src/services/restaurantEquipment.service');
var owner = require('../src/services/ownerView.service');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var alerts = require('../src/jobs/dailyAlerts');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { esi: '7791', yaw: '7792' };
var IP = '10.15.0.';
var PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
var PNG_BYTES = Buffer.from(PNG.split(',')[1], 'base64');
var PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
var co = {}, bpl = null, dept = null, people = {}, tok = {}, ctx = {};
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQFV'")).rows.map(function (r) { return r.id; });
  await pool.query("DELETE FROM supplier_bills WHERE supplier_name LIKE 'Zqfv %' OR company_id = ANY($1)", [cos]);
  await pool.query("DELETE FROM assets WHERE description LIKE 'Zqfv %'");
  await pool.query("DELETE FROM expiry_alerts WHERE kind IN ('bill', 'service') AND ref_id NOT IN (SELECT id FROM supplier_bills UNION SELECT id FROM assets)");
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_purchase_orders WHERE company_id = ANY($1)', 'DELETE FROM restaurant_ingredients WHERE company_id = ANY($1)', 'DELETE FROM restaurant_suppliers WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_events WHERE company_id = ANY($1)', 'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_orders WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)', 'DELETE FROM restaurant_rota_shifts WHERE company_id = ANY($1)']) await pool.query(q, [cos]).catch(function (e) { if (e.code !== '42P01') throw e; });
  }
  await pool.query("DELETE FROM notifications WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQFV-%')");
  await pool.query("DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQFV-%')");
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zqfv.%@example.com')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqfv.%@example.com'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQFV-%'");
  await pool.query("DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE key = 'zqfv_clerk')");
  await pool.query("DELETE FROM roles WHERE key = 'zqfv_clerk'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
  await pool.query("UPDATE settings SET bills = '{}' WHERE id = 1");
}
async function employee(code, first, opts) {
  opts = opts || {};
  var id = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqfv', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, 'zqfv.' + first.toLowerCase() + '@example.com', dept, opts.pin ? pinAuth.hashPin(opts.pin) : null])).rows[0].id;
  if (opts.till) await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [co.id, id, opts.till]);
  if (opts.role) {
    var user = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, 'x', 'active') RETURNING id", [id, 'zqfv.' + first.toLowerCase() + '@example.com'])).rows[0].id;
    await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [user, opts.role]);
    ctx[first.toLowerCase()] = await buildContext(user);
  }
  return id;
}
async function notes(empId) { return (await pool.query('SELECT title, body, link FROM notifications WHERE employee_id = $1 ORDER BY at', [empId])).rows; }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  co = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQFV', 'Zqfv Courtyard') RETURNING *")).rows[0];
  bpl = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQFVK', 'Zqfv Kitchen', $1) RETURNING id", [co.id])).rows[0].id;
  // A clerk who enters bills and pays them, but does not approve.
  var clerkRole = (await pool.query("INSERT INTO roles (key, name, description) VALUES ('zqfv_clerk', 'Zqfv clerk', 'Zqfv: bills, no approval') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, 'bill.read'), ($1, 'bill.manage'), ($1, 'asset.read')", [clerkRole]);
  people.fin = await employee('ZQFV-1', 'Abena', { role: 'finance_manager' });
  people.clerk = await employee('ZQFV-2', 'Kwesi', { role: 'zqfv_clerk' });
  people.boss = await employee('ZQFV-3', 'Akosua', { role: 'administrator' });
  people.floor = await employee('ZQFV-4', 'Fiifi', { role: 'employee' });
  people.esi = await employee('ZQFV-5', 'Esi', { pin: PINS.esi, till: 'cashier' });
  people.yaw = await employee('ZQFV-6', 'Yaw', { pin: PINS.yaw, till: 'manager' });
  await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqfv jollof', 'Zqfv Mains', 60, true)", [co.id]);
  tok.esi = (await pos.login(PINS.esi, IP + '1', 'till')).token;
  tok.yaw = (await pos.login(PINS.yaw, IP + '2', 'till')).token;
});
test.after(async function () { await cleanup(); await pool.end(); });

var big, small;
test('bills to pay: entered, approved over the limit, paid in parts, files kept, cancelled only unpaid; who may do what', async function () {
  await assert.rejects(bills.list(ctx.fiifi, {}), /bill\.read/);
  await assert.rejects(bills.save(ctx.akosua, { companyId: co.id, supplierName: 'Zqfv Gas Ltd', amount: 0, dueDate: day(5) }), /More than 0/);
  await assert.rejects(bills.save(ctx.akosua, { companyId: co.id, supplierName: 'Zqfv Gas Ltd', amount: 300, billDate: day(0), dueDate: day(-2) }), /cannot be due before/);
  // Under the limit (2000 by default): approved at once, even by the clerk.
  small = await bills.save(ctx.kwesi, { companyId: co.id, supplierName: 'Zqfv Gas Ltd', reference: 'ZQ-INV-77', category: 'utilities', amount: 450, billDate: day(-3), dueDate: day(2), note: 'Zqfv: LPG for October' });
  assert.deepEqual([small.ref.slice(0, 2), small.status, small.state, small.balance, small.company.code], ['B-', 'approved', 'soon', 450, 'ZQFV']);
  // Over it: waits for someone with bill.approve, who is told.
  big = await bills.save(ctx.kwesi, { companyId: co.id, supplierName: 'Zqfv Cold Rooms', reference: 'CR-2026-11', category: 'equipment', amount: 6800, billDate: day(-20), dueDate: day(-1) });
  assert.deepEqual([big.status, big.state], ['to_approve', 'overdue']);
  var n = await notes(people.fin);
  assert.ok(n.some(function (x) { return /to approve · GHS 6800\.00/.test(x.title) && x.link === '/bills?open=' + big.id; }), 'the approver is told');
  await assert.rejects(bills.pay(ctx.kwesi, big.id, { amount: 100, method: 'bank' }), /approve it first/);
  await assert.rejects(bills.approve(ctx.kwesi, big.id), /bill\.approve/);
  big = await bills.approve(ctx.abena, big.id);
  assert.deepEqual([big.status, big.approvedBy], ['approved', 'Abena Zqfv']);
  assert.ok((await notes(people.clerk)).some(function (x) { return /approved/.test(x.title); }), 'who entered it is told');
  // Paid in two parts; the second with the transfer slip.
  await assert.rejects(bills.pay(ctx.kwesi, big.id, { amount: 9000, method: 'bank' }), /more than is left to pay \(GHS 6800\.00\)/);
  await assert.rejects(bills.pay(ctx.kwesi, big.id, { amount: 100, method: 'barter' }), /How was it paid/);
  big = await bills.pay(ctx.kwesi, big.id, { amount: 4000, method: 'bank', account: 'Zqfv Ecobank', reference: 'TRF-1', paidOn: day(-1) });
  assert.deepEqual([big.status, big.paid, big.balance, big.payments.length], ['approved', 4000, 2800, 1]);
  big = await bills.pay(ctx.kwesi, big.id, { amount: 2800, method: 'mobile_money', reference: 'MM-2', photo: PNG });
  assert.deepEqual([big.status, big.balance, big.state, big.payments[1].hasPhoto], ['paid', 0, 'paid', true]);
  var ph = await bills.paymentPhotoKey(ctx.kwesi, big.payments[1].id);
  assert.equal(ph.name, 'payment.png');
  // Files: a photo and a PDF of the bill, nothing else.
  var withFiles = await bills.addFiles(ctx.kwesi, small.id, [{ buffer: PNG_BYTES, originalname: 'zqfv gas.png' }, { buffer: PDF_BYTES, originalname: 'zqfv-gas.pdf' }]);
  assert.deepEqual(withFiles.files.map(function (f) { return f.type; }), ['image/png', 'application/pdf']);
  await assert.rejects(bills.addFiles(ctx.kwesi, small.id, [{ buffer: Buffer.from('hello there'), originalname: 'x.pdf' }]), /photo .* or a PDF/);
  assert.equal((await bills.fileKey(ctx.kwesi, small.id, 1)).name, 'zqfv-gas.pdf');
  // Cancelled: only with nothing paid, and a reason.
  await assert.rejects(bills.cancel(ctx.kwesi, big.id, { reason: 'Zqfv twice' }), /paid already|is paid/);
  var third = await bills.save(ctx.kwesi, { companyId: co.id, supplierName: 'Zqfv Cleaners', amount: 120, dueDate: day(20) });
  await assert.rejects(bills.cancel(ctx.kwesi, third.id, {}), /Why is it cancelled/);
  third = await bills.cancel(ctx.kwesi, third.id, { reason: 'Zqfv: entered twice' });
  assert.equal(third.status, 'cancelled');
  // The list: open first by due date, the summary.
  var l = await bills.list(ctx.abena, { company: co.id });
  assert.deepEqual(l.bills.map(function (b) { return b.supplierName; }), ['Zqfv Gas Ltd']);
  assert.deepEqual([l.summary.week.n, l.summary.week.amount, l.summary.overdue.n, l.summary.paidThisMonth], [1, 450, 0, 6800]);
  assert.equal(l.canApprove, true);
  assert.equal((await bills.list(ctx.kwesi, { company: co.id, status: 'paid' })).bills[0].ref, big.ref);
  // The approval limit, set by an approver.
  await assert.rejects(bills.saveSettings(ctx.kwesi, { approveOver: 500 }), /bill\.approve/);
  var s = await bills.saveSettings(ctx.abena, { approveOver: 500, dueDays: 14, accounts: ['Zqfv Ecobank', 'Zqfv MoMo'] });
  assert.deepEqual([s.approveOver, s.dueDays, s.accounts.length], [500, 14, 2]);
});

test('the till: a purchase order received becomes a bill unless paid at the door; the back office enters one with its photo', async function () {
  var sup = (await pool.query("INSERT INTO restaurant_suppliers (company_id, name, phone) VALUES ($1, 'Zqfv Fresh Farms', '0200000915') RETURNING id", [co.id])).rows[0].id;
  var rice = (await pool.query("INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, reorder_level, unit_cost, active, supplier_id) VALUES ($1, 'Zqfv rice', 'kg', 2, 5, 12, true, $2) RETURNING id", [co.id, sup])).rows[0].id;
  var draft = async function () { return (await access.purchasing(tok.yaw, { action: 'draft', order: { supplierId: sup, lines: [{ type: 'ingredient', id: rice, qty: 25, unitCost: 12 }] } }, IP + '3')).done.order; };
  var o1 = await draft();
  var r = await access.purchasing(tok.yaw, { action: 'receive', id: o1.id, supplierRef: 'ZQ-DN-551' }, IP + '3');
  assert.deepEqual([r.done.order.status, r.done.order.bill.status, r.done.order.bill.balance], ['received', 'approved', 300]);
  assert.equal(r.done.order.bill.dueDate, day(14), 'due in the usual number of days');
  var b = (await pool.query('SELECT * FROM supplier_bills WHERE purchase_order_id = $1', [o1.id])).rows[0];
  assert.deepEqual([b.supplier_name, b.reference, b.category, b.source], ['Zqfv Fresh Farms', 'ZQ-DN-551', 'stock', 'purchase_order']);
  var o2 = await draft();
  r = await access.purchasing(tok.yaw, { action: 'receive', id: o2.id, paidAtDoor: true }, IP + '3');
  assert.equal(r.done.order.bill, null, 'paid at the door: no bill');
  // The back office: a bill entered on the till, with its photo; over the
  // limit (500 now) it waits for the office.
  await assert.rejects(bills.tillTab(tok.esi, { action: 'list' }, IP + '4'), /manager/i);
  var t = await bills.tillTab(tok.yaw, { action: 'save', bill: { supplierName: 'Zqfv Fresh Farms', supplierId: sup, reference: 'ZQ-INV-90', category: 'stock', amount: 760, billDate: day(0), dueDate: day(7), photo: PNG } }, IP + '4');
  assert.equal(t.done.status, 'to_approve');
  var mine = t.bills.find(function (x) { return x.reference === 'ZQ-INV-90'; });
  assert.deepEqual([mine.source, mine.files.length, t.summary.toApprove.n], ['till', 1, 1]);
  var f = await bills.tillFileKey(tok.esi, mine.id, 0);
  assert.equal(f.name, 'bill.png');
  assert.ok((await notes(people.fin)).some(function (x) { return x.title.indexOf('760.00') >= 0; }), 'the office is told');
});

var fridge, problem;
test('equipment: reported on the till (out of use until fixed), fixed and serviced on the back office; reported in the OS by anyone', async function () {
  // The manager adds the restaurant's equipment.
  var v = await equipment.tab(tok.yaw, { action: 'save', equipment: { name: 'Zqfv walk-in fridge', category: 'Fridge and freezer', location: 'Zqfv kitchen', serviceIntervalDays: 90, warrantyUntil: day(200) } }, IP + '5');
  fridge = v.equipment.find(function (e) { return e.name === 'Zqfv walk-in fridge'; });
  assert.deepEqual([fridge.assetNo.slice(0, 4), fridge.status, fridge.nextServiceDate, fridge.underWarranty], ['AST-', 'in_use', day(90), true]);
  await assert.rejects(equipment.tab(tok.esi, { action: 'list' }, IP + '5'), /manager/i);
  // Anyone on the till reports it: stopped, a photo.
  var c = await equipment.choices(tok.esi);
  assert.ok(c.equipment.some(function (e) { return e.id === fridge.id; }));
  await assert.rejects(equipment.report(tok.esi, { assetId: fridge.id, what: 'x', urgency: 'stopped' }, IP + '6'), /What is wrong/);
  await assert.rejects(equipment.report(tok.esi, { assetId: fridge.id, what: 'Zqfv: not cooling', urgency: 'maybe' }, IP + '6'), /still working/);
  var rep = await equipment.report(tok.esi, { assetId: fridge.id, what: 'Zqfv: not cooling, 12 degrees inside', urgency: 'stopped', photo: PNG }, IP + '6');
  assert.equal(rep.urgency, 'stopped');
  await assert.rejects(equipment.report(tok.esi, { assetId: fridge.id, what: 'Zqfv: not cooling, 12 degrees inside', urgency: 'stopped' }, IP + '6'), /reported already today/);
  v = await equipment.tab(tok.yaw, { action: 'list' }, IP + '5');
  fridge = v.equipment.find(function (e) { return e.id === fridge.id; });
  problem = fridge.open[0];
  assert.deepEqual([fridge.status, problem.status, problem.urgency, problem.reportedBy, problem.photos, v.summary.problems, v.summary.stopped], ['in_repair', 'reported', 'stopped', 'Esi Zqfv', 1, 1, 1]);
  assert.ok((await notes(people.boss)).some(function (x) { return /Zqfv walk-in fridge: stopped working/.test(x.title) && x.link === '/assets?problem=' + problem.id; }), 'who looks after assets is told');
  assert.equal((await equipment.photoOf(tok.esi, problem.id, 0)).name, 'equipment-1.png');
  // A visit planned, then fixed: back in use; the cost on record.
  await assert.rejects(equipment.tab(tok.yaw, { action: 'fix', id: problem.id, done: { technician: '', cost: 350 } }, IP + '5'), /Technician/);
  await equipment.tab(tok.yaw, { action: 'plan', id: problem.id, date: day(0), technician: 'Zqfv Cool Tech' }, IP + '5');
  v = await equipment.tab(tok.yaw, { action: 'fix', id: problem.id, done: { technician: 'Zqfv Cool Tech', cost: 350, partsReplaced: 'Zqfv: fan motor', notes: 'Zqfv: gas topped up', photo: PNG } }, IP + '5');
  fridge = v.equipment.find(function (e) { return e.id === fridge.id; });
  assert.deepEqual([fridge.status, fridge.open.length, fridge.last.cost, fridge.last.technician, v.summary.spent90], ['in_use', 0, 350, 'Zqfv Cool Tech', 350]);
  // A service planned for a day.
  v = await equipment.tab(tok.yaw, { action: 'plan', assetId: fridge.id, date: day(3), what: 'Zqfv: quarterly service', technician: 'Zqfv Cool Tech' }, IP + '5');
  fridge = v.equipment.find(function (e) { return e.id === fridge.id; });
  assert.deepEqual([fridge.open[0].status, fridge.nextServiceDate], ['scheduled', day(3)]);
  // Reported a second time, then taken off the list: back in use.
  await equipment.report(tok.esi, { assetId: fridge.id, what: 'Zqfv: door seal loose', urgency: 'unsafe' }, IP + '6');
  v = await equipment.tab(tok.yaw, { action: 'list' }, IP + '5');
  var seal = v.equipment.find(function (e) { return e.id === fridge.id; }).open.find(function (m) { return m.status === 'reported'; });
  v = await equipment.tab(tok.yaw, { action: 'dismiss', id: seal.id }, IP + '5');
  assert.equal(v.equipment.find(function (e) { return e.id === fridge.id; }).status, 'in_use');

  // The factory floor: anyone signed in reports a machine.
  var saw = (await pool.query("INSERT INTO assets (asset_no, category, description, location, company_id, status, condition) VALUES ('AST-Z15', 'Machines', 'Zqfv bamboo splitter', 'Zqfv workshop', $1, 'in_use', 'good') RETURNING id", [bpl ? bpl.id : null])).rows[0].id;
  var ch = await maintenance.reportChoices(ctx.fiifi);
  assert.ok(ch.assets.some(function (a) { return a.id === saw; }));
  var r = await maintenance.report(ctx.fiifi, { assetId: saw, what: 'Zqfv: blade wobbles and sparks', urgency: 'unsafe', photos: [PNG] });
  assert.deepEqual([r.status, r.urgency, r.source, r.photos, r.reportedBy], ['reported', 'unsafe', 'floor', 1, 'Fiifi Zqfv']);
  assert.equal((await maintenance.photoKey(ctx.fiifi, r.id, 0)).name, 'problem-1.png', 'who reported it sees the photo');
  await assert.rejects(maintenance.schedule(ctx.fiifi, r.id, { date: day(1) }), /asset\.manage/);
  await maintenance.schedule(ctx.akosua, r.id, { date: day(1), technician: 'Zqfv Mill Fixers' });
  await maintenance.complete(ctx.akosua, r.id, { technician: 'Zqfv Mill Fixers', cost: 900 });
  assert.equal((await pool.query('SELECT status FROM assets WHERE id = $1', [saw])).rows[0].status, 'in_use');
  assert.ok((await notes(people.floor)).some(function (x) { return /Fixed: Zqfv bamboo splitter/.test(x.title); }), 'who reported it is told it is fixed');
  var mine = (await maintenance.reportChoices(ctx.fiifi)).mine;
  assert.equal(mine[0].status, 'completed');
});

test('reminders: a bill three days before, on the day and late; a service a week before and on the day — each once', async function () {
  var due = await bills.save(ctx.abena, { companyId: co.id, supplierName: 'Zqfv Water Co', amount: 90, dueDate: day(3) });
  var sent = await alerts.billAlerts(day(0), {});
  assert.ok(sent >= 1);
  var n = (await notes(people.clerk)).filter(function (x) { return /Bill due in 3 days — Zqfv Water Co/.test(x.title); });
  assert.equal(n.length, 1);
  await alerts.billAlerts(day(0), {});
  assert.equal((await notes(people.clerk)).filter(function (x) { return /Zqfv Water Co/.test(x.title); }).length, 1, 'once');
  await alerts.billAlerts(day(4), {});
  assert.ok((await notes(people.clerk)).some(function (x) { return /Bill overdue — Zqfv Water Co/.test(x.title); }), 'late');
  await pool.query('UPDATE assets SET next_service_date = $2 WHERE id = $1', [fridge.id, day(6)]);
  await pool.query("DELETE FROM maintenance_records WHERE asset_id = $1 AND status = 'scheduled'", [fridge.id]);
  await alerts.serviceAlerts(day(0), {});
  assert.ok((await notes(people.boss)).some(function (x) { return /Service due in 6 days — Zqfv walk-in fridge/.test(x.title); }));
  void due;
});

test('the owner\'s view: money in the drawers and the safe, staff on shift and late, today\'s event, and what needs looking at', async function () {
  await pos.openDrawerSession(tok.esi, 400);
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status, source) VALUES ($1, current_date, (now() - interval '2 hours')::time, 'present', 'kiosk')", [people.esi]);
  var later = new Date(Date.now() - 60 * 60000).toISOString().slice(11, 16);
  await pool.query("INSERT INTO restaurant_rota_shifts (company_id, employee_id, day, starts, ends, role, published) VALUES ($1, $2, current_date, $3, '23:59', 'Zqfv floor', true)", [co.id, people.yaw, later]);
  await pool.query("INSERT INTO restaurant_events (company_id, number, token, name, phone, occasion, starts_at, ends_at, guests, status) VALUES ($1, 1, 'zqfv-event-token-0000001', 'Zqfv Party', '+233200000916', 'Birthday', now() + interval '1 hour', now() + interval '5 hours', 30, 'confirmed')", [co.id]);
  await pool.query('INSERT INTO restaurant_orders (company_id, order_no, cashier_id, status, total) VALUES ($1, $2, $3, $4, $5)', [co.id, 'ZQFV-1', people.esi, 'completed', 240]);
  await equipment.report(tok.esi, { assetId: fridge.id, what: 'Zqfv: compressor noisy', urgency: 'working' }, IP + '6');
  await pool.query("UPDATE restaurant_ingredients SET stock_qty = 1 WHERE company_id = $1", [co.id]);
  var v = await owner.view(ctx.akosua, [co.id]);
  var r = v.restaurants.find(function (x) { return x.id === co.id; });
  assert.ok(r, 'the restaurant is on the owner\'s view');
  assert.deepEqual([r.money.inDrawers, r.money.drawers, r.staff.on.map(function (s) { return s.name; }).join(), r.staff.late.map(function (s) { return s.name; }).join(), r.events.today.length],
    [640, 1, 'Esi Z.', 'Yaw Z.', 1], 'the float and the cash sale');
  var keys = r.alerts.map(function (a) { return a.key; });
  assert.ok(keys.indexOf('problems') >= 0 && keys.indexOf('low') >= 0, 'an equipment problem and the rice running low: ' + keys.join());
  assert.ok(keys.indexOf('billsWeek') >= 0 || keys.indexOf('bills') >= 0, 'bills to pay: ' + keys.join());
  assert.ok(v.needs.some(function (a) { return a.company.id === co.id; }), 'what needs the owner first');
  assert.equal(v.total.onShift >= 1, true);
  assert.ok(v.bpl && typeof v.bpl.shop.today === 'number', 'Bamboo Products\' day, for whoever may see it');
  var noBpl = await owner.view(ctx.kwesi, [co.id]);
  assert.equal(noBpl.bpl, null, 'not for whoever cannot see invoices');
});
