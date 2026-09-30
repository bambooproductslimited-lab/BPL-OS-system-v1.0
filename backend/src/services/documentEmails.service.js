var { pool } = require('../db/pool');
var config = require('../config');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { todayISO, bplScopeClause } = require('../utils/documents');
var mail = require('./mail.service');
var shares = require('./shares.service');
var pdf = require('./documentPdf.service');

// Emails to customers and tenants, through the company's mailbox
// (mail.service.js), each with the document as a PDF (documentPdf.service.js)
// and a link to view it online (a share link, 30 days):
//
//   - an invoice, quotation, estimate or Poki bill: only when someone presses
//     Email on its preview, after reading (and if they like, changing) the
//     message;
//   - a payment reminder: from the reminders list, or on its own at the same
//     points as the automatic texts (3 days before the due date, on the day,
//     7 and 30 days after);
//   - a payment receipt: on its own, as soon as a payment is recorded.
//
// The automatic ones can be switched off in Company settings → Email. Every
// email is recorded (document_emails), so each document shows what went to
// whom, when, and whether a person or the OS sent it.

var SETTINGS_DEFAULTS = { autoReminders: true, autoReceipts: true };
// However many are due, no more than this many automatic emails a day — a
// free Gmail mailbox sends about 500, and a mistake (a bad import, a wrong
// due date on 300 bills) must not use them all up.
var AUTO_DAILY_LIMIT = 150;
var LINK_DAYS = 30;
var AUTO_BILL_MAX_OVERDUE = 45;
var BILL_MILESTONES = [{ key: 'before3', at: -3 }, { key: 'due', at: 0 }, { key: 'late7', at: 7 }, { key: 'late30', at: 30 }];

var TABLE = { invoice: 'invoices', quotation: 'quotations', estimate: 'estimates' };
var LABEL = { invoice: 'Invoice', quotation: 'Quotation', estimate: 'Estimate', receipt: 'Receipt' };
var UUID = /^[0-9a-f-]{36}$/i;

// ---- settings -----------------------------------------------------------------

async function settings() {
  var r = (await pool.query('SELECT client_emails FROM settings WHERE id = 1')).rows[0];
  return Object.assign({}, SETTINGS_DEFAULTS, (r && r.client_emails) || {});
}
async function saveSettings(ctx, p) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var current = await settings(), next = {};
  Object.keys(SETTINGS_DEFAULTS).forEach(function (k) { next[k] = p && p[k] !== undefined ? !!p[k] : current[k]; });
  await pool.query('UPDATE settings SET client_emails = $1 WHERE id = 1', [JSON.stringify(next)]);
  await audit(pool, ctx, 'settings.client_emails', 'settings', '1',
    'Automatic emails to customers: payment reminders ' + (next.autoReminders ? 'on' : 'off') + ', receipts ' + (next.autoReceipts ? 'on' : 'off') + '.');
  return status(ctx);
}
async function status(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var month = (await pool.query(
    "SELECT count(*) FILTER (WHERE automatic)::int AS automatic, count(*)::int AS total FROM document_emails WHERE sent_at >= date_trunc('month', now())")).rows[0];
  return { configured: mail.configured(), settings: await settings(), dailyLimit: AUTO_DAILY_LIMIT, thisMonth: month, appUrl: config.appUrl || null };
}

// ---- who may, and about what ------------------------------------------------------

async function pokiCompanyId() { return require('./poki.service').pokiCompanyId(); }

// A document's company decides who may email it: Poki's bills and estimates
// need Poki access, the group's need invoicing or quotations.
async function permissionFor(type, companyId) {
  if (companyId && companyId === await pokiCompanyId()) return 'poki.manage';
  return type === 'quotation' || type === 'estimate' ? 'quotation.manage' : 'invoice.manage';
}

