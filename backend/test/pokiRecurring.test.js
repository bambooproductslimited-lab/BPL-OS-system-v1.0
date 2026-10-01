/*
 * Recurring Poki charges (CAM, flat utility fees): billed in advance on
 * their date, several due together on one invoice, missed periods caught up,
 * never billed twice, the last period cut at the charge's or booking's end
 * and charged pro rata, pause skips what passed, and a billed charge can
 * only be ended, not deleted. Test data is marked RCTEST, in 2035.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var recurring = require('../src/services/pokiRecurring.service');
var { buildContext } = require('../src/services/context.service');

var MARK = 'RCTEST';
var server, base, token, kelvin, alice, booking;

async function call(method, path, body) {
  var opts = { method: method, headers: { Authorization: 'Bearer ' + token } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  var res = await fetch(base + path, opts);
  return { status: res.status, body: await res.json().catch(function () { return null; }) };
}
test.before(async function () {
  server = app.listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  token = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'kelvin.duho@bplghana.com', password: 'bamboo123' }) })).json()).token;
  kelvin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  alice = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'alice.kamau@bplghana.com'")).rows[0].id);
  var prop = await call('POST', '/api/poki/properties', { name: MARK + ' Court', code: MARK + 'P', address: '1 Test Road' });
  var unit = await call('POST', '/api/poki/units', { propertyId: prop.body.id, code: MARK + '-A1', name: 'Shop A1', unitType: 'shop', baseRent: 2000, currency: 'GHS' });
  var tenant = await call('POST', '/api/poki/tenants', { name: MARK + ' Tenant', email: 'rctest@example.com', phone: '0200000001' });
  var b = await call('POST', '/api/poki/bookings', { unitId: unit.body.id, tenantId: tenant.body.id, startDate: '2035-01-01', durationMonths: 6, durationDays: 0, depositAmount: 0, status: 'active', notes: MARK });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  booking = b.body;
});
test.after(async function () {
  if (server) server.close();
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE poki_booking_id IN (SELECT id FROM poki_bookings WHERE notes LIKE '%" + MARK + "%'))");
  await pool.query("DELETE FROM poki_recurring_charges WHERE booking_id IN (SELECT id FROM poki_bookings WHERE notes LIKE '%" + MARK + "%')");
  await pool.query("DELETE FROM invoices WHERE poki_booking_id IN (SELECT id FROM poki_bookings WHERE notes LIKE '%" + MARK + "%')");
  await pool.query("DELETE FROM poki_bookings WHERE notes LIKE '%" + MARK + "%'");
  await pool.query("DELETE FROM poki_units WHERE code LIKE '" + MARK + "%'");
  await pool.query("DELETE FROM poki_tenants WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE '%" + MARK + "%')");
  await pool.query("DELETE FROM customers WHERE name LIKE '%" + MARK + "%'");
  await pool.query("DELETE FROM poki_properties WHERE name LIKE '%" + MARK + "%'");
  await pool.end();
});
async function linesOf(invoiceId) {
  return (await pool.query("SELECT description, notes, unit_price::float AS price FROM document_line_items WHERE document_type = 'invoice' AND document_id = $1 ORDER BY sort_order", [invoiceId])).rows;
}

test('charges due together go on one invoice, missed periods are caught up, and nothing is billed twice', async function () {
  var cam = await call('POST', '/api/poki/recurring-charges', { bookingId: booking.id, kind: 'cam', amount: 300, frequency: 'monthly', startDate: '2035-01-01', netDays: 10 });
  assert.equal(cam.status, 201, JSON.stringify(cam.body));
  assert.equal(cam.body.description, 'Service charge (CAM)');
  var water = await recurring.create(kelvin, { bookingId: booking.id, kind: 'utility', description: 'Water (flat)', amount: 100, frequency: 'monthly', startDate: '2035-01-01' });

  var r = await recurring.run(kelvin, { asOf: '2035-03-15' });
  var mine = r.invoices.filter(function (i) { return i.bookingNo === booking.bookingNo; });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].amount, 1200); // Jan–Mar of 300 and 100
  var inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [mine[0].invoiceId])).rows[0];
  assert.equal(inv.doc_kind, 'other'); // CAM and utility together
  assert.equal(String(inv.period_start).slice(0, 10), '2035-01-01');
  assert.equal(String(inv.period_end).slice(0, 10), '2035-03-31');
  assert.equal((await linesOf(inv.id)).length, 6);

  var again = await recurring.run(kelvin, { asOf: '2035-03-15' });
  assert.equal(again.invoices.filter(function (i) { return i.bookingNo === booking.bookingNo; }).length, 0);
  var list = (await call('GET', '/api/poki/recurring-charges')).body.filter(function (c) { return c.bookingId === booking.id; });
  var camRow = list.find(function (c) { return c.kind === 'cam'; });
  assert.equal(camRow.nextDate, '2035-04-01');
  assert.equal(camRow.periodsBilled, 3);
  assert.equal(camRow.billedTotal, 900);
  assert.equal(camRow.lastInvoice.invoiceNo, mine[0].invoiceNo);

  // Bill the next CAM period early: April, on its own invoice, due in 10 days.
  var early = await call('POST', '/api/poki/recurring-charges/' + cam.body.id + '/bill-now');
  assert.equal(early.status, 200, JSON.stringify(early.body));
  assert.equal(early.body.invoices[0].amount, 300);
  var aprInv = (await pool.query('SELECT doc_kind, period_start FROM invoices WHERE id = $1', [early.body.invoices[0].invoiceId])).rows[0];
  assert.equal(aprInv.doc_kind, 'cam');
  assert.equal(String(aprInv.period_start).slice(0, 10), '2035-04-01');

  // A billed charge can't be deleted, only ended.
  var del = await call('DELETE', '/api/poki/recurring-charges/' + water.id);
  assert.equal(del.status, 409);
  await recurring.setStatus(kelvin, water.id, 'ended');
});

test('the last period is cut at the end date and charged pro rata; the booking end stops a charge', async function () {
  var c = await recurring.create(kelvin, { bookingId: booking.id, kind: 'cam', description: RC('Car park'), amount: 310, frequency: 'monthly', startDate: '2035-04-01', endDate: '2035-05-15' });
  var r = await recurring.run(kelvin, { asOf: '2035-05-20' });
  var inv = r.invoices.find(function (i) { return i.bookingNo === booking.bookingNo; });
  var lines = (await linesOf(inv.invoiceId)).filter(function (l) { return /Car park/.test(l.description); });
  assert.deepEqual(lines.map(function (l) { return l.price; }), [310, 150]); // May 1–15: 310 × 15/31
  assert.match(lines[1].notes, /Part period: 15 of 31 days/);
  assert.match(lines[1].notes, /× 15 ÷ 31 = GHS/, 'the pro rata sum is written out');
  var row = (await recurring.list(kelvin)).find(function (x) { return x.id === c.id; });
  assert.equal(row.status, 'ended');

  // The CAM charge runs to the booking's end (30 June) and then stops.
  await recurring.run(kelvin, { asOf: '2035-07-10' });
  var cam = (await recurring.list(kelvin)).find(function (x) { return x.bookingId === booking.id && x.description === 'Service charge (CAM)'; });
  assert.equal(cam.status, 'ended');
  assert.equal(cam.lastPeriod.end, '2035-06-30');
});

test('pause skips what passed; checks and permissions', async function () {
  var q = await recurring.create(kelvin, { bookingId: booking.id, kind: 'other', description: RC('Signage'), amount: 90, frequency: 'quarterly', startDate: '2035-01-01' });
  await recurring.setStatus(kelvin, q.id, 'paused');
  var res = await recurring.setStatus(kelvin, q.id, 'active');
  assert.ok(res.nextDate >= new Date().toISOString().slice(0, 10) || res.nextDate > '2035-01-01');
  await assert.rejects(recurring.create(kelvin, { bookingId: booking.id, kind: 'cam', amount: 0 }), /more than zero/);
  await assert.rejects(recurring.create(kelvin, { bookingId: booking.id, kind: 'cam', amount: 10, startDate: '2036-01-01' }), /after the booking ends/);
  await assert.rejects(recurring.update(kelvin, q.id, { netDays: 120 }), /0 to 90/);
  await assert.rejects(recurring.create(alice, { bookingId: booking.id, kind: 'cam', amount: 10 }), /poki.manage/);
  var fresh = await recurring.create(kelvin, { bookingId: booking.id, kind: 'cam', description: RC('Temp'), amount: 5, startDate: '2035-06-01' });
  assert.equal((await call('DELETE', '/api/poki/recurring-charges/' + fresh.id)).status, 200);
});

function RC(s) { return s + ' ' + MARK; }

test('nothing is billed by itself: the morning job leaves due charges for a person to bill', async function () {
  var job = require('../src/jobs/dailyAlerts');
  var before = (await pool.query('SELECT count(*)::int AS n FROM poki_recurring_charge_runs')).rows[0].n;
  var out = await job.runOnce(new Date(Date.UTC(2035, 11, 31, 9, 0)));
  assert.equal(out.recurring, undefined, 'the job has no recurring billing any more');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM poki_recurring_charge_runs')).rows[0].n, before, 'no period billed');
  await assert.rejects(recurring.run(null, {}), /billed by a person, never automatically/);
});

// ── Billing meter readings with the tenant's recurring charges ─────────
// One invoice per tenant with every ticked meter on it, and the tenant's
// recurring charges (the month's CAM, a flat fee) on the same invoice when
// chosen — billed once, so "Bill what is due" doesn't bill them again.
// Here, not in a file of its own, so it never runs alongside the 2035 runs
// above (they bill every charge due by then). Test data is marked RBTEST,
// dated around today.
var RB = 'RBTEST';
var rbBooking, other, elec, water, otherMeter, cam, flat, rbInvoice;
var { todayISO } = require('../src/utils/documents');
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function ok(method, path, body) {
  var r = await call(method, path, body);
  assert.ok(r.status < 300, path + ' ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body;
}
async function cleanupReadings() {
  var bk = "(SELECT id FROM poki_bookings WHERE notes LIKE '%" + RB + "%')";
  var inv = '(SELECT id FROM invoices WHERE poki_booking_id IN ' + bk + ')';
  await pool.query("DELETE FROM poki_meter_readings WHERE meter_id IN (SELECT m.id FROM poki_meters m JOIN poki_units u ON u.id = m.unit_id WHERE u.code LIKE '" + RB + "%')");
  await pool.query("DELETE FROM poki_meters WHERE unit_id IN (SELECT id FROM poki_units WHERE code LIKE '" + RB + "%')");
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN " + inv);
  await pool.query('DELETE FROM poki_recurring_charges WHERE booking_id IN ' + bk);
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query('DELETE FROM poki_bookings WHERE id IN ' + bk);
  await pool.query("DELETE FROM poki_units WHERE code LIKE '" + RB + "%'");
  await pool.query("DELETE FROM poki_tenants WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE '%" + RB + "%')");
  await pool.query("DELETE FROM customers WHERE name LIKE '%" + RB + "%'");
  await pool.query("DELETE FROM poki_properties WHERE name LIKE '%" + RB + "%'");
}

async function setupReadings() {
  await cleanupReadings();
  var today = todayISO();
  var prop = await ok('POST', '/api/poki/properties', { name: RB + ' Court', code: RB + 'P', address: '1 Test Road' });
  async function rentOut(code, name) {
    var unit = await ok('POST', '/api/poki/units', { propertyId: prop.id, code: RB + '-' + code, name: 'Shop ' + code, unitType: 'shop', baseRent: 2000, currency: 'GHS' });
    var tenant = await ok('POST', '/api/poki/tenants', { name: RB + ' ' + name, email: code.toLowerCase() + '@example.com', phone: '02000000' + code.length });
    var b = await ok('POST', '/api/poki/bookings', { unitId: unit.id, tenantId: tenant.id, startDate: addDays(today, -20), durationMonths: 6, durationDays: 0, depositAmount: 0, status: 'active', notes: RB });
    return { unit: unit, booking: b };
  }
  var a = await rentOut('7B', 'Paint Shop');
  var o = await rentOut('8C', 'Auto Parts');
  rbBooking = a.booking; other = o.booking;
  elec = await ok('POST', '/api/poki/meters', { unitId: a.unit.id, utilityType: 'electricity', measureUnit: 'kWh', rate: 2 });
  water = await ok('POST', '/api/poki/meters', { unitId: a.unit.id, utilityType: 'water', measureUnit: 'm³', rate: 10 });
  otherMeter = await ok('POST', '/api/poki/meters', { unitId: o.unit.id, utilityType: 'electricity', measureUnit: 'kWh', rate: 2 });
  // CAM came due ten days ago; a flat fee starts in five days.
  cam = await ok('POST', '/api/poki/recurring-charges', { bookingId: rbBooking.id, kind: 'cam', amount: 300, frequency: 'monthly', startDate: addDays(today, -10), netDays: 7 });
  flat = await ok('POST', '/api/poki/recurring-charges', { bookingId: rbBooking.id, kind: 'utility', description: 'Refuse collection', amount: 50, frequency: 'monthly', startDate: addDays(today, 5) });
}

test('readings: a tenant\'s meters and their CAM go on one invoice, and the CAM is not billed again', async function () {
  await setupReadings();
  var today = todayISO();
  var r1 = await ok('POST', '/api/poki/readings', { meterId: elec.id, periodStart: addDays(today, -30), periodEnd: today, previousReading: 1000, currentReading: 1100 });
  var r2 = await ok('POST', '/api/poki/readings', { meterId: water.id, periodStart: addDays(today, -30), periodEnd: today, previousReading: 0, currentReading: 12 });
  var r3 = await ok('POST', '/api/poki/readings', { meterId: otherMeter.id, periodStart: addDays(today, -30), periodEnd: today, previousReading: 0, currentReading: 40 });

  // The preview: one group per tenant, with what could go on the same invoice.
  var pv = await ok('POST', '/api/poki/readings/bill/preview', { readingIds: [r1.id, r2.id, r3.id] });
  var mine = pv.groups.find(function (g) { return g.bookingId === rbBooking.id; });
  assert.equal(pv.groups.length, 2);
  assert.deepEqual(mine.readings.map(function (r) { return r.utilityType; }).sort(), ['electricity', 'water']);
  var offerCam = mine.charges.find(function (c) { return c.id === cam.id; });
  assert.ok(offerCam.due, 'the CAM has come due');
  assert.equal(offerCam.amount, 300);
  var offerFlat = mine.charges.find(function (c) { return c.id === flat.id; });
  assert.equal(offerFlat.due, false, 'the flat fee is offered early');
  assert.equal(offerFlat.periods[0].start, addDays(today, 5));
  assert.equal(pv.groups.find(function (g) { return g.bookingId === other.id; }).charges.length, 0);

  // A charge can't go on another tenant's invoice.
  var wrong = await call('POST', '/api/poki/readings/bill', { readingIds: [r3.id], chargeIds: [cam.id] });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error.message || wrong.body.error, /own tenant/);

  // Bill all three readings with 7B's CAM.
  var res = await ok('POST', '/api/poki/readings/bill', { readingIds: [r1.id, r2.id, r3.id], chargeIds: [cam.id] });
  assert.equal(res.created, 2, 'one invoice per tenant');
  var inv7 = res.invoices.find(function (i) { return /Paint Shop/.test(i.tenantName); });
  assert.equal(inv7.amount, 200 + 120 + 300);
  assert.equal(inv7.charges, 1);
  var row = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv7.invoiceId])).rows[0];
  assert.equal(row.doc_kind, 'other', 'utilities and CAM together');
  assert.equal(String(row.due_date).slice(0, 10), addDays(today, 7), 'due by the shorter of the two');
  var lines = (await pool.query("SELECT description FROM document_line_items WHERE document_type = 'invoice' AND document_id = $1 ORDER BY sort_order", [inv7.invoiceId])).rows.map(function (l) { return l.description; });
  assert.deepEqual(lines, ['Electricity — ' + RB + '-7B', 'Water — ' + RB + '-7B', 'Service charge (CAM) — ' + RB + '-7B']);
  rbInvoice = inv7;
  // The working is written under each line.
  var notes = (await pool.query("SELECT notes FROM document_line_items WHERE document_type = 'invoice' AND document_id = $1 ORDER BY sort_order", [inv7.invoiceId])).rows.map(function (l) { return l.notes; });
  assert.match(notes[0], /Reading 1,100 – last reading 1,000 = 100 kWh used/);
  assert.match(notes[0], /100 kWh × GHS 2\.00 per kWh = GHS 200\.00/);
  assert.match(notes[1], /12 m³ × GHS 10\.00 per m³ = GHS 120\.00/);
  assert.match(notes[2], /\(monthly\)/);
  var inv8 = res.invoices.find(function (i) { return /Auto Parts/.test(i.tenantName); });
  assert.equal((await pool.query('SELECT doc_kind FROM invoices WHERE id = $1', [inv8.invoiceId])).rows[0].doc_kind, 'utility');

  // The CAM's period is billed: its next date moved on, its run points at the invoice.
  var list = (await ok('GET', '/api/poki/recurring-charges')).filter(function (c) { return c.bookingId === rbBooking.id; });
  var camRow = list.find(function (c) { return c.id === cam.id; });
  assert.equal(camRow.periodsBilled, 1);
  assert.equal(camRow.lastInvoice.invoiceNo, inv7.invoiceNo);
  assert.ok(camRow.nextDate > today);
  var run = await ok('POST', '/api/poki/recurring-charges/run');
  assert.equal(run.invoices.filter(function (i) { return i.bookingNo === rbBooking.bookingNo; }).length, 0, 'Bill what is due finds nothing left for 7B');

  // Readings already billed can't be billed again.
  var again = await call('POST', '/api/poki/readings/bill', { readingIds: [r1.id] });
  assert.equal(again.status, 409);
});

test('readings: the flat fee, billed early with a reading, moves on one period', async function () {
  var today = todayISO();
  var r = await ok('POST', '/api/poki/readings', { meterId: elec.id, periodStart: today, periodEnd: today, currentReading: 1110 });
  var res = await ok('POST', '/api/poki/readings/bill', { readingIds: [r.id], chargeIds: [flat.id] });
  assert.equal(res.invoices[0].amount, 20 + 50);
  var row = (await ok('GET', '/api/poki/recurring-charges')).find(function (c) { return c.id === flat.id; });
  assert.equal(row.periodsBilled, 1);
  // Billed already: offering it again is the period after.
  var r2 = await ok('POST', '/api/poki/readings', { meterId: elec.id, periodStart: today, periodEnd: today, currentReading: 1111 });
  var pv = await ok('POST', '/api/poki/readings/bill/preview', { readingIds: [r2.id] });
  assert.equal(pv.groups[0].charges.find(function (c) { return c.id === flat.id; }).periods[0].start, row.nextDate);
});

test('readings: a bill can be changed after it is raised, but not below what is paid', async function () {
  var full = await ok('GET', '/api/poki/invoices/' + rbInvoice.invoiceId);
  var items = full.items.map(function (it) { return Object.assign({}, it); });
  items[0].qty = 90; // the electricity meter was misread
  items[0].notes = items[0].notes.replace('1,100', '1,090').replace('= 100 kWh', '= 90 kWh').replace('100 kWh ×', '90 kWh ×').replace('GHS 200.00', 'GHS 180.00');
  items.push({ description: 'Late fee', qty: 1, unitPrice: 15, notes: '' });
  var changed = await ok('PUT', '/api/poki/invoices/' + rbInvoice.invoiceId, { items: items, dueDate: addDays(todayISO(), 21), notes: 'Corrected electricity reading.' });
  assert.equal(changed.grandTotal, 180 + 120 + 300 + 15);
  assert.equal(changed.balanceDue, 615);
  assert.equal(changed.invoiceNo, rbInvoice.invoiceNo, 'keeps its number');
  assert.equal(changed.items.length, 4);
  assert.match(changed.items[0].notes, /90 kWh × GHS 2\.00/);
  assert.equal(String(changed.dueDate).slice(0, 10), addDays(todayISO(), 21));

  // Paid 500: it can't go below that.
  await ok('POST', '/api/poki/invoices/' + rbInvoice.invoiceId + '/payments', { amount: 500, method: 'cash' });
  var low = await call('PUT', '/api/poki/invoices/' + rbInvoice.invoiceId, { items: [{ description: 'Electricity', qty: 1, unitPrice: 100 }] });
  assert.equal(low.status, 400);
  assert.match(JSON.stringify(low.body), /credit note/);
  var up = await ok('PUT', '/api/poki/invoices/' + rbInvoice.invoiceId, { items: changed.items.slice(0, 3) });
  assert.equal(up.grandTotal, 600);
  assert.equal(up.balanceDue, 100);
  assert.equal(up.status, 'partially_paid');

  // A rent invoice follows its booking; a Bamboo Products invoice isn't Poki's.
  var rent = (await pool.query("SELECT id FROM invoices WHERE poki_booking_id = $1 AND doc_kind = 'rent' LIMIT 1", [rbBooking.id])).rows[0];
  if (rent) {
    var r = await call('PUT', '/api/poki/invoices/' + rent.id, { notes: 'x' });
    assert.equal(r.status, 409);
    assert.match(JSON.stringify(r.body), /Change the booking/);
  }
  var bpl = (await pool.query('SELECT id FROM invoices WHERE company_id IS NULL LIMIT 1')).rows[0];
  if (bpl) assert.equal((await call('PUT', '/api/poki/invoices/' + bpl.id, { notes: 'x' })).status, 404);
});

test('readings: a bill raised by mistake is voided and everything on it can be billed again; a wrong reading is deleted', async function () {
  var today = todayISO();
  var r = await ok('POST', '/api/poki/readings', { meterId: water.id, periodStart: today, periodEnd: today, currentReading: 20 });
  var camBefore = (await ok('GET', '/api/poki/recurring-charges')).find(function (c) { return c.id === cam.id; });
  var pv = await ok('POST', '/api/poki/readings/bill/preview', { readingIds: [r.id] });
  var res = await ok('POST', '/api/poki/readings/bill', { readingIds: [r.id], chargeIds: [cam.id] });
  var id = res.invoices[0].invoiceId;
  assert.equal((await ok('GET', '/api/poki/recurring-charges')).find(function (c) { return c.id === cam.id; }).periodsBilled, camBefore.periodsBilled + 1);

  // On a bill: can't be deleted.
  var del = await call('DELETE', '/api/poki/readings/' + r.id);
  assert.equal(del.status, 409);
  assert.match(JSON.stringify(del.body), /Void that invoice first/);

  var v = await ok('POST', '/api/poki/invoices/' + id + '/void');
  assert.deepEqual(v.released, { readings: 1, periods: 1 });
  assert.equal((await pool.query('SELECT invoice_id FROM poki_meter_readings WHERE id = $1', [r.id])).rows[0].invoice_id, null, 'the reading is not billed again');
  var camAfter = (await ok('GET', '/api/poki/recurring-charges')).find(function (c) { return c.id === cam.id; });
  assert.equal(camAfter.periodsBilled, camBefore.periodsBilled);
  assert.equal(camAfter.nextDate, camBefore.nextDate, 'the CAM period is billable again');
  var pv2 = await ok('POST', '/api/poki/readings/bill/preview', { readingIds: [r.id] });
  assert.deepEqual(pv2.groups[0].charges.find(function (c) { return c.id === cam.id; }).periods, pv.groups[0].charges.find(function (c) { return c.id === cam.id; }).periods);

  // Now the wrong reading can go; the meter's last reading is the one before it.
  await ok('DELETE', '/api/poki/readings/' + r.id);
  var meter = (await ok('GET', '/api/poki/meters')).find(function (m) { return m.id === water.id; });
  assert.equal(meter.lastReading, 12);

  // A reading left on a bill voided before voiding released it (as the old
  // code did) can still be deleted.
  var r2 = await ok('POST', '/api/poki/readings', { meterId: water.id, periodStart: today, periodEnd: today, currentReading: 30 });
  var b2 = await ok('POST', '/api/poki/readings/bill', { readingIds: [r2.id] });
  await pool.query("UPDATE invoices SET status = 'void' WHERE id = $1", [b2.invoices[0].invoiceId]);
  await ok('DELETE', '/api/poki/readings/' + r2.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM poki_meter_readings WHERE id = $1', [r2.id])).rows[0].n, 0);
  await cleanupReadings();
});
