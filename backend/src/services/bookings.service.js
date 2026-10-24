var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { internationalNumber } = require('../utils/phone');
var config = require('../config');

// Booking a consultation with Bamboo Products on the website (migration
// 0187; settings.booking) — Square Appointments' booking page, at /book on
// the OS's own address: a showroom visit, a site measurement or a call, on
// a day and time the business is open and has room. Each booking is a lead
// in the CRM (and, for a visit to the customer, a site visit on the rep's
// map); the customer gets its own page to see or cancel it; staff confirm,
// reassign and close them on the Appointments page. Ghana keeps UTC all
// year, so times are kept and shown as they are. A booking can carry a fee
// (migration 0188): each service's own (a consultation, a call, a site
// measurement), or for a visit to the customer the fee of the area they
// pick; it is invoiced to them at once and paid on the invoice's page
// (invoicePay), on the customer website like the booking itself.

var DEFAULT_SERVICES = [
  { id: 'showroom', name: 'Showroom visit', minutes: 60, visit: false, note: 'See and touch our bamboo products, with someone to answer your questions.' },
  { id: 'measure', name: 'Site measurement', minutes: 90, visit: true, note: 'We come to your home or site to measure for blinds, furniture or a fit-out.' },
  { id: 'call', name: 'Phone or video call', minutes: 30, visit: false, note: 'Talk your project through with us.' }
];
var DEFAULTS = { on: false, intro: '', services: DEFAULT_SERVICES, days: [1, 2, 3, 4, 5, 6], from: '08:00', to: '17:00', step: 30, perSlot: 1, daysAhead: 30, noticeHours: 12, assignTo: null, areas: [], feeNote: '' };
var ctxBooking = { can: function () { return true; }, user: { id: null }, employee: { id: null, first_name: 'Online booking', last_name: '' } };
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function feeOf(v) { var n = round2(v); return n > 0 && n <= 100000 ? n : 0; }
var STATUSES = ['requested', 'confirmed', 'cancelled', 'done'];
var PER_IP_HOUR = 5;

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function isTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')); }
function isDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function isEmail(v) { return /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i.test(String(v || '')); }
function mins(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
function clock(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function addDays(day, n) { var d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function at(day, time) { return new Date(day + 'T' + time + ':00Z'); }
function whenText(d) {
  var x = new Date(d);
  return x.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) + ' at ' + x.toISOString().slice(11, 16);
}

function cleanServices(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (s) {
    if (!s || out.length >= 8) return;
    var id = String(s.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
    var name = text(s.name, 60);
    var minutes = Math.round(Number(s.minutes));
    if (id.length < 2 || name.length < 2 || !(minutes >= 15 && minutes <= 480) || out.some(function (o) { return o.id === id; })) return;
    out.push({ id: id, name: name, minutes: minutes, visit: !!s.visit, note: text(s.note, 200), fee: feeOf(s.fee) });
  });
  return out;
}
// The areas a visit is priced by (Accra, Tema, further…), each with its fee.
function cleanAreas(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (a) {
    var name = text(a && a.name, 60);
    if (name.length < 2 || out.length >= 20 || out.some(function (o) { return o.name.toLowerCase() === name.toLowerCase(); })) return;
    out.push({ name: name, fee: feeOf(a.fee) });
  });
  return out;
}
async function settingsOf(db) {
  var s = ((await (db || pool).query('SELECT booking FROM settings WHERE id = 1')).rows[0] || {}).booking || {};
  var services = cleanServices(s.services);
  return {
    on: !!s.on, intro: text(s.intro, 400), services: services.length ? services : DEFAULT_SERVICES,
    days: Array.isArray(s.days) ? s.days.map(Number).filter(function (d) { return d >= 0 && d <= 6; }) : DEFAULTS.days,
    from: isTime(s.from) ? s.from : DEFAULTS.from, to: isTime(s.to) ? s.to : DEFAULTS.to,
    step: [15, 30, 60].indexOf(Number(s.step)) >= 0 ? Number(s.step) : DEFAULTS.step,
    perSlot: Number(s.perSlot) >= 1 && Number(s.perSlot) <= 10 ? Math.round(Number(s.perSlot)) : DEFAULTS.perSlot,
    daysAhead: Number(s.daysAhead) >= 1 && Number(s.daysAhead) <= 90 ? Math.round(Number(s.daysAhead)) : DEFAULTS.daysAhead,
    noticeHours: Number(s.noticeHours) >= 0 && Number(s.noticeHours) <= 72 ? Math.round(Number(s.noticeHours)) : DEFAULTS.noticeHours,
    assignTo: /^[0-9a-f-]{36}$/i.test(String(s.assignTo || '')) ? s.assignTo : null,
    areas: cleanAreas(s.areas), feeNote: text(s.feeNote, 200)
  };
}
// What a booking costs: a visit's area's fee (when areas are set), else the service's.
function feeFor(s, service, areaName) {
  if (service.visit && s.areas.length) {
    var area = s.areas.find(function (a) { return a.name.toLowerCase() === String(areaName || '').trim().toLowerCase(); });
    if (!area) fail('invalid', 'Choose your area.');
    return { area: area.name, fee: area.fee };
  }
  return { area: '', fee: service.fee || 0 };
}

// The days open for booking, from today (with the notice asked) on.
function openDays(s, now) {
  var out = [];
  var today = now.toISOString().slice(0, 10);
  for (var i = 0; i <= s.daysAhead && out.length < 60; i++) {
    var d = addDays(today, i);
    if (s.days.indexOf(new Date(d + 'T12:00:00Z').getUTCDay()) < 0) continue;
    if (at(d, s.to).getTime() - s.noticeHours * 3600000 <= now.getTime()) continue;
    out.push(d);
  }
  return out;
}
// A day's start times for a service: each ending by closing time, after the
// notice, and full when as many bookings as perSlot overlap it.
async function slotsOf(s, service, day, now, db) {
  var taken = (await (db || pool).query(
    "SELECT starts_at, ends_at FROM appointments WHERE status IN ('requested', 'confirmed') AND starts_at < $2 AND ends_at > $1",
    [at(day, '00:00'), at(addDays(day, 1), '00:00')])).rows;
  var out = [];
  for (var m = mins(s.from); m + service.minutes <= mins(s.to); m += s.step) {
    var a = at(day, clock(m)), b = new Date(a.getTime() + service.minutes * 60000);
    if (a.getTime() - s.noticeHours * 3600000 <= now.getTime()) continue;
    var overlapping = taken.filter(function (t) { return new Date(t.starts_at) < b && new Date(t.ends_at) > a; }).length;
    out.push({ time: clock(m), full: overlapping >= s.perSlot });
  }
  return out;
}

// GET /api/book?service=&date= — what can be booked, and a day's times.
async function options(q) {
  q = q || {};
  var s = await settingsOf();
  if (!s.on) return { on: false };
  var now = new Date();
  var days = openDays(s, now);
  var service = s.services.find(function (x) { return x.id === q.service; }) || s.services[0];
  var date = isDay(q.date) && days.indexOf(q.date) >= 0 ? q.date : days[0] || null;
  return {
    on: true, intro: s.intro, services: s.services, areas: s.areas, feeNote: s.feeNote, payOnline: require('./invoicePay.service').configured(), days: days, service: service.id, date: date,
    slots: date ? await slotsOf(s, service, date, now) : []
  };
}

var bookedBy = new Map();
function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (bookedBy.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many bookings from here in the last hour. Call us instead.');
  list.push(now);
  bookedBy.set(key, list);
  if (bookedBy.size > 5000) bookedBy.clear();
}

// The booking's fee, from its row with its invoice (FEE_JOIN): how much,
// whether paid, and the invoice's page to pay it on.
function feeOut(r) {
  if (!(Number(r.fee) > 0)) return null;
  return { amount: round2(r.fee), area: r.area || '', paid: r.fee_status === 'paid', void: r.fee_status === 'void', due: r.fee_balance != null ? round2(r.fee_balance) : round2(r.fee),
    token: r.fee_token || null, invoiceId: r.fee_invoice_id || null, invoiceNo: r.fee_invoice_no || null };
}
var FEE_JOIN = 'LEFT JOIN invoices fi ON fi.id = a.fee_invoice_id LEFT JOIN document_shares fs ON fs.id = a.fee_share_id ';
var FEE_COLS = 'fi.status AS fee_status, fi.balance_due AS fee_balance, fi.invoice_no AS fee_invoice_no, fs.token AS fee_token';
function viewOf(r) {
  var future = new Date(r.starts_at) > new Date();
  return {
    service: r.service, serviceName: r.service_name, startsAt: r.starts_at, endsAt: r.ends_at, name: r.name, location: r.location, area: r.area || '', note: r.note, status: r.status,
    canCancel: future && (r.status === 'requested' || r.status === 'confirmed'), fee: feeOut(r)
  };
}

// A booking with a fee: the customer (found by phone or email, else added,
// as the shop does), an invoice for the fee due on the day, and its link.
async function raiseFee(r, service) {
  var customerId = await withTransaction(function (client) { return require('./shop.service').customerFor(client, { name: r.name, phone: r.phone, email: r.email, address: r.location }); });
  var inv = await require('./invoices.service').createManual(ctxBooking, {
    customerId: customerId, currency: 'GHS', dueDate: String(r.starts_at instanceof Date ? r.starts_at.toISOString() : r.starts_at).slice(0, 10),
    items: [{ description: (service.name + ' fee' + (r.area ? ' (' + r.area + ')' : '')).slice(0, 160), qty: 1, unitPrice: round2(r.fee) }],
    notes: 'Booked on the website: ' + service.name.toLowerCase() + ' on ' + whenText(r.starts_at) + '.'
  });
  var link = await require('./shares.service').issueLink('invoice', inv.id, 30, null);
  await pool.query('UPDATE appointments SET customer_id = $2, fee_invoice_id = $3, fee_share_id = (SELECT id FROM document_shares WHERE token = $4) WHERE id = $1', [r.id, customerId, inv.id, link.token]);
  if (r.lead_id) await pool.query('UPDATE crm_leads SET customer_id = coalesce(customer_id, $2) WHERE id = $1', [r.lead_id, customerId]);
  return { token: link.token, invoiceNo: inv.invoiceNo };
}
// A booking cancelled: its fee's invoice voided when nothing was paid on it;
// paid, it stays for staff to refund. Says which.
async function dropFee(r) {
  if (!r.fee_invoice_id) return null;
  var inv = (await pool.query('SELECT status, amount_paid FROM invoices WHERE id = $1', [r.fee_invoice_id])).rows[0];
  if (!inv || inv.status === 'void') return null;
  if (Number(inv.amount_paid) > 0) return 'paid';
  try { await require('./invoices.service').voidInvoice(ctxBooking, r.fee_invoice_id, 'Booking cancelled.'); } catch (e) { return null; }
  return 'voided';
}

// POST /api/book { service, date, time, name, phone, email, location, note,
// website (left empty: a form robot fills it) } — the booking, its lead in
// the CRM (and a site visit, for a visit), and its own page's link.
async function book(p, ip) {
  p = p || {};
  var s = await settingsOf();
  if (!s.on) fail('conflict', 'Booking online is not open. Please call us.');
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  var service = s.services.find(function (x) { return x.id === p.service; }) || fail('invalid', 'Choose what you would like to book.');
  var now = new Date();
  if (!isDay(p.date) || openDays(s, now).indexOf(p.date) < 0) fail('invalid', 'Choose a day we are open.');
  if (!isTime(p.time)) fail('invalid', 'Choose a time.');
  var name = text(p.name, 120);
  if (name.length < 2) fail('invalid', 'Type your name.');
  var phone = text(p.phone, 30);
  if (!internationalNumber(phone)) fail('invalid', 'Type a phone number we can call, e.g. 024 412 3456.');
  var email = text(p.email, 160).toLowerCase();
  if (email && !isEmail(email)) fail('invalid', 'That email address does not look right.');
  var location = text(p.location, 300);
  if (service.visit && location.length < 5) fail('invalid', 'Where should we come? Type the address or a landmark.');
  var note = text(p.note, 500);
  var priced = feeFor(s, service, p.area);
  throttle(ip);

  var startsAt = at(p.date, p.time), endsAt = new Date(startsAt.getTime() + service.minutes * 60000);
  var made = await withTransaction(async function (client) {
    // One booking at a time, so two people cannot take the last place.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('appointments'))");
    var slot = (await slotsOf(s, service, p.date, now, client)).find(function (x) { return x.time === p.time; });
    if (!slot) fail('invalid', 'That time is not open. Choose another.');
    if (slot.full) fail('conflict', 'Someone just took that time. Choose another.');
    var whenWords = whenText(startsAt);
    var lead = (await client.query(
      "INSERT INTO crm_leads (name, phone, email, location, source, item, stage, rep_id, comments, next_follow_up) VALUES ($1,$2,$3,$4,'Website booking',$5,'new',$6,$7,$8) RETURNING id, ref",
      [name, '+' + internationalNumber(phone), email, location, service.name, s.assignTo, 'Booked a ' + service.name.toLowerCase() + ' for ' + whenWords + ' on the website.' + (note ? ' ' + note : ''), p.date])).rows[0];
    var visit = null;
    if (service.visit) {
      visit = (await client.query("INSERT INTO crm_site_visits (lead_id, client, location, scheduled_on, assessor_ids, findings) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [lead.id, name, location, p.date, s.assignTo ? [s.assignTo] : [], 'Booked on the website for ' + p.time + ' (' + service.name + ').'])).rows[0];
    }
    var row = (await client.query(
      'INSERT INTO appointments (service, service_name, starts_at, ends_at, name, phone, email, location, note, lead_id, site_visit_id, assigned_to, token, ip, area, fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
      [service.id, service.name, startsAt, endsAt, name, '+' + internationalNumber(phone), email, location, note, lead.id, visit ? visit.id : null, s.assignTo,
        crypto.randomBytes(18).toString('base64url'), String(ip || '').slice(0, 60), priced.area, priced.fee])).rows[0];
    return { row: row, lead: lead };
  });
  var r = made.row;
  var pay = null;
  if (priced.fee > 0) {
    try { pay = await raiseFee(r, service); } catch (e) { console.error('Booking fee not invoiced:', e.message); }
  }
  await audit(pool, { user: { id: null }, employee: { first_name: 'Website', last_name: 'booking' } }, 'booking.create', 'appointment', r.id, name + ' booked a ' + service.name.toLowerCase() + ' for ' + whenText(startsAt) + ' (' + made.lead.ref + ').');
  var to = s.assignTo ? [s.assignTo] : (await require('./staffAlerts.service').holdersOf(['crm.manage'])).map(function (h) { return h.employee_id; });
  for (var i = 0; i < to.length; i++) await notify(pool, to[i], '📅 New booking: ' + service.name, name + ' · ' + whenText(startsAt) + (location ? ' · ' + location : '') + (priced.fee ? ' · fee GHS ' + priced.fee.toFixed(2) : ''), '/appointments?open=' + r.id);
  var link = config.bplSiteUrl + '/book/' + r.token;
  if (email) {
    await tell(r, 'Your booking with Bamboo Products', 'Thank you, ' + name.split(' ')[0] + '! We have your request for a ' + service.name.toLowerCase() + ' on ' + whenText(startsAt) + '.' +
      (pay ? ' Its fee of GHS ' + priced.fee.toFixed(2) + ' is on invoice ' + pay.invoiceNo + ', to pay on its page: ' + config.bplSiteUrl + '/share/' + pay.token + '.' : '') +
      ' We will confirm it shortly. See or cancel it: ' + link);
  }
  return { token: r.token, booking: await view(r.token) };
}

// An email to the customer, when they gave one and email is set up.
async function tell(r, subject, words) {
  if (!r.email) return false;
  try {
    var mail = require('./mail.service');
    if (!mail.configured()) return false;
    await mail.send({ to: r.email, subject: subject, fromName: 'Bamboo Products', text: words, html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">' + mail.escapeHtml(words) + '</div>' });
    return true;
  } catch (e) { return false; }
}

async function byToken(token, lock, client) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail('notfound', 'We cannot find that booking.');
  var r = (await (client || pool).query(lock ? 'SELECT * FROM appointments WHERE token = $1 FOR UPDATE' : 'SELECT a.*, ' + FEE_COLS + ' FROM appointments a ' + FEE_JOIN + 'WHERE a.token = $1', [token])).rows[0];
  if (!r) fail('notfound', 'We cannot find that booking.');
  return r;
}
// GET /api/book/:token — the booking's own page.
async function view(token) { return viewOf(await byToken(token)); }
// POST /api/book/:token/cancel — cancelled by the customer, while it is still to come.
async function cancel(token) {
  var r = await withTransaction(async function (client) {
    var row = await byToken(token, true, client);
    if (!viewOf(row).canCancel) fail('conflict', 'This booking cannot be cancelled now. Please call us.');
    row = (await client.query("UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1 RETURNING *", [row.id])).rows[0];
    if (row.site_visit_id) await client.query("UPDATE crm_site_visits SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'scheduled'", [row.site_visit_id]);
    return row;
  });
  var fee = await dropFee(r);
  var to = r.assigned_to ? [r.assigned_to] : (await require('./staffAlerts.service').holdersOf(['crm.manage'])).map(function (h) { return h.employee_id; });
  for (var i = 0; i < to.length; i++) {
    await notify(pool, to[i], '✕ Booking cancelled: ' + r.service_name, r.name + ' cancelled ' + whenText(r.starts_at) + '.' + (fee === 'paid' ? ' The fee was paid: refund it from its invoice.' : ''), '/appointments?open=' + r.id);
  }
  return view(token);
}

// ── for staff ──
function staffOut(r) {
  return {
    id: r.id, service: r.service, serviceName: r.service_name, startsAt: r.starts_at, endsAt: r.ends_at, name: r.name, phone: r.phone, email: r.email, location: r.location, note: r.note,
    status: r.status, createdAt: r.created_at, leadId: r.lead_id, leadRef: r.lead_ref || null, siteVisitId: r.site_visit_id,
    assignedTo: r.assigned_to ? { id: r.assigned_to, name: r.a_first + ' ' + r.a_last } : null, area: r.area || '', fee: feeOut(r)
  };
}
var STAFF_SELECT = 'SELECT a.*, l.ref AS lead_ref, e.first_name AS a_first, e.last_name AS a_last, ' + FEE_COLS + ' FROM appointments a LEFT JOIN crm_leads l ON l.id = a.lead_id LEFT JOIN employees e ON e.id = a.assigned_to ' + FEE_JOIN;
async function people() {
  return (await pool.query(
    "SELECT DISTINCT e.id, e.first_name, e.last_name FROM employees e JOIN users u ON u.employee_id = e.id JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id " +
    "WHERE e.status = 'active' AND u.status = 'active' AND rp.permission_key = 'crm.manage' ORDER BY e.first_name, e.last_name")).rows.map(function (e) { return { id: e.id, name: e.first_name + ' ' + e.last_name }; });
}

// GET /api/appointments?from=&to= — the bookings between two days (yesterday
// to a month on, by default), with the booking page's settings.
async function list(ctx, q) {
  if (!ctx.can('crm.read')) fail('forbidden', 'Your role does not allow this action (crm.read).');
  q = q || {};
  var today = new Date().toISOString().slice(0, 10);
  var from = isDay(q.from) ? q.from : addDays(today, -1), to = isDay(q.to) ? q.to : addDays(today, 30);
  var rows = (await pool.query(STAFF_SELECT + 'WHERE a.starts_at >= $1 AND a.starts_at < $2 ORDER BY a.starts_at', [at(from, '00:00'), at(addDays(to, 1), '00:00')])).rows;
  var counts = (await pool.query(
    "SELECT count(*) FILTER (WHERE status = 'requested' AND starts_at > now()) AS waiting, count(*) FILTER (WHERE status IN ('requested', 'confirmed') AND starts_at::date = current_date) AS today, " +
    "count(*) FILTER (WHERE status IN ('requested', 'confirmed') AND starts_at > now() AND starts_at < now() + interval '7 days') AS week, count(*) FILTER (WHERE created_at > now() - interval '30 days') AS month FROM appointments")).rows[0];
  return {
    from: from, to: to, appointments: rows.map(staffOut), settings: await settingsOf(), people: await people(), url: config.bplSiteUrl + '/book',
    totals: { waiting: Number(counts.waiting), today: Number(counts.today), week: Number(counts.week), month: Number(counts.month) }
  };
}

// PATCH /api/appointments/:id { status, assignedTo } — confirmed (the
// customer is texted and emailed), done, cancelled; or given to someone.
async function update(ctx, id, p) {
  if (!ctx.can('crm.manage')) fail('forbidden', 'Your role does not allow this action (crm.manage).');
  p = p || {};
  var r = (await pool.query('SELECT * FROM appointments WHERE id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'That booking is gone.');
  var said = [];
  if (p.assignedTo !== undefined) {
    var who = p.assignedTo ? (await pool.query("SELECT id, first_name, last_name FROM employees WHERE id = $1 AND status = 'active'", [p.assignedTo])).rows[0] : null;
    if (p.assignedTo && !who) fail('invalid', 'Choose someone on the team.');
    await pool.query('UPDATE appointments SET assigned_to = $2 WHERE id = $1', [id, who ? who.id : null]);
    if (r.lead_id && who) await pool.query('UPDATE crm_leads SET rep_id = $2, updated_at = now() WHERE id = $1', [r.lead_id, who.id]);
    if (r.site_visit_id) await pool.query('UPDATE crm_site_visits SET assessor_ids = $2, updated_at = now() WHERE id = $1', [r.site_visit_id, who ? [who.id] : []]);
    if (who && who.id !== ctx.employee.id) await notify(pool, who.id, '📅 A booking for you: ' + r.service_name, r.name + ' · ' + whenText(r.starts_at), '/appointments?open=' + r.id);
    said.push('given to ' + (who ? who.first_name + ' ' + who.last_name : 'nobody'));
  }
  var texted = false;
  if (p.status !== undefined && p.status !== r.status) {
    if (STATUSES.indexOf(p.status) < 0 || p.status === 'requested') fail('invalid', 'Confirmed, done or cancelled?');
    if (r.status === 'cancelled') fail('conflict', 'That booking was cancelled.');
    await pool.query('UPDATE appointments SET status = $2, cancelled_at = CASE WHEN $2 = \'cancelled\' THEN now() ELSE cancelled_at END WHERE id = $1', [id, p.status]);
    var feeSaid = p.status === 'cancelled' ? await dropFee(r) : null;
    if (feeSaid) said.push(feeSaid === 'paid' ? 'the fee was paid: to refund' : 'its fee invoice voided');
    if (r.site_visit_id) {
      if (p.status === 'cancelled') await pool.query("UPDATE crm_site_visits SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'scheduled'", [r.site_visit_id]);
      if (p.status === 'done') await pool.query("UPDATE crm_site_visits SET status = 'visited', updated_at = now() WHERE id = $1 AND status = 'scheduled'", [r.site_visit_id]);
    }
    if (r.lead_id && p.status === 'confirmed') await pool.query("UPDATE crm_leads SET stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END, stage_changed_at = CASE WHEN stage = 'new' THEN now() ELSE stage_changed_at END, updated_at = now() WHERE id = $1", [r.lead_id]);
    var link = config.bplSiteUrl + '/book/' + r.token;
    if (p.status === 'confirmed' || p.status === 'cancelled') {
      var words = p.status === 'confirmed'
        ? 'Bamboo Products: your ' + r.service_name.toLowerCase() + ' on ' + whenText(r.starts_at) + ' is confirmed. See you then! ' + link
        : 'Bamboo Products: we are sorry, your ' + r.service_name.toLowerCase() + ' on ' + whenText(r.starts_at) + ' is cancelled. Call us to find another time.';
      var sms = require('./sms.service');
      if (sms.configured()) { try { await sms.send({ to: r.phone, message: words, purpose: 'booking', refId: r.id }); texted = true; } catch (e) { /* the email, or a call */ } }
      await tell(r, p.status === 'confirmed' ? 'Your booking is confirmed' : 'Your booking is cancelled', words);
    }
    said.push(p.status);
  }
  if (said.length) await audit(pool, ctx, 'booking.update', 'appointment', id, r.name + ', ' + r.service_name + ' on ' + whenText(r.starts_at) + ': ' + said.join(', ') + '.');
  return Object.assign(staffOut((await pool.query(STAFF_SELECT + 'WHERE a.id = $1', [id])).rows[0]), { texted: texted });
}

// GET/PUT /api/appointments/settings — the booking page: on or off, its
// words, what can be booked, the days and hours, how many at once.
async function getSettings(ctx) {
  if (!ctx.can('crm.read')) fail('forbidden', 'Your role does not allow this action (crm.read).');
  return { settings: await settingsOf(), people: await people(), url: config.bplSiteUrl + '/book' };
}
async function saveSettings(ctx, p) {
  if (!ctx.can('crm.manage')) fail('forbidden', 'Your role does not allow this action (crm.manage).');
  p = p || {};
  var services = cleanServices(p.services);
  if (!services.length) fail('invalid', 'Add at least one thing to book, with a name and 15 to 480 minutes.');
  if (!isTime(p.from) || !isTime(p.to) || mins(p.to) <= mins(p.from)) fail('invalid', 'Give the opening hours like 08:00 to 17:00.');
  var days = (Array.isArray(p.days) ? p.days : []).map(Number).filter(function (d, i, a) { return d >= 0 && d <= 6 && a.indexOf(d) === i; });
  if (p.on && !days.length) fail('invalid', 'Choose the days we take bookings.');
  var s = {
    on: !!p.on, intro: text(p.intro, 400), services: services, days: days, from: p.from, to: p.to,
    step: [15, 30, 60].indexOf(Number(p.step)) >= 0 ? Number(p.step) : 30,
    perSlot: Math.max(1, Math.min(10, Math.round(Number(p.perSlot) || 1))), daysAhead: Math.max(1, Math.min(90, Math.round(Number(p.daysAhead) || 30))),
    noticeHours: Math.max(0, Math.min(72, Math.round(Number(p.noticeHours) || 0))),
    assignTo: p.assignTo && (await pool.query("SELECT 1 FROM employees WHERE id = $1 AND status = 'active'", [p.assignTo])).rows[0] ? p.assignTo : null,
    areas: cleanAreas(p.areas), feeNote: text(p.feeNote, 200)
  };
  await pool.query('UPDATE settings SET booking = $1 WHERE id = 1', [JSON.stringify(s)]);
  await audit(pool, ctx, 'settings.booking', 'settings', 'booking', 'Booking page ' + (s.on ? 'open' : 'closed') + ': ' + s.services.map(function (x) { return x.name; }).join(', ') + '.');
  return getSettings(ctx);
}

module.exports = { options: options, book: book, view: view, cancel: cancel, list: list, update: update, getSettings: getSettings, saveSettings: saveSettings, settingsOf: settingsOf, DEFAULT_SERVICES: DEFAULT_SERVICES };
