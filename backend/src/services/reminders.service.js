var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { bplScopeClause, todayISO } = require('../utils/documents');
var config = require('../config');
var poki = require('./poki.service');
var sharesService = require('./shares.service');

// Payment reminders: everyone whose rent, utility bill or invoice is due soon
// or overdue, and a WhatsApp message to each, ready to send (migration 0076).
//
// The OS can't send WhatsApp messages by itself — that needs the WhatsApp
// Business API (or paid SMS), which the company isn't using. So it does
// everything short of pressing send: it writes the message, with a link to
// the bill, and opens WhatsApp on the staff member's own phone or computer
// with the customer's chat and the message filled in. They press send. The
// reminder is recorded, so the list shows who was reminded when, and by whom.
//
// Two companies' bills meet here and stay apart the way they do elsewhere:
// Bamboo Products' invoices for people with invoice.read (sending needs
// invoice.manage), Poki's rent, utility and other bills for people with Poki
// access (sending needs poki.manage).

var DEFAULT_WINDOW_DAYS = 7;

// Ghana numbers as WhatsApp wants them: country code, no plus, no spaces.
// "024 412 3456" and "+233 24 412 3456" both become 233244123456.
function whatsappNumber(phone) {
  var d = String(phone || '').replace(/\D/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);
  if (d.length === 10 && d[0] === '0') return '233' + d.slice(1);
  if (d.length === 9) return '233' + d;
  if (d.length === 12 && d.indexOf('233') === 0) return d;
  if (d.length >= 11 && d.length <= 15 && d[0] !== '0') return d; // another country's number, already international
  return null;
}

function daysBetween(fromISO, toISO) {
  return Math.round((new Date(toISO + 'T00:00:00Z') - new Date(fromISO + 'T00:00:00Z')) / 86400000);
}

