// A photo of the water or electricity meter with each utility reading: taken
// with the reading or added after, replaced or taken off, shown back to
// staff, and kept even once the reading is billed.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var { todayISO } = require('../src/utils/documents');

var MARK = 'MPTEST';
// A 1×1 PNG, as the browser sends a shrunk photo (a data URL).
var PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
var server, base, token, water, elec;

async function call(method, path, body) {
  var opts = { method: method, headers: { Authorization: 'Bearer ' + token } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  var res = await fetch(base + path, opts);
  return { status: res.status, body: await res.json().catch(function () { return null; }) };
}
async function ok(method, path, body) {
  var r = await call(method, path, body);
  assert.ok(r.status < 300, path + ' ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body;
}
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function cleanup() {
  var bk = "(SELECT id FROM poki_bookings WHERE notes LIKE '%" + MARK + "%')";
  var inv = '(SELECT id FROM invoices WHERE poki_booking_id IN ' + bk + ')';
  await pool.query("DELETE FROM poki_meter_readings WHERE meter_id IN (SELECT m.id FROM poki_meters m JOIN poki_units u ON u.id = m.unit_id WHERE u.code LIKE '" + MARK + "%')");
  await pool.query("DELETE FROM poki_meters WHERE unit_id IN (SELECT id FROM poki_units WHERE code LIKE '" + MARK + "%')");
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN " + inv);
  await pool.query('DELETE FROM poki_recurring_charges WHERE booking_id IN ' + bk);
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query('DELETE FROM poki_bookings WHERE id IN ' + bk);
  await pool.query("DELETE FROM poki_units WHERE code LIKE '" + MARK + "%'");
  await pool.query("DELETE FROM poki_tenants WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE '%" + MARK + "%')");
  await pool.query("DELETE FROM customers WHERE name LIKE '%" + MARK + "%'");
  await pool.query("DELETE FROM poki_properties WHERE name LIKE '%" + MARK + "%'");
}

test.before(async function () {
  server = app.listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  token = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'kelvin.duho@bplghana.com', password: 'bamboo123' }) })).json()).token;
  await cleanup();
  var prop = await ok('POST', '/api/poki/properties', { name: MARK + ' Court', code: MARK + 'P', address: '1 Test Road' });
  var unit = await ok('POST', '/api/poki/units', { propertyId: prop.id, code: MARK + '-B2', name: 'Shop B2', unitType: 'shop', baseRent: 1500, currency: 'GHS' });
  var tenant = await ok('POST', '/api/poki/tenants', { name: MARK + ' Tailor', email: 'mptest@example.com', phone: '0200000077' });
  await ok('POST', '/api/poki/bookings', { unitId: unit.id, tenantId: tenant.id, startDate: addDays(todayISO(), -20), durationMonths: 6, durationDays: 0, depositAmount: 0, status: 'active', notes: MARK });
  water = await ok('POST', '/api/poki/meters', { unitId: unit.id, utilityType: 'water', measureUnit: 'm³', rate: 10 });
  elec = await ok('POST', '/api/poki/meters', { unitId: unit.id, utilityType: 'electricity', measureUnit: 'kWh', rate: 2 });
});
test.after(async function () {
  if (server) server.close();
  await cleanup();
  await pool.end();
});

test('a reading taken with a photo of the meter keeps it, and staff can see it', async function () {
  var today = todayISO();
  var r = await ok('POST', '/api/poki/readings', { meterId: water.id, periodStart: addDays(today, -30), periodEnd: today, previousReading: 100, currentReading: 112, photo: PNG });
  assert.equal(r.hasPhoto, true);
  assert.ok(r.photoAt, 'when it was taken');
  var res = await fetch(base + '/api/poki/readings/' + r.id + '/photo', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image\/png/);
  var bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.slice(1, 4).toString(), 'PNG', 'the photo itself comes back');
  var listed = (await ok('GET', '/api/poki/readings')).find(function (x) { return x.id === r.id; });
  assert.equal(listed.hasPhoto, true, 'the list says it has one');
  // Without a sign-in, no photo.
  var anon = await fetch(base + '/api/poki/readings/' + r.id + '/photo');
  assert.equal(anon.status, 401);
});

test('a photo added after the reading, replaced, then taken off; a bad one is refused', async function () {
  var today = todayISO();
  var r = await ok('POST', '/api/poki/readings', { meterId: elec.id, periodStart: addDays(today, -30), periodEnd: today, previousReading: 5000, currentReading: 5180 });
  assert.equal(r.hasPhoto, false);
  var none = await call('GET', '/api/poki/readings/' + r.id + '/photo');
  assert.equal(none.status, 404);

  var bad = await call('PUT', '/api/poki/readings/' + r.id + '/photo', { photo: 'data:text/plain;base64,aGVsbG8=' });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body), /did not come through/);

  var added = await ok('PUT', '/api/poki/readings/' + r.id + '/photo', { photo: PNG });
  assert.equal(added.hasPhoto, true);
  var first = (await pool.query('SELECT photo FROM poki_meter_readings WHERE id = $1', [r.id])).rows[0].photo;
  var replaced = await ok('PUT', '/api/poki/readings/' + r.id + '/photo', { photo: PNG });
  assert.equal(replaced.hasPhoto, true);
  var second = (await pool.query('SELECT photo FROM poki_meter_readings WHERE id = $1', [r.id])).rows[0].photo;
  assert.notEqual(second.key, first.key, 'the new photo is kept in its place');

  var off = await ok('PUT', '/api/poki/readings/' + r.id + '/photo', { photo: null });
  assert.equal(off.hasPhoto, false);
  var log = (await pool.query("SELECT action, summary FROM audit_logs WHERE entity_id = $1 AND action LIKE 'poki.reading.photo%' ORDER BY at", [r.id])).rows;
  assert.deepEqual(log.map(function (l) { return l.action; }), ['poki.reading.photo', 'poki.reading.photo', 'poki.reading.photo_remove']);
  assert.match(log[0].summary, /Added the meter photo on the electricity reading for MPTEST-B2/);
  assert.match(log[1].summary, /Replaced/);

  var missing = await call('PUT', '/api/poki/readings/00000000-0000-0000-0000-000000000000/photo', { photo: PNG });
  assert.equal(missing.status, 404);
});

test('a billed reading can still take a photo: it backs the figure and changes no money', async function () {
  var today = todayISO();
  var r = await ok('POST', '/api/poki/readings', { meterId: water.id, periodStart: today, periodEnd: today, currentReading: 118 });
  var billed = await ok('POST', '/api/poki/readings/bill', { readingIds: [r.id] });
  var invoiceId = billed.invoices[0].invoiceId;
  var before = (await pool.query('SELECT grand_total FROM invoices WHERE id = $1', [invoiceId])).rows[0].grand_total;
  var withPhoto = await ok('PUT', '/api/poki/readings/' + r.id + '/photo', { photo: PNG });
  assert.equal(withPhoto.hasPhoto, true);
  assert.equal(withPhoto.invoiceId, invoiceId);
  assert.equal((await pool.query('SELECT grand_total FROM invoices WHERE id = $1', [invoiceId])).rows[0].grand_total, before);
});
