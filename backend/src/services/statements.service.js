var crypto = require('crypto');
var PDFDocument = require('pdfkit');
var config = require('../config');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Customer statements and credit limits (migration 0197). A statement of
// a customer's account in one currency: what they owed at the start, every
// invoice, payment, credit note and refund since, the running balance, what
// they owe now and how old it is, and the invoices still open with their
// pay-online links. Seen in the OS (Statements), sent as a link of its own
// (online.bplghana.com/statement/<link>) by email with its PDF or by
// WhatsApp, and every month by itself for customers who asked for it.
// A customer can have a credit limit: an invoice that would take what they
// owe over it needs a second "yes" (invoices.service createManual).

var LINK_DAYS = 30;
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function money(n, cur) { return (cur || 'GHS') + ' ' + round2(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function monthsBack(n) { var d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); }
var DAY = /^\d{4}-\d{2}-\d{2}$/;
var METHOD = { bank_transfer: 'Bank transfer', cash: 'Cash', mobile_money: 'Mobile Money', card: 'Card', cheque: 'Cheque' };

async function customerOf(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('notfound', 'Customer not found.');
  var c = (await pool.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0];
  if (!c) fail('notfound', 'Customer not found.');
  return c;
}

// What a customer owes in a currency now, and how old it is.
async function owedOf(customerId, currency) {
  var rows = (await pool.query(
    "SELECT id, invoice_no, issued_at, due_date, grand_total, balance_due FROM invoices WHERE customer_id = $1 AND currency = $2 AND status IN ('unpaid', 'partially_paid') AND balance_due > 0 " +
    'ORDER BY coalesce(due_date, issued_at), invoice_no', [customerId, currency])).rows;
  var t = today();
  var ageing = { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0 };
  var open = rows.map(function (r) {
    var due = dayText(r.due_date || r.issued_at), late = Math.max(0, daysBetween(due, t));
    var b = round2(r.balance_due);
    if (late === 0) ageing.current += b; else if (late <= 30) ageing.d1to30 += b; else if (late <= 60) ageing.d31to60 += b; else if (late <= 90) ageing.d61to90 += b; else ageing.d90plus += b;
    return { id: r.id, invoiceNo: r.invoice_no, issuedAt: dayText(r.issued_at), dueDate: due, total: round2(r.grand_total), balance: b, daysOverdue: late };
  });
  Object.keys(ageing).forEach(function (k) { ageing[k] = round2(ageing[k]); });
  var owed = round2(open.reduce(function (s, o) { return s + o.balance; }, 0));
  return { owed: owed, overdue: round2(owed - ageing.current), ageing: ageing, open: open };
}

// The limit, what is owed against it, what is left (in the customer's own
// currency).
async function creditOf(customerId, currency) {
  var c = await customerOf(customerId);
  var cur = currency || c.preferred_currency || 'GHS';
  var o = await owedOf(c.id, cur);
  var limit = c.credit_limit == null ? null : round2(c.credit_limit);
  return { limit: limit, currency: cur, owed: o.owed, overdue: o.overdue, available: limit == null ? null : round2(limit - o.owed), over: limit != null && o.owed > limit };
}

// The statement: opening balance, then each line with the running balance.
async function build(customerId, q) {
  q = q || {};
  var c = await customerOf(customerId);
  var currencies = (await pool.query("SELECT DISTINCT currency FROM invoices WHERE customer_id = $1 AND status <> 'void' ORDER BY 1", [c.id])).rows.map(function (r) { return r.currency; });
  var cur = q.currency && currencies.indexOf(q.currency) >= 0 ? q.currency : (currencies.indexOf(c.preferred_currency) >= 0 ? c.preferred_currency : currencies[0] || c.preferred_currency || 'GHS');
  var from = DAY.test(String(q.from || '')) ? q.from : monthsBack(5);
  var to = DAY.test(String(q.to || '')) ? q.to : today();
  if (to < from) fail('invalid', 'The end of the statement cannot be before its start.');
  var inv = (await pool.query("SELECT id, invoice_no, issued_at, due_date, grand_total, po_reference FROM invoices WHERE customer_id = $1 AND currency = $2 AND status <> 'void'", [c.id, cur])).rows;
  var pays = (await pool.query(
    "SELECT p.date, p.amount, p.method, p.reference, p.source, i.invoice_no FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.customer_id = $1 AND i.currency = $2 AND i.status <> 'void'", [c.id, cur])).rows;
  var credits = (await pool.query(
    "SELECT n.created_at, n.amount, n.credit_no, n.reason, i.invoice_no FROM credit_notes n JOIN invoices i ON i.id = n.invoice_id WHERE n.customer_id = $1 AND i.currency = $2 AND i.status <> 'void' AND n.amount > 0", [c.id, cur])).rows;
  var all = [];
  inv.forEach(function (r) { all.push({ date: dayText(r.issued_at), order: 0, kind: 'invoice', ref: r.invoice_no, text: 'Invoice' + (r.po_reference ? ' · PO ' + r.po_reference : ''), dueDate: dayText(r.due_date), debit: round2(r.grand_total), credit: 0 }); });
  credits.forEach(function (r) { all.push({ date: dayText(r.created_at), order: 1, kind: 'credit', ref: r.credit_no, text: 'Credit note on ' + r.invoice_no, debit: 0, credit: round2(r.amount) }); });
  pays.forEach(function (r) {
    var amt = round2(r.amount);
    if (amt < 0) all.push({ date: dayText(r.date), order: 2, kind: 'refund', ref: r.invoice_no, text: 'Refund on ' + r.invoice_no, debit: -amt, credit: 0 });
    else all.push({ date: dayText(r.date), order: 2, kind: 'payment', ref: r.invoice_no, text: 'Payment, ' + (METHOD[r.method] || 'paid') + (r.reference ? ' · ' + r.reference : '') + ' (' + r.invoice_no + ')', method: r.method, debit: 0, credit: amt });
  });
  all.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order || (a.ref < b.ref ? -1 : 1); });
  var opening = 0, lines = [], bal = 0;
  all.forEach(function (l) {
    if (l.date < from) { opening = round2(opening + l.debit - l.credit); return; }
    if (l.date > to) return;
    if (!lines.length) bal = opening;
    bal = round2(bal + l.debit - l.credit);
    lines.push(Object.assign({}, l, { balance: bal }));
  });
  var closing = lines.length ? lines[lines.length - 1].balance : opening;
  var o = await owedOf(c.id, cur);
  var limit = c.credit_limit == null ? null : round2(c.credit_limit);
  return {
    customer: { id: c.id, name: c.name, contactPerson: c.contact_person, email: c.email, phone: c.phone, address: c.billing_address || c.address, creditLimit: limit, statementMonthly: c.statement_monthly, terms: c.payment_terms },
    currency: cur, currencies: currencies.length ? currencies : [cur], from: from, to: to, today: today(),
    opening: opening, lines: lines, closing: closing,
    totals: { invoiced: round2(lines.reduce(function (s, l) { return s + (l.kind === 'invoice' ? l.debit : 0); }, 0)), paid: round2(lines.reduce(function (s, l) { return s + (l.kind === 'payment' ? l.credit : 0); }, 0)),
      credited: round2(lines.reduce(function (s, l) { return s + (l.kind === 'credit' ? l.credit : 0); }, 0)) },
    owed: o.owed, overdue: o.overdue, ageing: o.ageing, open: o.open,
    credit: { limit: limit, available: limit == null ? null : round2(limit - o.owed), over: limit != null && o.owed > limit }
  };
}

