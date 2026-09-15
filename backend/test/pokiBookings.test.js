/*
 * Integration test for the Poki booking model: pricing, availability, the
 * up-front invoice, and the deposit ledger.
 *
 * Rent is taken as a block of time paid for in advance — so many months plus
 * so many days — rather than as a recurring tenancy. That means three things
 * have to hold together, and none of them was covered by a test until now:
 *
 *   - the price the booking screen quotes is the price the invoice charges
 *   - a unit cannot be let to two tenants for overlapping dates
 *   - the deposit is collected once and carried across renewals
 *
 * Requires `npm run migrate && npm run seed` first — the pretest hook does
 * both against the test database.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');

var server, base, admin;

// Everything this test creates is stamped so teardown can find it again,
// and so a failure part-way through does not leave a unit permanently
// booked for the next run.
var MARK = 'BKTEST';

test.before(async function () {
  server = app.listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  admin = await login('kelvin.duho@bplghana.com');
});

test.after(async function () {
  if (server) server.close();
  await pool.query("DELETE FROM document_line_items WHERE description LIKE '%" + MARK + "%'");
  await pool.query("DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE notes LIKE '%" + MARK + "%')");
  await pool.query("DELETE FROM invoices WHERE poki_booking_id IN (SELECT id FROM poki_bookings WHERE notes LIKE '%" + MARK + "%')");
  await pool.query("DELETE FROM poki_bookings WHERE notes LIKE '%" + MARK + "%'");
  await pool.query("DELETE FROM poki_units WHERE code LIKE '" + MARK + "%'");
  await pool.query("DELETE FROM poki_tenants WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE '%" + MARK + "%')");
  await pool.query("DELETE FROM customers WHERE name LIKE '%" + MARK + "%'");
  await pool.query("DELETE FROM poki_properties WHERE name LIKE '%" + MARK + "%'");
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

// A property, a unit and a tenant of this test's own, so it depends on
// nothing the seed happens to contain and leaves nothing behind.
async function fixtures(unitSuffix, monthlyRate, dailyRate) {
  // A property per case, with its own code: property codes are unique, and
  // sharing one across cases would make each test depend on the order the
  // others ran in.
  var prop = await call('POST', '/api/poki/properties', {
    name: MARK + ' Property ' + unitSuffix, code: MARK + unitSuffix, address: '1 Test Road'
  });
  assert.equal(prop.status, 201, 'could not create the test property: ' + JSON.stringify(prop.body));

  var unit = await call('POST', '/api/poki/units', {
    propertyId: prop.body.id, code: MARK + '-' + unitSuffix, name: 'Test unit',
    unitType: 'apartment', baseRent: monthlyRate, dailyRate: dailyRate || 0, currency: 'GHS'
  });
  assert.equal(unit.status, 201, 'could not create the test unit: ' + JSON.stringify(unit.body));

  var tenant = await call('POST', '/api/poki/tenants', { name: MARK + ' Tenant', email: 'bktest@example.com', phone: '0200000000' });
  assert.equal(tenant.status, 201, 'could not create the test tenant: ' + JSON.stringify(tenant.body));

  return { propertyId: prop.body.id, unitId: unit.body.id, tenantId: tenant.body.id };
}

function bookingBody(f, over) {
  return Object.assign({
    unitId: f.unitId, tenantId: f.tenantId,
    startDate: '2035-01-01', durationMonths: 6, durationDays: 0,
    depositAmount: 0, status: 'active', notes: MARK
  }, over || {});
}

// ---------------------------------------------------------------------------

test('a booking is priced as months at the monthly rate plus days at the daily rate', async function () {
  var f = await fixtures('P1', 2000, 100);

  var q = await call('POST', '/api/poki/bookings/quote', {
    unitId: f.unitId, startDate: '2035-03-01', durationMonths: 6, durationDays: 10, depositAmount: 4000
  });
  assert.equal(q.status, 200);
  assert.equal(q.body.monthsAmount, 12000, '6 months at 2000');
  assert.equal(q.body.daysAmount, 1000, '10 days at the unit\'s own daily rate of 100');
  assert.equal(q.body.rentTotal, 13000);
  assert.equal(q.body.total, 17000, 'rent plus deposit is what the tenant pays before occupation');
  assert.equal(q.body.durationLabel, '6 months and 10 days');

  // The end date is derived, never typed: 6 months from 1 March is 1
  // September, and the booking runs to the day before.
  assert.equal(q.body.endDate, '2035-09-10');
});

test('a unit with no daily rate charges a thirtieth of the monthly rate for days', async function () {
  var f = await fixtures('P2', 3000, 0);
  var q = await call('POST', '/api/poki/bookings/quote', {
    unitId: f.unitId, startDate: '2035-03-01', durationMonths: 0, durationDays: 5
  });
  assert.equal(q.body.dailyRate, 100, '3000 / 30');
  assert.equal(q.body.rentTotal, 500);
  assert.equal(q.body.durationLabel, '5 days');
});

test('a booking of days alone is allowed; a booking of no time at all is not', async function () {
  var f = await fixtures('P3', 3000, 250);

  var days = await call('POST', '/api/poki/bookings', bookingBody(f, { durationMonths: 0, durationDays: 4, startDate: '2035-05-01' }));
  assert.equal(days.status, 201, 'four days is a booking');
  assert.equal(days.body.rentTotal, 1000);
  assert.equal(days.body.endDate.slice(0, 10), '2035-05-04');

  var nothing = await call('POST', '/api/poki/bookings', bookingBody(f, { durationMonths: 0, durationDays: 0, startDate: '2036-01-01' }));
  assert.equal(nothing.status, 400);
  assert.match(nothing.body.error.message, /how long/i);
});

test('a unit cannot be booked twice over the same dates', async function () {
  var f = await fixtures('P4', 1000, 50);

  var first = await call('POST', '/api/poki/bookings', bookingBody(f, { startDate: '2035-01-01', durationMonths: 6 }));
  assert.equal(first.status, 201);

  // Overlapping at the front, in the middle, and enclosing it entirely.
  var overlaps = [
    { startDate: '2034-12-01', durationMonths: 2, label: 'starting before and running into it' },
    { startDate: '2035-03-01', durationMonths: 1, label: 'wholly inside it' },
    { startDate: '2034-11-01', durationMonths: 12, label: 'swallowing it' },
    { startDate: '2035-06-30', durationMonths: 1, label: 'starting on its last day' }
  ];
  for (var o of overlaps) {
    var clash = await call('POST', '/api/poki/bookings', bookingBody(f, { startDate: o.startDate, durationMonths: o.durationMonths }));
    assert.equal(clash.status, 409, 'a booking ' + o.label + ' should be refused');
    assert.match(clash.body.error.message, /already booked/i);
  }

  // The day after it ends is free — consecutive bookings must tile.
  var next = await call('POST', '/api/poki/bookings', bookingBody(f, { startDate: '2035-07-01', durationMonths: 3 }));
  assert.equal(next.status, 201, 'the day after the previous booking ends is available');

  // And the quote says so before anything is saved.
  var q = await call('POST', '/api/poki/bookings/quote', { unitId: f.unitId, startDate: '2035-02-01', durationMonths: 1 });
  assert.equal(q.body.available, false);
  assert.ok(q.body.clashesWith.bookingNo, 'the quote names the booking in the way');
});

test('the database refuses an overlap even when the service check is bypassed', async function () {
  // The service checks availability first so it can name the clash, but two
  // people booking at the same instant would both pass that check. What
  // actually prevents the double-let is the exclusion constraint, so assert
  // it directly rather than trusting the layer above it.
  var f = await fixtures('P5', 1000, 0);
  var b = await call('POST', '/api/poki/bookings', bookingBody(f, { startDate: '2035-01-01', durationMonths: 3 }));
  assert.equal(b.status, 201);

  await assert.rejects(
    pool.query(
      'INSERT INTO poki_bookings (booking_no, unit_id, tenant_id, start_date, end_date, ' +
      'duration_months, duration_days, monthly_rate, rent_total, status, notes) ' +
      "VALUES ($1,$2,$3,'2035-02-01','2035-04-30',3,0,1000,3000,'active',$4)",
      [MARK + '-RAW', f.unitId, f.tenantId, MARK]),
    function (err) { return err.code === '23P01'; },
    'a direct insert overlapping an existing booking must violate the exclusion constraint'
  );
});

test('making a booking raises one invoice for the whole block, matching the quote', async function () {
  var f = await fixtures('P6', 2200, 0);
  var body = bookingBody(f, { startDate: '2035-02-01', durationMonths: 6, durationDays: 10, depositAmount: 4400 });

  var quoted = await call('POST', '/api/poki/bookings/quote', body);
  var made = await call('POST', '/api/poki/bookings', body);
  assert.equal(made.status, 201);

  var invoices = await call('GET', '/api/poki/invoices');
  var inv = invoices.body.find(function (i) { return i.bookingNo === made.body.bookingNo; });
  assert.ok(inv, 'creating a booking must raise its invoice — there is no rent run to raise it later');

  // The number on the invoice is the number the screen quoted. If these
  // ever diverge the tenant is billed something they were never shown.
  assert.equal(inv.grandTotal, quoted.body.total,
    'the invoice total must equal what the booking screen quoted');

  var full = await call('GET', '/api/poki/invoices/' + inv.id);
  var descriptions = full.body.items.map(function (i) { return i.description; }).join(' | ');
  assert.match(descriptions, /^Rent —/, 'a months line');
  assert.match(descriptions, /Rent \(days\)/, 'a days line');
  assert.match(descriptions, /Security deposit/, 'a deposit line');
  assert.equal(full.body.items.length, 3);

  // Payable before occupation, so due on the start date.
  assert.equal(String(inv.dueDate).slice(0, 10), '2035-02-01');
});

test('an invoice is never dated overdue on the day it is raised', async function () {
  // A booking entered after the tenant moved in would otherwise be due on a
  // date already past, and show as overdue the moment it is created.
  var f = await fixtures('P7', 1000, 0);
  var made = await call('POST', '/api/poki/bookings', bookingBody(f, { startDate: '2020-01-01', durationMonths: 3 }));
  assert.equal(made.status, 201);

  var invoices = await call('GET', '/api/poki/invoices');
  var inv = invoices.body.find(function (i) { return i.bookingNo === made.body.bookingNo; });
  var today = new Date().toISOString().slice(0, 10);
  assert.ok(String(inv.dueDate).slice(0, 10) >= today, 'due date must not be in the past');
});

test('the deposit is held only once the invoice is settled in full', async function () {
  var f = await fixtures('P8', 2000, 0);
  var made = await call('POST', '/api/poki/bookings',
    bookingBody(f, { startDate: '2035-02-01', durationMonths: 3, depositAmount: 4000 }));
  assert.equal(made.status, 201);
  assert.equal(made.body.depositHeld, 0, 'nothing is held until it is paid');

  var invoices = await call('GET', '/api/poki/invoices');
  var inv = invoices.body.find(function (i) { return i.bookingNo === made.body.bookingNo; });
  assert.equal(inv.grandTotal, 10000, '3 x 2000 rent, plus 4000 deposit');

  // A part payment cannot be assumed to have covered the deposit rather
  // than the rent, so the ledger must not move.
  var part = await call('POST', '/api/poki/invoices/' + inv.id + '/payments',
    { amount: 5000, method: 'bank_transfer', reference: MARK + '-1' });
  assert.equal(part.status, 201);
  var midway = await call('GET', '/api/poki/bookings/' + made.body.id);
  assert.equal(midway.body.depositHeld, 0, 'a part payment must not credit the deposit');

  var rest = await call('POST', '/api/poki/invoices/' + inv.id + '/payments',
    { amount: 5000, method: 'cash', reference: MARK + '-2' });
  assert.equal(rest.status, 201);
  var settled = await call('GET', '/api/poki/bookings/' + made.body.id);
  assert.equal(settled.body.depositHeld, 4000, 'settling the invoice hands over the deposit');
  assert.equal(settled.body.balanceTotal, 0);
});

test('renewing carries the deposit over instead of charging it again', async function () {
  var f = await fixtures('P9', 2000, 0);
  var made = await call('POST', '/api/poki/bookings',
    bookingBody(f, { startDate: '2035-01-01', durationMonths: 6, depositAmount: 4000 }));
  assert.equal(made.status, 201);

  var invoices = await call('GET', '/api/poki/invoices');
  var first = invoices.body.find(function (i) { return i.bookingNo === made.body.bookingNo; });
  await call('POST', '/api/poki/invoices/' + first.id + '/payments',
    { amount: first.grandTotal, method: 'bank_transfer', reference: MARK + '-R1' });

  var renewed = await call('POST', '/api/poki/bookings/' + made.body.id + '/renew', { escalationPercent: 10, notes: MARK });
  assert.equal(renewed.status, 201);

  // The new block opens the day after the old one closes. Starting on the
  // same day would be a one-day overlap, which the constraint now refuses.
  assert.equal(String(renewed.body.startDate).slice(0, 10), '2035-07-01');
  assert.equal(renewed.body.monthlyRate, 2200, 'escalated by 10%');
  assert.equal(renewed.body.durationMonths, 6, 'same length as the block being renewed');
  assert.equal(renewed.body.depositHeld, 4000, 'the deposit follows the tenant');

  var after = await call('GET', '/api/poki/invoices');
  var second = after.body.find(function (i) { return i.bookingNo === renewed.body.bookingNo; });
  assert.ok(second, 'a renewal must be invoiced too — it is another block of time');

  var lines = await call('GET', '/api/poki/invoices/' + second.id);
  var descriptions = lines.body.items.map(function (i) { return i.description; }).join(' | ');
  assert.doesNotMatch(descriptions, /deposit/i,
    'the deposit carried over, so charging it again would bill the tenant twice');
  assert.equal(second.grandTotal, 13200, '6 x 2200 rent alone');
});

test('reading and managing bookings are separately permissioned', async function () {
  var f = await fixtures('PA', 1000, 0);
  var alice = await login('alice.kamau@bplghana.com'); // ordinary employee

  var read = await fetch(base + '/api/poki/bookings', { headers: { Authorization: 'Bearer ' + alice } });
  assert.equal(read.status, 403, 'poki.read is required even to list bookings');

  var write = await fetch(base + '/api/poki/bookings', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + alice, 'Content-Type': 'application/json' },
    body: JSON.stringify(bookingBody(f))
  });
  assert.equal(write.status, 403);

  var quote = await fetch(base + '/api/poki/bookings/quote', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + alice, 'Content-Type': 'application/json' },
    body: JSON.stringify({ unitId: f.unitId, startDate: '2035-01-01', durationMonths: 1 })
  });
  assert.equal(quote.status, 403, 'pricing a unit is not public either');
});
