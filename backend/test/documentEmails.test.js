/*
 * Emails to customers (documentEmails.service.js, documentPdf.service.js):
 * an invoice or quotation from its preview with the PDF attached and a link,
 * payment receipts and reminders on their own, and the switches for them.
 *
 * Nothing leaves the machine: mail goes to an outbox (mail.setTransportForTests).
 * Customers and documents use the Z7E prefix and are removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var config = require('../src/config');
var mail = require('../src/services/mail.service');
var shares = require('../src/services/shares.service');
var emails = require('../src/services/documentEmails.service');
var invoices = require('../src/services/invoices.service');
var quotations = require('../src/services/quotations.service');
var reminders = require('../src/services/reminders.service');
var { buildContext } = require('../src/services/context.service');

var admin, cust, noEmail, outbox = [];
var ORIGIN = config.corsOrigin[0];
function ctxWith(perms) { return Object.assign({}, admin, { can: function (p) { return perms.indexOf(p) >= 0; } }); }
function iso(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, ms) { var t = Date.now(); while (Date.now() - t < (ms || 3000)) { if (fn()) return true; await wait(25); } return false; }

async function cleanup() {
  var inv = "(SELECT id FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Z7E%'))";
  var quo = "(SELECT id FROM quotations WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Z7E%'))";
  await pool.query('DELETE FROM document_emails WHERE document_id IN ' + inv + ' OR document_id IN ' + quo +
    ' OR document_id IN (SELECT id FROM receipts WHERE invoice_id IN ' + inv + ')');
  await pool.query('DELETE FROM auto_texts WHERE ref_id IN ' + inv);
  await pool.query('DELETE FROM payment_reminders WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM document_shares WHERE document_id IN ' + inv + ' OR document_id IN ' + quo);
  await pool.query('DELETE FROM receipts WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM payments WHERE invoice_id IN ' + inv);
  await pool.query("DELETE FROM document_line_items WHERE document_id IN " + inv + " OR document_id IN " + quo);
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query('DELETE FROM quotations WHERE id IN ' + quo);
  await pool.query("DELETE FROM customers WHERE name LIKE 'Z7E%'");
}
async function newInvoice(customerId, extra) {
  return invoices.createManual(admin, Object.assign({
    customerId: customerId,
    items: [{ description: 'Z7E Bamboo floor panel', qty: 10, unitPrice: 120 }, { description: 'Z7E Skirting', qty: 5, unitPrice: 30, discount: 10, discountType: 'percent' }]
  }, extra || {}));
}

test.before(async function () {
  await cleanup();
  mail.setTransportForTests({ sendMail: async function (m) { outbox.push(m); return { messageId: 'z7e' + outbox.length }; } });
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = (await pool.query("INSERT INTO customers (name, contact_person, email, phone) VALUES ('Z7E Coastal Builders', 'Ama Mensah', 'z7e.buyer@example.com', '0240000001') RETURNING id")).rows[0].id;
  noEmail = (await pool.query("INSERT INTO customers (name, email) VALUES ('Z7E No Email', '') RETURNING id")).rows[0].id;
  await pool.query("UPDATE settings SET client_emails = '{}' WHERE id = 1");
});
test.after(async function () {
  await wait(100);
  await cleanup();
  await pool.query("UPDATE settings SET client_emails = '{}' WHERE id = 1");
  mail.setTransportForTests(null);
  await pool.end();
});

test('an invoice from its preview: the draft to read, then the email with the PDF and a link', async function () {
  var inv = await newInvoice(cust);
  var d = await emails.draft(admin, 'invoice', inv.id);
  assert.equal(d.to, 'z7e.buyer@example.com');
  assert.equal(d.subject, 'Invoice ' + inv.invoiceNo + ' from Bamboo Products Limited');
  assert.match(d.message, /^Hello Ama Mensah,/);
  assert.match(d.message, /Please find attached invoice .* for GHS 1,335\.00/);
  assert.equal(d.attachment, 'Invoice-' + inv.invoiceNo + '.pdf');
  assert.deepEqual(d.history, []);

  outbox.length = 0;
  var r = await emails.send(admin, 'invoice', inv.id, {
    to: 'z7e.buyer@example.com', cc: 'z7e.accounts@example.com; z7e.boss@example.com', subject: d.subject,
    message: d.message + '\n\nZ7E extra line from the clerk.', origin: ORIGIN
  });
  assert.equal(r.sent, true);
  assert.equal(outbox.length, 1);
  var m = outbox[0];
  assert.equal(m.to, 'z7e.buyer@example.com');
  assert.deepEqual(m.cc, ['z7e.accounts@example.com', 'z7e.boss@example.com']);
  assert.equal(m.from.name, 'Bamboo Products Limited');
  assert.equal(m.subject, d.subject);
  assert.match(m.text, /Z7E extra line from the clerk\./);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'Invoice-' + inv.invoiceNo + '.pdf');
  assert.equal(m.attachments[0].content.slice(0, 5).toString(), '%PDF-');
  assert.ok(m.attachments[0].content.length > 2000);

  // The link opens the same invoice, for 30 days.
  var link = new RegExp(ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/share/([A-Za-z0-9_-]+)').exec(m.html);
  assert.ok(link, 'a link to the invoice in the email');
  var shared = await shares.getSharedDocument(link[1]);
  assert.equal(shared.docNo, inv.invoiceNo);
  assert.equal(shared.bankInstructions, undefined, 'the page behind the link shows what it always did');

  var again = await emails.draft(admin, 'invoice', inv.id);
  assert.equal(again.history.length, 1);
  assert.equal(again.history[0].to, 'z7e.buyer@example.com');
  assert.equal(again.history[0].automatic, false);
  assert.ok(again.history[0].by);
});

test('what is refused: a wrong address, no message, a voided invoice, and people without the right', async function () {
  var inv = await newInvoice(cust);
  var base = { to: 'z7e.buyer@example.com', subject: 'x', message: 'y' };
  await assert.rejects(emails.send(admin, 'invoice', inv.id, Object.assign({}, base, { to: 'not-an-address' })), /isn't an email address/);
  await assert.rejects(emails.send(admin, 'invoice', inv.id, Object.assign({}, base, { cc: 'ok@example.com, nope' })), /Copy to: "nope"/);
  await assert.rejects(emails.send(admin, 'invoice', inv.id, Object.assign({}, base, { message: '  ' })), /Write a message/);
  await assert.rejects(emails.draft(ctxWith(['invoice.read']), 'invoice', inv.id), /does not allow/);
  await assert.rejects(emails.draft(admin, 'payslip', inv.id), /Unknown document type/);
  await pool.query("UPDATE invoices SET status = 'void' WHERE id = $1", [inv.id]);
  await assert.rejects(emails.send(admin, 'invoice', inv.id, base), /voided/);
});

test('a quotation goes the same way, with its own words', async function () {
  var q = await quotations.create(admin, { customerId: cust, items: [{ description: 'Z7E Pergola', qty: 1, unitPrice: 4200 }] });
  var d = await emails.draft(admin, 'quotation', q.id);
  assert.match(d.subject, /^Quotation .* from Bamboo Products Limited$/);
  assert.match(d.message, /our quotation .* for GHS 4,200\.00/);
  outbox.length = 0;
  await emails.send(admin, 'quotation', q.id, { to: d.to, subject: d.subject, message: d.message, origin: ORIGIN });
  assert.match(outbox[0].attachments[0].filename, /^Quotation-.*\.pdf$/);
  await assert.rejects(emails.draft(ctxWith(['invoice.manage']), 'quotation', q.id), /does not allow/);
});

test('a receipt goes on its own when a payment is recorded — once each, and not when switched off', async function () {
  var inv = await newInvoice(cust);
  outbox.length = 0;
  var paid = await invoices.recordPayment(admin, inv.id, { amount: 500, method: 'mobile_money', reference: 'Z7E-MOMO-1' });
  assert.ok(await until(function () { return outbox.length === 1; }), 'the receipt email went');
  var m = outbox[0];
  assert.equal(m.to, 'z7e.buyer@example.com');
  assert.match(m.subject, /^Receipt .*: payment of GHS 500\.00 received$/);
  assert.match(m.text, /balance still to pay .* is GHS 835\.00/);
  assert.equal(m.attachments[0].filename, 'Receipt-' + paid.receipt.receiptNo + '.pdf');
  var rows = (await pool.query("SELECT automatic, kind FROM document_emails WHERE document_type = 'receipt' AND document_id = $1", [paid.receipt.id])).rows;
  assert.deepEqual(rows, [{ automatic: true, kind: 'receipt' }]);
  // Asked again (two servers, a retry): still one.
  assert.equal(await emails.afterPayment(paid.receipt.id), false);
  assert.equal(outbox.length, 1);

  await pool.query("UPDATE settings SET client_emails = '{\"autoReceipts\": false}' WHERE id = 1");
  await invoices.recordPayment(admin, inv.id, { amount: 835, method: 'cash' });
  await wait(300);
  assert.equal(outbox.length, 1, 'switched off: no receipt');
  await pool.query("UPDATE settings SET client_emails = '{}' WHERE id = 1");

  // No address on file: nothing, and the payment stands.
  var other = await newInvoice(noEmail);
  var p2 = await invoices.recordPayment(admin, other.id, { amount: 100, method: 'cash' });
  await wait(300);
  assert.equal(outbox.length, 1);
  assert.equal(p2.invoice.balanceDue, 1235);
});

test('a payment reminder by email, from the reminders list', async function () {
  var inv = await newInvoice(cust);
  await pool.query('UPDATE invoices SET due_date = $1 WHERE id = $2', [iso(-4), inv.id]);
  var list = await reminders.due(admin, {});
  var row = list.rows.find(function (r) { return r.invoiceId === inv.id; });
  assert.equal(row.email, 'z7e.buyer@example.com');
  assert.equal(list.emailAvailable, true);
  outbox.length = 0;
  var r = await reminders.sendEmail(admin, inv.id, ORIGIN);
  assert.equal(r.channel, 'email');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].subject, 'Overdue: invoice ' + inv.invoiceNo + ' (GHS 1,335.00)');
  assert.match(outbox[0].text, /friendly reminder from Bamboo Products Limited that invoice .* was due on/);
  assert.match(outbox[0].attachments[0].filename, /^Invoice-/);
  var h = await reminders.history(admin, inv.id);
  assert.equal(h[0].channel, 'email');
  assert.equal(h[0].email, 'z7e.buyer@example.com');

  var bare = await newInvoice(noEmail);
  await pool.query('UPDATE invoices SET due_date = $1 WHERE id = $2', [iso(-2), bare.id]);
  await assert.rejects(reminders.sendEmail(admin, bare.id, ORIGIN), /no email address on file/);
});

test('payment reminders by email on their own: once per point, only with an address, and not when switched off', async function () {
  var late = await newInvoice(cust);
  await pool.query('UPDATE invoices SET due_date = $1 WHERE id = $2', [iso(-8), late.id]);
  var bare = await newInvoice(noEmail);
  await pool.query('UPDATE invoices SET due_date = $1 WHERE id = $2', [iso(-8), bare.id]);
  var only = { customerIds: [cust, noEmail] };

  await pool.query("UPDATE settings SET client_emails = '{\"autoReminders\": false}' WHERE id = 1");
  outbox.length = 0;
  assert.equal(await emails.autoReminders(only), 0);
  await pool.query("UPDATE settings SET client_emails = '{}' WHERE id = 1");

  var n = await emails.autoReminders(only);
  var mine = outbox.filter(function (m) { return m.to === 'z7e.buyer@example.com'; });
  assert.ok(n >= 1);
  assert.equal(mine.filter(function (m) { return m.text.indexOf(late.invoiceNo) >= 0; }).length, 1, 'one email for 8 days late, not three');
  var points = (await pool.query("SELECT milestone FROM auto_texts WHERE kind = 'bill_email' AND ref_id = $1 ORDER BY milestone", [late.id])).rows.map(function (r) { return r.milestone; });
  assert.deepEqual(points, ['before3', 'due', 'late7']);
  var rem = (await pool.query("SELECT channel, automatic, email FROM payment_reminders WHERE invoice_id = $1", [late.id])).rows;
  assert.deepEqual(rem, [{ channel: 'email', automatic: true, email: 'z7e.buyer@example.com' }]);

  outbox.length = 0;
  await emails.autoReminders(only);
  assert.equal(outbox.filter(function (m) { return m.text.indexOf(late.invoiceNo) >= 0; }).length, 0, 'not again at the same point');
});

test('the switches, for people who manage settings', async function () {
  var s = await emails.status(admin);
  assert.deepEqual(s.settings, { autoReminders: true, autoReceipts: true });
  var saved = await emails.saveSettings(admin, { autoReminders: false });
  assert.deepEqual(saved.settings, { autoReminders: false, autoReceipts: true });
  await assert.rejects(emails.saveSettings(ctxWith(['invoice.manage']), { autoReceipts: false }), /settings\.manage/);
  await emails.saveSettings(admin, { autoReminders: true });
});
