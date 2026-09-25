// Poki overview: what was billed and collected by month, vacant units and
// how long they have stood empty, move-ins coming up, deposits held, and the
// tenant's phone on the arrears list. Other test files use the Poki company
// too, so this checks its own records rather than totals.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var poki = require('../src/services/poki.service');
var billing = require('../src/services/pokiBilling.service');
var pokiInvoices = require('../src/services/pokiInvoices.service');
var { buildContext } = require('../src/services/context.service');

var MARK = 'ZQPO';
var boss;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
});
test.after(async function () {
  await pool.query("DELETE FROM payments WHERE invoice_id IN (SELECT i.id FROM invoices i JOIN poki_bookings b ON b.id = i.poki_booking_id WHERE b.notes = $1)", [MARK]);
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT i.id FROM invoices i JOIN poki_bookings b ON b.id = i.poki_booking_id WHERE b.notes = $1)", [MARK]).catch(function () {});
  await pool.query("DELETE FROM invoices WHERE poki_booking_id IN (SELECT id FROM poki_bookings WHERE notes = $1)", [MARK]);
  await pool.query('DELETE FROM poki_bookings WHERE notes = $1', [MARK]);
  await pool.query("DELETE FROM poki_units WHERE code LIKE $1", [MARK + '%']);
  await pool.query("DELETE FROM poki_tenants WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE $1)", [MARK + '%']);
  await pool.query("DELETE FROM customers WHERE name LIKE $1", [MARK + '%']);
  await pool.query("DELETE FROM poki_properties WHERE code LIKE $1", [MARK + '%']);
  await pool.end();
});

test('vacant units say since when; a move-in coming up, money billed and collected, and deposits held all show', async function () {
  var prop = await poki.createProperty(boss, { name: MARK + ' Court', code: MARK + '1' });
  var never = await poki.createUnit(boss, { propertyId: prop.id, code: MARK + '-A', baseRent: 1500 });
  var left = await poki.createUnit(boss, { propertyId: prop.id, code: MARK + '-B', baseRent: 2000 });
  var coming = await poki.createUnit(boss, { propertyId: prop.id, code: MARK + '-C', baseRent: 1800 });
  var tenant = await poki.createTenant(boss, { name: MARK + ' Tenant', phone: '0240000099' });

  // a tenancy on B that was ended 40 days ago
  await pool.query(
    "INSERT INTO poki_bookings (booking_no, unit_id, tenant_id, start_date, end_date, duration_months, duration_days, monthly_rate, rent_total, status, terminated_on, notes) " +
    "VALUES ($1,$2,$3,$4,$5,6,0,2000,12000,'terminated',$6,$7)",
    [MARK + '-OLD', left.id, tenant.id, day(-200), day(-20), day(-40), MARK]);

  var b = await poki.createBooking(boss, { unitId: coming.id, tenantId: tenant.id, startDate: day(10), durationMonths: 3, depositAmount: 1800, status: 'draft', notes: MARK });
  var inv = (await pool.query('SELECT id, grand_total FROM invoices WHERE poki_booking_id = $1', [b.id])).rows[0];
  assert.ok(inv, 'the booking raised its invoice');
  await pokiInvoices.recordPayment(boss, inv.id, { amount: 2000, method: 'cash', date: day(0) });

  var o = await poki.overview(boss);
  var a = o.vacantUnits.find(function (u) { return u.id === never.id; });
  var bb = o.vacantUnits.find(function (u) { return u.id === left.id; });
  assert.deepEqual([a.vacantSince, a.daysVacant, a.timesLet], [day(0), 0, 0]);
  assert.deepEqual([bb.vacantSince, bb.daysVacant, bb.timesLet, bb.baseRent], [day(-40), 40, 1, 2000]);
  assert.ok(o.upcomingBookings.some(function (x) { return x.id === b.id; }), 'the move-in in 10 days is listed');

  assert.equal(o.months.length, 12);
  assert.equal(o.months[11], day(0).slice(0, 7));
  var thisMonth = function (rows) { return rows.filter(function (r) { return r.month === day(0).slice(0, 7) && r.currency === 'GHS'; }).reduce(function (s, r) { return s + r.amount; }, 0); };
  assert.ok(thisMonth(o.billedByMonth) >= Number(inv.grand_total), 'this month\'s billing includes the booking invoice');
  assert.ok(thisMonth(o.collectedByMonth) >= 2000, 'and the 2000 paid against it');

  // settle it: the deposit is then held and counted
  var rest = Number(inv.grand_total) - 2000;
  await pokiInvoices.recordPayment(boss, inv.id, { amount: rest, method: 'cash', date: day(0) });
  var o2 = await poki.overview(boss);
  var held = o2.depositsHeld.find(function (d) { return d.currency === 'GHS'; });
  assert.ok(held && held.amount >= 1800, 'the deposit collected with the invoice is held');
});

