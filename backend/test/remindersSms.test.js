/*
 * Reminders by text message (reminders.service.js through sms.service.js),
 * tenants whose booking is ending, and the automatic texts — against a
 * stand-in for mNotify on localhost, so nothing is really sent.
 *
 * Customers, bills, properties and bookings use the Z7S prefix and are
 * removed afterwards. The automatic-text runs are limited to Z7S customers
 * and given their settings directly, so tests running alongside (and the
 * seeded bills) are left alone.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var svc = require('../src/services/reminders.service');
var { buildContext } = require('../src/services/context.service');

var fake, saved, admin, ids = {}, cust = {}, bookings = {};
var received = [];
var nextAnswer = null;
var ON = { autoPaymentReminders: true, autoBookingNotices: true, staffAlertsBySms: false };

function iso(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function ctxWith(perms) { return Object.assign({}, admin, { can: function (p) { return perms.indexOf(p) >= 0; } }); }
function texts() { return received.filter(function (r) { return r.path === '/api/sms/quick'; }); }
function ourCustomers() { return Object.keys(cust).map(function (k) { return cust[k]; }); }

async function cleanup() {
  await pool.query("DELETE FROM auto_texts WHERE ref_id IN (SELECT id FROM invoices WHERE invoice_no LIKE 'Z7S%') OR ref_id IN (SELECT id FROM poki_bookings WHERE booking_no LIKE 'Z7S%')");
  await pool.query("DELETE FROM sms_messages WHERE ref_id IN (SELECT id FROM invoices WHERE invoice_no LIKE 'Z7S%') OR ref_id IN (SELECT id FROM poki_bookings WHERE booking_no LIKE 'Z7S%')");
  await pool.query("DELETE FROM payment_reminders WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_no LIKE 'Z7S%')");
  await pool.query("DELETE FROM document_shares WHERE document_id IN (SELECT id FROM invoices WHERE invoice_no LIKE 'Z7S%')");
  await pool.query("DELETE FROM invoices WHERE invoice_no LIKE 'Z7S%'");
  await pool.query("DELETE FROM poki_bookings WHERE booking_no LIKE 'Z7S%'");
  await pool.query("DELETE FROM poki_units WHERE code LIKE 'Z7S%'");
  await pool.query("DELETE FROM poki_tenants WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Z7S%')");
  await pool.query("DELETE FROM poki_properties WHERE code LIKE 'Z7S%'");
  await pool.query("DELETE FROM customers WHERE name LIKE 'Z7S%'");
}

async function invoice(no, customer, companyId, kind, dueDays, balance) {
  ids[no] = (await pool.query(
    "INSERT INTO invoices (invoice_no, customer_id, company_id, doc_kind, grand_total, balance_due, status, due_date, currency) " +
    "VALUES ($1,$2,$3,$4,$5,$5,'unpaid',$6,'GHS') RETURNING id",
    [no, customer, companyId, kind, balance, iso(dueDays)]
  )).rows[0].id;
}

async function booking(no, unitId, tenantId, endDays) {
  bookings[no] = (await pool.query(
    "INSERT INTO poki_bookings (booking_no, unit_id, tenant_id, start_date, end_date, duration_months, duration_days, status) " +
    "VALUES ($1,$2,$3,$4,$5,6,0,'active') RETURNING id",
    [no, unitId, tenantId, iso(endDays - 180), iso(endDays)]
  )).rows[0].id;
}

test.before(async function () {
  saved = { apiKey: config.sms.apiKey, senderId: config.sms.senderId, baseUrl: config.sms.baseUrl };
  fake = http.createServer(function (req, res) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var url = new URL(req.url, 'http://x');
      var body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      received.push({ path: url.pathname, body: body });
      res.setHeader('Content-Type', 'application/json');
      var answer = nextAnswer || { status: 'success', code: '2000', summary: { _id: 'c' + received.length, numbers_sent: body && body.recipient, credit_used: 1, credit_left: 100 } };
      nextAnswer = null;
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise(function (done) { fake.listen(0, done); });
  Object.assign(config.sms, { apiKey: 'k', senderId: 'BambooOS', baseUrl: 'http://127.0.0.1:' + fake.address().port });

  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var bpl = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0].id;
  var pki = (await pool.query("SELECT id FROM companies WHERE code = 'PKI'")).rows[0].id;
  cust.hotel = (await pool.query("INSERT INTO customers (name, phone, contact_person) VALUES ('Z7S Hotel', '024 412 3456', 'Ama Mensah') RETURNING id")).rows[0].id;
  cust.tenant = (await pool.query("INSERT INTO customers (name, phone) VALUES ('Z7S Tenant', '020 111 2222') RETURNING id")).rows[0].id;
  cust.far = (await pool.query("INSERT INTO customers (name, phone) VALUES ('Z7S Far Tenant', '020 333 4444') RETURNING id")).rows[0].id;
  cust.nophone = (await pool.query("INSERT INTO customers (name, phone) VALUES ('Z7S Nophone', '') RETURNING id")).rows[0].id;
  await invoice('Z7S-OVERDUE', cust.hotel, bpl, 'sale', -3, 500);

  var prop = (await pool.query("INSERT INTO poki_properties (company_id, code, name) VALUES ($1, 'Z7S', 'Z7S Court') RETURNING id", [pki])).rows[0].id;
  var unitA = (await pool.query("INSERT INTO poki_units (property_id, code, name) VALUES ($1, 'Z7S-A1', 'Flat A1') RETURNING id", [prop])).rows[0].id;
  var unitB = (await pool.query("INSERT INTO poki_units (property_id, code, name) VALUES ($1, 'Z7S-B1', 'Flat B1') RETURNING id", [prop])).rows[0].id;
  var tA = (await pool.query('INSERT INTO poki_tenants (customer_id) VALUES ($1) RETURNING id', [cust.tenant])).rows[0].id;
  var tB = (await pool.query('INSERT INTO poki_tenants (customer_id) VALUES ($1) RETURNING id', [cust.far])).rows[0].id;
  await booking('Z7S-BKG-SOON', unitA, tA, 20);
  await booking('Z7S-BKG-FAR', unitB, tB, 100);
});
test.after(async function () {
  await cleanup();
  Object.assign(config.sms, saved);
  fake.close();
  await pool.end();
});

test('"Send by text": sent through mNotify at once, with the bill link; recorded as a text', async function () {
  var origin = config.corsOrigin[0];
  var before = texts().length;
  var r = await svc.sendSms(admin, ids['Z7S-OVERDUE'], origin);
  assert.equal(r.sent, true);
  assert.equal(r.channel, 'sms');
  assert.equal(r.whatsappUrl, undefined);
  var sent = texts()[before];
  assert.deepEqual(sent.body.recipient, ['0244123456']);
  assert.match(sent.body.message, /^Hello Ama Mensah,/);
  assert.match(sent.body.message, /GHS 500\.00 was due on/);
  assert.ok(sent.body.message.indexOf(origin + '/share/') >= 0, 'the link to the bill');

  var row = (await svc.due(admin, {})).rows.filter(function (x) { return x.invoiceId === ids['Z7S-OVERDUE']; })[0];
  assert.equal(row.lastReminder.channel, 'sms');
  assert.equal(row.lastReminder.automatic, false);
  assert.equal((await svc.due(admin, {})).smsAvailable, true);
  var hist = await svc.history(admin, ids['Z7S-OVERDUE']);
  assert.equal(hist[0].channel, 'sms');
});

test('a text mNotify refuses is not recorded as a reminder, and the reason comes back', async function () {
  var count = async function () { return (await pool.query('SELECT count(*)::int AS n FROM payment_reminders WHERE invoice_id = $1', [ids['Z7S-OVERDUE']])).rows[0].n; };
  var n = await count();
  nextAnswer = { status: 'error', code: '1003', message: 'Insufficient balance' };
  await assert.rejects(svc.sendSms(admin, ids['Z7S-OVERDUE'], null), /Not enough SMS credit/);
  assert.equal(await count(), n);

  var key = config.sms.apiKey;
  config.sms.apiKey = '';
  try {
    await assert.rejects(svc.sendSms(admin, ids['Z7S-OVERDUE'], null), /aren't set up/);
    assert.equal((await svc.due(admin, {})).smsAvailable, false);
  } finally { config.sms.apiKey = key; }

  await assert.rejects(svc.sendSms(ctxWith(['invoice.read']), ids['Z7S-OVERDUE'], null), /does not allow/);
});

test('bookings ending: within the window, not renewed; a notice by WhatsApp or text', async function () {
  var list = await svc.bookingsEnding(admin, {});
  var ours = list.rows.filter(function (r) { return /^Z7S/.test(r.bookingNo); });
  assert.deepEqual(ours.map(function (r) { return [r.bookingNo, r.daysLeft]; }), [['Z7S-BKG-SOON', 20]], 'not the one ending in 100 days');
  assert.equal(ours[0].unit, 'Z7S Court · Flat A1');
  assert.equal(ours[0].whatsapp, '233201112222');
  assert.ok((await svc.bookingsEnding(admin, { windowDays: 120 })).rows.some(function (r) { return r.bookingNo === 'Z7S-BKG-FAR'; }));

  var wa = await svc.noticeBooking(admin, bookings['Z7S-BKG-SOON'], 'whatsapp');
  assert.match(wa.whatsappUrl, /^https:\/\/wa\.me\/233201112222\?text=/);
  assert.match(wa.message, /Your booking for Z7S Court · Flat A1 \(Z7S-BKG-SOON\) ends on .* \(in 20 days\)\./);
  var before = texts().length;
  var viaSms = await svc.noticeBooking(admin, bookings['Z7S-BKG-SOON'], 'sms');
  assert.equal(viaSms.sent, true);
  assert.deepEqual(texts()[before].body.recipient, ['0201112222']);
  var again = (await svc.bookingsEnding(admin, {})).rows.filter(function (r) { return r.bookingNo === 'Z7S-BKG-SOON'; })[0];
  assert.equal(again.lastNotice.channel, 'sms');
  assert.equal(again.lastNotice.count, 2);

  // Read-only Poki staff see the list but can't send; no Poki access, no list.
  var readOnly = (await svc.bookingsEnding(ctxWith(['poki.read']), {})).rows.filter(function (r) { return r.bookingNo === 'Z7S-BKG-SOON'; })[0];
  assert.equal(readOnly.canSend, false);
  await assert.rejects(svc.noticeBooking(ctxWith(['poki.read']), bookings['Z7S-BKG-SOON'], 'sms'), /poki\.manage/);
  await assert.rejects(svc.bookingsEnding(ctxWith(['invoice.read']), {}), /poki\.read/);
});

test('automatic texts: once per milestone, only the most urgent, nothing old; off means off', async function () {
  var bpl = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0].id;
  await invoice('Z7S-IN3', cust.hotel, bpl, 'sale', 3, 50);        // 3 days before → "before3"
  await invoice('Z7S-TODAY', cust.hotel, bpl, 'sale', 0, 60);      // due today → "due"
  await invoice('Z7S-LATE8', cust.hotel, bpl, 'sale', -8, 70);     // 8 days late → "late7" only
  await invoice('Z7S-ANCIENT', cust.hotel, bpl, 'sale', -100, 80); // a person's job
  await invoice('Z7S-NOPH', cust.nophone, bpl, 'sale', 0, 90);     // nobody to text

  assert.equal(await svc.autoTexts({ settings: { autoPaymentReminders: false, autoBookingNotices: false }, customerIds: ourCustomers() }), 0);

  var before = texts().length;
  var n = await svc.autoTexts({ settings: ON, customerIds: ourCustomers() });
  var sent = texts().slice(before).map(function (t) { return t.body.message; });
  // Z7S-OVERDUE (3 days late → "due") too, plus the booking ending in 20 days.
  assert.equal(n, 5, sent.join('\n---\n'));
  assert.ok(sent.some(function (m) { return /GHS 50\.00 is due on/.test(m); }));
  assert.ok(sent.some(function (m) { return /GHS 60\.00 is due today/.test(m); }));
  assert.ok(sent.some(function (m) { return /GHS 70\.00 was due on .* \(8 days ago\)/.test(m); }));
  assert.ok(!sent.some(function (m) { return /GHS 80\.00/.test(m); }), 'not the bill 100 days late');
  assert.ok(sent.some(function (m) { return /booking for Z7S Court · Flat A1/.test(m); }));
  assert.ok(!sent.some(function (m) { return /Flat B1/.test(m); }), 'not the booking 100 days away');

  var late8 = (await pool.query('SELECT milestone FROM auto_texts WHERE ref_id = $1 ORDER BY milestone', [ids['Z7S-LATE8']])).rows.map(function (r) { return r.milestone; });
  assert.deepEqual(late8, ['before3', 'due', 'late7'], 'the milestones it passed are marked, one text sent');
  var rec = (await pool.query('SELECT channel, automatic, sent_by FROM payment_reminders WHERE invoice_id = $1', [ids['Z7S-LATE8']])).rows;
  assert.deepEqual(rec, [{ channel: 'sms', automatic: true, sent_by: null }]);

  assert.equal(await svc.autoTexts({ settings: ON, customerIds: ourCustomers() }), 0, 'nothing twice');
});

test('automatic texts: a refused text is tried again later, not lost', async function () {
  var bpl = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0].id;
  await invoice('Z7S-RETRY', cust.hotel, bpl, 'sale', 0, 33);
  nextAnswer = { status: 'error', code: '1003', message: 'Insufficient balance' };
  assert.equal(await svc.autoTexts({ settings: ON, customerIds: ourCustomers() }), 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM auto_texts WHERE ref_id = $1', [ids['Z7S-RETRY']])).rows[0].n, 0);
  var failed = (await pool.query("SELECT status FROM sms_messages WHERE ref_id = $1", [ids['Z7S-RETRY']])).rows;
  assert.deepEqual(failed.map(function (r) { return r.status; }), ['failed']);

  assert.equal(await svc.autoTexts({ settings: ON, customerIds: ourCustomers() }), 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_reminders WHERE invoice_id = $1 AND automatic", [ids['Z7S-RETRY']])).rows[0].n, 1);
});
