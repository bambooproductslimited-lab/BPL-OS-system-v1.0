/*
 * Payment reminders (reminders.service.js) and the morning alert to staff
 * (jobs/morningDigest.js).
 *
 * Invoices and customers use the Z6R prefix and are removed afterwards.
 * Requires `npm run migrate && npm run seed` first (the pretest hook).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var config = require('../src/config');
var svc = require('../src/services/reminders.service');
var digest = require('../src/jobs/morningDigest');
var { buildContext } = require('../src/services/context.service');

var admin, bplCust, pokiCust, noPhone, ids = {};
function iso(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function ctxWith(perms) {
  return Object.assign({}, admin, { can: function (p) { return perms.indexOf(p) >= 0; } });
}

async function cleanup() {
  await pool.query("DELETE FROM payment_reminders WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_no LIKE 'Z6R%')");
  await pool.query("DELETE FROM document_shares WHERE document_id IN (SELECT id FROM invoices WHERE invoice_no LIKE 'Z6R%')");
  await pool.query("DELETE FROM invoices WHERE invoice_no LIKE 'Z6R%'");
  await pool.query("DELETE FROM customers WHERE name LIKE 'Z6R%'");
  await pool.query("DELETE FROM notifications WHERE title IN ('Payments to chase today', 'Stock to reorder') AND at > now() - interval '1 hour'");
  await pool.query("DELETE FROM staff_digests WHERE date >= CURRENT_DATE - 1");
}

async function invoice(no, customer, companyId, kind, dueDays, balance, status) {
  var r = await pool.query(
    "INSERT INTO invoices (invoice_no, customer_id, company_id, doc_kind, grand_total, balance_due, status, due_date, currency) " +
    "VALUES ($1,$2,$3,$4,$5,$5,$6,$7,'GHS') RETURNING id",
    [no, customer, companyId, kind, balance, status || 'unpaid', iso(dueDays)]
  );
  ids[no] = r.rows[0].id;
}

test.before(async function () {
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var bpl = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0].id;
  var pki = (await pool.query("SELECT id FROM companies WHERE code = 'PKI'")).rows[0].id;
  bplCust = (await pool.query("INSERT INTO customers (name, phone, contact_person) VALUES ('Z6R Hotel', '024 412 3456', 'Ama Mensah') RETURNING id")).rows[0].id;
  pokiCust = (await pool.query("INSERT INTO customers (name, phone) VALUES ('Z6R Tenant', '+233 20 111 2222') RETURNING id")).rows[0].id;
  noPhone = (await pool.query("INSERT INTO customers (name, phone) VALUES ('Z6R No Phone', '') RETURNING id")).rows[0].id;
  await invoice('Z6R-OVERDUE', bplCust, bpl, 'sale', -3, 500);
  await invoice('Z6R-SOON', bplCust, bpl, 'sale', 2, 120.5);
  await invoice('Z6R-LATER', bplCust, bpl, 'sale', 20, 99);
  await invoice('Z6R-PAID', bplCust, bpl, 'sale', -5, 0, 'paid');
  await invoice('Z6R-RENT', pokiCust, pki, 'rent', -1, 2500);
  await invoice('Z6R-NOPHONE', noPhone, bpl, 'sale', -1, 10);
});
test.after(async function () { await cleanup(); await pool.end(); });

function ours(list) { return list.rows.filter(function (r) { return /^Z6R/.test(r.invoiceNo); }); }

test('Ghana phone numbers are turned into WhatsApp numbers', function () {
  assert.equal(svc.whatsappNumber('024 412 3456'), '233244123456');
  assert.equal(svc.whatsappNumber('+233 24 412 3456'), '233244123456');
  assert.equal(svc.whatsappNumber('00233244123456'), '233244123456');
  assert.equal(svc.whatsappNumber('244123456'), '233244123456');
  assert.equal(svc.whatsappNumber('+44 7700 900123'), '447700900123');
  assert.equal(svc.whatsappNumber('12345'), null);
  assert.equal(svc.whatsappNumber(''), null);
});

test('the list: unpaid bills overdue or due within the window, most overdue first', async function () {
  var rows = ours(await svc.due(admin, {}));
  assert.deepEqual(rows.map(function (r) { return [r.invoiceNo, r.daysOverdue]; }), [
    ['Z6R-OVERDUE', 3], ['Z6R-NOPHONE', 1], ['Z6R-RENT', 1], ['Z6R-SOON', -2]
  ], 'not the one due in 20 days, not the paid one');
  var rent = rows.filter(function (r) { return r.invoiceNo === 'Z6R-RENT'; })[0];
  assert.equal(rent.company, 'poki');
  assert.equal(rent.whatsapp, '233201112222');
  assert.equal(rent.canSend, true);
  assert.ok(ours(await svc.due(admin, { windowDays: 30 })).some(function (r) { return r.invoiceNo === 'Z6R-LATER'; }));
});

test('each company\'s bills only for people who may see them; sending needs the manage permission', async function () {
  await assert.rejects(svc.due(ctxWith([]), {}), /forbidden|does not allow/);
  var bplOnly = ours(await svc.due(ctxWith(['invoice.read']), {}));
  assert.ok(bplOnly.length && bplOnly.every(function (r) { return r.company === 'bpl' && !r.canSend; }));
  var pokiOnly = ours(await svc.due(ctxWith(['poki.read']), {}));
  assert.deepEqual(pokiOnly.map(function (r) { return r.invoiceNo; }), ['Z6R-RENT']);
  await assert.rejects(svc.prepare(ctxWith(['invoice.read']), ids['Z6R-OVERDUE'], null), /does not allow sending/);
  await assert.rejects(svc.prepare(ctxWith(['invoice.read', 'invoice.manage']), ids['Z6R-RENT'], null), /not due, or you can't see it/);
});

test('a reminder: the message, a WhatsApp link to the customer, a link to the bill, and a record of it', async function () {
  var origin = config.corsOrigin[0];
  var r = await svc.prepare(admin, ids['Z6R-OVERDUE'], origin);
  assert.equal(r.phone, '233244123456');
  assert.ok(r.whatsappUrl.indexOf('https://wa.me/233244123456?text=') === 0);
  assert.match(r.message, /^Hello Ama Mensah,/);
  assert.match(r.message, /invoice Z6R-OVERDUE of GHS 500\.00 was due on .* \(3 days ago\)\./);
  assert.match(r.message, new RegExp('You can view it here: ' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/share/[A-Za-z0-9_-]+'));
  assert.match(r.message, /If you have already paid/);
  assert.equal(decodeURIComponent(r.whatsappUrl.split('?text=')[1]), r.message);

  var noLink = await svc.prepare(admin, ids['Z6R-SOON'], 'https://evil.example');
  assert.doesNotMatch(noLink.message, /view it here/, 'a link only to our own address');
  assert.match(noLink.message, /is due on/);

  var rent = await svc.prepare(admin, ids['Z6R-RENT'], null);
  assert.match(rent.message, /friendly reminder from Poki Properties that your rent of GHS 2,500\.00 was due on/);
  assert.match(rent.message, /Reference: Z6R-RENT\./);

  await assert.rejects(svc.prepare(admin, ids['Z6R-NOPHONE'], null), /has no phone number on file/);

  var row = ours(await svc.due(admin, {})).filter(function (x) { return x.invoiceNo === 'Z6R-OVERDUE'; })[0];
  assert.equal(row.lastReminder.count, 1);
  assert.ok(row.lastReminder.by);
  var h = await svc.history(admin, ids['Z6R-OVERDUE']);
  assert.equal(h.length, 1);
  assert.equal(h[0].message, r.message);
});

test('the morning alert tells each person what they can act on, once a day, not before 07:00', async function () {
  var d = await digest.digestFor(admin);
  assert.equal(d.title, 'Payments to chase today');
  assert.match(d.body, /bills? overdue \(GHS [\d,.]+\)/);
  assert.equal(d.link, 'reminders', 'a route name, as the bell expects');
  assert.equal(await digest.digestFor(ctxWith([])), null, 'nothing for someone who can see none of it');

  var early = new Date(); early.setUTCHours(6, 30, 0, 0);
  assert.equal(await digest.runOnce(early), 0);
  var morning = new Date(); morning.setUTCHours(8, 0, 0, 0);
  var sent = await digest.runOnce(morning);
  assert.ok(sent >= 1);
  assert.equal(await digest.runOnce(morning), 0, 'once a day');
  var n = await pool.query("SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND title = 'Payments to chase today' AND at > now() - interval '1 hour'", [admin.employee.id]);
  assert.equal(n.rows[0].n, 1);
});