// GET /api/statements/customers/:id
async function get(ctx, customerId, q) {
  need(ctx, 'invoice.read');
  var st = await build(customerId, q);
  st.sends = (await pool.query(
    'SELECT s.channel, s.to_address, s.automatic, s.balance, s.sent_at, e.first_name, e.last_name FROM statement_sends s LEFT JOIN employees e ON e.id = s.sent_by WHERE s.customer_id = $1 ORDER BY s.sent_at DESC LIMIT 12', [st.customer.id])).rows
    .map(function (r) { return { channel: r.channel, to: r.to_address, automatic: r.automatic, balance: round2(r.balance), at: r.sent_at, by: r.first_name ? r.first_name + ' ' + r.last_name : null }; });
  st.canManage = ctx.can('invoice.manage');
  return st;
}

// GET /api/statements — every customer who owes something or has a limit,
// the most overdue first.
async function overview(ctx, q) {
  need(ctx, 'invoice.read');
  q = q || {};
  var t = today();
  var rows = (await pool.query(
    'SELECT c.id, c.name, c.email, c.phone, c.credit_limit, c.statement_monthly, c.preferred_currency, ' +
    "coalesce(sum(i.balance_due) FILTER (WHERE i.status IN ('unpaid', 'partially_paid')), 0) AS owed, " +
    "coalesce(sum(i.balance_due) FILTER (WHERE i.status IN ('unpaid', 'partially_paid') AND coalesce(i.due_date, i.issued_at) < $1), 0) AS overdue, " +
    "coalesce(sum(i.balance_due) FILTER (WHERE i.status IN ('unpaid', 'partially_paid') AND coalesce(i.due_date, i.issued_at) < $1::date - 60), 0) AS old, " +
    "count(i.id) FILTER (WHERE i.status IN ('unpaid', 'partially_paid'))::int AS open, " +
    "min(coalesce(i.due_date, i.issued_at)) FILTER (WHERE i.status IN ('unpaid', 'partially_paid')) AS oldest_due, " +
    '(SELECT max(p.date) FROM payments p WHERE p.customer_id = c.id AND p.amount > 0) AS last_paid, ' +
    '(SELECT max(s.sent_at) FROM statement_sends s WHERE s.customer_id = c.id) AS last_sent ' +
    "FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id AND i.currency = coalesce(nullif(c.preferred_currency, ''), 'GHS') AND i.status <> 'void' " +
    'GROUP BY c.id HAVING coalesce(sum(i.balance_due) FILTER (WHERE i.status IN (\'unpaid\', \'partially_paid\')), 0) > 0 OR c.credit_limit IS NOT NULL ' +
    'ORDER BY overdue DESC, owed DESC, c.name LIMIT 500', [t])).rows;
  var search = String(q.q || '').trim().toLowerCase();
  var list = rows.map(function (r) {
    var limit = r.credit_limit == null ? null : round2(r.credit_limit), owed = round2(r.owed);
    return {
      id: r.id, name: r.name, hasEmail: !!r.email, hasPhone: !!r.phone, currency: r.preferred_currency || 'GHS', owed: owed, overdue: round2(r.overdue), old: round2(r.old), open: r.open,
      oldestDue: dayText(r.oldest_due), daysOverdue: r.oldest_due && dayText(r.oldest_due) < t ? daysBetween(dayText(r.oldest_due), t) : 0,
      creditLimit: limit, used: limit ? Math.round(owed / limit * 100) : null, over: limit != null && owed > limit, monthly: r.statement_monthly,
      lastPaid: dayText(r.last_paid), lastSent: r.last_sent
    };
  }).filter(function (c) { return !search || c.name.toLowerCase().indexOf(search) >= 0; });
  var owing = list.filter(function (c) { return c.owed > 0; });
  return {
    customers: list,
    summary: {
      owed: round2(owing.reduce(function (s, c) { return s + c.owed; }, 0)), overdue: round2(owing.reduce(function (s, c) { return s + c.overdue; }, 0)),
      old: round2(owing.reduce(function (s, c) { return s + c.old; }, 0)), customers: owing.length, overLimit: list.filter(function (c) { return c.over; }).length,
      monthly: list.filter(function (c) { return c.monthly; }).length
    },
    canManage: ctx.can('invoice.manage'), today: t
  };
}