// Everything an email about one document needs.
async function target(type, id) {
  if (!UUID.test(String(id))) fail('notfound', 'Document not found.');
  if (type === 'receipt') {
    var r = (await pool.query(
      'SELECT r.id, r.receipt_no, r.invoice_id, r.date, r.amount, r.method, r.balance_after, i.invoice_no, i.currency, i.company_id, ' +
      '       c.name AS customer_name, c.contact_person, c.email ' +
      'FROM receipts r JOIN invoices i ON i.id = r.invoice_id JOIN customers c ON c.id = r.customer_id WHERE r.id = $1', [id])).rows[0];
    if (!r) fail('notfound', 'Receipt not found.');
    return {
      type: 'receipt', id: r.id, docNo: r.receipt_no, companyId: r.company_id, currency: r.currency,
      customerName: r.customer_name, contactPerson: r.contact_person || '', email: r.email || '',
      linkType: 'invoice', linkId: r.invoice_id, receipt: r, filename: 'Receipt-' + safeName(r.receipt_no) + '.pdf'
    };
  }
  if (!TABLE[type]) fail('invalid', 'Unknown document type.');
  var no = type === 'invoice' ? 'invoice_no' : type === 'quotation' ? 'quote_no' : 'estimate_no';
  var d = (await pool.query(
    'SELECT d.id, d.' + no + ' AS doc_no, d.company_id, d.currency, d.status, d.grand_total, ' +
    (type === 'invoice' ? 'd.balance_due, d.amount_paid, d.due_date::text AS due_date, d.doc_kind, NULL::text AS valid_until, ' : 'NULL::numeric AS balance_due, NULL::numeric AS amount_paid, NULL::text AS due_date, NULL::text AS doc_kind, d.valid_until::text AS valid_until, ') +
    '       c.name AS customer_name, c.contact_person, c.email ' +
    'FROM ' + TABLE[type] + ' d JOIN customers c ON c.id = d.customer_id WHERE d.id = $1', [id])).rows[0];
  if (!d) fail('notfound', 'Document not found.');
  return {
    type: type, id: d.id, docNo: d.doc_no, companyId: d.company_id, currency: d.currency, status: d.status,
    grandTotal: Number(d.grand_total), balanceDue: d.balance_due == null ? null : Number(d.balance_due), amountPaid: d.amount_paid == null ? null : Number(d.amount_paid),
    dueDate: d.due_date, validUntil: d.valid_until, kind: d.doc_kind,
    customerName: d.customer_name, contactPerson: d.contact_person || '', email: d.email || '',
    linkType: type, linkId: d.id, filename: LABEL[type] + '-' + safeName(d.doc_no) + '.pdf'
  };
}
function safeName(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '-'); }

// ---- the words ----------------------------------------------------------------------
// English, like the documents themselves, and polite: this goes to paying
// customers. Staff may change the message before an invoice or quotation
// goes; the link and the PDF are added whatever they write.

function hello(t) { var n = (t.contactPerson || t.customerName || '').trim(); return n ? 'Hello ' + n + ',' : 'Hello,'; }
function money(t, n) { return pdf.money(n, t.currency); }

