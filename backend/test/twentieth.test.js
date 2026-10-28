// The twentieth batch (migration 0201): licences and permits; the kiln and
// treatment log; bills of materials and product costing; supplier
// scorecards; policies to read and sign. Fake Zqtw data in its own companies
// (ZQTW, ZQTX).
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var licences = require('../src/services/licences.service');
var kilns = require('../src/services/kilns.service');
var bom = require('../src/services/bom.service');
var scorecards = require('../src/services/scorecards.service');
var policies = require('../src/services/policies.service');
var onboarding = require('../src/services/onboarding.service');
var alerts = require('../src/jobs/dailyAlerts');

var co = {}, dept = {}, people = {}, ctx = {}, prod = {};
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function months(n) { var d = new Date(day(0) + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
var PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
var PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% Zqtw policy\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n').toString('base64');

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code IN ('ZQTW', 'ZQTX')")).rows.map(function (r) { return r.id; });
  var emps = "SELECT id FROM employees WHERE code LIKE 'ZQTW-%' OR email LIKE 'zqtw.%@example.com'";
  await pool.query("DELETE FROM licences WHERE title LIKE 'Zqtw%'");
  await pool.query("DELETE FROM vehicles WHERE name LIKE 'Zqtw%'");
  await pool.query("DELETE FROM kiln_charges WHERE kiln_id IN (SELECT id FROM kilns WHERE name LIKE 'Zqtw%')");
  await pool.query("DELETE FROM kilns WHERE name LIKE 'Zqtw%'");
  await pool.query("DELETE FROM bom_lines WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'ZQTW-%')");
  await pool.query("DELETE FROM bom_costs WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'ZQTW-%')");
  await pool.query("DELETE FROM product_cost_history WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'ZQTW-%')");
  await pool.query("DELETE FROM products WHERE sku LIKE 'ZQTW-%'");
  await pool.query("DELETE FROM supplier_ratings WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE 'Zqtw%') OR supplier_id IN (SELECT id FROM restaurant_suppliers WHERE name LIKE 'Zqtw%')");
  await pool.query("DELETE FROM raw_batches WHERE batch_no LIKE 'ZQTW-%'");
  await pool.query("DELETE FROM suppliers WHERE name LIKE 'Zqtw%'");
  if (cos.length) {
    await pool.query('DELETE FROM restaurant_purchase_order_lines WHERE po_id IN (SELECT id FROM restaurant_purchase_orders WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM restaurant_purchase_orders WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_suppliers WHERE company_id = ANY($1)', [cos]);
  }
  await pool.query("DELETE FROM policies WHERE title LIKE 'Zqtw%'");
  await pool.query("DELETE FROM expiry_alerts WHERE kind IN ('licence', 'kiln_soaked', 'kiln_late', 'kiln_quiet', 'policy_sign', 'policy_late')");
  await pool.query('DELETE FROM onboard_lists WHERE employee_id IN (' + emps + ')');
  await pool.query('DELETE FROM notifications WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zqtw.%@example.com')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqtw.%@example.com'");
  await pool.query('DELETE FROM employees WHERE id IN (' + emps + ')');
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, o) {
  o = o || {};
  var id = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date, status, employment_type, pay_cycle) VALUES ($1, $2, 'Zqtw', $3, $4, $5, $6, 'active', 'permanent', 'monthly') RETURNING id",
    [code, first, 'zqtw.' + first.toLowerCase() + '@example.com', '0200005' + code.slice(-3), o.dept || dept.works, o.hired || '2022-01-01'])).rows[0].id;
  people[key] = id;
  if (o.role) {
    var user = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, 'x', 'active') RETURNING id", [id, 'zqtw.' + first.toLowerCase() + '@example.com'])).rows[0].id;
    await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [user, o.role]);
    ctx[key] = await buildContext(user);
  }
  return id;
}
async function notes(empId) { return (await pool.query('SELECT title, body, link FROM notifications WHERE employee_id = $1 ORDER BY at', [empId])).rows; }
async function product(key, sku, name, o) {
  prod[key] = (await pool.query('INSERT INTO products (sku, name, category, unit, cost_price, selling_price, current_stock) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [sku, name, o.category || 'Zqtw', o.unit || 'each', o.cost || 0, o.price || 0, o.stock || 0])).rows[0].id;
  return prod[key];
}

test.before(async function () {
  await cleanup();
  co.works = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTW', 'Zqtw Works') RETURNING id")).rows[0].id;
  co.kitchen = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTX', 'Zqtw Kitchen') RETURNING id")).rows[0].id;
  dept.works = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTWW', 'Zqtw Workshop', $1) RETURNING id", [co.works])).rows[0].id;
  dept.office = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTWO', 'Zqtw Office', $1) RETURNING id", [co.works])).rows[0].id;
  dept.kitchen = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTWK', 'Zqtw Kitchen', $1) RETURNING id", [co.kitchen])).rows[0].id;
  await person('boss', 'ZQTW-001', 'Kojo', { role: 'administrator', dept: dept.office });
  await person('hr', 'ZQTW-002', 'Abena', { role: 'hr_manager', dept: dept.office });
  await person('fin', 'ZQTW-003', 'Efua', { role: 'finance_manager', dept: dept.office });
  await person('mgr', 'ZQTW-004', 'Ekow', { role: 'department_manager' });
  await person('sup', 'ZQTW-005', 'Yaw', { role: 'supervisor' });
  await person('staff', 'ZQTW-006', 'Fiifi', { role: 'employee' });
  await person('mate', 'ZQTW-007', 'Akos', { role: 'employee' });
  await person('cook', 'ZQTW-008', 'Dzifa', { role: 'employee', dept: dept.kitchen });
  await person('kmgr', 'ZQTW-009', 'Esi', { role: 'department_manager', dept: dept.kitchen });
  await person('kboss', 'ZQTW-010', 'Nana', { role: 'department_manager', dept: dept.kitchen });
});
test.after(async function () { await cleanup(); await pool.end(); });

test('licences: kept with a copy, ending soon or ended, applied for, renewed into the history, closed; the daily alerts once per milestone', async function () {
  await assert.rejects(licences.overview(ctx.staff), /licence\.manage/);
  await assert.rejects(licences.save(ctx.fin, null, { title: 'ab' }), /What is it called/);
  await assert.rejects(licences.save(ctx.fin, null, { title: 'Zqtw: Fire certificate', issuedOn: day(0), expiresOn: day(-5) }), /cannot end before/);
  await assert.rejects(licences.save(ctx.fin, null, { title: 'Zqtw: Fire certificate', addFiles: [{ dataUrl: 'data:text/plain;base64,aGVsbG8gdGhlcmU=' }] }), /PDF or a photo/);

  var fire = await licences.save(ctx.fin, null, {
    kind: 'fire', title: 'Zqtw: Fire certificate', companyId: co.works, authority: 'Zqtw Fire Service', number: 'ZQ-FIRE-1', site: 'Zqtw yard',
    issuedOn: months(-11), expiresOn: day(20), cost: 850, ownerId: people.mgr, leadDays: 30, addFiles: [{ dataUrl: PNG, name: 'certificate.png' }]
  });
  assert.equal(fire.state, 'due');
  assert.equal(fire.daysLeft, 20);
  assert.equal(fire.company.code, 'ZQTW');
  assert.equal(fire.files.length, 1);
  assert.equal(fire.owner.id, people.mgr);
  var permit = await licences.save(ctx.fin, null, { kind: 'business', title: 'Zqtw: Operating permit', companyId: co.works, expiresOn: day(-3), cost: 400, ownerId: people.staff });
  assert.equal(permit.state, 'expired');
  var food = await licences.save(ctx.fin, null, { kind: 'food', title: 'Zqtw: Food hygiene', companyId: co.kitchen, expiresOn: day(12), cost: 300, ownerId: people.cook });
  assert.equal(food.state, 'due');
  var sign = await licences.save(ctx.fin, null, { kind: 'signage', title: 'Zqtw: Signboard permit', expiresOn: day(200) });
  assert.equal(sign.state, 'ok');
  var trade = await licences.save(ctx.fin, null, { kind: 'other', title: 'Zqtw: Trade register' });
  assert.equal(trade.state, 'no_expiry');

  // Vehicle papers ending soon are shown alongside.
  await pool.query("INSERT INTO vehicles (company_id, name, plate, insurance_until, roadworthy_until) VALUES ($1, 'Zqtw van', 'ZQ 1-26', $2, $3)", [co.works, day(9), day(300)]);
  var o = await licences.overview(ctx.fin);
  var mine = o.licences.filter(function (l) { return /^Zqtw/.test(l.title); });
  assert.equal(mine.length, 5);
  assert.equal(mine[0].title, 'Zqtw: Operating permit', 'the ones ending first come first');
  assert.ok(o.summary.expired >= 1 && o.summary.due >= 2);
  assert.equal(o.months.length, 12);
  assert.ok(o.months.find(function (m) { return m.month === day(200).slice(0, 7); }).count >= 1);
  var van = o.also.vehicles.filter(function (v) { return v.vehicle === 'Zqtw van · ZQ 1-26'; });
  assert.deepEqual(van.map(function (v) { return v.what; }), ['insurance']);
  assert.equal(van[0].daysLeft, 9);

  // Applied for: renewing, not due.
  await assert.rejects(licences.applied(ctx.fin, fire.id, { on: day(2) }), /Today or before/);
  fire = await licences.applied(ctx.fin, fire.id, { note: 'Zqtw: inspection booked' });
  assert.equal(fire.status, 'renewing');
  assert.equal(fire.state, 'renewing');
  assert.equal(fire.renewingSince, day(0));

  // Renewed: the period before goes into the history, with its copy.
  await assert.rejects(licences.renew(ctx.fin, fire.id, { expiresOn: day(10) }), /should end after/);
  fire = await licences.renew(ctx.fin, fire.id, { number: 'ZQ-FIRE-2', issuedOn: day(0), expiresOn: months(12), cost: 900, files: [{ dataUrl: PNG, name: 'new.png' }] });
  assert.equal(fire.status, 'active');
  assert.equal(fire.state, 'ok');
  assert.equal(fire.number, 'ZQ-FIRE-2');
  assert.equal(fire.renewals, 1);
  assert.equal(fire.spent, 1750);
  assert.equal(fire.history.length, 1);
  assert.equal(fire.history[0].number, 'ZQ-FIRE-1');
  assert.equal(fire.history[0].cost, 850);
  assert.equal(fire.history[0].files.length, 1);
  var f = await licences.fileOf(ctx.fin, fire.id, 0);
  assert.equal(f.name, 'new.png');
  f = await licences.fileOf(ctx.fin, fire.id, 0, fire.history[0].id);
  assert.equal(f.name, 'certificate.png');
  await assert.rejects(licences.fileOf(ctx.fin, fire.id, 3), /gone/);

  // Closed: no longer needed.
  await assert.rejects(licences.setClosed(ctx.fin, sign.id, true, {}), /no longer needed/);
  sign = await licences.setClosed(ctx.fin, sign.id, true, { note: 'Zqtw: the sign came down' });
  assert.equal(sign.state, 'closed');
  assert.ok(!(await licences.overview(ctx.fin)).licences.some(function (l) { return l.id === sign.id; }));
  assert.ok((await licences.overview(ctx.fin, { status: 'closed' })).licences.some(function (l) { return l.id === sign.id; }));
  await assert.rejects(licences.renew(ctx.fin, sign.id, { expiresOn: months(24) }), /closed/);
  sign = await licences.setClosed(ctx.fin, sign.id, false);
  assert.equal(sign.status, 'active');

  // The daily alerts: the owner and whoever keeps the licences; once per milestone.
  var sent = await alerts.licenceAlerts(day(0), {});
  assert.ok(sent >= 2);
  var staffNotes = await notes(people.staff);
  assert.ok(staffNotes.some(function (n) { return n.title === 'Expired: Zqtw: Operating permit' && n.link === '/licences?licence=' + permit.id; }), 'the owner is told');
  assert.ok((await notes(people.fin)).some(function (n) { return n.title === 'Zqtw: Food hygiene ends in 12 days'; }), 'whoever keeps the licences is told');
  assert.ok((await notes(people.cook)).some(function (n) { return n.title === 'Zqtw: Food hygiene ends in 12 days'; }));
  assert.ok(!(await notes(people.mgr)).some(function (n) { return /Fire certificate/.test(n.title); }), 'renewed: nothing to say');
  var before = (await notes(people.fin)).length;
  await alerts.licenceAlerts(day(0), {});
  assert.equal((await notes(people.fin)).length, before, 'nothing twice');
  // Seven days later the food licence passes the 7-day mark.
  await alerts.licenceAlerts(day(7), {});
  assert.ok((await notes(people.cook)).some(function (n) { return n.title === 'Zqtw: Food hygiene ends in 5 days'; }));
});

test('kilns: a charge in, read until dry (and those running production told), finished with what split; a soak, a late shed, the daily alerts', async function () {
  await assert.rejects(kilns.overview(ctx.staff), /production\.read/);
  await assert.rejects(kilns.saveKiln(ctx.sup, null, { name: 'Zqtw Kiln 1' }), /production\.manage/);
  await assert.rejects(kilns.saveKiln(ctx.mgr, null, { name: 'Zqtw Kiln 1', targetMoisture: 80 }), /between 0 and 60/);
  await kilns.saveKiln(ctx.mgr, null, { name: 'Zqtw Kiln 1', kind: 'kiln', capacity: 400, unit: 'culms', targetMoisture: 12, days: 10 });
  await kilns.saveKiln(ctx.mgr, null, { name: 'Zqtw Tank', kind: 'tank', capacity: 300, unit: 'culms', targetMoisture: 12, days: 7 });
  var o = await kilns.saveKiln(ctx.mgr, null, { name: 'Zqtw Shed', kind: 'shed', capacity: 0, unit: 'culms', targetMoisture: 15, days: 30 });
  var k = {};
  o.kilns.forEach(function (x) { if (/^Zqtw/.test(x.name)) k[x.kind] = x; });
  assert.equal(k.tank.targetMoisture, null, 'a tank soaks for days, it has no moisture target');
  assert.equal(k.kiln.capacity, 400);
  var batch = (await pool.query("INSERT INTO raw_batches (batch_no, species, date_received, quantity, received_qty, unit) VALUES ('ZQTW-RB-1', 'Zqtw bambusa', $1, 500, 500, 'culms') RETURNING id", [day(-3)])).rows[0].id;
  // The supervisor can look, not change.
  assert.ok((await kilns.overview(ctx.sup)).kilns.some(function (x) { return x.id === k.kiln.id; }));

  await assert.rejects(kilns.start(ctx.mgr, { kilnId: k.kiln.id, rawBatchId: batch, qty: 0 }), /How many/);
  await assert.rejects(kilns.start(ctx.mgr, { kilnId: k.kiln.id, rawBatchId: batch, qty: 450 }), /More than it holds/);
  var c = await kilns.start(ctx.mgr, { kilnId: k.kiln.id, rawBatchId: batch, qty: 300, startMoisture: 38 });
  assert.match(c.ref, /^K-\d{4}$/);
  assert.equal(c.description, 'Batch ZQTW-RB-1 · Zqtw bambusa');
  assert.equal(c.unit, 'culms');
  assert.equal(c.plannedDays, 10);
  assert.equal(c.targetMoisture, 12);
  assert.equal(c.readings.length, 1);
  assert.equal(c.ready, false);
  await assert.rejects(kilns.start(ctx.mgr, { kilnId: k.kiln.id, description: 'Zqtw boards', qty: 10 }), /in use/);

  await assert.rejects(kilns.read(ctx.sup, c.id, { moisture: 20 }), /production\.manage/);
  await assert.rejects(kilns.read(ctx.mgr, c.id, {}), /What did it read/);
  await assert.rejects(kilns.read(ctx.mgr, c.id, { moisture: 120 }), /between 0 and 100/);
  await assert.rejects(kilns.read(ctx.mgr, c.id, { moisture: 20, at: new Date(Date.now() + 3600000).toISOString() }), /Now or before/);
  c = await kilns.read(ctx.mgr, c.id, { moisture: 25, temperature: 55, humidity: 40 });
  assert.equal(c.latestMoisture, 25);
  assert.equal(c.progress, 50);
  assert.equal(c.ready, false);
  c = await kilns.read(ctx.mgr, c.id, { moisture: 11.5 });
  assert.equal(c.ready, true);
  assert.equal(c.progress, 100);
  assert.ok((await notes(people.mgr)).some(function (n) { return n.title === '✅ Zqtw Kiln 1 is dry — ' + c.ref && n.link === '/kilns?charge=' + c.id; }));

  await assert.rejects(kilns.finish(ctx.mgr, c.id, { outQty: 290, rejectQty: 15 }), /More than went in/);
  c = await kilns.finish(ctx.mgr, c.id, { outQty: 285, rejectQty: 15, endMoisture: 11 });
  assert.equal(c.status, 'done');
  assert.equal(c.outQty, 285);
  assert.equal(c.rejectQty, 15);
  assert.equal(c.ready, false, 'finished: no longer waiting');
  await assert.rejects(kilns.read(ctx.mgr, c.id, { moisture: 10 }), /finished/);
  o = await kilns.overview(ctx.mgr);
  var card = o.kilns.find(function (x) { return x.id === k.kiln.id; });
  assert.equal(card.running, null);
  assert.equal(card.last.id, c.id);
  assert.equal(card.charges30, 1);

  // A soak with no days set anywhere cannot start.
  var bare = (await kilns.saveKiln(ctx.mgr, null, { name: 'Zqtw Tank 2', kind: 'tank' })).kilns.find(function (x) { return x.name === 'Zqtw Tank 2'; });
  await assert.rejects(kilns.start(ctx.mgr, { kilnId: bare.id, description: 'Zqtw culms', qty: 10 }), /soak/);
  var stop = await kilns.start(ctx.mgr, { kilnId: bare.id, description: 'Zqtw culms', qty: 10, plannedDays: 5, solution: 'Zqtw borate 5%' });
  await assert.rejects(kilns.abort(ctx.mgr, stop.id, {}), /Why/);
  stop = await kilns.abort(ctx.mgr, stop.id, { note: 'Zqtw: the pump failed' });
  assert.equal(stop.status, 'aborted');

  // The daily alerts: a soak that has had its days; a shed running late and not read.
  var soak = await kilns.start(ctx.mgr, { kilnId: k.tank.id, rawBatchId: batch, qty: 200, solution: 'Zqtw borate 5%' });
  assert.equal(soak.plannedDays, 7);
  assert.equal(soak.targetMoisture, null);
  var shed = await kilns.start(ctx.mgr, { kilnId: k.shed.id, description: 'Zqtw boards', qty: 80, plannedDays: 5, startMoisture: 30 });
  await pool.query("UPDATE kiln_charges SET started_at = now() - interval '8 days' WHERE id = $1", [soak.id]);
  await pool.query("UPDATE kiln_charges SET started_at = now() - interval '7 days' WHERE id = $1", [shed.id]);
  await pool.query("UPDATE kiln_readings SET at = now() - interval '7 days' WHERE charge_id = $1", [shed.id]);
  soak = await kilns.get(ctx.mgr, soak.id);
  assert.equal(soak.ready, true);
  shed = await kilns.get(ctx.sup, shed.id);
  assert.equal(shed.late, true);
  assert.equal(shed.quiet, true);
  assert.equal(shed.canManage, false);
  o = await kilns.overview(ctx.mgr);
  assert.ok(o.summary.ready >= 1 && o.summary.late >= 1);

  var before = (await notes(people.mgr)).length;
  await alerts.kilnAlerts(day(0), {});
  var told = (await notes(people.mgr)).slice(before);
  assert.ok(told.some(function (n) { return n.title === 'Zqtw Tank: the soak is done — ' + soak.ref; }));
  assert.ok(told.some(function (n) { return n.title === 'Zqtw Shed: ' + shed.ref + ' is taking longer than planned'; }));
  assert.ok(!told.some(function (n) { return /no reading/.test(n.title); }), 'late and not read: one message, not two');
  before = (await notes(people.mgr)).length;
  await alerts.kilnAlerts(day(0), {});
  assert.equal((await notes(people.mgr)).length, before, 'nothing twice in the week');
  // The next week, still not read: a reminder.
  await alerts.kilnAlerts(day(7), {});
  assert.ok((await notes(people.mgr)).slice(before).some(function (n) { return n.title === 'Zqtw Shed: no reading for two days'; }));
});

test('bill of materials: the cost rolls up through a sub-assembly, the margin, what can be made and what a run is short of; the cost price set from it', async function () {
  await product('culm', 'ZQTW-CULM', 'Zqtw culm', { cost: 12, stock: 100 });
  await product('glue', 'ZQTW-GLUE', 'Zqtw glue', { cost: 40, stock: 3, unit: 'litre' });
  await product('board', 'ZQTW-BOARD', 'Zqtw board', { cost: 35, stock: 12 });
  await product('table', 'ZQTW-TABLE', 'Zqtw table', { cost: 300, price: 600, stock: 0, category: 'Zqtw furniture' });
  await assert.rejects(bom.overview(ctx.staff), /production\.read/);
  await assert.rejects(bom.save(ctx.sup, prod.board, { lines: [] }), /production\.manage/);
  await assert.rejects(bom.save(ctx.mgr, prod.board, { lines: [{ componentId: prod.board, qty: 1 }] }), /made of itself/);
  await assert.rejects(bom.save(ctx.mgr, prod.board, { lines: [{ componentId: prod.culm, qty: 2, wastePct: 95 }] }), /between 0 and 90/);
  await assert.rejects(bom.save(ctx.mgr, prod.board, { lines: [{ componentId: prod.culm, qty: 0 }] }), /how many go into one/);

  // A board: two culms (the same part twice, merged), 10% waste, labour, overhead.
  var board = await bom.save(ctx.mgr, prod.board, { lines: [{ componentId: prod.culm, qty: 1, wastePct: 10 }, { componentId: prod.culm, qty: 1 }], labourHours: 0.5, labourRate: 20, overhead: 3.6 });
  assert.equal(board.lines.length, 1);
  assert.equal(board.lines[0].qty, 2);
  assert.equal(board.lines[0].perUnit, 2.2);
  assert.equal(board.material, 26.4);
  assert.equal(board.labour, 10);
  assert.equal(board.cost, 40);
  assert.equal(board.diffPct, 14.3, 'the 35 on file is out of date');
  // A table: six boards (their cost rolled up), a quarter litre of glue.
  var table = await bom.save(ctx.mgr, prod.table, { lines: [{ componentId: prod.board, qty: 6 }, { componentId: prod.glue, qty: 0.25 }], labourHours: 4, labourRate: 25, overhead: 50 });
  assert.equal(table.material, 250);
  assert.equal(table.cost, 400);
  assert.equal(table.margin, 200);
  assert.equal(table.marginPct, 33.3);
  assert.equal(table.diffPct, 33.3);
  assert.equal(table.buildable, 2, 'twelve boards make two');
  assert.equal(table.limiting.name, 'Zqtw board');
  assert.equal(table.lines[0].unitCost, 40);
  assert.equal(table.lines[0].component.hasBom, true);
  // A loop through the parts is refused.
  await assert.rejects(bom.save(ctx.mgr, prod.board, { lines: [{ componentId: prod.table, qty: 1 }] }), /inside its own bill/);

  // A planned run of five: eighteen boards short, the glue is there.
  var run = await bom.get(ctx.sup, prod.table, { qty: 5 });
  assert.equal(run.canManage, false);
  assert.equal(run.plan.ok, false);
  var boards = run.plan.needs.find(function (n) { return n.component.id === prod.board; });
  assert.deepEqual([boards.need, boards.have, boards.short, boards.shortCost], [30, 12, 18, 720]);
  assert.equal(run.plan.needs.find(function (n) { return n.component.id === prod.glue; }).short, 0);
  assert.equal(run.plan.shortCost, 720);
  assert.equal(run.plan.cost, 2000);
  assert.equal(run.plan.value, 3000);
  assert.deepEqual((await bom.get(ctx.mgr, prod.board)).whereUsed.map(function (w) { return w.name; }), ['Zqtw table']);

  var o = await bom.overview(ctx.sup);
  var row = o.products.find(function (p) { return p.id === prod.table; });
  assert.equal(row.marginPct, 33.3);
  assert.equal(row.cost, 400);
  assert.ok(o.parts.some(function (p) { return p.id === prod.culm && p.usedIn === 1; }));
  assert.ok(!o.noBom.some(function (p) { return p.id === prod.table; }));

  // The cost price on file becomes the roll-up, kept in the history.
  table = await bom.useCost(ctx.mgr, prod.table);
  assert.equal(table.costOnFile, 400);
  assert.equal(table.diffPct, 0);
  assert.equal(table.history.length, 1);
  assert.deepEqual([table.history[0].before, table.history[0].after], [300, 400]);
  await assert.rejects(bom.useCost(ctx.mgr, prod.table), /already 400\.00/);
  await assert.rejects(bom.useCost(ctx.mgr, prod.culm), /no bill of materials/);
  // A bill emptied is gone.
  await bom.save(ctx.mgr, prod.board, { lines: [] });
  assert.equal((await bom.get(ctx.mgr, prod.board)).lines.length, 0);
  assert.equal((await bom.get(ctx.mgr, prod.table)).lines[0].unitCost, 35, 'without a bill the board costs what is on file');
});

test('supplier scorecards: from the purchase orders, the raw bamboo taken in and ratings; grades, the trend, a poor delivery tells the buyers', async function () {
  assert.equal(scorecards.gradeOf(85), 'A');
  assert.equal(scorecards.gradeOf(84), 'B');
  assert.equal(scorecards.gradeOf(55), 'C');
  assert.equal(scorecards.gradeOf(54), 'D');
  assert.equal(scorecards.priceScore(-3), 100);
  assert.equal(scorecards.priceScore(4), 80);
  assert.equal(scorecards.priceScore(30), 0);
  assert.equal(scorecards.scoreOf({ delivery: [100], completeness: [100], quality: [], price: [], service: [] }).grade, null, 'too few to grade');
  await assert.rejects(scorecards.overview(ctx.staff), /supplier\.read/);

  // Bamboo Products: raw bamboo by grade, the price against the delivery before.
  var farm = (await pool.query("INSERT INTO suppliers (name, contact_person, materials_supplied) VALUES ('Zqtw Bamboo Farms', 'Zqtw', 'Bamboo culms') RETURNING id")).rows[0].id;
  var intake = async function (no, n, grade, cost) {
    await pool.query("INSERT INTO raw_batches (batch_no, species, supplier_id, date_received, quantity, received_qty, unit, quality_grade, cost, status) VALUES ($1, 'Zqtw bambusa', $2, $3, 1000, 1000, 'culms', $4, $5, 'consumed')", [no, farm, day(n), grade, cost]);
  };
  await intake('ZQTW-B1', -300, 'C', 5000);
  await intake('ZQTW-B2', -280, 'C', 5000);
  await intake('ZQTW-B3', -260, 'C', 5000);
  await intake('ZQTW-B4', -100, 'A', 5000);
  await intake('ZQTW-B5', -60, 'B', 5250);
  await intake('ZQTW-B6', -20, 'A', 5250);
  // A restaurant: purchase orders on the day or late, all there or short, dearer or not.
  var fish = (await pool.query("INSERT INTO restaurant_suppliers (company_id, name) VALUES ($1, 'Zqtw Fish Ltd') RETURNING id", [co.kitchen])).rows[0].id;
  var po = async function (number, expected, received, lines) {
    var id = (await pool.query("INSERT INTO restaurant_purchase_orders (company_id, number, supplier_id, supplier_name, status, expected_on, received_at, total) VALUES ($1,$2,$3,'Zqtw Fish Ltd','received',$4,$5,$6) RETURNING id",
      [co.kitchen, number, fish, day(expected), day(received) + 'T10:00:00Z', lines.reduce(function (a, l) { return a + l[0] * l[2]; }, 0)])).rows[0].id;
    for (var i = 0; i < lines.length; i++) await pool.query("INSERT INTO restaurant_purchase_order_lines (po_id, item_type, item_id, name, qty, received_qty, unit_cost, previous_cost) VALUES ($1, 'ingredient', gen_random_uuid(), 'Zqtw tilapia', $2, $3, $4, $5)", [id, lines[i][0], lines[i][1], lines[i][2], lines[i][3]]);
  };
  await po(1, -30, -29, [[10, 10, 50, 50]]);
  await po(2, -15, -15, [[10, 8, 55, 50]]);
  await po(3, -5, -6, [[20, 20, 55, 55]]);

  var o = await scorecards.overview(ctx.boss);
  var f = o.suppliers.find(function (s) { return s.key === 'bpl:' + farm; });
  assert.deepEqual([f.parts.quality.score, f.parts.price.score], [90, 88]);
  assert.equal(f.score, 89);
  assert.equal(f.grade, 'A');
  assert.equal(f.deliveries, 3);
  assert.equal(f.spend, 15500);
  assert.equal(f.before, 64, 'the half-year before: grade C bamboo');
  assert.equal(f.change, 25);
  var r = o.suppliers.find(function (s) { return s.key === 'restaurant:' + fish; });
  assert.deepEqual([r.parts.delivery.score, r.parts.completeness.score, r.parts.price.score], [67, 93, 83]);
  assert.equal(r.score, 79);
  assert.equal(r.grade, 'B');
  assert.equal(r.company.code, 'ZQTX');
  assert.equal(r.before, null);
  // A supervisor sees the restaurants' suppliers only.
  var sup = await scorecards.overview(ctx.sup);
  assert.ok(sup.suppliers.some(function (s) { return s.key === 'restaurant:' + fish; }));
  assert.ok(!sup.suppliers.some(function (s) { return s.kind === 'bpl'; }));
  assert.deepEqual(sup.canRate, { bpl: false, restaurant: false });
  await assert.rejects(scorecards.get(ctx.sup, 'bpl', farm), /not yours to see/);
  assert.ok((await scorecards.overview(ctx.boss, { company: 'ZQTX' })).suppliers.every(function (s) { return s.company.code === 'ZQTX'; }));

  var one = await scorecards.get(ctx.boss, 'restaurant', fish);
  assert.equal(one.months.length, 6);
  assert.equal(one.events.length, 3);
  assert.equal(one.events.find(function (e) { return e.ref === 'PO-1'; }).onTime, false);
  assert.equal(one.events.find(function (e) { return e.ref === 'PO-2'; }).fill, 80);

  // Rated by whoever took it in: a poor one tells the other buyers.
  await assert.rejects(scorecards.rate(ctx.sup, { kind: 'restaurant', supplierId: fish, quality: 3 }), /restaurant\.manage/);
  await assert.rejects(scorecards.rate(ctx.kmgr, { kind: 'restaurant', supplierId: fish, quality: 6 }), /One to five/);
  await assert.rejects(scorecards.rate(ctx.kmgr, { kind: 'restaurant', supplierId: fish }), /at least one/);
  await assert.rejects(scorecards.rate(ctx.kmgr, { kind: 'restaurant', supplierId: fish, quality: 3, deliveredOn: day(2) }), /Today or before/);
  one = await scorecards.rate(ctx.kmgr, { kind: 'restaurant', supplierId: fish, ref: 'PO-4', quality: 2, service: 3, onTime: false, note: 'Zqtw: the fish was not fresh' });
  assert.equal(one.ratings, 1);
  assert.ok(one.ratingId);
  assert.equal(one.parts.quality.score, 25);
  assert.equal(one.parts.delivery.n, 4);
  assert.ok((await notes(people.kboss)).some(function (n) { return n.title === '👎 A poor delivery from Zqtw Fish Ltd' && n.link === '/scorecards?supplier=restaurant:' + fish; }));
  assert.ok(!(await notes(people.kmgr)).some(function (n) { return /poor delivery/.test(n.title); }), 'not the one who rated it');
  // A fine one tells nobody.
  var n = (await notes(people.kboss)).length;
  await scorecards.rate(ctx.kmgr, { kind: 'restaurant', supplierId: fish, quality: 5, onTime: true, complete: true });
  assert.equal((await notes(people.kboss)).length, n);
});

test('policies: drafted, published to a company, signed in My space with a name; a new version signs again; joiners; late signers reminded weekly', async function () {
  await assert.rejects(policies.overview(ctx.staff), /policy\.manage/);
  await assert.rejects(policies.save(ctx.hr, null, { title: 'Zqtw: Code of conduct', body: 'Too short' }), /Write the policy/);
  var p = await policies.save(ctx.hr, null, { title: 'Zqtw: Code of conduct', category: 'conduct', companyId: co.works, summary: 'Zqtw: how we work together', body: 'Zqtw: be on time, be kind, keep the workshop safe and clean.', signDays: 10 });
  assert.equal(p.status, 'draft');
  assert.equal(p.version, 1);
  assert.deepEqual(p.audience, { kind: 'company', id: co.works, name: 'Zqtw Works' });
  await assert.rejects(policies.get(ctx.staff, p.id), /not for you/);
  await assert.rejects(policies.sign(ctx.staff, p.id, { name: 'Fiifi Zqtw', agree: true }), /not in force/);

  p = await policies.publish(ctx.hr, p.id);
  assert.equal(p.status, 'published');
  assert.equal(p.versions.length, 1);
  assert.ok((await notes(people.staff)).some(function (n) { return n.title === '📜 Please read and sign: Zqtw: Code of conduct' && n.link === '/myspace'; }));
  assert.ok(!(await notes(people.cook)).some(function (n) { return /Code of conduct/.test(n.title); }), 'not for the kitchen company');
  await assert.rejects(policies.publish(ctx.hr, p.id), /already/);
  await assert.rejects(policies.get(ctx.cook, p.id), /not for you/);
  await assert.rejects(policies.sign(ctx.cook, p.id, { name: 'Dzifa Zqtw', agree: true }), /not for you/);

  var mine = await policies.mine(ctx.staff);
  var it = mine.toSign.find(function (x) { return x.id === p.id; });
  assert.equal(it.due, day(10));
  assert.equal(it.overdue, false);
  assert.equal(it.again, false);
  assert.equal(it.body, undefined, 'the list is light: the text comes with the policy');
  var read = await policies.get(ctx.staff, p.id);
  assert.match(read.body, /be on time/);
  assert.equal(read.mine.forMe, true);
  assert.equal(read.people, undefined, 'staff do not see who else has signed');

  await assert.rejects(policies.sign(ctx.staff, p.id, { name: 'Fiifi Zqtw', agree: false }), /Tick/);
  await assert.rejects(policies.sign(ctx.staff, p.id, { name: 'Somebody Else', agree: true }), /Type your name/);
  assert.deepEqual(await policies.sign(ctx.staff, p.id, { name: 'Fiifi Zqtw', agree: true }), { ok: true, version: 1 });
  await assert.rejects(policies.sign(ctx.staff, p.id, { name: 'Fiifi Zqtw', agree: true }), /already/);
  assert.ok((await policies.mine(ctx.staff)).signed.some(function (x) { return x.id === p.id; }));
  var full = await policies.get(ctx.hr, p.id);
  var me = full.people.find(function (x) { return x.id === people.staff; });
  assert.ok(me.signedAt);
  assert.ok(full.people.some(function (x) { return x.id === people.mate && !x.signedAt; }));
  assert.ok(!full.people.some(function (x) { return x.id === people.cook; }));

  // Changing what it says: a new version, and everyone signs again.
  await assert.rejects(policies.save(ctx.hr, p.id, { title: p.title, companyId: co.works, body: p.body + ' Phones away on the shop floor.' }), /new version/);
  await assert.rejects(policies.save(ctx.hr, p.id, { title: p.title, companyId: co.works, body: p.body + ' Phones away on the shop floor.', newVersion: true, versionNote: 'ab' }), /What changed/);
  var v2 = await policies.save(ctx.hr, p.id, { title: p.title, category: 'conduct', companyId: co.works, signDays: 10, body: p.body + ' Phones away on the shop floor.', newVersion: true, versionNote: 'Zqtw: phones away on the shop floor' });
  assert.equal(v2.version, 2);
  assert.equal(v2.versions.length, 2);
  assert.ok((await notes(people.staff)).some(function (n) { return n.title === '📜 Zqtw: Code of conduct has changed: please read and sign again'; }));
  it = (await policies.mine(ctx.staff)).toSign.find(function (x) { return x.id === p.id; });
  assert.equal(it.again, true);
  // A summary alone is not a new version.
  var same = await policies.save(ctx.hr, p.id, { title: v2.title, category: 'conduct', companyId: co.works, signDays: 10, body: v2.body, summary: 'Zqtw: the rules of the house' });
  assert.equal(same.version, 2);

  // To read only: nothing to sign. With a PDF: those it is for can open it.
  var info = await policies.save(ctx.hr, null, { title: 'Zqtw: Canteen menu rules', category: 'food', companyId: co.works, mustSign: false, file: PDF, fileName: 'canteen.pdf' });
  info = await policies.publish(ctx.hr, info.id);
  assert.equal(info.hasFile, true);
  assert.ok((await policies.mine(ctx.mate)).toRead.some(function (x) { return x.id === info.id; }));
  await assert.rejects(policies.sign(ctx.mate, info.id, { name: 'Akos Zqtw', agree: true }), /only to read/);
  assert.equal((await policies.fileOf(ctx.mate, info.id)).type, 'application/pdf');
  await assert.rejects(policies.fileOf(ctx.cook, info.id), /not for you/);
  await assert.rejects(policies.fileOf(ctx.mate, p.id), /no PDF/);

  // A joiner: each policy for them on their first-day checklist, ticked when they sign.
  var safety = await policies.save(ctx.hr, null, { title: 'Zqtw: Workshop safety rules', category: 'safety', departmentId: dept.works, body: 'Zqtw: goggles and gloves at the saws, always.', signDays: 30 });
  assert.deepEqual(safety.audience, { kind: 'department', id: dept.works, name: 'Zqtw Workshop' });
  await policies.publish(ctx.hr, safety.id);
  await person('newbie', 'ZQTW-011', 'Kwesi', { role: 'employee', hired: day(0) });
  var list = await onboarding.start(ctx.boss, { employeeId: people.newbie, kind: 'join' });
  var steps = (await pool.query("SELECT id, title, owner, assignee_id, due_on, ref_id FROM onboard_steps WHERE list_id = $1 AND kind = 'policy' ORDER BY title", [list.id])).rows;
  assert.deepEqual(steps.map(function (s) { return s.title; }), ['Read and sign: Zqtw: Code of conduct', 'Read and sign: Zqtw: Workshop safety rules']);
  assert.equal(steps[0].assignee_id, people.newbie);
  assert.equal(String(steps[0].due_on instanceof Date ? steps[0].due_on.toISOString() : steps[0].due_on).slice(0, 10), day(10));
  await assert.rejects(onboarding.tick(ctx.boss, steps[1].id, { done: true }), /sign it themselves/);
  await policies.sign(ctx.newbie, safety.id, { name: 'kwesi', agree: true });
  assert.ok((await pool.query('SELECT done_at FROM onboard_steps WHERE id = $1', [steps[1].id])).rows[0].done_at, 'ticked itself');
  assert.equal((await pool.query('SELECT done_at FROM onboard_steps WHERE id = $1', [steps[0].id])).rows[0].done_at, null);
  // Retired: the open step closes.
  var gone = await policies.save(ctx.hr, null, { title: 'Zqtw: Old dress code', companyId: co.works, body: 'Zqtw: the old dress code, replaced next month.' });
  await policies.publish(ctx.hr, gone.id);
  var oldStep = (await pool.query("INSERT INTO onboard_steps (list_id, seq, title, owner, assignee_id, due_on, kind, ref_id) VALUES ($1, 99, 'Read and sign: Zqtw: Old dress code', 'person', $2, $3, 'policy', $4) RETURNING id", [list.id, people.newbie, day(5), gone.id])).rows[0].id;
  gone = await policies.retire(ctx.hr, gone.id);
  assert.equal(gone.status, 'retired');
  assert.equal((await pool.query('SELECT note FROM onboard_steps WHERE id = $1', [oldStep])).rows[0].note, 'Policy retired');
  assert.ok(!(await policies.mine(ctx.newbie)).toSign.some(function (x) { return x.id === gone.id; }));

  // Late: reminded once a week, and whoever keeps the policies told who.
  await pool.query("UPDATE policies SET published_at = now() - interval '20 days' WHERE id = $1", [p.id]);
  var late = await policies.lateSigners();
  assert.deepEqual(late.byPerson[people.mate], ['Zqtw: Code of conduct']);
  assert.ok(late.byPerson[people.staff], 'version 2 is not signed yet');
  assert.equal(late.byPerson[people.newbie], undefined, 'a joiner has from their first day');
  var row = late.byPolicy.find(function (x) { return x.id === p.id; });
  assert.ok(row.late >= 5 && row.of > row.late);
  var o = await policies.overview(ctx.hr);
  var card = o.policies.find(function (x) { return x.id === p.id; });
  assert.equal(card.overdue, row.late);
  assert.ok(o.summary.overdue >= row.late);

  await alerts.policyAlerts(day(0), {});
  assert.ok((await notes(people.mate)).some(function (n) { return n.title === 'A policy to sign: Zqtw: Code of conduct' && n.link === '/myspace'; }));
  assert.ok((await notes(people.hr)).some(function (n) { return n.title === row.late + ' late to sign Zqtw: Code of conduct' && n.link === '/policies?policy=' + p.id; }));
  var before = (await notes(people.mate)).length;
  await alerts.policyAlerts(day(0), {});
  assert.equal((await notes(people.mate)).length, before, 'once a week');
  await alerts.policyAlerts(day(7), {});
  assert.equal((await notes(people.mate)).length, before + 1, 'and the next week again');

  var rem = await policies.remind(ctx.hr, p.id);
  assert.equal(rem.reminded, row.of - (await pool.query('SELECT count(*)::int AS n FROM policy_signatures WHERE policy_id = $1 AND version = 2', [p.id])).rows[0].n);
  assert.ok((await notes(people.mate)).some(function (n) { return n.title === '📜 A reminder: please read and sign Zqtw: Code of conduct' && /was due on/.test(n.body); }));
  await assert.rejects(policies.remind(ctx.hr, info.id), /Nobody needs to sign/);
});
