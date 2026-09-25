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

  var r = await recurring.run(null, { asOf: '2035-03-15' });
  var mine = r.invoices.filter(function (i) { return i.bookingNo === booking.bookingNo; });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].amount, 1200); // Jan–Mar of 300 and 100
  var inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [mine[0].invoiceId])).rows[0];
  assert.equal(inv.doc_kind, 'other'); // CAM and utility together
  assert.equal(String(inv.period_start).slice(0, 10), '2035-01-01');
  assert.equal(String(inv.period_end).slice(0, 10), '2035-03-31');
  assert.equal((await linesOf(inv.id)).length, 6);

  var again = await recurring.run(null, { asOf: '2035-03-15' });
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
  var r = await recurring.run(null, { asOf: '2035-05-20' });
  var inv = r.invoices.find(function (i) { return i.bookingNo === booking.bookingNo; });
  var lines = (await linesOf(inv.invoiceId)).filter(function (l) { return /Car park/.test(l.description); });
  assert.deepEqual(lines.map(function (l) { return l.price; }), [310, 150]); // May 1–15: 310 × 15/31
  assert.match(lines[1].notes, /part period: 15 of 31 days/);
  var row = (await recurring.list(kelvin)).find(function (x) { return x.id === c.id; });
  assert.equal(row.status, 'ended');

  // The CAM charge runs to the booking's end (30 June) and then stops.
  await recurring.run(null, { asOf: '2035-07-10' });
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