function compose(t, lh) {
  var company = lh.name, lines, subject;
  if (t.type === 'invoice') {
    subject = 'Invoice ' + t.docNo + ' from ' + company;
    lines = [hello(t), '',
      'Please find attached invoice ' + t.docNo + ' for ' + money(t, t.grandTotal) + (t.dueDate ? ', due on ' + pdf.docDate(t.dueDate) : '') + '.'];
    if (t.amountPaid > 0 && t.balanceDue > 0) lines.push('Paid so far: ' + money(t, t.amountPaid) + '. Balance due: ' + money(t, t.balanceDue) + '.');
    if (t.balanceDue != null && t.balanceDue <= 0.005) lines.push('This invoice is paid in full. Thank you.');
    lines.push('', 'Thank you for your business.');
  } else if (t.type === 'quotation' || t.type === 'estimate') {
    var what = t.type === 'quotation' ? 'quotation' : 'estimate';
    subject = LABEL[t.type] + ' ' + t.docNo + ' from ' + company;
    lines = [hello(t), '',
      'Please find attached our ' + what + ' ' + t.docNo + ' for ' + money(t, t.grandTotal) + (t.validUntil ? ', valid until ' + pdf.docDate(t.validUntil) : '') + '.',
      'We would be glad to answer any questions, and to go ahead whenever you are ready.'];
  } else {
    var r = t.receipt, balance = Number(r.balance_after);
    subject = 'Receipt ' + t.docNo + ': payment of ' + money(t, r.amount) + ' received';
    lines = [hello(t), '',
      'Thank you for your payment of ' + money(t, r.amount) + ' on ' + pdf.docDate(r.date) + ' for invoice ' + r.invoice_no + '. Your receipt is attached.',
      balance > 0.005 ? 'The balance still to pay on invoice ' + r.invoice_no + ' is ' + money(t, balance) + '.' : 'Invoice ' + r.invoice_no + ' is now paid in full.'];
  }
  lines.push('', 'Kind regards,', company);
  return { subject: subject, message: lines.join('\n') };
}

// The email itself: the message as written, a button to the document online,
// and who it is from.
function build(message, lh, t, link) {
  var esc = mail.escapeHtml;
  var what = LABEL[t.linkType === 'invoice' && t.type === 'receipt' ? 'invoice' : t.type].toLowerCase();
  var linkText = t.type === 'receipt' ? 'View the invoice online' : 'View the ' + what + ' online';
  var until = pdf.docDate(link.expiresAt);
  var text = message.trim() + '\n\n' + linkText + ' (the PDF is attached): ' + link.url + '\nThe link works until ' + until + '.\n';
  var paragraphs = message.trim().split(/\n{2,}/).map(function (p) {
    return '<p style="margin:0 0 14px">' + esc(p).replace(/\n/g, '<br>') + '</p>';
  }).join('');
  var html =
    '<div style="background:#f4f3ef;padding:24px 12px">' +
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 28px 22px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#201e1d">' +
    '<p style="color:#3f7d3b;font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 18px">' + esc(lh.name) + '</p>' +
    paragraphs +
    '<p style="margin:22px 0 8px"><a href="' + esc(link.url) + '" style="display:inline-block;background:#3f7d3b;color:#ffffff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px">' + esc(linkText) + '</a></p>' +
    '<p style="margin:0 0 20px;color:#6b6966;font-size:12.5px">The PDF is attached. The link works until ' + esc(until) + '.</p>' +
    '<p style="margin:0;border-top:1px solid #e6e4df;padding-top:12px;color:#6b6966;font-size:12px">' + esc(lh.name) + (lh.lines && lh.lines.length ? '<br>' + lh.lines.map(esc).join('<br>') : '') + '</p>' +
    '</div></div>';
  return { text: text, html: html };
}

// Sends one email about a document and records it. Returns what went.
async function deliver(t, o) {
  var lh = await pdf.letterheadFor(t.companyId);
  var file = t.type === 'receipt' ? await pdf.receiptPdf(t.id) : await pdf.documentPdf(t.type, t.id);
  var issued = await shares.issueLink(t.linkType, t.linkId, LINK_DAYS, o.sentBy);
  var link = { url: (o.base || config.appUrl) + '/share/' + issued.token, expiresAt: issued.expiresAt };
  var body = build(o.message, lh, t, link);
  await mail.send({
    to: o.to, cc: o.cc, subject: o.subject, text: body.text, html: body.html, fromName: lh.name, replyTo: lh.email,
    attachments: [{ filename: file.filename, content: file.buffer, contentType: 'application/pdf' }]
  });
  var row = (await pool.query(
    'INSERT INTO document_emails (document_type, document_id, kind, to_address, cc, subject, automatic, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ' +
    'ON CONFLICT DO NOTHING RETURNING sent_at',
    [t.type, t.id, o.kind, o.to, (o.cc || []).join(', '), o.subject, !!o.automatic, o.sentBy || null])).rows[0];
  return { sent: true, to: o.to, cc: o.cc || [], subject: o.subject, at: row ? row.sent_at : new Date(), attachment: file.filename, linkUntil: link.expiresAt };
}

