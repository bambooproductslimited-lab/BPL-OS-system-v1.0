// The twenty-first batch (migration 0203): production jobs from the bill of
// materials; bamboo outgrowers; the generator and power log; requests for
// quotes; the monthly management report. Fake Zqty data in its own
// companies (ZQTY, ZQTZ).
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var jobs = require('../src/services/productionJobs.service');
var outgrowers = require('../src/services/outgrowers.service');
var power = require('../src/services/power.service');
var rfqs = require('../src/services/rfqs.service');
var report = require('../src/services/managementReport.service');
var bom = require('../src/services/bom.service');
var mail = require('../src/services/mail.service');
var alerts = require('../src/jobs/dailyAlerts');

var co = {}, dept = {}, people = {}, ctx = {}, prod = {};
var savedReportSettings = null;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function hoursAgo(h) { return new Date(Date.now() - h * 3600000).toISOString(); }

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code IN ('ZQTY', 'ZQTZ')")).rows.map(function (r) { return r.id; });
  var emps = "SELECT id FROM employees WHERE code LIKE 'ZQTY-%' OR email LIKE 'zqty.%@example.com'";
  var zprod = "SELECT id FROM products WHERE sku LIKE 'ZQTY-%'";
  await pool.query("DELETE FROM qc_inspections WHERE lot_ref IN (SELECT 'J-' || lpad(number::text, 4, '0') FROM production_jobs WHERE product_id IN (" + zprod + '))');
  await pool.query("DELETE FROM inventory_tx WHERE item_type = 'product' AND item_id IN (" + zprod + ')');
  await pool.query('DELETE FROM production_jobs WHERE product_id IN (' + zprod + ')');
  await pool.query('DELETE FROM bom_lines WHERE product_id IN (' + zprod + ')');
  await pool.query('DELETE FROM bom_costs WHERE product_id IN (' + zprod + ')');
  await pool.query('DELETE FROM products WHERE sku LIKE \'ZQTY-%\'');
  await pool.query("DELETE FROM rfqs WHERE title LIKE 'Zqty%'");
  await pool.query("DELETE FROM procurement_requests WHERE item LIKE 'Zqty%'");
  await pool.query("DELETE FROM inventory_tx WHERE item_type = 'raw' AND item_id IN (SELECT id FROM raw_batches WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE 'Zqty%'))");
  await pool.query("DELETE FROM raw_batches WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE 'Zqty%')");
  await pool.query("DELETE FROM suppliers WHERE name LIKE 'Zqty%'");
  if (cos.length) {
    await pool.query('DELETE FROM power_sources WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM power_outages WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_purchase_order_lines WHERE po_id IN (SELECT id FROM restaurant_purchase_orders WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM restaurant_purchase_orders WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_ingredients WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM restaurant_suppliers WHERE company_id = ANY($1)', [cos]);
  }
  await pool.query("DELETE FROM expiry_alerts WHERE kind IN ('power_fuel', 'job_late')");
  await pool.query("DELETE FROM management_reports WHERE sent_to LIKE '%zqty%' OR sent_to = ''");
  await pool.query('DELETE FROM notifications WHERE employee_id IN (' + emps + ')');
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zqty.%@example.com')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqty.%@example.com'");
  await pool.query('DELETE FROM employees WHERE id IN (' + emps + ')');
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, o) {
  o = o || {};
  var id = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date, status, employment_type, pay_cycle) VALUES ($1, $2, 'Zqty', $3, $4, $5, $6, 'active', 'permanent', 'monthly') RETURNING id",
    [code, first, 'zqty.' + first.toLowerCase() + '@example.com', '0200006' + code.slice(-3), o.dept || dept.works, o.hired || '2022-01-01'])).rows[0].id;
  people[key] = id;
  if (o.role) {
    var user = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, 'x', 'active') RETURNING id", [id, 'zqty.' + first.toLowerCase() + '@example.com'])).rows[0].id;
    await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [user, o.role]);
    ctx[key] = await buildContext(user);
  }
  return id;
}
async function notes(empId) { return (await pool.query('SELECT title, body, link FROM notifications WHERE employee_id = $1 ORDER BY at', [empId])).rows; }
async function product(key, sku, name, o) {
  prod[key] = (await pool.query('INSERT INTO products (sku, name, category, unit, cost_price, selling_price, current_stock) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [sku, name, o.category || 'Zqty', o.unit || 'each', o.cost || 0, o.price || 0, o.stock || 0])).rows[0].id;
  return prod[key];
}
async function stockOf(id) { return Number((await pool.query('SELECT current_stock FROM products WHERE id = $1', [id])).rows[0].current_stock); }

test.before(async function () {
  await cleanup();
  savedReportSettings = (await pool.query('SELECT management_report FROM settings WHERE id = 1')).rows[0].management_report;
  co.works = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTY', 'Zqty Works') RETURNING id")).rows[0].id;
  co.kitchen = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQTZ', 'Zqty Kitchen') RETURNING id")).rows[0].id;
  dept.works = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTYW', 'Zqty Workshop', $1) RETURNING id", [co.works])).rows[0].id;
  dept.office = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTYO', 'Zqty Office', $1) RETURNING id", [co.works])).rows[0].id;
  dept.kitchen = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQTYK', 'Zqty Kitchen', $1) RETURNING id", [co.kitchen])).rows[0].id;
  await person('boss', 'ZQTY-001', 'Kojo', { role: 'administrator', dept: dept.office });
  await person('fin', 'ZQTY-003', 'Efua', { role: 'finance_manager', dept: dept.office });
  await person('mgr', 'ZQTY-004', 'Ekow', { role: 'department_manager' });
  await person('staff', 'ZQTY-006', 'Fiifi', { role: 'employee' });
  await person('kmgr', 'ZQTY-009', 'Esi', { role: 'department_manager', dept: dept.kitchen });
  await person('exec', 'ZQTY-011', 'Afia', { role: 'executive', dept: dept.office });
});
test.after(async function () {
  mail.setTransportForTests(null);
  await pool.query('UPDATE settings SET management_report = $1 WHERE id = 1', [JSON.stringify(savedReportSettings || {})]);
  await cleanup();
  await pool.end();
});

test('production jobs: planned from the bill, parts taken out of stock (what is there), more taken and some given back, finished into stock with scrap, cost against the bill, quality told; cancelled gives the parts back', async function () {
  await product('table', 'ZQTY-TABLE', 'Zqty side table', { price: 1000, cost: 240 });
  await product('board', 'ZQTY-BOARD', 'Zqty board', { cost: 50, stock: 10, unit: 'pieces' });
  await product('glue', 'ZQTY-GLUE', 'Zqty glue', { cost: 20, stock: 1, unit: 'litres' });
  await product('chair', 'ZQTY-CHAIR', 'Zqty chair', { price: 600 });
  await bom.save(ctx.mgr, prod.table, { lines: [{ componentId: prod.board, qty: 4 }, { componentId: prod.glue, qty: 0.5, wastePct: 10 }], labourHours: 2, labourRate: 15, overhead: 10 });

  await assert.rejects(jobs.overview(ctx.staff), /production\.read/);
  await assert.rejects(jobs.create(ctx.staff, { productId: prod.table, qty: 3 }), /production\.manage/);
  await assert.rejects(jobs.create(ctx.mgr, { productId: prod.chair, qty: 3 }), /no bill of materials/);
  await assert.rejects(jobs.create(ctx.mgr, { productId: prod.table, qty: 0 }), /How many to make/);

  var j = await jobs.create(ctx.mgr, { productId: prod.table, qty: 3, dueOn: day(-1), leadId: people.staff, note: 'Zqty order for a hotel' });
  assert.match(j.ref, /^J-\d{4}$/);
  assert.equal(j.status, 'planned');
  assert.equal(j.state, 'late');
  assert.deepEqual(j.plan, { material: 633, labour: 90, overhead: 30, hours: 6, total: 753, each: 251 });
  var board = j.parts.find(function (x) { return x.componentId === prod.board; });
  var glue = j.parts.find(function (x) { return x.componentId === prod.glue; });
  assert.equal(board.planned, 12);
  assert.equal(glue.planned, 1.65);
  assert.equal(j.short.length, 2, 'the store holds less of both than the job needs');
  assert.ok((await notes(people.staff)).some(function (n) { return n.title === 'Job ' + j.ref + ': 3 × Zqty side table'; }));

  // Changing how many re-plans while it has not started.
  j = await jobs.update(ctx.mgr, j.id, { qty: 2 });
  assert.equal(j.plan.total, 502);
  j = await jobs.update(ctx.mgr, j.id, { qty: 3 });

  // Started: what is there is taken.
  j = await jobs.start(ctx.mgr, j.id);
  assert.equal(j.status, 'in_progress');
  assert.deepEqual(j.wasShort.map(function (s) { return [s.name, s.need]; }), [['Zqty board', 2], ['Zqty glue', 0.65]]);
  assert.equal(await stockOf(prod.board), 0);
  assert.equal(await stockOf(prod.glue), 0);
  await assert.rejects(jobs.start(ctx.mgr, j.id), /Only a planned job/);
  await assert.rejects(jobs.update(ctx.mgr, j.id, { qty: 5 }), /has started/);

  // More taken when it comes; some given back.
  await assert.rejects(jobs.issue(ctx.mgr, j.id, { componentId: prod.board, qty: 2 }), /Only 0 pieces of Zqty board in stock/);
  await pool.query('UPDATE products SET current_stock = 5 WHERE id = $1', [prod.board]);
  j = await jobs.issue(ctx.mgr, j.id, { componentId: prod.board, qty: 2, note: 'the rest came' });
  assert.equal(j.parts.find(function (x) { return x.componentId === prod.board; }).issued, 12);
  assert.equal(await stockOf(prod.board), 3);
  j = await jobs.issue(ctx.mgr, j.id, { componentId: prod.glue, qty: -0.5 });
  assert.equal(j.parts.find(function (x) { return x.componentId === prod.glue; }).issued, 0.5);
  assert.equal(await stockOf(prod.glue), 0.5);
  await assert.rejects(jobs.issue(ctx.mgr, j.id, { componentId: prod.glue, qty: -1 }), /that is all that can go back/);
  await assert.rejects(jobs.issue(ctx.mgr, j.id, { componentId: prod.table, qty: 1 }), /cannot use what it makes/);

  // Finished: two good, one spoilt.
  await assert.rejects(jobs.finish(ctx.mgr, j.id, { good: 2, scrap: 1 }), /What spoilt them/);
  await assert.rejects(jobs.finish(ctx.mgr, j.id, { good: 0, scrap: 0 }), /How many were made/);
  j = await jobs.finish(ctx.mgr, j.id, { good: 2, scrap: 1, scrapReason: 'split in the press' });
  assert.equal(j.status, 'done');
  assert.equal(await stockOf(prod.table), 2);
  assert.equal(j.actual.material, 610);
  assert.equal(j.actual.labour, 90);
  assert.equal(j.actual.overhead, 30);
  assert.equal(j.actual.total, 730);
  assert.equal(j.actual.each, 365);
  assert.equal(j.actual.planFor, 502);
  assert.equal(j.actual.variance, 228);
  assert.equal(j.actual.variancePct, 45.4);
  assert.deepEqual(j.moves.map(function (m) { return m.type; }).sort(), ['job_issue', 'job_issue', 'job_issue', 'job_output', 'job_return']);
  var told = (await notes(people.boss)).find(function (n) { return n.title === j.ref + ' is done: 2 × Zqty side table to inspect'; });
  assert.ok(told, 'quality is told');
  assert.equal(told.link, '/quality?lot=' + j.ref + '&product=' + prod.table + '&qty=2');
  await assert.rejects(jobs.cancel(ctx.mgr, j.id, { reason: 'x' }), /not finished yet/);

  // A second one, started and then cancelled: the parts go back.
  await pool.query('UPDATE products SET current_stock = 10 WHERE id = ANY($1)', [[prod.board, prod.glue]]);
  var k = await jobs.create(ctx.mgr, { productId: prod.table, qty: 1, dueOn: day(5) });
  k = await jobs.start(ctx.mgr, k.id);
  assert.equal(await stockOf(prod.board), 6);
  await assert.rejects(jobs.cancel(ctx.mgr, k.id, {}), /Why is it cancelled/);
  k = await jobs.cancel(ctx.mgr, k.id, { reason: 'the customer changed the size' });
  assert.equal(k.status, 'cancelled');
  assert.equal(await stockOf(prod.board), 10);
  assert.equal(await stockOf(prod.glue), 10);

  var o = await jobs.overview(ctx.mgr, { show: 'all' });
  assert.ok(o.jobs.some(function (x) { return x.id === j.id; }));
  assert.ok(o.products.some(function (p) { return p.id === prod.table && p.canMake === 2; }), 'boards 10 / 4 = 2');
  assert.ok(o.summary.finished >= 1);
  var m = await jobs.monthFigures(day(0).slice(0, 8) + '01', day(0));
  assert.ok(m.good >= 2 && m.scrap >= 1);

  // A late job: its lead and production are told once a week.
  var late = await jobs.create(ctx.mgr, { productId: prod.table, qty: 1, dueOn: day(-2), leadId: people.staff });
  assert.ok((await alerts.jobAlerts(day(0), {})) >= 1);
  assert.ok((await notes(people.staff)).some(function (n) { return n.title === 'Late: ' + late.ref + ', 1 × Zqty side table'; }));
  assert.equal(await alerts.jobAlerts(day(0), {}), 0, 'once a week');
});

test('outgrowers: a farmer with plots and harvests forecast, money advanced, a delivery taken in and paid by Mobile Money with the advance taken off, paid once', async function () {
  await assert.rejects(outgrowers.overview(ctx.staff), /supplier\.read/);
  await assert.rejects(outgrowers.save(ctx.staff, null, { name: 'Zqty Farmer Kofi' }), /supplier\.read|supplier\.manage/);
  await assert.rejects(outgrowers.save(ctx.mgr, null, { name: 'Zqty Farmer Kofi', momoNumber: 'call me' }), /not a phone number/);
  var f = await outgrowers.save(ctx.mgr, null, { name: 'Zqty Farmer Kofi', phone: '0200006101', town: 'Zqty town', region: 'Ashanti', momoNumber: '0200006101', momoNetwork: 'MTN' });
  assert.equal(f.momoNetwork, 'MTN');
  assert.equal(f.plots, 0);
  // A supplier already on file becomes one too.
  var other = (await pool.query("INSERT INTO suppliers (name, phone) VALUES ('Zqty Farmer Ama', '0200006102') RETURNING id")).rows[0].id;
  var ama = await outgrowers.save(ctx.mgr, null, { supplierId: other, momoNumber: '0200006102' });
  assert.equal(ama.name, 'Zqty Farmer Ama');
  await assert.rejects(outgrowers.save(ctx.mgr, null, { supplierId: other }), /an outgrower already/);

  await assert.rejects(outgrowers.savePlot(ctx.mgr, f.id, null, { name: '' }), /Give the plot a name/);
  await assert.rejects(outgrowers.savePlot(ctx.mgr, f.id, null, { name: 'River plot', lat: 120 }), /latitude/);
  f = await outgrowers.savePlot(ctx.mgr, f.id, null, { name: 'River plot', place: 'Zqty river', lat: 6.7, lng: -1.6, hectares: 2.5, species: 'Bambusa vulgaris', cycleMonths: 12, nextHarvest: day(-30), expectedQty: 200 });
  f = await outgrowers.savePlot(ctx.mgr, f.id, null, { name: 'Hill plot', hectares: 1.5, cycleMonths: 6, nextHarvest: day(40), expectedQty: 120 });
  assert.equal(f.plots, 2);
  assert.equal(f.hectares, 4);
  assert.equal(f.overdue, true, 'the river plot was due a month ago');
  var river = f.plotList.find(function (p) { return p.name === 'River plot'; });
  assert.equal(river.lat, 6.7);

  var o = await outgrowers.overview(ctx.mgr);
  var mine = o.farmers.find(function (x) { return x.id === f.id; });
  assert.equal(mine.soonQty, 320);
  assert.equal(o.forecast.months.length, 6);
  assert.ok(o.forecast.months[0].qty >= 200 && o.forecast.months[0].late >= 1, 'the late harvest is still to come this month');
  assert.ok(o.overdue.some(function (p) { return p.id === river.id; }));

  // Money advanced.
  await assert.rejects(outgrowers.advance(ctx.staff, f.id, { amount: 300 }), /procurement\.approve/);
  await assert.rejects(outgrowers.advance(ctx.fin, f.id, { amount: 0 }), /How much was advanced/);
  f = await outgrowers.advance(ctx.fin, f.id, { amount: 300, method: 'mobile_money', reference: 'ZQ-ADV-1' });
  assert.equal(f.advanceLeft, 300);

  // A delivery taken in from the river plot: it moves the next harvest on.
  await assert.rejects(outgrowers.takeIn(ctx.fin, { farmerId: f.id, qty: 150 }), /production\.manage/);
  f = await outgrowers.takeIn(ctx.mgr, { farmerId: f.id, plotId: river.id, species: 'Bambusa vulgaris', qty: 150, unit: 'poles', grade: 'A', value: 900 });
  assert.match(f.batch.batchNo, /^RB-/);
  assert.equal(f.owed, 900);
  assert.equal(f.overdue, false);
  assert.ok(f.plotList.find(function (p) { return p.id === river.id; }).nextHarvest > day(300));

  // Paid: the advance comes off; Mobile Money needs its reference.
  await assert.rejects(outgrowers.pay(ctx.mgr, { batchId: f.batch.id, method: 'mobile_money' }), /transaction reference/);
  await assert.rejects(outgrowers.pay(ctx.mgr, { batchId: f.batch.id, advanceTaken: 500, reference: 'X' }), /Only GHS 300\.00 of advances/);
  f = await outgrowers.pay(ctx.fin, { batchId: f.batch.id, method: 'mobile_money', reference: 'ZQ-MOMO-77', text: true });
  assert.equal(f.texted, false, 'no texts on the test machine');
  assert.equal(f.payments.length, 1);
  assert.deepEqual([f.payments[0].amount, f.payments[0].advanceTaken, f.payments[0].paid, f.payments[0].momoNumber], [900, 300, 600, '0200006101']);
  assert.equal(f.advanceLeft, 0);
  assert.equal(f.owed, 0);
  await assert.rejects(outgrowers.pay(ctx.fin, { batchId: f.deliveries[0].id, reference: 'again' }), /paid already/);
  // A delivery from a supplier who is not an outgrower is not paid here.
  var other2 = (await pool.query("INSERT INTO suppliers (name) VALUES ('Zqty Timber Yard') RETURNING id")).rows[0].id;
  var rb = (await pool.query("INSERT INTO raw_batches (batch_no, species, supplier_id, date_received, quantity, received_qty, unit, cost) VALUES ('ZQTY-RB-1', 'Zqty', $1, current_date, 5, 5, 'poles', 50) RETURNING id", [other2])).rows[0].id;
  await assert.rejects(outgrowers.pay(ctx.fin, { batchId: rb, reference: 'x' }), /not from an outgrower/);

  var mf = await outgrowers.monthFigures(day(0).slice(0, 8) + '01', day(0));
  assert.ok(mf.paid >= 600 && mf.advanced >= 300);
});

test('power: generators and meters per site, a power cut with the generator run, fuel and top-ups, the litres an hour flagged once a week', async function () {
  await assert.rejects(power.overview(ctx.staff), /power\.manage/);
  await assert.rejects(power.saveSource(ctx.fin, null, { companyId: co.works, name: 'Zqty gen' }), /power\.manage/);
  await assert.rejects(power.saveSource(ctx.mgr, null, { companyId: co.works, name: '' }), /Give it a name/);
  var o = await power.saveSource(ctx.mgr, null, { companyId: co.works, kind: 'generator', name: 'Zqty Generator 1', kva: 60, fuel: 'diesel', tankLitres: 200, expectedLph: 5 });
  o = await power.saveSource(ctx.mgr, null, { companyId: co.works, kind: 'meter', name: 'Zqty prepaid meter', meterNo: 'ZQ-0001' });
  var site = o.sites.find(function (s) { return s.code === 'ZQTY'; });
  var gen = site.generators[0], meter = site.meters[0];
  assert.equal(gen.name, 'Zqty Generator 1');
  assert.equal(meter.name, 'Zqty prepaid meter');

  // The power went off ten hours ago; the generator started with it.
  await assert.rejects(power.outageStart(ctx.mgr, { companyId: co.works, at: hoursAgo(-2) }), /in the future/);
  o = await power.outageStart(ctx.mgr, { companyId: co.works, at: hoursAgo(10), generatorId: gen.id, note: 'ECG fault' });
  site = o.sites.find(function (s) { return s.code === 'ZQTY'; });
  assert.ok(site.off);
  assert.ok(site.generators[0].running);
  await assert.rejects(power.outageStart(ctx.mgr, { companyId: co.works }), /already off/);
  o = await power.outageEnd(ctx.mgr, site.off.id, {});
  site = o.sites.find(function (s) { return s.code === 'ZQTY'; });
  assert.equal(site.off, null);
  assert.equal(site.generators[0].running, null, 'the generator went off when the power came back');
  assert.ok(Math.abs(site.offHours - 10) < 0.2);
  assert.ok(Math.abs(site.generators[0].hours - 10) < 0.2);
  assert.ok(site.days[site.days.length - 1].off > 0 || site.days[site.days.length - 2].off > 0);

  // A run logged after the fact, by its hour meter.
  await power.saveSource(ctx.mgr, gen.id, { name: 'Zqty Generator 1', kva: 60, expectedLph: 5, hourMeter: 1000 });
  o = await power.runStart(ctx.mgr, { sourceId: gen.id, startedAt: hoursAgo(30), endedAt: hoursAgo(26), meterEnd: 1004 });
  site = o.sites.find(function (s) { return s.code === 'ZQTY'; });
  assert.ok(Math.abs(site.generators[0].hours - 14) < 0.2);
  assert.equal(site.generators[0].hourMeter, 1004);
  await assert.rejects(power.runStart(ctx.mgr, { sourceId: meter.id }), /a meter, not a generator/);

  // 112 litres for 14 hours: 8 an hour against 5 — flagged.
  o = await power.addFuel(ctx.mgr, { sourceId: gen.id, litres: 112, cost: 1680, vendor: 'Zqty fuel station' });
  site = o.sites.find(function (s) { return s.code === 'ZQTY'; });
  var g = site.generators[0];
  assert.equal(g.lph, 8);
  assert.equal(g.warn, 'high');
  assert.equal(g.overPct, 60);
  assert.equal(g.costPerHour, 120);
  assert.ok(o.warnings.some(function (w) { return w.id === gen.id; }));
  assert.ok((await alerts.powerAlerts(day(0), {})) >= 1);
  assert.ok((await notes(people.mgr)).some(function (n) { return n.title === 'Fuel use looks wrong: Zqty Generator 1'; }));
  assert.equal(await alerts.powerAlerts(day(0), {}), 0, 'once a week');

  // Prepaid top-ups; one entered by mistake taken off.
  o = await power.addTopup(ctx.mgr, { sourceId: meter.id, amount: 200, units: 150, reference: 'ZQ-TOKEN-1' });
  o = await power.addTopup(ctx.mgr, { sourceId: meter.id, amount: 999 });
  site = o.sites.find(function (s) { return s.code === 'ZQTY'; });
  assert.equal(site.meters[0].spent, 1199);
  var wrong = o.log.find(function (l) { return l.kind === 'topup' && l.amount === 999; });
  o = await power.remove(ctx.mgr, 'topup', wrong.id);
  site = o.sites.find(function (s) { return s.code === 'ZQTY'; });
  assert.equal(site.meters[0].spent, 200);
  assert.equal(site.meters[0].perUnit, 1.33);
  await assert.rejects(power.remove(ctx.mgr, 'nothing', wrong.id), /Nothing like that/);
  // The executive reads the log.
  assert.equal((await power.overview(ctx.exec)).canManage, false);

  var mf = await power.monthFigures(day(0).slice(0, 8) + '01', day(0));
  assert.ok(mf.fuelCost >= 1680 && mf.prepaid >= 200);
});

test('requests for quotes: sent to several suppliers, prices side by side with the cheapest, awarded into an order — a purchase request at Bamboo Products, a draft purchase order at a restaurant', async function () {
  var a = (await pool.query("INSERT INTO suppliers (name, phone, email) VALUES ('Zqty Supplies A', '0200006201', 'zqty.a@example.com') RETURNING id")).rows[0].id;
  var b = (await pool.query("INSERT INTO suppliers (name, phone) VALUES ('Zqty Supplies B', '0200006202') RETURNING id")).rows[0].id;
  await assert.rejects(rfqs.overview(ctx.staff), /procurement\.approve/);
  await assert.rejects(rfqs.create(ctx.mgr, { title: 'Zqty sanding', lines: [], supplierIds: [a] }), /Add what you want prices for/);
  await assert.rejects(rfqs.create(ctx.mgr, { title: 'Zqty sanding', lines: [{ name: 'Sandpaper', qty: 0 }], supplierIds: [a] }), /how many/);
  await assert.rejects(rfqs.create(ctx.mgr, { title: 'Zqty sanding', lines: [{ name: 'Sandpaper', qty: 10 }], supplierIds: [] }), /Pick the suppliers/);
  var r = await rfqs.create(ctx.mgr, { title: 'Zqty sanding', lines: [{ name: 'Sandpaper 120', qty: 100, unit: 'sheets' }, { name: 'Wood filler', qty: 4, unit: 'tins' }], supplierIds: [a, b], replyBy: day(2), neededBy: day(7) });
  assert.match(r.ref, /^RFQ-\d{4}$/);
  assert.equal(r.suppliers.length, 2);
  var sa = r.suppliers.find(function (s) { return s.supplierId === a; }), sb = r.suppliers.find(function (s) { return s.supplierId === b; });
  assert.match(sb.wa, /^https:\/\/wa\.me\/233200006202\?text=/);
  assert.match(sa.message, /Sandpaper 120 — 100 sheets/);

  // Sent by email (on the test outbox) and by WhatsApp.
  var outbox = [];
  mail.setTransportForTests({ sendMail: async function (m) { outbox.push(m); return { messageId: 'zqty' + outbox.length }; } });
  var sent = await rfqs.send(ctx.mgr, r.id, { rfqSupplierId: sa.id, via: 'email' });
  assert.equal(sent.sent, 'email');
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].subject, /request for a quote/);
  await assert.rejects(rfqs.send(ctx.mgr, r.id, { rfqSupplierId: sb.id, via: 'email' }), /no email address/);
  sent = await rfqs.send(ctx.mgr, r.id, { rfqSupplierId: sb.id, via: 'whatsapp' });
  assert.match(sent.wa, /wa\.me/);

  // Their prices: A all of it, B only the sandpaper (cheaper).
  var lines = r.lines;
  await assert.rejects(rfqs.quote(ctx.mgr, r.id, { rfqSupplierId: sa.id, prices: {} }), /at least one price/);
  r = await rfqs.quote(ctx.mgr, r.id, { rfqSupplierId: sa.id, prices: { [lines[0].id]: 2.5, [lines[1].id]: 60 }, deliveryDays: 3, validUntil: day(30) });
  r = await rfqs.quote(ctx.mgr, r.id, { rfqSupplierId: sb.id, prices: { [lines[0].id]: 2 }, deliveryDays: 1 });
  sa = r.suppliers.find(function (s) { return s.supplierId === a; }); sb = r.suppliers.find(function (s) { return s.supplierId === b; });
  assert.equal(sa.total, 490);
  assert.equal(sa.complete, true);
  assert.equal(sb.total, 200);
  assert.equal(sb.complete, false);
  assert.equal(sb.prices[0].cheapest, true);
  assert.equal(sa.prices[1].cheapest, true);
  assert.equal(r.cheapestId, sa.id, 'the cheapest that priced everything');
  await assert.rejects(rfqs.award(ctx.mgr, r.id, { rfqSupplierId: sb.id }), /has not priced Wood filler/);
  await assert.rejects(rfqs.award(ctx.staff, r.id, { rfqSupplierId: sa.id }), /not yours to see|procurement\.approve/);
  r = await rfqs.award(ctx.mgr, r.id, { rfqSupplierId: sa.id, note: 'Zqty: all of it from one' });
  assert.equal(r.status, 'awarded');
  var pr = (await pool.query("SELECT * FROM procurement_requests WHERE reason = $1", ['From ' + r.ref])).rows[0];
  assert.equal(pr.status, 'ordered');
  assert.equal(Number(pr.actual_cost), 490);
  assert.equal(pr.supplier_id, a);
  await assert.rejects(rfqs.quote(ctx.mgr, r.id, { rfqSupplierId: sb.id, prices: { [lines[1].id]: 50 } }), /closed/);

  // From an approved purchase request: it is ordered, and its requester told.
  var req = (await pool.query("INSERT INTO procurement_requests (requester_id, item, quantity, estimated_price, status, decided_by, decided_at) VALUES ($1, 'Zqty lacquer', 20, 900, 'approved', $2, now()) RETURNING id", [people.staff, people.mgr])).rows[0].id;
  var opts = await rfqs.options(ctx.mgr);
  assert.ok(opts.bpl.requests.some(function (x) { return x.id === req; }));
  var r2 = await rfqs.create(ctx.mgr, { requestId: req, title: 'Zqty lacquer', lines: [{ name: 'Lacquer', qty: 20, unit: 'litres' }], supplierIds: [a, b] });
  var s2 = r2.suppliers.find(function (s) { return s.supplierId === b; });
  r2 = await rfqs.quote(ctx.mgr, r2.id, { rfqSupplierId: s2.id, prices: { [r2.lines[0].id]: 40 } });
  r2 = await rfqs.quote(ctx.mgr, r2.id, { rfqSupplierId: r2.suppliers.find(function (s) { return s.supplierId === a; }).id, declined: true, note: 'out of stock' });
  assert.equal(r2.suppliers.find(function (s) { return s.supplierId === a; }).status, 'declined');
  r2 = await rfqs.award(ctx.fin, r2.id, { rfqSupplierId: s2.id });
  var reqRow = (await pool.query('SELECT * FROM procurement_requests WHERE id = $1', [req])).rows[0];
  assert.equal(reqRow.status, 'ordered');
  assert.equal(Number(reqRow.actual_cost), 800);
  assert.ok((await notes(people.staff)).some(function (n) { return n.title === 'Purchase ordered' && /Zqty Supplies B/.test(n.body); }));

  // A restaurant's: from its stock, into a draft purchase order.
  var ks = (await pool.query("INSERT INTO restaurant_suppliers (company_id, name, phone) VALUES ($1, 'Zqty Fresh Farm', '0200006301') RETURNING id", [co.kitchen])).rows[0].id;
  var ks2 = (await pool.query("INSERT INTO restaurant_suppliers (company_id, name, phone) VALUES ($1, 'Zqty Market', '0200006302') RETURNING id", [co.kitchen])).rows[0].id;
  var rice = (await pool.query("INSERT INTO restaurant_ingredients (company_id, name, unit, stock_qty, reorder_level, unit_cost, active) VALUES ($1, 'Zqty rice', 'kg', 2, 5, 12, true) RETURNING id", [co.kitchen])).rows[0].id;
  await assert.rejects(rfqs.create(ctx.fin, { kind: 'restaurant', companyId: co.kitchen, title: 'Zqty rice', lines: [{ type: 'ingredient', id: rice, qty: 50 }], supplierIds: [ks] }), /restaurant\.manage/);
  await assert.rejects(rfqs.create(ctx.kmgr, { kind: 'restaurant', companyId: co.kitchen, title: 'Zqty rice', lines: [{ name: 'Rice', qty: 50 }], supplierIds: [ks] }), /pick it from the restaurant/);
  var r3 = await rfqs.create(ctx.kmgr, { kind: 'restaurant', companyId: co.kitchen, title: 'Zqty rice for the month', lines: [{ type: 'ingredient', id: rice, qty: 50 }], supplierIds: [ks, ks2] });
  assert.equal(r3.company.code, 'ZQTZ');
  r3 = await rfqs.quote(ctx.kmgr, r3.id, { rfqSupplierId: r3.suppliers.find(function (s) { return s.supplierId === ks; }).id, prices: { [r3.lines[0].id]: 11 }, deliveryDays: 2 });
  r3 = await rfqs.quote(ctx.kmgr, r3.id, { rfqSupplierId: r3.suppliers.find(function (s) { return s.supplierId === ks2; }).id, prices: { [r3.lines[0].id]: 13 } });
  assert.equal(r3.spread, 100);
  r3 = await rfqs.award(ctx.kmgr, r3.id, { rfqSupplierId: r3.cheapestId });
  assert.match(r3.po.ref, /^PO-\d+$/);
  var po = (await pool.query('SELECT * FROM restaurant_purchase_orders WHERE id = $1', [r3.po.id])).rows[0];
  assert.equal(po.status, 'draft');
  assert.equal(po.supplier_id, ks);
  assert.equal(Number(po.total), 550);
  assert.equal((po.expected_on instanceof Date ? po.expected_on.toISOString() : String(po.expected_on)).slice(0, 10), day(2));

  var o = await rfqs.overview(ctx.mgr, { show: 'closed' });
  assert.ok(o.rfqs.some(function (x) { return x.id === r.id && x.awarded.name === 'Zqty Supplies A'; }));
  assert.ok(o.summary.awardedMonth >= 2);
  // A restaurant's request is not Bamboo Products' to see.
  assert.ok(!(await rfqs.overview(ctx.fin, { show: 'closed' })).rfqs.some(function (x) { return x.id === r3.id; }));
  // Cancelled.
  var r4 = await rfqs.create(ctx.mgr, { title: 'Zqty screws', lines: [{ name: 'Screws', qty: 500 }], supplierIds: [a] });
  await assert.rejects(rfqs.cancel(ctx.mgr, r4.id, {}), /Why is it cancelled/);
  r4 = await rfqs.cancel(ctx.mgr, r4.id, { reason: 'bought at the market' });
  assert.equal(r4.status, 'cancelled');
});