test('the arrears list carries the tenant\'s phone so they can be called', async function () {
  var prop = await poki.createProperty(boss, { name: MARK + ' Lodge', code: MARK + '2' });
  var unit = await poki.createUnit(boss, { propertyId: prop.id, code: MARK + '-D', baseRent: 900 });
  var tenant = await poki.createTenant(boss, { name: MARK + ' Debtor', phone: '0240000098' });
  var b = await poki.createBooking(boss, { unitId: unit.id, tenantId: tenant.id, startDate: day(40), durationMonths: 1, status: 'draft', notes: MARK });
  var arrears = await billing.arrears(boss);
  var row = arrears.rows.find(function (r) { return r.bookingNo === b.bookingNo; });
  assert.ok(row, 'the unpaid booking invoice is in arrears');
  assert.deepEqual([row.tenantName, row.tenantPhone], [MARK + ' Debtor', '0240000098']);
});

test('a unit says when it was last let, when its next booking starts, who is in it and how many repairs are open', async function () {
  var prop = await poki.createProperty(boss, { name: MARK + ' Terrace', code: MARK + '3' });
  var e = await poki.createUnit(boss, { propertyId: prop.id, code: MARK + '-E', baseRent: 1200 });
  var f = await poki.createUnit(boss, { propertyId: prop.id, code: MARK + '-F', baseRent: 1300 });
  var tenant = await poki.createTenant(boss, { name: MARK + ' Resident', phone: '0240000097' });
  await pool.query(
    "INSERT INTO poki_bookings (booking_no, unit_id, tenant_id, start_date, end_date, duration_months, duration_days, monthly_rate, rent_total, status, notes) " +
    "VALUES ($1,$2,$3,$4,$5,3,0,1200,3600,'expired',$6)", [MARK + '-OLD2', e.id, tenant.id, day(-120), day(-25), MARK]);
  await poki.createBooking(boss, { unitId: e.id, tenantId: tenant.id, startDate: day(5), durationMonths: 2, status: 'draft', notes: MARK });
  var live = await poki.createBooking(boss, { unitId: f.id, tenantId: tenant.id, startDate: day(-10), durationMonths: 6, status: 'active', notes: MARK });
  await billing.createRequest(boss, { unitId: f.id, title: MARK + ' tap', priority: 'high' });

  var units = await poki.listUnits(boss, { propertyId: prop.id });
  var ue = units.find(function (u) { return u.id === e.id; });
  var uf = units.find(function (u) { return u.id === f.id; });
  assert.deepEqual([ue.lastLetEnd, ue.nextBookingStart, ue.status, ue.openRequests], [day(-25), day(5), 'vacant', 0]);
  assert.deepEqual([uf.status, uf.tenantName, uf.tenantPhone, uf.bookingNo, uf.bookingMonthly, uf.openRequests], ['occupied', MARK + ' Resident', '0240000097', live.bookingNo, 1300, 1]);
  await pool.query('DELETE FROM poki_maintenance_requests WHERE unit_id = $1', [f.id]);
});