// ---- from a document's preview ----------------------------------------------------

function sentRow(r) {
  return { at: r.sent_at, to: r.to_address, cc: r.cc, subject: r.subject, kind: r.kind, automatic: r.automatic, by: r.first_name ? r.first_name + ' ' + r.last_name : null };
}
async function history(type, id) {
  return (await pool.query(
    'SELECT de.*, e.first_name, e.last_name FROM document_emails de LEFT JOIN employees e ON e.id = de.sent_by ' +
    'WHERE de.document_type = $1 AND de.document_id = $2 ORDER BY de.sent_at DESC LIMIT 20', [type, id])).rows.map(sentRow);
}

// GET /api/document-emails/:type/:id — the email as it would go, to read
// and change before sending, and what was sent before.
async function draft(ctx, type, id) {
  var t = await target(type, id);
  if (!ctx.can(await permissionFor(t.type, t.companyId))) fail('forbidden', 'Your role does not allow emailing this document.');
  var lh = await pdf.letterheadFor(t.companyId);
  var c = compose(t, lh);
  return {
    configured: mail.configured(), to: t.email, customerName: t.customerName, cc: '', subject: c.subject, message: c.message,
    from: lh.name, attachment: t.filename, linkDays: LINK_DAYS, history: await history(t.type, t.id)
  };
}

// POST /api/document-emails/:type/:id { to, cc, subject, message, origin }
async function send(ctx, type, id, p) {
  p = p || {};
  var t = await target(type, id);
  if (!ctx.can(await permissionFor(t.type, t.companyId))) fail('forbidden', 'Your role does not allow emailing this document.');
  if (t.status === 'void') fail('conflict', 'This ' + LABEL[t.type].toLowerCase() + ' has been voided; it can\'t be sent.');
  var to = String(p.to || '').trim();
  if (!mail.isEmail(to)) fail('invalid', to ? '"' + to.slice(0, 80) + '" isn\'t an email address.' : 'Enter the email address to send it to.');
  var cc = mail.addressList(p.cc, 'Copy to');
  var subject = String(p.subject || '').replace(/[\r\n]+/g, ' ').trim();
  if (!subject) fail('invalid', 'Enter a subject.');
  if (subject.length > 200) fail('invalid', 'The subject is too long (200 characters at most).');
  var message = String(p.message || '').trim();
  if (!message) fail('invalid', 'Write a message.');
  if (message.length > 5000) fail('invalid', 'The message is too long (5,000 characters at most).');
  var out = await deliver(t, {
    to: to, cc: cc, subject: subject, message: message, kind: t.type === 'receipt' ? 'receipt' : 'document',
    sentBy: ctx.employee.id, base: shareBase(p.origin)
  });
  await audit(pool, ctx, 'mail.document', t.type, t.id, 'Emailed ' + LABEL[t.type].toLowerCase() + ' ' + t.docNo + ' to ' + to + (cc.length ? ' (copy to ' + cc.join(', ') + ')' : '') + '.');
  out.history = await history(t.type, t.id);
  return out;
}

// Links go to the address the person is using the OS on, when it is one of
// ours; otherwise to the OS's own address.
function shareBase(origin) {
  var o = String(origin || '').replace(/\/+$/, '');
  return o && config.corsOrigin.indexOf(o) >= 0 ? o : config.appUrl;
}

// ---- receipts, on their own -------------------------------------------------------