// PUT /api/statements/customers/:id { creditLimit, statementMonthly }
async function saveCustomer(ctx, customerId, p) {
  need(ctx, 'invoice.manage');
  p = p || {};
  var c = await customerOf(customerId);
  var limit = p.creditLimit === '' || p.creditLimit == null ? null : round2(p.creditLimit);
  if (limit != null && !(limit >= 0 && limit <= 1e9)) fail('invalid', 'A credit limit is an amount of 0 or more, or none.');
  var monthly = p.statementMonthly === undefined ? c.statement_monthly : !!p.statementMonthly;
  if (monthly && !c.email) fail('invalid', c.name + ' has no email address: add one to send them a statement every month.');
  await pool.query('UPDATE customers SET credit_limit = $2, statement_monthly = $3 WHERE id = $1', [c.id, limit, monthly]);
  var was = c.credit_limit == null ? null : round2(c.credit_limit);
  if (was !== limit || c.statement_monthly !== monthly) {
    await audit(pool, ctx, 'customer.credit', 'customer', c.id, c.name + ': credit limit ' + (limit == null ? 'none' : money(limit, c.preferred_currency)) + (was !== limit ? ' (was ' + (was == null ? 'none' : money(was, c.preferred_currency)) + ')' : '') +
      '; monthly statement ' + (monthly ? 'on' : 'off') + '.');
  }
  return get(ctx, c.id, {});
}