test('a tenant carries what they owe, how overdue, what they have paid and when their booking ends', async function () {
  var prop = await poki.createProperty(boss, { name: MARK + ' Heights', code: MARK + '4' });
  var unit = await poki.createUnit(boss, { propertyId: prop.id, code: MARK + '-G', baseRent: 1000 });
  var tenant = await poki.createTenant(boss, { name: MARK + ' Payer', phone: '0240000096' });
  var fresh = await poki.createTenant(boss, { name: MARK + ' Prospect', status: 'prospect' });
  var b = await poki.createBooking(boss, { unitId: unit.id, tenantId: tenant.id, startDate: day(-40), durationMonths: 3, status: 'active', notes: MARK });
  var inv = (await pool.query('SELECT id, grand_total FROM invoices WHERE poki_booking_id = $1', [b.id])).rows[0];
  await pool.query('UPDATE invoices SET issued_at = $1, due_date = $2 WHERE id = $3', [day(-40), day(-12), inv.id]);
  await pokiInvoices.recordPayment(boss, inv.id, { amount: 1000, method: 'cash', date: day(-30) });

  var list = await poki.listTenants(boss);
  var t = list.find(function (x) { return x.id === tenant.id; });
  var p = list.find(function (x) { return x.id === fresh.id; });
  var left = Number(inv.grand_total) - 1000;
  assert.deepEqual(t.owed, [{ currency: 'GHS', amount: left }]);
  assert.deepEqual(t.overdue, [{ currency: 'GHS', amount: left }]);
  assert.deepEqual([t.daysOverdue, t.paid[0].amount, t.bookings, t.since, t.currentEnd], [12, 1000, 1, day(-40), b.endDate.slice(0, 10)]);
  assert.deepEqual([p.owed, p.bookings, p.currentEnd, p.status], [[], 0, null, 'prospect']);
});

test('a repair is charged to the tenant once; voiding that invoice lets it be charged again', async function () {
  var prop = await poki.createProperty(boss, { name: MARK + ' Mews', code: MARK + '5' });
  var unit = await poki.createUnit(boss, { propertyId: prop.id, code: MARK + '-H', baseRent: 800 });
  var tenant = await poki.createTenant(boss, { name: MARK + ' Breaker', phone: '0240000095' });
  await poki.createBooking(boss, { unitId: unit.id, tenantId: tenant.id, startDate: day(-5), durationMonths: 2, status: 'active', notes: MARK });
  var r = await billing.createRequest(boss, { unitId: unit.id, title: MARK + ' broken window', priority: 'urgent' });
  assert.deepEqual([r.tenantName, r.tenantPhone, r.chargeInvoiceId], [MARK + ' Breaker', '0240000095', null]);
  await assert.rejects(function () { return billing.chargeRequestToTenant(boss, r.id); }, /repair cost/);
  await billing.updateRequest(boss, r.id, { cost: 350, status: 'resolved' });

  var first = await billing.chargeRequestToTenant(boss, r.id);
  assert.equal(first.amount, 350);
  var listed = (await billing.listRequests(boss, { unitId: unit.id }))[0];
  assert.deepEqual([listed.chargeInvoiceId, listed.chargeInvoiceNo, listed.chargeToTenant], [first.invoiceId, first.invoiceNo, true]);
  await assert.rejects(function () { return billing.chargeRequestToTenant(boss, r.id); }, /already charged/);

  await pokiInvoices.voidInvoice(boss, first.invoiceId);
  var again = await billing.chargeRequestToTenant(boss, r.id);
  assert.notEqual(again.invoiceId, first.invoiceId);
  await pool.query('DELETE FROM poki_maintenance_requests WHERE id = $1', [r.id]);
  await pool.query('DELETE FROM invoices WHERE id = ANY($1::uuid[])', [[first.invoiceId, again.invoiceId]]);
});