// Right after a payment is recorded (invoices.service.js recordPayment).
// Never throws: the payment stands whether or not the email goes.
async function afterPayment(receiptId) {
  try {
    if (!mail.configured() || !config.appUrl) return false;
    if (!(await settings()).autoReceipts) return false;
    var t = await target('receipt', receiptId);
    if (!mail.isEmail(t.email)) return false;
    // Claimed first, so two instances can't both send it.
    var claim = await pool.query(
      "INSERT INTO document_emails (document_type, document_id, kind, to_address, subject, automatic) VALUES ('receipt', $1, 'receipt', $2, '', true) ON CONFLICT DO NOTHING RETURNING id",
      [t.id, t.email]);
    if (!claim.rowCount) return false;
    var lh = await pdf.letterheadFor(t.companyId), c = compose(t, lh);
    try {
      await deliver(t, { to: t.email, subject: c.subject, message: c.message, kind: 'receipt', automatic: true });
    } catch (e) {
      await pool.query('DELETE FROM document_emails WHERE id = $1', [claim.rows[0].id]);
      throw e;
    }
    await pool.query('UPDATE document_emails SET subject = $2 WHERE id = $1', [claim.rows[0].id, c.subject]);
    return true;
  } catch (e) {
    console.error('Receipt email not sent:', e.message);
    return false;
  }
}

// ---- payment reminders --------------------------------------------------------------

// One reminder email for one bill; the words are the text message's
// (reminders.service.js composeMessage), with the bill attached and linked.
async function reminderEmail(b, o) {
  var reminders = require('./reminders.service');
  var t = await target('invoice', b.invoiceId);
  var lh = await pdf.letterheadFor(t.companyId);
  var overdue = b.daysOverdue > 0;
  var subject = (overdue ? 'Overdue: ' : 'Payment reminder: ') + (b.kind && b.kind !== 'sale' ? 'your bill ' : 'invoice ') + t.docNo + ' (' + money(t, b.balanceDue) + ')';
  var message = reminders.composeMessage(b, null) + '\n\nKind regards,\n' + lh.name;
  var out = await deliver(t, { to: o.to, subject: subject, message: message, kind: 'reminder', automatic: !!o.automatic, sentBy: o.sentBy, base: o.base });
  await pool.query(
    "INSERT INTO payment_reminders (invoice_id, customer_id, channel, email, message, sent_by, automatic) VALUES ($1,$2,'email',$3,$4,$5,$6)",
    [b.invoiceId, b.customerId, o.to, message, o.sentBy || null, !!o.automatic]);
  return Object.assign(out, { message: message });
}

async function remindersSentToday() {
  return (await pool.query(
    "SELECT count(*)::int AS n FROM document_emails WHERE automatic AND kind = 'reminder' AND sent_at >= date_trunc('day', now())")).rows[0].n;
}