test('the monthly management report: the figures, a PDF, emailed to the owners, and on its own on the 1st — once', async function () {
  await assert.rejects(report.view(ctx.staff, {}), /report\.read/);
  await assert.rejects(report.view(ctx.exec, { month: '2099-01' }), /has not begun/);
  var month = day(0).slice(0, 7);
  var v = await report.view(ctx.exec, { month: month });
  assert.equal(v.month, month);
  assert.ok(Array.isArray(v.sales.companies));
  assert.ok(v.sales.companies.some(function (s) { return s.code === 'BPL'; }));
  assert.ok(v.power.fuelCost >= 1680, 'the power log is in it');
  assert.ok(v.stock.jobs.good >= 2, 'the production jobs are in it');
  assert.ok(v.stock.outgrowers.paid >= 600, 'the outgrowers are in it');
  assert.equal(v.months.length, 12);

  var p = await report.pdf(ctx.exec, { month: month });
  assert.equal(p.buffer.slice(0, 5).toString('latin1'), '%PDF-');
  assert.ok(p.buffer.length > 3000);

  var outbox = [];
  mail.setTransportForTests({ sendMail: async function (m) { outbox.push(m); return { messageId: 'zqty-r' + outbox.length }; } });
  await assert.rejects(report.saveSettings(ctx.staff, { recipients: ['zqty.owner@example.com'] }), /report\.manage/);
  await assert.rejects(report.saveSettings(ctx.fin, { recipients: ['not an email'] }), /not an email address/);
  await assert.rejects(report.saveSettings(ctx.fin, { recipients: [], autoSend: true }), /Add who it goes to/);
  v = await report.saveSettings(ctx.fin, { recipients: 'zqty.owner@example.com, zqty.partner@example.com', autoSend: true });
  assert.deepEqual(v.settings, { recipients: ['zqty.owner@example.com', 'zqty.partner@example.com'], autoSend: true });

  v = await report.send(ctx.exec, { month: month });
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0].attachments[0].contentType, 'application/pdf');
  assert.match(outbox[0].subject, /^Management report — /);
  assert.ok(v.sent.some(function (s) { return s.month === month && /zqty\.owner/.test(s.to); }));

  // On the 1st, the month just ended goes on its own — once; not after the 3rd.
  var next = new Date(Date.parse(month + '-01T00:00:00Z'));
  next.setUTCMonth(next.getUTCMonth() + 1);
  var first = next.toISOString().slice(0, 10);
  await pool.query('DELETE FROM management_reports WHERE month = $1', [month]);
  outbox.length = 0;
  assert.equal(await report.autoSend(first.slice(0, 8) + '05'), 0, 'not after the 3rd');
  assert.equal(await report.autoSend(first), 2);
  assert.equal(outbox.length, 2);
  assert.equal(await report.autoSend(first), 0, 'once');
  var row = (await pool.query('SELECT * FROM management_reports WHERE month = $1', [month])).rows[0];
  assert.equal(row.auto, true);
  await pool.query('DELETE FROM management_reports WHERE month = $1', [month]);
});