// A link of its own, kept 30 days; the one still good is used again.
async function linkFor(customerId, currency, from, byId, fresh) {
  if (!fresh) {
    var have = (await pool.query("SELECT token, expires_at FROM statement_links WHERE customer_id = $1 AND currency = $2 AND from_date IS NOT DISTINCT FROM $3 AND expires_at > now() + interval '7 days' ORDER BY created_at DESC LIMIT 1",
      [customerId, currency, from || null])).rows[0];
    if (have) return { token: have.token, url: config.bplSiteUrl + '/statement/' + have.token, expiresAt: have.expires_at };
  }
  var token = crypto.randomBytes(24).toString('base64url');
  var expires = new Date(Date.now() + LINK_DAYS * 86400000);
  await pool.query('INSERT INTO statement_links (token, customer_id, currency, from_date, expires_at, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [token, customerId, currency, from || null, expires, byId || null]);
  return { token: token, url: config.bplSiteUrl + '/statement/' + token, expiresAt: expires };
}

// POST /api/statements/customers/:id/link { currency, from }
async function link(ctx, customerId, p) {
  need(ctx, 'invoice.manage');
  p = p || {};
  var st = await build(customerId, p);
  var l = await linkFor(st.customer.id, st.currency, DAY.test(String(p.from || '')) ? p.from : null, ctx.employee ? ctx.employee.id : null, true);
  await pool.query("INSERT INTO statement_sends (customer_id, channel, balance, sent_by) VALUES ($1, 'link', $2, $3)", [st.customer.id, st.owed, ctx.employee ? ctx.employee.id : null]);
  return l;
}

function messageFor(st, url, lh) {
  var first = String(st.customer.contactPerson || st.customer.name).split(' ')[0];
  return 'Dear ' + first + ',\n\nHere is your statement of account with ' + lh.name + ' from ' + st.from + ' to ' + st.to + '. ' +
    (st.owed > 0 ? 'You owe ' + money(st.owed, st.currency) + (st.overdue > 0 ? ', of which ' + money(st.overdue, st.currency) + ' is overdue' : '') + '. You can pay each open invoice online from the statement.' : 'Your account is fully paid. Thank you!') +
    '\n\nView it online: ' + url;
}

// POST /api/statements/customers/:id/send { via: 'email' | 'whatsapp', to, currency, from }
async function send(ctx, customerId, p) {
  need(ctx, 'invoice.manage');
  p = p || {};
  var st = await build(customerId, p);
  var l = await linkFor(st.customer.id, st.currency, DAY.test(String(p.from || '')) ? p.from : null, ctx.employee ? ctx.employee.id : null);
  var lh = await require('./documentPdf.service').letterheadFor(null);
  var by = ctx.employee ? ctx.employee.id : null;
  if (p.via === 'whatsapp') {
    var digits = String(p.to || st.customer.phone || '').replace(/\D/g, '');
    if (digits.length < 9) fail('invalid', st.customer.name + ' has no phone number on file.');
    if (digits.length === 10 && digits.charAt(0) === '0') digits = '233' + digits.slice(1);
    var text = messageFor(st, l.url, lh);
    await pool.query("INSERT INTO statement_sends (customer_id, channel, to_address, balance, sent_by) VALUES ($1, 'whatsapp', $2, $3, $4)", [st.customer.id, '+' + digits, st.owed, by]);
    await audit(pool, ctx, 'statement.send', 'customer', st.customer.id, 'Statement for ' + st.customer.name + ' shared on WhatsApp (' + money(st.owed, st.currency) + ' owed).');
    return { sent: false, whatsappUrl: 'https://wa.me/' + digits + '?text=' + encodeURIComponent(text), url: l.url };
  }
  var mail = require('./mail.service');
  var to = String(p.to || st.customer.email || '').trim();
  if (!mail.isEmail(to)) fail('invalid', 'Which email address? ' + st.customer.name + ' has none on file.');
  await emailStatement(st, l, lh, to);
  await pool.query("INSERT INTO statement_sends (customer_id, channel, to_address, balance, sent_by) VALUES ($1, 'email', $2, $3, $4)", [st.customer.id, to, st.owed, by]);
  await audit(pool, ctx, 'statement.send', 'customer', st.customer.id, 'Statement for ' + st.customer.name + ' emailed to ' + to + ' (' + money(st.owed, st.currency) + ' owed).');
  return { sent: true, to: to, url: l.url };
}

async function emailStatement(st, l, lh, to) {
  var mail = require('./mail.service');
  var esc = mail.escapeHtml;
  var text = messageFor(st, l.url, lh) + '\n\nKind regards,\n' + lh.name;
  var row = function (k, v, strong) { return '<tr><td style="padding:6px 0;color:#6b6966">' + esc(k) + '</td><td style="padding:6px 0;text-align:right;' + (strong ? 'font-weight:700' : '') + '">' + esc(v) + '</td></tr>'; };
  var html =
    '<div style="background:#f4f3ef;padding:24px 12px"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#201e1d">' +
    '<p style="color:#3f7d3b;font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 18px">' + esc(lh.name) + '</p>' +
    '<p style="margin:0 0 14px">' + esc(messageFor(st, '', lh).split('\n\nView it online')[0]).replace(/\n/g, '<br>') + '</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:8px 0 18px;font-size:14px">' +
    row('Owed now', money(st.owed, st.currency), true) + row('Overdue', money(st.overdue, st.currency)) + row('Statement', st.from + ' – ' + st.to) + '</table>' +
    '<p style="margin:0 0 20px"><a href="' + esc(l.url) + '" style="display:inline-block;background:#2f6b2b;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:700">View the statement and pay online</a></p>' +
    '<p style="margin:0;color:#6b6966;font-size:12.5px">The PDF is attached.</p></div></div>';
  var file = await statementPdf(st, lh);
  await mail.send({ to: to, subject: 'Statement of account — ' + st.customer.name + ' (' + money(st.owed, st.currency) + ' owed)', text: text, html: html, fromName: lh.name, replyTo: lh.email,
    attachments: [{ filename: 'statement-' + st.to + '.pdf', content: file, contentType: 'application/pdf' }] });
}

// The statement as a PDF, A4.
function statementPdf(st, lh) {
  var doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: 'Statement — ' + st.customer.name, Author: lh.name } });
  var chunks = [];
  var done = new Promise(function (resolve, reject) { doc.on('data', function (c) { chunks.push(c); }); doc.on('end', function () { resolve(Buffer.concat(chunks)); }); doc.on('error', reject); });
  var green = '#2f6b2b', muted = '#6b6966', W = doc.page.width - 84;
  doc.fillColor(green).font('Helvetica-Bold').fontSize(16).text(lh.name, 42, 42);
  doc.fillColor(muted).font('Helvetica').fontSize(8.5).text((lh.lines || []).join('  ·  '), { width: W });
  doc.moveDown(1.2);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(20).text('Statement of account');
  doc.font('Helvetica').fontSize(10).fillColor(muted).text(st.from + ' to ' + st.to + '  ·  ' + st.currency);
  doc.moveDown(0.6);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text(st.customer.name);
  doc.font('Helvetica').fontSize(9).fillColor(muted).text([st.customer.address, st.customer.phone, st.customer.email].filter(Boolean).join('\n'));
  doc.moveDown(0.8);
  // The summary boxes.
  var y = doc.y, boxW = (W - 24) / 4;
  [['Owed now', st.owed], ['Overdue', st.overdue], ['Invoiced', st.totals.invoiced], ['Paid', st.totals.paid]].forEach(function (b, i) {
    var x = 42 + i * (boxW + 8);
    doc.roundedRect(x, y, boxW, 46, 6).fillAndStroke(i === 1 && st.overdue > 0 ? '#fdecec' : '#f2f5f1', '#dfe5dc');
    doc.fillColor(muted).font('Helvetica').fontSize(8).text(b[0], x + 8, y + 8, { width: boxW - 16 });
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(12).text(money(b[1], st.currency), x + 8, y + 22, { width: boxW - 16 });
  });
  doc.y = y + 60;
  var cols = [{ k: 'Date', w: 62 }, { k: 'Reference', w: 70 }, { k: 'Details', w: W - 62 - 70 - 3 * 70 }, { k: 'Charged', w: 70, r: true }, { k: 'Paid', w: 70, r: true }, { k: 'Balance', w: 70, r: true }];
  var line = function (vals, opts) {
    opts = opts || {};
    if (doc.y > doc.page.height - 90) doc.addPage();
    var yy = doc.y, x = 42;
    if (opts.fill) doc.rect(42, yy - 3, W, 16).fill(opts.fill);
    doc.fillColor(opts.color || '#111').font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    var h = 12;
    cols.forEach(function (c, i) { doc.text(vals[i] == null ? '' : String(vals[i]), x, yy, { width: c.w - 4, align: c.r ? 'right' : 'left' }); h = Math.max(h, doc.heightOfString(String(vals[i] || ''), { width: c.w - 4 })); x += c.w; });
    doc.y = yy + h + 4;
  };
  line(cols.map(function (c) { return c.k; }), { bold: true, fill: '#e8efe6', color: green });
  line([st.from, '', 'Balance brought forward', '', '', money(st.opening, '').trim()], { color: muted });
  st.lines.forEach(function (l) { line([l.date, l.ref, l.text, l.debit ? money(l.debit, '').trim() : '', l.credit ? money(l.credit, '').trim() : '', money(l.balance, '').trim()]); });
  line(['', '', 'Balance at ' + st.to, '', '', money(st.closing, st.currency)], { bold: true, fill: '#f2f5f1' });
  doc.moveDown(1);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text('How old what you owe is', 42);
  doc.font('Helvetica').fontSize(9).fillColor(muted).text(
    'Not yet due ' + money(st.ageing.current, st.currency) + '   ·   1–30 days ' + money(st.ageing.d1to30, st.currency) + '   ·   31–60 days ' + money(st.ageing.d31to60, st.currency) +
    '   ·   61–90 days ' + money(st.ageing.d61to90, st.currency) + '   ·   over 90 days ' + money(st.ageing.d90plus, st.currency), { width: W });
  doc.end();
  return done;
}

