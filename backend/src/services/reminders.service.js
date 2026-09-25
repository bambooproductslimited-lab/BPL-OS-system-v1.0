var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { bplScopeClause, todayISO } = require('../utils/documents');
var config = require('../config');
var { internationalNumber } = require('../utils/phone');
var poki = require('./poki.service');
var sharesService = require('./shares.service');
var sms = require('./sms.service');

// Payment reminders: everyone whose rent, utility bill or invoice is due soon
// or overdue, and a reminder to each (migrations 0076, 0077). Two ways:
//
//   - WhatsApp: the OS can't send WhatsApp messages by itself (that needs
//     WhatsApp Business, which the company doesn't use), so it writes the
//     message, with a link to the bill, and opens WhatsApp on the staff
//     member's own phone or computer with it filled in. They press send.
//   - Text message: sent straight away through mNotify (sms.service.js) on
//     the company's SMS credit. Optionally, the OS texts on its own at set
//     points (autoTexts below) — off until someone turns it on.
//
// Every reminder is recorded, so the list shows who was reminded when, how,
// and by whom. The same goes for tenants whose booking is ending.
//
// Two companies' bills meet here and stay apart the way they do elsewhere:
// Bamboo Products' invoices for people with invoice.read (sending needs
// invoice.manage), Poki's rent, utility and other bills for people with Poki
// access (sending needs poki.manage).

var DEFAULT_WINDOW_DAYS = 7;

