var { pool, withTransaction } = require('../db/pool');
var { notify } = require('../utils/notify');
var { todayISO } = require('../utils/documents');
var poki = require('./poki.service');

// Booking expiry reminders.
//
// A booking left to lapse frees its unit and stops billing on its end date,
// so the useful moment to act is weeks before that, not after. The Poki
// overview already shows what is expiring; this pushes the same facts into
// the notification bell so nobody has to go looking.
//
// There is no scheduler in this deployment, so this runs as a lazy sweep
// when someone opens the bookings or overview screen — the established
// pattern here (autoExpireBookings, autoExpireQuotations). That has one real
// consequence: the sweep is NOT guaranteed to run on any particular day,
// and may run many times on others. Both are handled below.

// Notify at these distances from the end date. Wide at the top because a
// commercial tenant deciding whether to renew needs months, tight at the
// bottom because the last week is when re-letting actually starts.
var MILESTONES = [
  { key: '90', days: 90, label: '90 days' },
  { key: '60', days: 60, label: '60 days' },
  { key: '30', days: 30, label: '30 days' },
  { key: '14', days: 14, label: '14 days' },
  { key: '7', days: 7, label: '7 days' }
];
var WIDEST = MILESTONES[0].days;

// Whoever can act on a booking gets told about it. Read-only Poki staff are
// deliberately left out: a reminder they cannot act on is just noise.
async function recipients() {
  var res = await pool.query(
    'SELECT DISTINCT u.employee_id ' +
    'FROM users u ' +
    'JOIN user_roles ur ON ur.user_id = u.id ' +
    'JOIN role_permissions rp ON rp.role_id = ur.role_id ' +
    "WHERE rp.permission_key = 'poki.manage' AND u.status = 'active'"
  );
  return res.rows.map(function (r) { return r.employee_id; });
}

function daysBetween(fromISO, toISO) {
  var a = new Date(fromISO + 'T00:00:00Z').getTime();
  var b = new Date(toISO + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

function fmtDate(iso) {
  var d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// In-process throttle. The unique constraint is what makes the sweep
// correct; this only stops it re-querying on every single page load. It is
// per-instance and resets on restart, which is harmless — a redundant sweep
// writes nothing.
var lastSweptAt = 0;
var THROTTLE_MS = 10 * 60 * 1000;

// Returns the number of reminders sent. Never throws into the caller: a
// failed reminder must not take down the screen someone was trying to
// open, so problems are logged and swallowed.
async function sweep(opts) {
  var force = !!(opts && opts.force);
  if (!force && Date.now() - lastSweptAt < THROTTLE_MS) return 0;
  lastSweptAt = Date.now();

  try {
    var today = todayISO();
    var companyId = await poki.pokiCompanyId();

    var res = await pool.query(
      'SELECT l.id, l.booking_no, l.end_date, l.status, u.code AS unit_code, p.name AS property_name, ' +
      '       c.name AS tenant_name ' +
      'FROM poki_bookings l ' +
      'JOIN poki_units u ON u.id = l.unit_id ' +
      'JOIN poki_properties p ON p.id = u.property_id ' +
      'JOIN poki_tenants t ON t.id = l.tenant_id ' +
      'JOIN customers c ON c.id = t.customer_id ' +
      "WHERE p.company_id = $1 AND l.status IN ('active', 'expired') " +
      "  AND l.end_date <= ($2::date + $3::integer) " +
      'ORDER BY l.end_date',
      [companyId, today, WIDEST]
    );
    if (!res.rows.length) return 0;

    var who = await recipients();
    if (!who.length) return 0;

    var sent = 0;
    for (var i = 0; i < res.rows.length; i++) {
      sent += await remindFor(res.rows[i], today, who);
    }
    return sent;
  } catch (err) {
    console.error('poki booking reminder sweep failed:', err.message);
    return 0;
  }
}

async function remindFor(booking, today, who) {
  var endISO = String(booking.end_date).slice(0, 10);
  var daysLeft = daysBetween(today, endISO);

  // Which milestones this booking has now passed. If the sweep hasn't run in
  // a while — nobody opened the screen for a month — several will have been
  // crossed at once. Only the most urgent is worth a notification; the rest
  // are recorded as sent so they don't fire later out of order. Sending
  // "90 days", "60 days" and "30 days" in one burst would be noise that
  // misstates the position.
  var crossed = [];
  if (daysLeft < 0 || booking.status === 'expired') {
    crossed = MILESTONES.map(function (m) { return m.key; }).concat(['expired']);
  } else {
    for (var i = 0; i < MILESTONES.length; i++) {
      if (daysLeft <= MILESTONES[i].days) crossed.push(MILESTONES[i].key);
    }
  }
  if (!crossed.length) return 0;

  var urgent = crossed[crossed.length - 1];
  var already = await pool.query(
    'SELECT milestone FROM poki_booking_reminders WHERE booking_id = $1 AND end_date = $2',
    [booking.id, endISO]
  );
  var done = {};
  already.rows.forEach(function (r) { done[r.milestone] = true; });

  var fresh = crossed.filter(function (k) { return !done[k]; });
  if (!fresh.length) return 0;

  var announce = fresh.indexOf(urgent) !== -1;
  var where = booking.property_name + ' · ' + booking.unit_code;
  var title = urgent === 'expired'
    ? 'Booking expired — ' + where
    : 'Booking ends in ' + (MILESTONES.filter(function (m) { return m.key === urgent; })[0] || {}).label + ' — ' + where;
  var body = urgent === 'expired'
    ? booking.booking_no + ' for ' + booking.tenant_name + ' ended ' + fmtDate(endISO) + '. The unit is now free to re-let.'
    : booking.booking_no + ' for ' + booking.tenant_name + ' ends ' + fmtDate(endISO) + '. Renew it or start re-letting.';

  // One transaction so a reminder is never marked sent without the
  // notifications actually being written, nor written twice if two
  // instances sweep at the same moment — the unique constraint makes the
  // loser roll back.
  try {
    await withTransaction(async function (client) {
      for (var i = 0; i < fresh.length; i++) {
        await client.query(
          'INSERT INTO poki_booking_reminders (booking_id, milestone, end_date) VALUES ($1,$2,$3)',
          [booking.id, fresh[i], endISO]
        );
      }
      if (announce) {
        for (var j = 0; j < who.length; j++) {
          await notify(client, who[j], title, body, 'pokibookings');
        }
      }
    });
  } catch (err) {
    // A concurrent sweep got there first. Nothing to do and nothing wrong.
    if (err && String(err.code) === '23505') return 0;
    throw err;
  }

  return announce ? who.length : 0;
}

module.exports = { sweep: sweep, MILESTONES: MILESTONES, recipients: recipients };