// GET /api/statement/:token — the customer's own page (no internal notes,
// no staff names): the statement, and each open invoice's pay-online page.
async function publicView(token) {
  var l = (await pool.query('SELECT * FROM statement_links WHERE token = $1', [String(token || '')])).rows[0];
  if (!l) fail('notfound', 'This link is invalid or has been removed.');
  if (new Date(l.expires_at) < new Date()) fail('notfound', 'This link has expired — ask for a new one.');
  var st = await build(l.customer_id, { currency: l.currency, from: l.from_date ? dayText(l.from_date) : undefined });
  await pool.query('UPDATE statement_links SET viewed_at = coalesce(viewed_at, now()) WHERE token = $1', [l.token]);
  var lh = await require('./documentPdf.service').letterheadFor(null);
  var portal = require('./portal.service');
  for (var i = 0; i < st.open.length; i++) st.open[i].url = config.bplSiteUrl + '/share/' + await portal.shareOf('invoice', st.open[i].id);
  st.open.forEach(function (o) { delete o.id; });
  delete st.customer.id; delete st.customer.statementMonthly; delete st.customer.creditLimit;
  delete st.credit;
  st.lines.forEach(function (x) { delete x.method; });
  return Object.assign(st, { company: { name: lh.name, lines: lh.lines || [] }, expiresAt: l.expires_at, pdf: '/api/statement/' + l.token + '/pdf' });
}
async function publicPdf(token) {
  var l = (await pool.query('SELECT * FROM statement_links WHERE token = $1', [String(token || '')])).rows[0];
  if (!l || new Date(l.expires_at) < new Date()) fail('notfound', 'This link is invalid or has expired.');
  var st = await build(l.customer_id, { currency: l.currency, from: l.from_date ? dayText(l.from_date) : undefined });
  return { buffer: await statementPdf(st, await require('./documentPdf.service').letterheadFor(null)), filename: 'statement-' + st.to + '.pdf' };
}
// GET /api/statements/customers/:id/pdf
async function pdf(ctx, customerId, q) {
  need(ctx, 'invoice.read');
  var st = await build(customerId, q);
  return { buffer: await statementPdf(st, await require('./documentPdf.service').letterheadFor(null)), filename: 'statement-' + st.customer.name.replace(/[^\w]+/g, '-').toLowerCase() + '-' + st.to + '.pdf' };
}