// Ghana numbers as WhatsApp wants them: country code, no plus, no spaces.
var whatsappNumber = internationalNumber;

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
    '       r.sent_at AS last_sent_at, r.count AS reminder_count, r.channel AS last_channel, r.automatic AS last_automatic, ' +
    '       e.first_name AS last_by_first, e.last_name AS last_by_last ' +
    'FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
    'LEFT JOIN poki_bookings l ON l.id = i.poki_booking_id ' +
    'LEFT JOIN poki_units u ON u.id = l.unit_id ' +
    'LEFT JOIN poki_properties pp ON pp.id = u.property_id ' +
    'LEFT JOIN LATERAL (SELECT pr.sent_at, pr.sent_by, pr.channel, pr.automatic, (SELECT count(*)::int FROM payment_reminders x WHERE x.invoice_id = i.id) AS count ' +
    '                   FROM payment_reminders pr WHERE pr.invoice_id = i.id ORDER BY pr.sent_at DESC LIMIT 1) r ON true ' +
    'LEFT JOIN employees e ON e.id = r.sent_by ' +
    "WHERE i.status IN ('unpaid', 'partially_paid') AND i.balance_due > 0 AND i.due_date IS NOT NULL AND i.due_date <= $1 " +
    'AND (' + where.join(' OR ') + ') ' +
    'ORDER BY i.due_date ASC, c.name',
    params
  )).rows;

  // Whether the OS also texts on its own (Company settings → Messaging),
  // so the page can say so rather than leave people chasing by hand.
  var m = await sms.messaging();
  return {
    today: today,
    windowDays: windowDays,
    smsAvailable: sms.configured(),
    auto: { payments: !!m.autoPaymentReminders, bookings: !!m.autoBookingNotices },
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
        lastReminder: r.last_sent_at ? {
          at: r.last_sent_at, by: r.last_by_first ? r.last_by_first + ' ' + r.last_by_last : null, count: r.reminder_count,
          channel: r.last_channel, automatic: r.last_automatic
        } : null,
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
  else if (b.kind === 'cam') what = 'your service charge' + place + period;
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

// Writes the reminder for one bill, records it, and either hands back a
// WhatsApp link for the screen to open (channel 'whatsapp') or texts it
// straight away (channel 'sms').
async function remind(ctx, invoiceId, origin, channel) {
  var list = await due(ctx, { windowDays: 60 });
  var b = list.rows.filter(function (r) { return r.invoiceId === invoiceId; })[0];
  if (!b) fail('notfound', 'That bill is not due, or you can\'t see it.');
  if (!b.canSend) fail('forbidden', 'Your role does not allow sending reminders for this bill.');
  if (!b.whatsapp) fail('invalid', b.phone ? 'The phone number on file for ' + b.customerName + ' (' + b.phone + ') isn\'t one a message can go to. Correct it on the customer.' : b.customerName + ' has no phone number on file. Add one on the customer first.');
  if (channel === 'sms' && !sms.configured()) fail('unavailable', 'Text messages aren\'t set up yet. An administrator adds the mNotify details on the server.');

  var link = null;
  var base = shareBase(origin);
  if (base) {
    var share = b.company === 'poki'
      ? await require('./pokiInvoices.service').createShareLink(ctx, b.invoiceId, sharesService.SHARE_MAX_DAYS)
      : await sharesService.createShareLink(ctx, 'invoice', b.invoiceId, sharesService.SHARE_MAX_DAYS);
    link = base + '/share/' + share.token;
  }
  var message = composeMessage(b, link);
  var sentBy = ctx.employee ? ctx.employee.id : null;
  if (channel === 'sms') {
    await sms.send({ to: b.phone, message: message, purpose: 'payment_reminder', refId: b.invoiceId, sentBy: sentBy });
  }
  await pool.query(
    'INSERT INTO payment_reminders (invoice_id, customer_id, channel, phone, message, sent_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [b.invoiceId, b.customerId, channel === 'sms' ? 'sms' : 'whatsapp', b.whatsapp, message, sentBy]
  );
  var out = { invoiceId: b.invoiceId, phone: b.whatsapp, message: message, channel: channel === 'sms' ? 'sms' : 'whatsapp' };
  if (channel === 'sms') out.sent = true;
  else out.whatsappUrl = 'https://wa.me/' + b.whatsapp + '?text=' + encodeURIComponent(message);
  return out;
}

function prepare(ctx, invoiceId, origin) { return remind(ctx, invoiceId, origin, 'whatsapp'); }
function sendSms(ctx, invoiceId, origin) { return remind(ctx, invoiceId, origin, 'sms'); }

async function history(ctx, invoiceId) {
  V.text(invoiceId, 'Invoice', 60);
  var list = await due(ctx, { windowDays: 60 });
  if (!list.rows.some(function (r) { return r.invoiceId === invoiceId; })) fail('notfound', 'That bill is not due, or you can\'t see it.');
  return (await pool.query(
    'SELECT pr.sent_at, pr.message, pr.phone, pr.channel, pr.automatic, e.first_name, e.last_name FROM payment_reminders pr LEFT JOIN employees e ON e.id = pr.sent_by ' +
    'WHERE pr.invoice_id = $1 ORDER BY pr.sent_at DESC', [invoiceId]
  )).rows.map(function (r) {
    return { at: r.sent_at, by: r.first_name ? r.first_name + ' ' + r.last_name : null, phone: r.phone, message: r.message, channel: r.channel, automatic: r.automatic };
  });
}

// ---- bookings ending ------------------------------------------------------------

// Poki tenants whose booking ends within `windowDays` (default 60) and
// hasn't been renewed, with a notice to send them.
async function bookingsEnding(ctx, opts) {
  if (!ctx.can('poki.read') && !ctx.can('poki.manage')) fail('forbidden', 'Your role does not allow this action (poki.read).');
  var windowDays = Math.max(1, Math.min(180, Number(opts && opts.windowDays) || 60));
  var today = todayISO();
  var rows = (await pool.query(
    'SELECT l.id, l.booking_no, l.end_date::text AS end_date, c.id AS customer_id, c.name AS customer_name, c.phone, c.contact_person, ' +
    '       u.code AS unit_code, u.name AS unit_name, p.name AS property_name, ' +
    '       n.sent_at AS last_sent_at, n.channel AS last_channel, n.automatic AS last_automatic, n.count AS notice_count, ' +
    '       e.first_name AS last_by_first, e.last_name AS last_by_last ' +
    'FROM poki_bookings l ' +
    'JOIN poki_units u ON u.id = l.unit_id JOIN poki_properties p ON p.id = u.property_id ' +
    'JOIN poki_tenants t ON t.id = l.tenant_id JOIN customers c ON c.id = t.customer_id ' +
    'LEFT JOIN LATERAL (SELECT bn.sent_at, bn.sent_by, bn.channel, bn.automatic, (SELECT count(*)::int FROM booking_notices x WHERE x.booking_id = l.id) AS count ' +
    '                   FROM booking_notices bn WHERE bn.booking_id = l.id ORDER BY bn.sent_at DESC LIMIT 1) n ON true ' +
    'LEFT JOIN employees e ON e.id = n.sent_by ' +
    "WHERE p.company_id = $1 AND l.status = 'active' AND l.end_date >= $2::date AND l.end_date <= ($2::date + $3::integer) " +
    "AND NOT EXISTS (SELECT 1 FROM poki_bookings nx WHERE nx.renewed_from_id = l.id AND nx.status IN ('draft', 'active')) " +
    'ORDER BY l.end_date, c.name',
    [await poki.pokiCompanyId(), today, windowDays]
  )).rows;
  return {
    today: today, windowDays: windowDays, smsAvailable: sms.configured(),
    rows: rows.map(function (r) { return bookingRow(ctx, r, today); })
  };
}

function bookingRow(ctx, r, today) {
  return {
    bookingId: r.id, bookingNo: r.booking_no, customerId: r.customer_id, customerName: r.customer_name,
    contactPerson: r.contact_person || '', phone: r.phone || '', whatsapp: whatsappNumber(r.phone),
    unit: (r.property_name ? r.property_name + ' · ' : '') + (r.unit_name || r.unit_code),
    endDate: r.end_date, daysLeft: daysBetween(today, r.end_date),
    lastNotice: r.last_sent_at ? {
      at: r.last_sent_at, by: r.last_by_first ? r.last_by_first + ' ' + r.last_by_last : null, count: r.notice_count,
      channel: r.last_channel, automatic: r.last_automatic
    } : null,
    canSend: ctx ? ctx.can('poki.manage') : true
  };
}

function composeBookingNotice(b) {
  var name = (b.contactPerson || b.customerName || '').trim();
  var when = b.daysLeft === 0 ? 'today' : 'on ' + fmtDate(b.endDate) + ' (in ' + b.daysLeft + ' day' + (b.daysLeft === 1 ? '' : 's') + ')';
  return [
    name ? 'Hello ' + name + ',' : 'Hello,',
    'This is Poki Properties. Your booking for ' + b.unit + ' (' + b.bookingNo + ') ends ' + when + '.',
    'If you would like to stay on, please contact us to renew. Thank you.'
  ].join('\n');
}

async function noticeBooking(ctx, bookingId, channel) {
  var list = await bookingsEnding(ctx, { windowDays: 180 });
  var b = list.rows.filter(function (r) { return r.bookingId === bookingId; })[0];
  if (!b) fail('notfound', 'That booking isn\'t ending soon, or you can\'t see it.');
  if (!b.canSend) fail('forbidden', 'Your role does not allow this action (poki.manage).');
  if (!b.whatsapp) fail('invalid', b.phone ? 'The phone number on file for ' + b.customerName + ' (' + b.phone + ') isn\'t one a message can go to.' : b.customerName + ' has no phone number on file. Add one on the tenant first.');
  var message = composeBookingNotice(b);
  var sentBy = ctx.employee ? ctx.employee.id : null;
  if (channel === 'sms') await sms.send({ to: b.phone, message: message, purpose: 'booking_notice', refId: b.bookingId, sentBy: sentBy });
  await pool.query(
    'INSERT INTO booking_notices (booking_id, channel, phone, message, sent_by) VALUES ($1,$2,$3,$4,$5)',
    [b.bookingId, channel === 'sms' ? 'sms' : 'whatsapp', b.whatsapp, message, sentBy]
  );
  var out = { bookingId: b.bookingId, phone: b.whatsapp, message: message, channel: channel === 'sms' ? 'sms' : 'whatsapp' };
  if (channel === 'sms') out.sent = true;
  else out.whatsappUrl = 'https://wa.me/' + b.whatsapp + '?text=' + encodeURIComponent(message);
  return out;
}

// ---- automatic texts ------------------------------------------------------------
//
// When turned on in Company settings, the OS texts customers and tenants on
// its own, once per milestone:
//   bills:     3 days before the due date, on the day, 7 and 30 days after
//   bookings:  30 and 7 days before the end date
// Only bills that fell due in the last AUTO_BILL_MAX_OVERDUE days: older
// debts are for a person to chase, and turning this on must not text every
// customer who has owed something for a year. If a text can't be sent (no
// credit, mNotify down), the run stops and tries again later.

var AUTO_BILL_MAX_OVERDUE = 45;
var BILL_MILESTONES = [{ key: 'before3', at: -3 }, { key: 'due', at: 0 }, { key: 'late7', at: 7 }, { key: 'late30', at: 30 }];
var BOOKING_MILESTONES = [{ key: '30', at: 30 }, { key: '7', at: 7 }];

// The most urgent milestone passed and not yet sent, claimed so two
// instances can't both send it. Once the text has gone, settle() marks the
// earlier ones sent with it, so a bill first seen 8 days late gets one text,
// not three.
async function claimMilestone(kind, refId, refDate, passed) {
  if (!passed.length) return null;
  var urgent = passed[passed.length - 1];
  var done = (await pool.query('SELECT milestone FROM auto_texts WHERE kind = $1 AND ref_id = $2 AND ref_date = $3', [kind, refId, refDate])).rows
    .map(function (r) { return r.milestone; });
  if (done.indexOf(urgent) >= 0) return null;
  var claimed = await pool.query(
    'INSERT INTO auto_texts (kind, ref_id, milestone, ref_date) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING milestone',
    [kind, refId, urgent, refDate]
  );
  if (!claimed.rowCount) return null; // another instance got it
  return { key: urgent, earlier: passed.slice(0, -1) };
}

async function settle(kind, refId, refDate, earlier) {
  for (var i = 0; i < earlier.length; i++) {
    await pool.query('INSERT INTO auto_texts (kind, ref_id, milestone, ref_date) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [kind, refId, earlier[i], refDate]);
  }
}

// A text that didn't go: let the next run try it again.
async function unclaim(kind, refId, milestone, refDate) {
  await pool.query('DELETE FROM auto_texts WHERE kind = $1 AND ref_id = $2 AND milestone = $3 AND ref_date = $4', [kind, refId, milestone, refDate]);
}

// Returns how many texts went out. Never throws. opts (for the tests):
// settings — use these instead of the saved ones; customerIds — only these
// customers.
async function autoTexts(opts) {
  opts = opts || {};
  var sent = 0;
  try {
    if (!sms.configured()) return 0;
    var settings = opts.settings || await sms.messaging();
    var only = Array.isArray(opts.customerIds) ? opts.customerIds : null;
    if (!settings.autoPaymentReminders && !settings.autoBookingNotices) return 0;
    var budget = sms.AUTO_DAILY_LIMIT - await sms.autoSentToday();
    var today = todayISO();
    var pokiId = await poki.pokiCompanyId();

    if (settings.autoPaymentReminders && budget > 0) {
      var bills = (await pool.query(
        'SELECT i.id, i.invoice_no, i.doc_kind, i.company_id, i.currency, i.balance_due, i.due_date::text AS due_date, ' +
        '       i.period_start::text AS period_start, i.period_end::text AS period_end, c.id AS customer_id, c.name AS customer_name, c.phone, c.contact_person, ' +
        '       u.code AS unit_code, u.name AS unit_name, pp.name AS property_name ' +
        'FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
        'LEFT JOIN poki_bookings l ON l.id = i.poki_booking_id LEFT JOIN poki_units u ON u.id = l.unit_id LEFT JOIN poki_properties pp ON pp.id = u.property_id ' +
        "WHERE i.status IN ('unpaid', 'partially_paid') AND i.balance_due > 0 AND i.due_date IS NOT NULL " +
        '  AND i.due_date <= ($1::date + 3) AND i.due_date >= ($1::date - $2::integer) ' +
        '  AND (' + bplScopeClause('i') + ' OR i.company_id = $3) ' +
        "  AND coalesce(c.phone, '') <> '' AND ($4::uuid[] IS NULL OR c.id = ANY($4)) ORDER BY i.due_date",
        [today, AUTO_BILL_MAX_OVERDUE, pokiId, only]
      )).rows;
      for (var i = 0; i < bills.length && budget > 0; i++) {
        var r = bills[i];
        if (!whatsappNumber(r.phone)) continue;
        var days = daysBetween(r.due_date, today);
        var passed = BILL_MILESTONES.filter(function (m) { return days >= m.at; }).map(function (m) { return m.key; });
        var milestone = await claimMilestone('bill', r.id, r.due_date, passed);
        if (!milestone) continue;
        var b = {
          invoiceNo: r.invoice_no, company: r.company_id === pokiId ? 'poki' : 'bpl', kind: r.doc_kind,
          customerName: r.customer_name, contactPerson: r.contact_person || '', currency: r.currency, balanceDue: Number(r.balance_due),
          dueDate: r.due_date, daysOverdue: days, periodStart: r.period_start, periodEnd: r.period_end,
          unit: r.unit_code ? (r.property_name ? r.property_name + ' · ' : '') + (r.unit_name || r.unit_code) : null
        };
        var message = composeMessage(b, null);
        try {
          await sms.send({ to: r.phone, message: message, purpose: 'auto_payment_reminder', refId: r.id });
        } catch (e) {
          await unclaim('bill', r.id, milestone.key, r.due_date);
          console.error('Automatic payment reminder not sent:', e.message);
          return sent;
        }
        await settle('bill', r.id, r.due_date, milestone.earlier);
        await pool.query(
          "INSERT INTO payment_reminders (invoice_id, customer_id, channel, phone, message, automatic) VALUES ($1,$2,'sms',$3,$4,true)",
          [r.id, r.customer_id, whatsappNumber(r.phone), message]
        );
        sent++;
        budget--;
      }
    }

    if (settings.autoBookingNotices && budget > 0) {
      var bookings = (await pool.query(
        'SELECT l.id, l.booking_no, l.end_date::text AS end_date, c.id AS customer_id, c.name AS customer_name, c.phone, c.contact_person, ' +
        '       u.code AS unit_code, u.name AS unit_name, p.name AS property_name ' +
        'FROM poki_bookings l JOIN poki_units u ON u.id = l.unit_id JOIN poki_properties p ON p.id = u.property_id ' +
        'JOIN poki_tenants t ON t.id = l.tenant_id JOIN customers c ON c.id = t.customer_id ' +
        "WHERE p.company_id = $1 AND l.status = 'active' AND l.end_date >= $2::date AND l.end_date <= ($2::date + 30) " +
        "AND NOT EXISTS (SELECT 1 FROM poki_bookings nx WHERE nx.renewed_from_id = l.id AND nx.status IN ('draft', 'active')) " +
        "AND coalesce(c.phone, '') <> '' AND ($3::uuid[] IS NULL OR c.id = ANY($3)) ORDER BY l.end_date",
        [pokiId, today, only]
      )).rows;
      for (var j = 0; j < bookings.length && budget > 0; j++) {
        var bk = bookingRow(null, bookings[j], today);
        if (!bk.whatsapp) continue;
        var passedB = BOOKING_MILESTONES.filter(function (m) { return bk.daysLeft <= m.at; }).map(function (m) { return m.key; });
        var ms = await claimMilestone('booking', bk.bookingId, bk.endDate, passedB);
        if (!ms) continue;
        var notice = composeBookingNotice(bk);
        try {
          await sms.send({ to: bk.phone, message: notice, purpose: 'auto_booking_notice', refId: bk.bookingId });
        } catch (e) {
          await unclaim('booking', bk.bookingId, ms.key, bk.endDate);
          console.error('Automatic booking notice not sent:', e.message);
          return sent;
        }
        await settle('booking', bk.bookingId, bk.endDate, ms.earlier);
        await pool.query(
          "INSERT INTO booking_notices (booking_id, channel, phone, message, automatic) VALUES ($1,'sms',$2,$3,true)",
          [bk.bookingId, bk.whatsapp, notice]
        );
        sent++;
        budget--;
      }
    }
  } catch (e) {
    console.error('Automatic texts failed:', e.message);
  }
  if (sent) console.log('Automatic texts: sent ' + sent + '.');
  return sent;
}

module.exports = {
  due: due, prepare: prepare, sendSms: sendSms, history: history, whatsappNumber: whatsappNumber, composeMessage: composeMessage,
  bookingsEnding: bookingsEnding, noticeBooking: noticeBooking, composeBookingNotice: composeBookingNotice, autoTexts: autoTexts
};
