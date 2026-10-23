var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { internationalNumber } = require('../utils/phone');
var config = require('../config');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Bookings and the waitlist (migration 0171). On the till (the Bookings
// panel, frontend till/Bookings.jsx): tables booked for a time, and
// walk-ins waiting for one, told roughly how long. A booking holds its
// table for its minutes (the floor map shows it coming); a guest waiting is
// texted when their table is ready; seated, they become an order.
//
// On the website (online/BookSheet.jsx) a guest asks for a table at a time
// the restaurant offers (the till's settings, bookings): it waits for the
// till to confirm it — or is booked at once (autoConfirm) — and the guest
// is texted either way, with their own link to see or cancel it.
//
// Texts go by SMS when the server has it (sms.service); otherwise the till
// is handed a WhatsApp link to send the same words itself. The restaurant's
// clock is Ghana's: GMT, all year.

var STATUSES = ['requested', 'booked', 'waiting', 'called', 'seated', 'cancelled', 'no_show', 'declined'];
// Still to come, holding their table.
var LIVE = ['requested', 'booked', 'waiting', 'called'];
var QUOTES = [0, 5, 10, 15, 20, 30, 45, 60, 90];
var DAY = /^\d{4}-\d{2}-\d{2}$/;
var MAX_ACTIVE_PER_PHONE = 3, PER_IP_HOUR = 10;
var askedBy = new Map(); // address -> [times]

function sms() { return require('./sms.service'); }
function online() { return require('./restaurantOnline.service'); }
function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function dayOf(d) { return new Date(d).toISOString().slice(0, 10); }
function hhmm(d) { return new Date(d).toISOString().slice(11, 16); }
var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function whenText(d) { d = new Date(d); return WEEKDAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' at ' + hhmm(d); }
function minutesOf(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
function timeOf(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function bookingLink(code, token) { return online().siteUrlFor(code) + '/b/' + token; }

function rowOut(r) {
  var waited = r.kind === 'waitlist' ? Math.max(0, Math.round((Date.now() - new Date(r.at).getTime()) / 60000)) : null;
  return {
    id: r.id, kind: r.kind, status: r.status, name: r.name, phone: r.phone || '', party: r.party, at: r.at, minutes: r.minutes,
    quotedMinutes: r.quoted_minutes, waited: waited, tableId: r.table_id || null, tableName: r.table_name || null, note: r.note || '',
    source: r.source, texted: r.texted || [], calledAt: r.called_at || null, seatedAt: r.seated_at || null,
    createdBy: r.by_first ? r.by_first + ' ' + r.by_last : null, createdAt: r.created_at
  };
}
var SELECT = 'SELECT b.*, t.name AS table_name, e.first_name AS by_first, e.last_name AS by_last FROM restaurant_bookings b ' +
  'LEFT JOIN restaurant_tables t ON t.id = b.table_id LEFT JOIN employees e ON e.id = b.created_by ';

// A table already kept for someone else at that time (bookings overlap
// when one starts before the other ends).
async function clashOf(db, companyId, tableId, at, minutes, exceptId) {
  if (!tableId) return null;
  return (await db.query(
    "SELECT b.name, b.at, b.minutes, t.name AS table_name FROM restaurant_bookings b JOIN restaurant_tables t ON t.id = b.table_id " +
    "WHERE b.company_id = $1 AND b.table_id = $2 AND b.kind = 'booking' AND b.status IN ('requested', 'booked', 'called', 'seated') AND b.id <> $5 " +
    "AND b.at < $3::timestamptz + ($4 || ' minutes')::interval AND b.at + (b.minutes || ' minutes')::interval > $3::timestamptz LIMIT 1",
    [companyId, tableId, at, String(minutes), exceptId || '00000000-0000-0000-0000-000000000000'])).rows[0] || null;
}

// The words of a text to the guest, and whether it went: by SMS when the
// server can, else a WhatsApp link for the till to open.
async function tell(db, b, what, extra) {
  var co = (await db.query('SELECT name, code FROM companies WHERE id = $1', [b.company_id])).rows[0];
  var words = what === 'confirmed' ? co.name + ': your table for ' + b.party + ' on ' + whenText(b.at) + ' is booked.' + (b.token ? ' See or cancel it: ' + bookingLink(co.code, b.token) : ' See you then!')
    : what === 'received' ? co.name + ': we have your booking request for ' + b.party + ' on ' + whenText(b.at) + '. We will text you when it is confirmed.' + (b.token ? ' ' + bookingLink(co.code, b.token) : '')
    : what === 'declined' ? co.name + ': sorry, we cannot take your booking for ' + whenText(b.at) + '. ' + (extra || 'Please call us for another time.')
    : co.name + ': your table is ready! Please come to the front in the next 10 minutes.';
  var digits = internationalNumber(b.phone);
  var out = { what: what, words: words, sent: false, whatsapp: null };
  if (!digits) return out;
  if (sms().configured()) {
    try { await sms().send({ to: '+' + digits, message: words, purpose: 'booking', refId: b.id }); out.sent = true; }
    catch (e) { out.error = e.message; }
  }
  if (!out.sent) out.whatsapp = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(words);
  await db.query('UPDATE restaurant_bookings SET texted = texted || $2::jsonb WHERE id = $1',
    [b.id, JSON.stringify([{ what: what, channel: out.sent ? 'sms' : 'whatsapp', at: new Date().toISOString() }])]);
  return out;
}

// GET /api/pos/bookings?day=YYYY-MM-DD — the day's bookings, the waitlist,
// website requests still to answer and what is booked the days after.
async function list(token, q) {
  var session = await access.need(token, 'bookings');
  var company = session.posCompanyId;
  q = q || {};
  var day = DAY.test(q.day || '') ? q.day : dayOf(new Date());
  var rows = (await pool.query(SELECT + "WHERE b.company_id = $1 AND b.kind = 'booking' AND b.at >= $2::date AND b.at < $2::date + 1 ORDER BY b.at, b.created_at", [company, day])).rows;
  var waiting = (await pool.query(SELECT + "WHERE b.company_id = $1 AND b.kind = 'waitlist' AND (b.status IN ('waiting', 'called') OR b.updated_at > now() - interval '3 hours') ORDER BY b.at", [company])).rows;
  var requests = (await pool.query(SELECT + "WHERE b.company_id = $1 AND b.status = 'requested' AND b.at > now() - interval '1 hour' ORDER BY b.at", [company])).rows;
  var ahead = (await pool.query(
    "SELECT to_char(at, 'YYYY-MM-DD') AS day, count(*)::int AS n, sum(party)::int AS people FROM restaurant_bookings " +
    "WHERE company_id = $1 AND kind = 'booking' AND status IN ('requested', 'booked') AND at >= $2::date AND at < $2::date + 14 GROUP BY 1 ORDER BY 1", [company, dayOf(new Date())])).rows;
  return {
    day: day, bookings: rows.map(rowOut), waitlist: waiting.map(rowOut), requests: requests.map(rowOut), ahead: ahead,
    settings: session.access.settings.bookings, smsOn: sms().configured(), quotes: QUOTES
  };
}

// GET /api/pos/bookings/soon — for the till's top bar and the floor map:
// what is booked in the next hours (by table), how many wait, and how many
// website requests are still to answer.
async function soon(token) {
  var session = await access.need(token, 'till');
  var company = session.posCompanyId;
  var rows = (await pool.query(SELECT +
    "WHERE b.company_id = $1 AND b.kind = 'booking' AND b.status IN ('booked', 'called') AND b.at > now() - interval '45 minutes' AND b.at < now() + interval '4 hours' ORDER BY b.at", [company])).rows;
  var counts = (await pool.query(
    "SELECT count(*) FILTER (WHERE kind = 'waitlist' AND status IN ('waiting', 'called'))::int AS waiting, " +
    "count(*) FILTER (WHERE status = 'requested' AND at > now() - interval '1 hour')::int AS requested, " +
    "count(*) FILTER (WHERE kind = 'booking' AND status IN ('booked', 'called', 'seated') AND at >= current_date AND at < current_date + 1)::int AS today " +
    'FROM restaurant_bookings WHERE company_id = $1', [company])).rows[0];
  var tables = {};
  rows.forEach(function (r) { if (r.table_id && !tables[r.table_id]) tables[r.table_id] = { id: r.id, name: r.name, party: r.party, at: r.at, minutes: r.minutes }; });
  return { next: rows.slice(0, 6).map(rowOut), tables: tables, waiting: counts.waiting, requested: counts.requested, today: counts.today, can: !!session.access.can.bookings };
}

function partyOf(v, max) {
  var n = Math.round(Number(v));
  if (!(n >= 1 && n <= (max || 200))) fail('invalid', max ? 'Book for 1 to ' + max + ' people here; call the restaurant for more.' : 'How many people? From 1 to 200.');
  return n;
}
function atOf(p) {
  var at = p.at ? new Date(p.at) : (DAY.test(p.date || '') && /^\d{2}:\d{2}$/.test(p.time || '') ? new Date(p.date + 'T' + p.time + ':00Z') : null);
  if (!at || isNaN(at.getTime())) fail('invalid', 'Pick the day and the time.');
  return at;
}

// POST /api/pos/bookings { id?, kind, name, phone, party, at | date + time,
// minutes, tableId, note, quotedMinutes } — a booking or someone on the
// waitlist, made or changed on the till.
async function save(token, p) {
  var session = await access.need(token, 'bookings');
  var company = session.posCompanyId;
  p = p || {};
  var name = cleanText(p.name, 80);
  if (name.length < 2) fail('invalid', 'Write the guest\'s name.');
  var phone = cleanText(p.phone, 30);
  if (phone && !internationalNumber(phone)) fail('invalid', 'That phone number does not look right.');
  var party = partyOf(p.party);
  var note = cleanText(p.note, 300);
  var settings = session.access.settings.bookings;
  return withTransaction(async function (client) {
    var before = p.id ? (await client.query('SELECT * FROM restaurant_bookings WHERE id = $1 AND company_id = $2 FOR UPDATE', [p.id, company])).rows[0] : null;
    if (p.id && !before) fail('notfound', 'That booking is no longer there.');
    var kind = before ? before.kind : (p.kind === 'waitlist' ? 'waitlist' : 'booking');
    var tableId = p.tableId || null;
    if (tableId && !(await client.query("SELECT 1 FROM restaurant_tables WHERE id = $1 AND company_id = $2 AND status = 'active'", [tableId, company])).rows[0]) fail('invalid', 'That table is not on the floor.');
    var row;
    if (kind === 'waitlist') {
      var quote = p.quotedMinutes === undefined || p.quotedMinutes === null || p.quotedMinutes === '' ? null : Math.round(Number(p.quotedMinutes));
      if (quote !== null && !(quote >= 0 && quote <= 600)) fail('invalid', 'Tell them a wait from 0 to 600 minutes.');
      row = before
        ? (await client.query('UPDATE restaurant_bookings SET name = $2, phone = $3, party = $4, note = $5, quoted_minutes = $6, table_id = $7, updated_at = now() WHERE id = $1 RETURNING *',
          [before.id, name, phone, party, note, quote, tableId])).rows[0]
        : (await client.query("INSERT INTO restaurant_bookings (company_id, kind, status, name, phone, party, at, quoted_minutes, table_id, note, created_by) VALUES ($1,'waitlist','waiting',$2,$3,$4,now(),$5,$6,$7,$8) RETURNING *",
          [company, name, phone, party, quote, tableId, note, session.posEmployeeId])).rows[0];
    } else {
      var at = atOf(p);
      if (!before && at.getTime() < Date.now() - 3600000) fail('invalid', 'That time has passed: pick a later one.');
      var minutes = p.minutes ? Math.round(Number(p.minutes)) : (before ? before.minutes : settings.minutes);
      if (!(minutes >= 15 && minutes <= 600)) fail('invalid', 'Keep the table from 15 to 600 minutes.');
      var clash = await clashOf(client, company, tableId, at, minutes, before && before.id);
      if (clash) fail('conflict', clash.table_name + ' is booked for ' + clash.name + ' from ' + hhmm(clash.at) + ' to ' + hhmm(new Date(new Date(clash.at).getTime() + clash.minutes * 60000)) + '. Pick another table or time.');
      row = before
        ? (await client.query('UPDATE restaurant_bookings SET name = $2, phone = $3, party = $4, at = $5, minutes = $6, table_id = $7, note = $8, updated_at = now() WHERE id = $1 RETURNING *',
          [before.id, name, phone, party, at, minutes, tableId, note])).rows[0]
        : (await client.query("INSERT INTO restaurant_bookings (company_id, kind, status, name, phone, party, at, minutes, table_id, note, created_by) VALUES ($1,'booking','booked',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [company, name, phone, party, at, minutes, tableId, note, session.posEmployeeId])).rows[0];
    }
    await activity.log(client, { companyId: company, employeeId: session.posEmployeeId, app: 'till', action: kind === 'waitlist' ? 'till.waitlist' : 'till.booking',
      summary: (before ? 'Changed ' : '') + (kind === 'waitlist' ? (before ? name + ' on the waitlist' : name + ' (' + party + ') put on the waitlist' + (row.quoted_minutes != null ? ', told about ' + row.quoted_minutes + ' min' : ''))
        : (before ? 'the booking for ' + name : 'Booked a table for ' + name + ' (' + party + ') on ' + whenText(row.at))) + '.', refType: 'booking', refId: row.id });
    return rowOut((await client.query(SELECT + 'WHERE b.id = $1', [row.id])).rows[0]);
  });
}

// POST /api/pos/bookings/:id/:action — confirm or decline a website
// request; call a guest (their table is ready); seat them (at a table);
// no-show; cancel; or back to waiting. What was texted comes back too.
var ACTIONS = ['confirm', 'decline', 'call', 'seat', 'noShow', 'cancel', 'undo'];
async function act(token, id, action, p) {
  var session = await access.need(token, 'bookings');
  var company = session.posCompanyId;
  if (ACTIONS.indexOf(action) < 0) fail('invalid', 'Unknown action.');
  p = p || {};
  return withTransaction(async function (client) {
    var b = (await client.query('SELECT * FROM restaurant_bookings WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, company])).rows[0];
    if (!b) fail('notfound', 'That booking is no longer there.');
    var next = null, text = null, set = '', args = [b.id];
    if (action === 'confirm') {
      if (b.status !== 'requested') fail('conflict', 'It is no longer waiting for an answer.');
      var clash = await clashOf(client, company, p.tableId || b.table_id, b.at, b.minutes, b.id);
      if (clash) fail('conflict', clash.table_name + ' is booked for ' + clash.name + ' then. Pick another table.');
      next = 'booked';
      if (p.tableId !== undefined) { args.push(p.tableId || null); set = ', table_id = $' + args.length; }
    } else if (action === 'decline') {
      if (b.status !== 'requested') fail('conflict', 'It is no longer waiting for an answer.');
      next = 'declined';
    } else if (action === 'call') {
      if (['waiting', 'booked', 'called'].indexOf(b.status) < 0) fail('conflict', 'They are not waiting now.');
      next = 'called'; set = ', called_at = now()';
    } else if (action === 'seat') {
      if (LIVE.indexOf(b.status) < 0) fail('conflict', 'They are not waiting now.');
      next = 'seated'; set = ', seated_at = now()';
      if (p.tableId) {
        if (!(await client.query("SELECT 1 FROM restaurant_tables WHERE id = $1 AND company_id = $2 AND status = 'active'", [p.tableId, company])).rows[0]) fail('invalid', 'That table is not on the floor.');
        args.push(p.tableId); set += ', table_id = $' + args.length;
      }
    } else if (action === 'noShow') {
      if (['booked', 'called', 'waiting'].indexOf(b.status) < 0) fail('conflict', 'Only someone still expected can be a no-show.');
      next = 'no_show';
    } else if (action === 'cancel') {
      if (LIVE.indexOf(b.status) < 0) fail('conflict', 'It is over already.');
      next = 'cancelled';
    } else {
      if (['seated', 'cancelled', 'no_show', 'called'].indexOf(b.status) < 0) fail('conflict', 'Nothing to undo.');
      next = b.kind === 'waitlist' ? 'waiting' : 'booked'; set = ', seated_at = NULL';
    }
    args.push(next);
    await client.query('UPDATE restaurant_bookings SET status = $' + args.length + set + ', updated_at = now() WHERE id = $1', args);
    var now = (await client.query('SELECT * FROM restaurant_bookings WHERE id = $1', [b.id])).rows[0];
    if (action === 'confirm') text = await tell(client, now, 'confirmed');
    else if (action === 'decline') text = await tell(client, now, 'declined', cleanText(p.reason, 160) || null);
    else if (action === 'call') text = await tell(client, now, 'ready');
    var WORDS = { confirm: 'Confirmed the booking of', decline: 'Declined the booking of', call: 'Called', seat: 'Seated', noShow: 'Marked as a no-show:', cancel: 'Cancelled the booking of', undo: 'Undid the last step for' };
    await activity.log(client, { companyId: company, employeeId: session.posEmployeeId, app: 'till', action: 'till.booking_' + action.toLowerCase(),
      summary: WORDS[action] + ' ' + b.name + ' (' + b.party + ')' + (b.kind === 'booking' ? ', ' + whenText(b.at) : ', on the waitlist') + (text ? (text.sent ? ' — texted.' : '.') : '.'), refType: 'booking', refId: b.id });
    return { booking: rowOut((await client.query(SELECT + 'WHERE b.id = $1', [b.id])).rows[0]), text: text };
  });
}

// ── the website ────────────────────────────────────────────────────────

// The times a guest may ask for on a day: every step from the first to the
// last time, on the days the restaurant takes bookings, not passed, not
// already full (perSlot bookings at that time).
async function slotsFor(companyId, settings, day) {
  var b = settings.bookings;
  var d = new Date(day + 'T00:00:00Z');
  if (b.days.length && b.days.indexOf(d.getUTCDay()) < 0) return [];
  var taken = (await pool.query(
    "SELECT to_char(at, 'HH24:MI') AS t, count(*)::int AS n FROM restaurant_bookings WHERE company_id = $1 AND kind = 'booking' AND status IN ('requested', 'booked', 'called', 'seated') " +
    'AND at >= $2::date AND at < $2::date + 1 GROUP BY 1', [companyId, day])).rows;
  var full = new Map(taken.map(function (r) { return [r.t, r.n]; }));
  var out = [];
  var soonest = Date.now() + 30 * 60000;
  for (var m = minutesOf(b.from); m <= minutesOf(b.to); m += b.step) {
    var t = timeOf(m);
    if (new Date(day + 'T' + t + ':00Z').getTime() < soonest) continue;
    out.push({ time: t, full: (full.get(t) || 0) >= b.perSlot });
  }
  return out;
}

// GET /api/pos/online/:code/book?date= — whether the restaurant takes
// bookings on the website, the days ahead, and the times on one of them.
async function onlineOptions(code, q) {
  var co = await online().shopOf(code);
  var settings = await access.settingsOf(co.id);
  var b = settings.bookings;
  if (!b.online) return { on: false, restaurant: { code: co.code, name: co.name } };
  var days = [];
  for (var i = 0; i <= b.daysAhead && days.length < 60; i++) {
    var d = dayOf(new Date(Date.now() + i * 86400000));
    if (!b.days.length || b.days.indexOf(new Date(d + 'T00:00:00Z').getUTCDay()) >= 0) days.push(d);
  }
  var day = q && DAY.test(q.date || '') && days.indexOf(q.date) >= 0 ? q.date : null;
  if (!day) {
    for (var j = 0; j < days.length && !day; j++) if ((await slotsFor(co.id, settings, days[j])).some(function (s) { return !s.full; })) day = days[j];
  }
  return {
    on: true, restaurant: { code: co.code, name: co.name, phone: co.settings.phone || '' }, maxParty: b.maxParty, autoConfirm: b.autoConfirm,
    days: days, date: day, slots: day ? await slotsFor(co.id, settings, day) : []
  };
}

function bookingOut(r, co) {
  return {
    token: r.token, status: r.status, name: r.name, party: r.party, at: r.at, note: r.note || '', restaurant: { code: co.code, name: co.name, phone: co.phone || '' },
    canCancel: (r.status === 'requested' || r.status === 'booked') && new Date(r.at).getTime() > Date.now()
  };
}

// POST /api/pos/online/:code/book { name, phone, party, date, time, note }
// — a guest asks for a table. Limited per address and per phone.
async function onlineBook(code, p, ip, accountToken) {
  p = p || {};
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  var co = await online().shopOf(code);
  var settings = await access.settingsOf(co.id);
  var b = settings.bookings;
  if (!b.online) fail('conflict', co.name + ' does not take bookings on the website. Call them to book.');
  var account = accountToken ? await require('./restaurantCustomerAccounts.service').accountOf(accountToken) : null;
  var name = cleanText(p.name || (account && account.name), 80);
  if (name.length < 2) fail('invalid', 'Write your name.');
  var digits = internationalNumber(p.phone || (account && account.phone));
  if (!digits) fail('invalid', 'Give a phone number we can text you on.');
  var party = partyOf(p.party, b.maxParty);
  if (!DAY.test(p.date || '') || !/^\d{2}:\d{2}$/.test(p.time || '')) fail('invalid', 'Pick the day and the time.');
  var slots = await slotsFor(co.id, settings, p.date);
  var slot = slots.find(function (s) { return s.time === p.time; });
  var lastDay = dayOf(new Date(Date.now() + b.daysAhead * 86400000));
  if (!slot || p.date > lastDay) fail('invalid', 'That time is not one the restaurant offers. Pick another.');
  if (slot.full) fail('conflict', 'That time is fully booked. Pick another.');
  var active = (await pool.query("SELECT count(*)::int AS n FROM restaurant_bookings WHERE company_id = $1 AND phone = $2 AND status IN ('requested', 'booked') AND at > now()", [co.id, '+' + digits])).rows[0].n;
  if (active >= MAX_ACTIVE_PER_PHONE) fail('conflict', 'You have bookings waiting here already. Call the restaurant to book more.');
  var now = Date.now(), key = String(ip || '');
  var tries = (askedBy.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (tries.length >= PER_IP_HOUR) fail('ratelimited', 'Too many bookings from here in the last hour. Call the restaurant instead.');
  tries.push(now); askedBy.set(key, tries);
  if (askedBy.size > 5000) askedBy.clear();
  var token = crypto.randomBytes(18).toString('base64url');
  return withTransaction(async function (client) {
    var row = (await client.query(
      "INSERT INTO restaurant_bookings (company_id, kind, status, name, phone, party, at, minutes, note, source, token, account_id) VALUES ($1,'booking',$2,$3,$4,$5,$6,$7,$8,'website',$9,$10) RETURNING *",
      [co.id, b.autoConfirm ? 'booked' : 'requested', name, '+' + digits, party, new Date(p.date + 'T' + p.time + ':00Z'), b.minutes, cleanText(p.note, 300), token, account ? account.id : null])).rows[0];
    await activity.log(client, { companyId: co.id, employeeId: null, app: 'online', action: 'online.booking',
      summary: name + ' ' + (b.autoConfirm ? 'booked' : 'asked for') + ' a table for ' + party + ' on ' + whenText(row.at) + ' on the website.', refType: 'booking', refId: row.id });
    var text = await tell(client, row, b.autoConfirm ? 'confirmed' : 'received');
    return Object.assign(bookingOut(row, { code: co.code, name: co.name, phone: co.settings.phone }), { texted: text.sent, link: bookingLink(co.code, token) });
  });
}

async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail('notfound', 'This booking link is not right.');
  var r = (await pool.query('SELECT b.*, c.code AS company_code, c.name AS company_name FROM restaurant_bookings b JOIN companies c ON c.id = b.company_id WHERE b.token = $1', [token])).rows[0];
  if (!r) fail('notfound', 'This booking link is not right, or the booking is no longer there.');
  return r;
}
async function coOf(r) {
  var s = (await pool.query('SELECT settings FROM restaurant_delivery_settings WHERE company_id = $1', [r.company_id])).rows[0];
  return { code: r.company_code, name: r.company_name, phone: s && s.settings ? s.settings.phone || '' : '' };
}
// GET /api/pos/online/bookings/:token — a guest's own booking.
async function onlineMine(token) { var r = await byToken(token); return bookingOut(r, await coOf(r)); }
// POST /api/pos/online/bookings/:token/cancel — a guest cancels before it starts.
async function onlineCancel(token) {
  var r = await byToken(token);
  if (!((r.status === 'requested' || r.status === 'booked') && new Date(r.at).getTime() > Date.now())) fail('conflict', 'This booking can no longer be cancelled here. Call the restaurant.');
  await pool.query("UPDATE restaurant_bookings SET status = 'cancelled', updated_at = now() WHERE id = $1", [r.id]);
  await activity.log(pool, { companyId: r.company_id, employeeId: null, app: 'online', action: 'online.booking_cancel',
    summary: r.name + ' cancelled their booking for ' + r.party + ' on ' + whenText(r.at) + ' on the website.', refType: 'booking', refId: r.id });
  return bookingOut(Object.assign({}, r, { status: 'cancelled' }), await coOf(r));
}

module.exports = {
  list: list, soon: soon, save: save, act: act, onlineOptions: onlineOptions, onlineBook: onlineBook, onlineMine: onlineMine, onlineCancel: onlineCancel,
  STATUSES: STATUSES, QUOTES: QUOTES, _askedBy: askedBy, whenText: whenText
};
