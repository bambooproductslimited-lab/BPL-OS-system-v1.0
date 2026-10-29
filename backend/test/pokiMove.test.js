/*
 * A tenant moving to another unit before their booking runs out
 * (poki.service.js moveBooking): the booking on the old unit ends as
 * 'moved', a new one carries on in the new unit to the same end date, the
 * deposit and the running charges go with them, and only the rent
 * difference is settled — charged when the new unit costs more, kept or
 * given back (a credit note, and a refund if paid) when it costs less.
 * Fake properties, units and tenants of its own (MVTEST), dated 2036.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');

var server, base, admin;
var MARK = 'MVTEST';

test.before(async function () {
  server = app.listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  admin = await login('kelvin.duho@bplghana.com');
  await cleanup();
});

async function cleanup() {
  var bookings = "SELECT id FROM poki_bookings WHERE notes LIKE '%" + MARK + "%' OR tenant_id IN (SELECT t.id FROM poki_tenants t JOIN customers c ON c.id = t.customer_id WHERE c.name LIKE '%" + MARK + "%')";
  var invoices = 'SELECT id FROM invoices WHERE poki_booking_id IN (' + bookings + ')';
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN (" + invoices + ')');
  await pool.query('DELETE FROM credit_notes WHERE invoice_id IN (' + invoices + ')');
  await pool.query('DELETE FROM payments WHERE invoice_id IN (' + invoices + ')');
  await pool.query('DELETE FROM poki_recurring_charges WHERE booking_id IN (' + bookings + ')');
  await pool.query('DELETE FROM invoices WHERE id IN (' + invoices + ')');
  await pool.query('UPDATE poki_bookings SET moved_from_id = NULL, renewed_from_id = NULL WHERE id IN (' + bookings + ')');
  await pool.query('DELETE FROM poki_bookings WHERE id IN (' + bookings + ')');
  await pool.query("DELETE FROM poki_units WHERE code LIKE '" + MARK + "%'");
  await pool.query("DELETE FROM poki_tenants WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE '%" + MARK + "%')");
  await pool.query("DELETE FROM customers WHERE name LIKE '%" + MARK + "%'");
  await pool.query("DELETE FROM poki_properties WHERE name LIKE '%" + MARK + "%'");
}

test.after(async function () {
  if (server) server.close();
  await cleanup();
  await pool.end();
});

async function login(email) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  return (await res.json()).token;
}

async function call(method, path, body) {
  var opts = { method: method, headers: { Authorization: 'Bearer ' + admin } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  var res = await fetch(base + path, opts);
  var text = await res.text();
  var parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
  return { status: res.status, body: parsed };
}

// A property with units at the rents given, and a tenant.
async function place(code, rents) {
  var prop = await call('POST', '/api/poki/properties', { name: MARK + ' House ' + code, code: MARK + code, address: '1 Test Road' });
  assert.equal(prop.status, 201, JSON.stringify(prop.body));
  var units = [];
  for (var i = 0; i < rents.length; i++) {
    var u = await call('POST', '/api/poki/units', {
      propertyId: prop.body.id, code: MARK + '-' + code + (i + 1), name: 'Room ' + (i + 1), unitType: 'apartment', baseRent: rents[i], dailyRate: 0, currency: 'GHS'
    });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    units.push(u.body);
  }
  var tenant = await call('POST', '/api/poki/tenants', { name: MARK + ' Tenant ' + code, email: 'mvtest@example.com', phone: '0200000000' });
  assert.equal(tenant.status, 201, JSON.stringify(tenant.body));
  return { units: units, tenantId: tenant.body.id };
}

async function book(unitId, tenantId, over) {
  var made = await call('POST', '/api/poki/bookings', Object.assign({
    unitId: unitId, tenantId: tenantId, startDate: '2036-01-01', durationMonths: 12, durationDays: 0, depositAmount: 0, status: 'active', notes: MARK
  }, over || {}));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body;
}

async function invoicesOf(bookingId) {
  return (await pool.query("SELECT id, invoice_no, grand_total, amount_paid, credit_total, balance_due FROM invoices WHERE poki_booking_id = $1 AND status <> 'void' ORDER BY issued_at, invoice_no", [bookingId])).rows;
}
async function payAll(bookingId) {
  var inv = (await invoicesOf(bookingId))[0];
  var r = await call('POST', '/api/poki/invoices/' + inv.id + '/payments', { amount: Number(inv.balance_due), method: 'cash', reference: MARK });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}
async function unitStatus(id) { return (await pool.query('SELECT status FROM poki_units WHERE id = $1', [id])).rows[0].status; }

test('a dearer unit: the old booking ends as moved, a new one carries on to the same end date, and only the difference is invoiced', async function () {
  var f = await place('A', [1000, 1200]);
  var A = f.units[0], B = f.units[1];
  var b = await book(A.id, f.tenantId, { depositAmount: 1000 });
  await payAll(b.id);
  assert.equal((await call('GET', '/api/poki/bookings/' + b.id)).body.depositHeld, 1000);

  var q = (await call('POST', '/api/poki/bookings/' + b.id + '/move/quote', { unitId: B.id, moveDate: '2036-04-01' })).body;
  assert.deepEqual([q.left.months, q.left.days, q.left.label], [9, 0, '9 months']);
  assert.deepEqual([q.from.forTheRest, q.to.forTheRest, q.difference], [9000, 10800, 1800]);
  assert.equal(q.available, true);
  assert.deepEqual(q.deposit, { amount: 1000, held: 1000, owing: 0 });

  var moved = await call('POST', '/api/poki/bookings/' + b.id + '/move', { unitId: B.id, moveDate: '2036-04-01', reason: 'wanted a bigger room' });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  var n = moved.body;
  assert.equal(n.unitId, B.id);
  assert.equal(n.status, 'active');
  assert.deepEqual([String(n.startDate).slice(0, 10), String(n.endDate).slice(0, 10), n.durationLabel], ['2036-04-01', '2036-12-31', '9 months']);
  assert.deepEqual([n.monthlyRate, n.rentTotal, n.depositAmount, n.depositHeld], [1200, 10800, 1000, 1000]);
  assert.equal(n.movedFromNo, b.bookingNo);
  assert.equal(n.movedFromUnit, A.code);
  assert.match(n.moveSummary, /charged/);

  var old = (await call('GET', '/api/poki/bookings/' + b.id)).body;
  assert.equal(old.status, 'moved');
  assert.equal(String(old.terminatedOn).slice(0, 10), '2036-04-01');
  assert.match(old.terminationReason, /^Moved to .*: wanted a bigger room$/);
  assert.equal(old.movedToNo, n.bookingNo);
  assert.equal(old.movedToUnit, B.code);
  assert.equal(await unitStatus(A.id), 'vacant');
  assert.equal(await unitStatus(B.id), 'occupied');

  // One invoice on the new booking, for the difference alone.
  var invs = await invoicesOf(n.id);
  assert.equal(invs.length, 1);
  assert.equal(Number(invs[0].grand_total), 1800);
  var line = (await pool.query("SELECT description FROM document_line_items WHERE document_type = 'invoice' AND document_id = $1", [invs[0].id])).rows;
  assert.match(line[0].description, /^Rent difference — moved from /);
  var audit = (await pool.query("SELECT summary FROM audit_logs WHERE action = 'poki.booking.move' AND entity_id = $1", [n.id])).rows[0];
  assert.match(audit.summary, /carrying on as .* for the 9 months left; the rent difference of GHS 1800.00 charged/);

  // The old unit is free from the moving day.
  var q2 = (await call('POST', '/api/poki/bookings/quote', { unitId: A.id, startDate: '2036-04-01', durationMonths: 3, durationDays: 0 })).body;
  assert.equal(q2.available, true);

  // The old booking is over; the new one keeps its terms.
  assert.equal((await call('POST', '/api/poki/bookings/' + b.id + '/end', {})).status, 409);
  assert.equal((await call('POST', '/api/poki/bookings/' + b.id + '/renew', {})).status, 409);
  assert.equal((await call('PATCH', '/api/poki/bookings/' + b.id, { notes: MARK + ' x' })).status, 409);
  assert.equal((await call('POST', '/api/poki/bookings/' + b.id + '/deposit-refund', { amount: 100 })).status, 409);
  var edit = await call('PATCH', '/api/poki/bookings/' + n.id, { monthlyRate: 1500 });
  assert.equal(edit.status, 409);
  assert.match(edit.body.error.message, /after a move/);
  assert.equal((await call('PATCH', '/api/poki/bookings/' + n.id, { notes: MARK + ' moved in' })).status, 200);
  assert.equal(Number((await invoicesOf(n.id))[0].grand_total), 1800, 'its invoice stays the difference');
});

test('a cheaper unit: the money is kept, or given back as a credit note and a refund', async function () {
  var f = await place('B', [1000, 800, 800]);
  var b = await book(f.units[0].id, f.tenantId, { durationMonths: 6 });
  await payAll(b.id);
  var q = (await call('POST', '/api/poki/bookings/' + b.id + '/move/quote', { unitId: f.units[1].id, moveDate: '2036-03-01' })).body;
  assert.deepEqual([q.left.months, q.difference], [4, -800]);
  assert.deepEqual(q.giveBack.credit + '/' + q.giveBack.refund, '800/800');

  var noWay = await call('POST', '/api/poki/bookings/' + b.id + '/move', { unitId: f.units[1].id, moveDate: '2036-03-01', difference: 'return' });
  assert.equal(noWay.status, 400);
  assert.match(noWay.body.error.message, /say how it is paid back/);
  var moved = await call('POST', '/api/poki/bookings/' + b.id + '/move',
    { unitId: f.units[1].id, moveDate: '2036-03-01', difference: 'return', refund: { method: 'mobile_money', reference: 'ZQ-MOMO-1' } });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.equal((await invoicesOf(moved.body.id)).length, 0, 'nothing more to pay');
  var oldInv = (await invoicesOf(b.id))[0];
  var note = (await pool.query('SELECT amount, refund_amount FROM credit_notes WHERE invoice_id = $1', [oldInv.id])).rows[0];
  assert.deepEqual([Number(note.amount), Number(note.refund_amount)], [800, 800]);
  var refund = (await pool.query("SELECT amount, method FROM payments WHERE invoice_id = $1 AND source = 'refund'", [oldInv.id])).rows[0];
  assert.deepEqual([Number(refund.amount), refund.method], [-800, 'mobile_money']);

  // Kept: no credit note, no invoice — and a rent kept as it was costs nothing either way.
  var t2 = await call('POST', '/api/poki/tenants', { name: MARK + ' Tenant B2', email: 'mvtest2@example.com', phone: '0200000001' });
  var b2 = await book(f.units[0].id, t2.body.id, { startDate: '2036-09-01', durationMonths: 3 });
  var kept = await call('POST', '/api/poki/bookings/' + b2.id + '/move', { unitId: f.units[2].id, moveDate: '2036-10-01' });
  assert.equal(kept.status, 201, JSON.stringify(kept.body));
  assert.equal(kept.body.monthlyRate, 800);
  assert.match(kept.body.moveSummary, /costs less kept/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM credit_notes WHERE invoice_id = $1', [(await invoicesOf(b2.id))[0].id])).rows[0].n, 0);
});

test('the new unit must be free, the moving day inside the booking; a draft moves whole; the deposit raise and the running charges', async function () {
  var f = await place('C', [1000, 1000, 1000, 1500]);
  var U = f.units;
  var b = await book(U[0].id, f.tenantId, { depositAmount: 1000 });
  // Someone else is booked into U[1] from May.
  var other = await call('POST', '/api/poki/tenants', { name: MARK + ' Tenant C2', email: 'mvtest3@example.com', phone: '0200000002' });
  await book(U[1].id, other.body.id, { startDate: '2036-05-01', durationMonths: 2, status: 'draft' });

  var busy = await call('POST', '/api/poki/bookings/' + b.id + '/move', { unitId: U[1].id, moveDate: '2036-04-01' });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error.message, /is booked 2036-05-01 to 2036-06-30 under/);
  assert.equal((await call('POST', '/api/poki/bookings/' + b.id + '/move/quote', { unitId: U[1].id, moveDate: '2036-04-01' })).body.available, false);
  assert.equal((await call('POST', '/api/poki/bookings/' + b.id + '/move', { unitId: U[0].id, moveDate: '2036-04-01' })).status, 400, 'the same unit');
  assert.equal((await call('POST', '/api/poki/bookings/' + b.id + '/move', { unitId: U[2].id, moveDate: '2035-12-01' })).status, 400, 'before it starts');
  assert.equal((await call('POST', '/api/poki/bookings/' + b.id + '/move', { unitId: U[2].id, moveDate: '2037-02-01' })).status, 400, 'after it ends');

  // CAM goes with them; a raised deposit is charged for the difference only.
  var cam = await call('POST', '/api/poki/recurring-charges', { bookingId: b.id, kind: 'cam', amount: 150, startDate: '2036-01-01' });
  assert.equal(cam.status, 201, JSON.stringify(cam.body));
  var moved = await call('POST', '/api/poki/bookings/' + b.id + '/move', { unitId: U[3].id, moveDate: '2036-07-01', keepRate: true, depositAmount: 1500 });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.equal(moved.body.monthlyRate, 1000, 'their rent kept as it was');
  assert.equal(moved.body.depositAmount, 1500);
  var invs = await invoicesOf(moved.body.id);
  assert.equal(invs.length, 1);
  assert.equal(Number(invs[0].grand_total), 500, 'only the rise in the deposit');
  var charge = (await pool.query('SELECT booking_id FROM poki_recurring_charges WHERE id = $1', [cam.body.id])).rows[0];
  assert.equal(charge.booking_id, moved.body.id);
  assert.match(moved.body.moveSummary, /1 running charge moved with them/);

  // A booking not started yet moves whole, and occupies nothing.
  var t3 = await call('POST', '/api/poki/tenants', { name: MARK + ' Tenant C3', email: 'mvtest4@example.com', phone: '0200000003' });
  var d = await book(U[2].id, t3.body.id, { startDate: '2036-11-01', durationMonths: 1, durationDays: 10, status: 'draft' });
  var dm = await call('POST', '/api/poki/bookings/' + d.id + '/move', { unitId: U[0].id, moveDate: '2036-12-25' });
  assert.equal(dm.status, 201, JSON.stringify(dm.body));
  assert.equal(dm.body.status, 'draft');
  assert.deepEqual([String(dm.body.startDate).slice(0, 10), dm.body.durationLabel], ['2036-11-01', '1 month and 10 days']);
  assert.equal(await unitStatus(U[2].id), 'vacant');
});

test('moving needs poki.manage; the quote is for anyone who can read the bookings', async function () {
  var r = await call('POST', '/api/poki/bookings/00000000-0000-0000-0000-000000000000/move', { unitId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(r.status, 404);
  var who = (await pool.query("SELECT u.email FROM users u WHERE u.email = 'christine.adhiambo@bplghana.com'")).rows[0];
  if (!who) return;
  var saved = admin;
  admin = await login(who.email);
  try {
    var f = (await pool.query("SELECT id FROM poki_bookings WHERE notes LIKE '%" + MARK + "%' LIMIT 1")).rows[0];
    var res = await call('POST', '/api/poki/bookings/' + f.id + '/move', { unitId: f.id });
    assert.equal(res.status, 403);
  } finally { admin = saved; }
});