// On their own, at the same points as the automatic texts — each point
// once per bill. Returns how many went. Never throws. opts (for the tests):
// customerIds — only these customers.
async function autoReminders(opts) {
  opts = opts || {};
  var sent = 0;
  try {
    if (!mail.configured() || !config.appUrl) return 0;
    if (!(await settings()).autoReminders) return 0;
    var reminders = require('./reminders.service');
    var only = Array.isArray(opts.customerIds) ? opts.customerIds : null;
    var budget = AUTO_DAILY_LIMIT - await remindersSentToday();
    var today = todayISO();
    var pokiId = await pokiCompanyId();
    var bills = (await pool.query(
      'SELECT i.id, i.invoice_no, i.doc_kind, i.company_id, i.currency, i.balance_due, i.due_date::text AS due_date, ' +
      '       i.period_start::text AS period_start, i.period_end::text AS period_end, c.id AS customer_id, c.name AS customer_name, c.email, c.contact_person, ' +
      '       u.code AS unit_code, u.name AS unit_name, pp.name AS property_name ' +
      'FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
      'LEFT JOIN poki_bookings l ON l.id = i.poki_booking_id LEFT JOIN poki_units u ON u.id = l.unit_id LEFT JOIN poki_properties pp ON pp.id = u.property_id ' +
      "WHERE i.status IN ('unpaid', 'partially_paid') AND i.balance_due > 0 AND i.due_date IS NOT NULL " +
      '  AND i.due_date <= ($1::date + 3) AND i.due_date >= ($1::date - $2::integer) ' +
      '  AND (' + bplScopeClause('i') + ' OR i.company_id = $3) ' +
      "  AND coalesce(c.email, '') <> '' AND ($4::uuid[] IS NULL OR c.id = ANY($4)) ORDER BY i.due_date",
      [today, AUTO_BILL_MAX_OVERDUE, pokiId, only])).rows;
    for (var i = 0; i < bills.length && budget > 0; i++) {
      var r = bills[i];
      if (!mail.isEmail(r.email)) continue;
      var days = Math.round((new Date(today + 'T00:00:00Z') - new Date(r.due_date + 'T00:00:00Z')) / 86400000);
      var passed = BILL_MILESTONES.filter(function (m) { return days >= m.at; }).map(function (m) { return m.key; });
      var milestone = await claim(r.id, r.due_date, passed);
      if (!milestone) continue;
      var b = {
        invoiceId: r.id, invoiceNo: r.invoice_no, company: r.company_id === pokiId ? 'poki' : 'bpl', kind: r.doc_kind,
        customerId: r.customer_id, customerName: r.customer_name, contactPerson: r.contact_person || '', currency: r.currency, balanceDue: Number(r.balance_due),
        dueDate: r.due_date, daysOverdue: days, periodStart: r.period_start, periodEnd: r.period_end,
        unit: r.unit_code ? (r.property_name ? r.property_name + ' · ' : '') + (r.unit_name || r.unit_code) : null
      };
      try {
        await reminderEmail(b, { to: r.email.trim(), automatic: true });
      } catch (e) {
        await pool.query("DELETE FROM auto_texts WHERE kind = 'bill_email' AND ref_id = $1 AND milestone = $2 AND ref_date = $3", [r.id, milestone.key, r.due_date]);
        console.error('Automatic reminder email not sent:', e.message);
        return sent; // the mailbox is refusing: try again next time
      }
      for (var k = 0; k < milestone.earlier.length; k++) {
        await pool.query("INSERT INTO auto_texts (kind, ref_id, milestone, ref_date) VALUES ('bill_email', $1, $2, $3) ON CONFLICT DO NOTHING", [r.id, milestone.earlier[k], r.due_date]);
      }
      sent++; budget--;
    }
  } catch (e) {
    console.error('Automatic reminder emails failed:', e.message);
  }
  if (sent) console.log('Automatic reminder emails: sent ' + sent + '.');
  return sent;
}

// The most urgent point passed and not yet emailed, claimed so two
// instances can't both send it (the same bookkeeping as the texts, kept
// apart by kind: a bill can be both texted and emailed at each point).
async function claim(refId, refDate, passed) {
  if (!passed.length) return null;
  var urgent = passed[passed.length - 1];
  var done = (await pool.query("SELECT milestone FROM auto_texts WHERE kind = 'bill_email' AND ref_id = $1 AND ref_date = $2", [refId, refDate])).rows
    .map(function (r) { return r.milestone; });
  if (done.indexOf(urgent) >= 0) return null;
  var got = await pool.query(
    "INSERT INTO auto_texts (kind, ref_id, milestone, ref_date) VALUES ('bill_email', $1, $2, $3) ON CONFLICT DO NOTHING RETURNING milestone",
    [refId, urgent, refDate]);
  return got.rowCount ? { key: urgent, earlier: passed.slice(0, -1) } : null;
}

module.exports = {
  settings: settings, saveSettings: saveSettings, status: status,
  draft: draft, send: send, afterPayment: afterPayment, reminderEmail: reminderEmail, autoReminders: autoReminders,
  shareBase: shareBase, AUTO_DAILY_LIMIT: AUTO_DAILY_LIMIT
};