function fmtDate(iso) {
  return new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function fmtMoney(currency, amount) {
  return currency + ' ' + Number(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function scopes(ctx) {
  var bpl = ctx.can('invoice.read');
  var pokiRead = ctx.can('poki.read') || ctx.can('poki.manage');
  if (!bpl && !pokiRead) fail('forbidden', 'Your role does not allow this action (invoice.read or poki.read).');
  return { bpl: bpl, poki: pokiRead, pokiId: pokiRead ? await poki.pokiCompanyId() : null };
}

// Unpaid bills due within `windowDays` or already overdue, most overdue first.
async function due(ctx, opts) {
  var s = await scopes(ctx);
  var windowDays = Math.max(0, Math.min(60, Number(opts && opts.windowDays) || DEFAULT_WINDOW_DAYS));
  var today = todayISO();
  var until = new Date(Date.now() + windowDays * 86400000).toISOString().slice(0, 10);

  var where = [];
  var params = [until];
  if (s.bpl) where.push(bplScopeClause('i'));
  if (s.poki) { params.push(s.pokiId); where.push('i.company_id = $' + params.length); }

  var rows = (await pool.query(
    'SELECT i.id, i.invoice_no, i.doc_kind, i.company_id, i.currency, i.balance_due, i.due_date::text AS due_date, ' +
    '       i.period_start::text AS period_start, i.period_end::text AS period_end, ' +
    '       c.id AS customer_id, c.name AS customer_name, c.phone, c.contact_person, ' +
    '       u.code AS unit_code, u.name AS unit_name, pp.name AS property_name, ' +
    '       r.sent_at AS last_sent_at, r.count AS reminder_count, e.first_name AS last_by_first, e.last_name AS last_by_last ' +
    'FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
    'LEFT JOIN poki_bookings l ON l.id = i.poki_booking_id ' +
    'LEFT JOIN poki_units u ON u.id = l.unit_id ' +
    'LEFT JOIN poki_properties pp ON pp.id = u.property_id ' +
    'LEFT JOIN LATERAL (SELECT pr.sent_at, pr.sent_by, (SELECT count(*)::int FROM payment_reminders x WHERE x.invoice_id = i.id) AS count ' +
    '                   FROM payment_reminders pr WHERE pr.invoice_id = i.id ORDER BY pr.sent_at DESC LIMIT 1) r ON true ' +
    'LEFT JOIN employees e ON e.id = r.sent_by ' +
    "WHERE i.status IN ('unpaid', 'partially_paid') AND i.balance_due > 0 AND i.due_date IS NOT NULL AND i.due_date <= $1 " +
    'AND (' + where.join(' OR ') + ') ' +
    'ORDER BY i.due_date ASC, c.name',
    params
  )).rows;

  return {
    today: today,
    windowDays: windowDays,
    rows: rows.map(function (r) {
      var isPoki = s.pokiId && r.company_id === s.pokiId;
      return {
        invoiceId: r.id, invoiceNo: r.invoice_no, company: isPoki ? 'poki' : 'bpl', kind: r.doc_kind,
        customerId: r.customer_id, customerName: r.customer_name, contactPerson: r.contact_person || '',
        phone: r.phone || '', whatsapp: whatsappNumber(r.phone),
        currency: r.currency, balanceDue: Number(r.balance_due),
        dueDate: r.due_date, daysOverdue: daysBetween(r.due_date, today),
        periodStart: r.period_start, periodEnd: r.period_end,
        unit: r.unit_code ? (r.property_name ? r.property_name + ' · ' : '') + (r.unit_name || r.unit_code) : null,
        lastReminder: r.last_sent_at ? { at: r.last_sent_at, by: r.last_by_first ? r.last_by_first + ' ' + r.last_by_last : null, count: r.reminder_count } : null,
        canSend: isPoki ? ctx.can('poki.manage') : ctx.can('invoice.manage')
      };
    })
  };
}

// The words. English — like the invoices themselves — and polite: this goes
// to paying customers and tenants.
function composeMessage(b, link) {
  var name = (b.contactPerson || b.customerName || '').trim();
  var hello = name ? 'Hello ' + name + ',' : 'Hello,';
  var from = b.company === 'poki' ? 'Poki Properties' : 'Bamboo Products Limited';
  var amount = fmtMoney(b.currency, b.balanceDue);
  var when = b.daysOverdue > 0
    ? 'was due on ' + fmtDate(b.dueDate) + ' (' + b.daysOverdue + ' day' + (b.daysOverdue === 1 ? '' : 's') + ' ago)'
    : b.daysOverdue === 0 ? 'is due today' : 'is due on ' + fmtDate(b.dueDate);
  var period = b.periodStart && b.periodEnd ? ' for ' + fmtDate(b.periodStart) + ' – ' + fmtDate(b.periodEnd) : '';
  var place = b.unit ? ' (' + b.unit + ')' : '';
  var what;
  if (b.kind === 'rent') what = 'your rent' + place + period;
  else if (b.kind === 'utility') what = 'your utility bill' + place + period;
  else if (b.kind === 'deposit') what = 'your security deposit' + place;
  else if (b.kind === 'maintenance') what = 'the maintenance charge' + place;
  else what = 'invoice ' + b.invoiceNo;
  var lines = [
    hello,
    'This is a friendly reminder from ' + from + ' that ' + what + ' of ' + amount + ' ' + when + '.',
    b.kind === 'sale' ? '' : 'Reference: ' + b.invoiceNo + '.',
    link ? 'You can view it here: ' + link : '',
    b.daysOverdue > 0 ? 'If you have already paid, please ignore this message and accept our thanks.' : 'Thank you.'
  ];
  return lines.filter(Boolean).join('\n');
}

// A link to the bill for the customer, when the screen tells us where the OS
// is served from — only accepted if it is one of our own addresses.
function shareBase(origin) {
  var o = String(origin || '').replace(/\/+$/, '');
  return config.corsOrigin.indexOf(o) >= 0 ? o : null;
}

// Writes the reminder for one bill and records it; the screen then opens
// WhatsApp with it.
async function prepare(ctx, invoiceId, origin) {
  var list = await due(ctx, { windowDays: 60 });
  var b = list.rows.filter(function (r) { return r.invoiceId === invoiceId; })[0];
  if (!b) fail('notfound', 'That bill is not due, or you can\'t see it.');
  if (!b.canSend) fail('forbidden', 'Your role does not allow sending reminders for this bill.');
  if (!b.whatsapp) fail('invalid', b.phone ? 'The phone number on file for ' + b.customerName + ' (' + b.phone + ') isn\'t a number WhatsApp can use. Correct it on the customer.' : b.customerName + ' has no phone number on file. Add one on the customer first.');

  var link = null;
  var base = shareBase(origin);
  if (base) {
    var share = b.company === 'poki'
      ? await require('./pokiInvoices.service').createShareLink(ctx, b.invoiceId, sharesService.SHARE_MAX_DAYS)
      : await sharesService.createShareLink(ctx, 'invoice', b.invoiceId, sharesService.SHARE_MAX_DAYS);
    link = base + '/share/' + share.token;
  }
  var message = composeMessage(b, link);
  await pool.query(
    "INSERT INTO payment_reminders (invoice_id, customer_id, channel, phone, message, sent_by) VALUES ($1,$2,'whatsapp',$3,$4,$5)",
    [b.invoiceId, b.customerId, b.whatsapp, message, ctx.employee ? ctx.employee.id : null]
  );
  return {
    invoiceId: b.invoiceId, phone: b.whatsapp, message: message,
    whatsappUrl: 'https://wa.me/' + b.whatsapp + '?text=' + encodeURIComponent(message)
  };
}

async function history(ctx, invoiceId) {
  V.text(invoiceId, 'Invoice', 60);
  var list = await due(ctx, { windowDays: 60 });
  if (!list.rows.some(function (r) { return r.invoiceId === invoiceId; })) fail('notfound', 'That bill is not due, or you can\'t see it.');
  return (await pool.query(
    'SELECT pr.sent_at, pr.message, pr.phone, e.first_name, e.last_name FROM payment_reminders pr LEFT JOIN employees e ON e.id = pr.sent_by ' +
    'WHERE pr.invoice_id = $1 ORDER BY pr.sent_at DESC', [invoiceId]
  )).rows.map(function (r) {
    return { at: r.sent_at, by: r.first_name ? r.first_name + ' ' + r.last_name : null, phone: r.phone, message: r.message };
  });
}

module.exports = { due: due, prepare: prepare, history: history, whatsappNumber: whatsappNumber, composeMessage: composeMessage };