// Every month (dailyAlerts): a statement to each customer who asked for
// one, who owes something and has an email address — once a month.
async function monthly(day) {
  day = day || today();
  if (Number(day.slice(8, 10)) > 5) return 0;
  var mail = require('./mail.service');
  if (!mail.configured()) return 0;
  var period = day.slice(0, 7);
  var rows = (await pool.query(
    "SELECT c.id, c.email FROM customers c WHERE c.statement_monthly AND c.email <> '' AND NOT EXISTS (SELECT 1 FROM statement_sends s WHERE s.customer_id = c.id AND s.automatic AND s.period = $1) " +
    "AND EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('unpaid', 'partially_paid') AND i.balance_due > 0)", [period])).rows;
  var lh = await require('./documentPdf.service').letterheadFor(null);
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    try {
      var claim = await pool.query("INSERT INTO statement_sends (customer_id, channel, to_address, period, automatic) VALUES ($1, 'email', $2, $3, true) ON CONFLICT DO NOTHING RETURNING id", [rows[i].id, rows[i].email, period]);
      if (!claim.rows[0]) continue;
      // Last month, start to end.
      var end = new Date(Date.parse(period + '-01T00:00:00Z') - 86400000).toISOString().slice(0, 10);
      var st = await build(rows[i].id, { from: end.slice(0, 8) + '01', to: end });
      var l = await linkFor(rows[i].id, st.currency, st.from, null);
      await emailStatement(st, l, lh, rows[i].email);
      await pool.query('UPDATE statement_sends SET balance = $2 WHERE id = $1', [claim.rows[0].id, st.owed]);
      sent++;
    } catch (e) { console.error('Monthly statement failed:', e.message); }
  }
  return sent;
}

module.exports = { build: build, get: get, overview: overview, saveCustomer: saveCustomer, link: link, send: send, publicView: publicView, publicPdf: publicPdf, pdf: pdf,
  monthly: monthly, creditOf: creditOf, owedOf: owedOf, statementPdf: statementPdf, linkFor: linkFor };
