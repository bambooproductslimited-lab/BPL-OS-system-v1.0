var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { internationalNumber } = require('../utils/phone');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Private events and room hire (migration 0195). A guest asks on the
// website (Hire our space: the occasion, the day and hours, how many, which
// space) or a manager writes one in the back office (Events). The manager
// sets the menu — dishes, so many portions a guest — the price a head, the
// extras (the room, decorations) and the deposit, and sends it: the guest's
// own page (/e/<its link>) shows it, and the deposit is paid there online
// (Paystack, purpose 'event') or taken at the till. Paid, it is confirmed.
// On the day the till shows its plan hour by hour (More → Events), and its
// dishes are on the kitchen's prep list (restaurantPrep).
//
// Settings (restaurant_more_settings 'events'): { on (the website's form),
// spaces [{ name, seats }], minGuests, leadDays, depositPercent, note }.

var STATUSES = ['enquiry', 'quoted', 'confirmed', 'done', 'cancelled'];
var LIVE = ['enquiry', 'quoted', 'confirmed'];
var WHO = ['all', 'kitchen', 'floor', 'bar'];
var DEFAULTS = { on: false, spaces: [{ name: 'Whole restaurant', seats: 80 }], minGuests: 10, leadDays: 3, depositPercent: 30, note: '' };
var PER_IP_HOUR = 5;
var asked = new Map();
var DAY = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function ref(n) { return 'E-' + String(n).padStart(4, '0'); }
function dayOf(d) { return new Date(d).toISOString().slice(0, 10); }
function hhmm(d) { return new Date(d).toISOString().slice(11, 16); }
function whenText(d) { d = new Date(d); return WEEKDAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ', ' + hhmm(d); }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : ''; }
function sms() { return require('./sms.service'); }
function online() { return require('./restaurantOnline.service'); }
function paystack() { return require('./restaurantPaystack.service'); }
function link(code, token) { return online().siteUrlFor(code) + '/e/' + token; }

async function settingsOf(companyId, db) {
  var r = (await (db || pool).query("SELECT value FROM restaurant_more_settings WHERE company_id = $1 AND name = 'events'", [companyId])).rows[0];
  return cleanSettings((r && r.value) || {}, true);
}
function cleanSettings(v, stored) {
  var spaces = (Array.isArray(v.spaces) ? v.spaces : stored ? DEFAULTS.spaces : []).map(function (s) {
    return { name: text(s && s.name, 40), seats: Math.max(0, Math.min(2000, Math.round(Number(s && s.seats) || 0))) };
  }).filter(function (s) { return s.name.length >= 2; }).slice(0, 8);
  return {
    on: !!v.on, spaces: spaces.length ? spaces : DEFAULTS.spaces,
    minGuests: Math.max(1, Math.min(500, Math.round(Number(v.minGuests)) || DEFAULTS.minGuests)),
    leadDays: Math.max(0, Math.min(60, v.leadDays === 0 ? 0 : Math.round(Number(v.leadDays)) || DEFAULTS.leadDays)),
    depositPercent: Math.max(0, Math.min(100, v.depositPercent === 0 ? 0 : Math.round(Number(v.depositPercent)) || DEFAULTS.depositPercent)),
    note: text(v.note, 300)
  };
}
function firstDay(s) { return dayOf(Date.now() + s.leadDays * 86400000); }

// What the website shows (the restaurant's menu, restaurant.events).
async function publicOf(companyId) {
  var s = await settingsOf(companyId);
  if (!s.on) return { on: false };
  return { on: true, spaces: s.spaces, minGuests: s.minGuests, leadDays: s.leadDays, firstDay: firstDay(s), depositPercent: s.depositPercent, note: s.note };
}

function menuOf(raw, known) {
  var list = Array.isArray(raw) ? raw : [];
  if (list.length > 40) fail('invalid', 'Up to 40 dishes on an event\'s menu.');
  return list.map(function (l) {
    var m = known.get(String(l && l.menuItemId));
    if (!m) fail('invalid', 'A dish on the menu is not on this restaurant\'s menu any more.');
    var per = Math.round(Number(l.perGuest) * 100) / 100;
    if (!(per > 0 && per <= 10)) fail('invalid', 'How many portions of ' + m.name + ' for each guest? From 0.1 to 10.');
    return { menuItemId: m.id, name: m.name, perGuest: per };
  });
}
function extrasOf(raw) {
  var list = Array.isArray(raw) ? raw : [];
  if (list.length > 12) fail('invalid', 'Up to 12 extras.');
  return list.map(function (x) {
    var t = text(x && x.text, 80), a = round2(x && x.amount);
    if (t.length < 2) return null;
    if (!(a >= 0 && a <= 1000000)) fail('invalid', '"' + t + '": its amount is from 0 up.');
    return { text: t, amount: a };
  }).filter(Boolean);
}
function planOf(raw) {
  var list = Array.isArray(raw) ? raw : [];
  if (list.length > 40) fail('invalid', 'Up to 40 lines on the day\'s plan.');
  return list.map(function (x) {
    var t = text(x && x.text, 140);
    if (t.length < 2) return null;
    if (!TIME.test(String(x.time || ''))) fail('invalid', '"' + t + '": give it a time, e.g. 18:30.');
    return { time: x.time, text: t, who: WHO.indexOf(x.who) >= 0 ? x.who : 'all' };
  }).filter(Boolean).sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
}
function totalOf(perHead, guests, extras) {
  return round2(perHead * guests + extras.reduce(function (a, x) { return a + x.amount; }, 0));
}
// The day and its hours: { startsAt, endsAt }; an end before the start is
// the next morning (a party until 01:00).
function hoursOf(day, from, to) {
  if (!DAY.test(String(day || ''))) fail('invalid', 'Pick the day.');
  if (!TIME.test(String(from || '')) || !TIME.test(String(to || ''))) fail('invalid', 'Give the hours, e.g. 18:00 to 23:00.');
  var s = new Date(day + 'T' + from + ':00Z'), e = new Date(day + 'T' + to + ':00Z');
  if (e <= s) e = new Date(e.getTime() + 86400000);
  if (e - s > 16 * 3600000) fail('invalid', 'An event is up to 16 hours long.');
  return { startsAt: s, endsAt: e };
}

function eventOut(r, staff) {
  var out = {
    id: r.id, ref: ref(r.number), status: r.status, source: r.source, occasion: r.occasion, space: r.space,
    startsAt: r.starts_at, endsAt: r.ends_at, guests: r.guests, menu: r.menu || [], perHead: round2(r.per_head), extras: r.extras || [], total: round2(r.total),
    deposit: { amount: round2(r.deposit_amount), status: r.deposit_status, method: r.deposit_method || null, paidAt: r.deposit_paid_at },
    note: r.note
  };
  if (staff) {
    Object.assign(out, { name: r.name, phone: r.phone, email: r.email, plan: r.plan || [], staffNote: r.staff_note, createdAt: r.created_at, updatedAt: r.updated_at,
      link: r.company_code ? link(r.company_code, r.token) : null, createdBy: nameOf(r.by_first, r.by_last), texted: r.texted || [] });
  } else out.name = String(r.name).split(' ')[0];
  return out;
}

async function tell(db, e, what) {
  var co = (await db.query('SELECT name, code FROM companies WHERE id = $1', [e.company_id])).rows[0];
  var url = link(co.code, e.token);
  var words = what === 'received' ? co.name + ': we have your request for ' + (e.occasion || 'your event') + ' on ' + whenText(e.starts_at) + ' for ' + e.guests + '. We will call you to plan it. ' + url
    : what === 'quoted' ? co.name + ': the plan for ' + (e.occasion || 'your event') + ' on ' + whenText(e.starts_at) + ' is ready: the menu and the price.' + (Number(e.deposit_amount) > 0 ? ' Pay the deposit to book it.' : '') + ' ' + url
    : what === 'confirmed' ? co.name + ': ' + (e.occasion || 'your event') + ' on ' + whenText(e.starts_at) + ' for ' + e.guests + ' is booked. Thank you! ' + url
    : co.name + ': ' + (e.occasion || 'your event') + ' on ' + whenText(e.starts_at) + ' was cancelled. Call us with any question.';
  var digits = internationalNumber(e.phone);
  var out = { what: what, words: words, sent: false, whatsapp: null };
  if (!digits) return out;
  if (sms().configured()) {
    try { await sms().send({ to: '+' + digits, message: words, purpose: 'event', refId: e.id }); out.sent = true; } catch (err) { out.error = err.message; }
  }
  if (!out.sent) out.whatsapp = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(words);
  await db.query('UPDATE restaurant_events SET texted = texted || $2::jsonb WHERE id = $1', [e.id, JSON.stringify([{ what: what, channel: out.sent ? 'sms' : 'whatsapp', at: new Date().toISOString() }])]);
  return out;
}

function throttle(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (asked.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= PER_IP_HOUR) fail('ratelimited', 'Too many requests from here in the last hour. Call the restaurant instead.');
  list.push(now); asked.set(key, list);
  if (asked.size > 5000) asked.clear();
}

// POST /api/pos/online/:code/events { name, phone, email, occasion, space,
// day, from, to, guests, note } — the website's "Hire our space".
async function ask(code, p, ip) {
  p = p || {};
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  var co = await online().shopOf(code);
  var s = await settingsOf(co.id);
  if (!s.on) fail('conflict', co.name + ' is not taking event requests online right now.');
  var name = text(p.name, 80);
  if (name.length < 2) fail('invalid', 'Your name, please.');
  var digits = internationalNumber(text(p.phone, 30));
  if (!digits) fail('invalid', 'Give a phone number we can call you on.');
  var email = text(p.email, 120).toLowerCase();
  if (email && !require('./mail.service').isEmail(email)) fail('invalid', 'That email address does not look right.');
  var h = hoursOf(p.day, p.from, p.to);
  if (dayOf(h.startsAt) < firstDay(s)) fail('invalid', 'Events are planned at least ' + s.leadDays + ' days ahead: the first day on offer is ' + firstDay(s) + '.');
  if (dayOf(h.startsAt) > dayOf(Date.now() + 365 * 86400000)) fail('invalid', 'Up to a year ahead.');
  var guests = Math.round(Number(p.guests));
  if (!(guests >= s.minGuests && guests <= 2000)) fail('invalid', 'Events are for ' + s.minGuests + ' guests or more.');
  var space = text(p.space, 40);
  if (space && !s.spaces.some(function (x) { return x.name === space; })) fail('invalid', 'Pick one of the spaces.');
  throttle(ip);
  var e = await withTransaction(async function (client) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('events:' || $1))", [co.id]);
    var n = (await client.query('SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_events WHERE company_id = $1', [co.id])).rows[0].n;
    var row = (await client.query(
      "INSERT INTO restaurant_events (company_id, number, token, source, name, phone, email, occasion, space, starts_at, ends_at, guests, note, ip) VALUES ($1,$2,$3,'website',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
      [co.id, n, crypto.randomBytes(18).toString('base64url'), name, '+' + digits, email, text(p.occasion, 60), space, h.startsAt, h.endsAt, guests, text(p.note, 500), String(ip || '').slice(0, 60)])).rows[0];
    await activity.log(client, { companyId: co.id, employeeId: null, app: 'online', action: 'event.asked',
      summary: name + ' asked for ' + (row.occasion || 'an event') + ' on ' + whenText(row.starts_at) + ' for ' + guests + (space ? ' (' + space + ')' : '') + ': ' + ref(n) + '. Plan it in the back office (Events).', refType: 'event', refId: row.id });
    return row;
  });
  try { await tell(pool, e, 'received'); } catch (err) { console.error('Event text not sent:', err.message); }
  return { ref: ref(e.number), token: e.token };
}

async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail('notfound', 'We cannot find that event.');
  var r = (await pool.query('SELECT e.*, c.code AS company_code, c.name AS company_name FROM restaurant_events e JOIN companies c ON c.id = e.company_id WHERE e.token = $1', [token])).rows[0];
  if (!r) fail('notfound', 'We cannot find that event.');
  return r;
}
async function depositRow(eventId) {
  return (await pool.query("SELECT * FROM restaurant_paystack_payments WHERE event_id = $1 AND purpose = 'event' ORDER BY (status = 'success') DESC, created_at DESC LIMIT 1", [eventId])).rows[0] || null;
}
// Paid online: the event is booked (once), the guest texted.
async function settleDeposit(row) {
  if (!row || row.status !== 'success' || !row.event_id) return null;
  var e = (await pool.query(
    "UPDATE restaurant_events SET deposit_status = 'paid', deposit_method = 'online', deposit_paid_at = now(), status = CASE WHEN status IN ('enquiry', 'quoted') THEN 'confirmed' ELSE status END, updated_at = now() " +
    "WHERE id = $1 AND deposit_status = 'due' AND status <> 'cancelled' RETURNING *", [row.event_id])).rows[0];
  if (!e) return null;
  await activity.log(pool, { companyId: e.company_id, employeeId: null, app: 'online', action: 'event.deposit',
    summary: e.name + ' paid the deposit of ' + round2(row.amount).toFixed(2) + ' for ' + ref(e.number) + ' (' + whenText(e.starts_at) + '): booked.', amount: round2(row.amount), refType: 'event', refId: e.id });
  try { await tell(pool, e, 'confirmed'); } catch (err) { console.error('Event text not sent:', err.message); }
  return e;
}
async function checkDeposit(r) {
  if (r.deposit_status !== 'due') return r;
  var row = await depositRow(r.id);
  if (row && row.status === 'pending') row = await paystack().check(row, false);
  if (row && row.status === 'success') { await settleDeposit(row); return byToken(r.token); }
  return r;
}

// GET /api/pos/online/events/:token — the guest's page.
async function guestView(token) {
  var r = await checkDeposit(await byToken(token));
  var till = await access.settingsOf(r.company_id);
  return Object.assign(eventOut(r, false), {
    restaurant: { code: r.company_code, name: r.company_name, phone: (await require('./restaurantDelivery.service').liveSettingsOf(r.company_id)).phone || '' },
    canPay: r.deposit_status === 'due' && ['quoted', 'enquiry'].indexOf(r.status) >= 0 && paystack().onFor(till)
  });
}
// POST /api/pos/online/events/:token/pay — the deposit, paid online.
async function payDeposit(token) {
  var r = await checkDeposit(await byToken(token));
  if (r.deposit_status !== 'due') fail('conflict', r.deposit_status === 'paid' ? 'The deposit is paid. Thank you!' : 'There is no deposit to pay.');
  if (['enquiry', 'quoted'].indexOf(r.status) < 0) fail('conflict', 'This event was ' + (r.status === 'cancelled' ? 'cancelled.' : 'booked already.'));
  if (!paystack().onFor(await access.settingsOf(r.company_id))) fail('conflict', 'Paying online is not on: call the restaurant to pay the deposit.');
  var started = await paystack().begin(r.company_id, round2(r.deposit_amount), 'event', null, null, link(r.company_code, r.token), { eventId: r.id, payer: r.name });
  return { url: started.url };
}

var STAFF_SELECT = 'SELECT e.*, c.code AS company_code, b.first_name AS by_first, b.last_name AS by_last FROM restaurant_events e JOIN companies c ON c.id = e.company_id LEFT JOIN employees b ON b.id = e.created_by ';

// POST /api/pos/settings/events { action: list|save|status|deposit|settings, … ,
// managerPin } — the back office's Events.
async function manage(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  var who = nameOf(m.manager.first_name, m.manager.last_name);
  var told = null, savedId = null;
  if (p.action === 'save') savedId = await save(company, m.manager, p.event || {});
  else if (p.action === 'status') told = await setStatus(company, m.manager, p.id, p.status);
  else if (p.action === 'deposit') await depositByHand(m.session, m.manager, p);
  else if (p.action === 'settings') {
    var v = cleanSettings(p.settings || {}, false);
    await pool.query("INSERT INTO restaurant_more_settings (company_id, name, value) VALUES ($1, 'events', $2) ON CONFLICT (company_id, name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [company, v]);
    await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'settings', action: 'event.settings', summary: 'Events settings saved by ' + who + (v.on ? ': asked for on the website.' : ': not on the website.') });
  }
  var rows = (await pool.query(STAFF_SELECT + "WHERE e.company_id = $1 AND (e.status IN ('enquiry', 'quoted', 'confirmed') OR e.starts_at > now() - interval '30 days') ORDER BY e.starts_at LIMIT 200", [company])).rows;
  var menu = (await pool.query('SELECT id, name, category, price FROM restaurant_menu_items WHERE company_id = $1 AND active ORDER BY category, name', [company])).rows;
  var till = await access.settingsOf(company);
  return {
    events: rows.map(function (r) { return eventOut(r, true); }), settings: await settingsOf(company),
    menu: menu.map(function (x) { return { id: x.id, name: x.name, category: x.category || '', price: round2(x.price) }; }),
    payOnline: paystack().onFor(till), told: told, savedId: savedId, managerName: who
  };
}

async function save(company, manager, x) {
  var name = text(x.name, 80);
  if (name.length < 2) fail('invalid', 'Who is it for? Their name.');
  var phone = text(x.phone, 30);
  var digits = phone ? internationalNumber(phone) : null;
  if (phone && !digits) fail('invalid', 'That phone number does not look right.');
  var h = hoursOf(x.day, x.from, x.to);
  var guests = Math.round(Number(x.guests));
  if (!(guests >= 1 && guests <= 2000)) fail('invalid', 'How many guests? From 1 to 2000.');
  var ids = (Array.isArray(x.menu) ? x.menu : []).map(function (l) { return String(l && l.menuItemId); }).filter(function (v) { return /^[0-9a-f-]{36}$/i.test(v); });
  var known = new Map(ids.length ? (await pool.query('SELECT id, name FROM restaurant_menu_items WHERE company_id = $1 AND id = ANY($2::uuid[])', [company, ids])).rows.map(function (r) { return [r.id, r]; }) : []);
  var menu = menuOf(x.menu, known), extras = extrasOf(x.extras), plan = planOf(x.plan);
  var perHead = round2(x.perHead);
  if (!(perHead >= 0 && perHead <= 100000)) fail('invalid', 'The price a head is from 0 up.');
  var total = totalOf(perHead, guests, extras);
  var deposit = round2(x.deposit);
  if (!(deposit >= 0)) deposit = 0;
  if (deposit > total) fail('invalid', 'The deposit is more than the event costs (' + total.toFixed(2) + ').');
  var fields = [name, digits ? '+' + digits : '', text(x.email, 120).toLowerCase(), text(x.occasion, 60), text(x.space, 40), h.startsAt, h.endsAt, guests, JSON.stringify(menu), perHead,
    JSON.stringify(extras), total, deposit, JSON.stringify(plan), text(x.note, 500), text(x.staffNote, 500)];
  return withTransaction(async function (client) {
    if (x.id) {
      var cur = (await client.query('SELECT * FROM restaurant_events WHERE id = $1 AND company_id = $2 FOR UPDATE', [x.id, company])).rows[0];
      if (!cur) fail('notfound', 'That event is gone.');
      if (cur.status === 'cancelled' || cur.status === 'done') fail('conflict', 'That event is ' + (cur.status === 'done' ? 'over.' : 'cancelled.'));
      // The deposit once paid stays as it was.
      var depStatus = cur.deposit_status === 'paid' || cur.deposit_status === 'refunded' ? cur.deposit_status : deposit > 0 ? 'due' : 'none';
      var amount = cur.deposit_status === 'paid' || cur.deposit_status === 'refunded' ? Number(cur.deposit_amount) : deposit;
      await client.query(
        'UPDATE restaurant_events SET name = $3, phone = $4, email = $5, occasion = $6, space = $7, starts_at = $8, ends_at = $9, guests = $10, menu = $11, per_head = $12, extras = $13, total = $14, deposit_amount = $15, ' +
        'plan = $16, note = $17, staff_note = $18, deposit_status = $19, updated_at = now() WHERE id = $1 AND company_id = $2',
        [x.id, company].concat(fields.slice(0, 12), [amount], fields.slice(13), [depStatus]));
      await activity.log(client, { companyId: company, employeeId: manager.id, app: 'settings', action: 'event.saved', summary: ref(cur.number) + ' (' + name + ', ' + whenText(h.startsAt) + ' for ' + guests + ') saved: ' + total.toFixed(2) + '.', refType: 'event', refId: cur.id });
      return cur.id;
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('events:' || $1))", [company]);
    var n = (await client.query('SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_events WHERE company_id = $1', [company])).rows[0].n;
    var row = (await client.query(
      'INSERT INTO restaurant_events (company_id, number, token, name, phone, email, occasion, space, starts_at, ends_at, guests, menu, per_head, extras, total, deposit_amount, plan, note, staff_note, deposit_status, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *',
      [company, n, crypto.randomBytes(18).toString('base64url')].concat(fields, [deposit > 0 ? 'due' : 'none', manager.id]))).rows[0];
    await activity.log(client, { companyId: company, employeeId: manager.id, app: 'settings', action: 'event.saved', summary: ref(n) + ' written for ' + name + ': ' + whenText(h.startsAt) + ' for ' + guests + ', ' + total.toFixed(2) + '.', refType: 'event', refId: row.id });
    return row.id;
  });
}

var MOVES = { enquiry: ['quoted', 'confirmed', 'cancelled'], quoted: ['confirmed', 'cancelled', 'quoted'], confirmed: ['done', 'cancelled'], done: [], cancelled: [] };
async function setStatus(company, manager, id, status) {
  if (STATUSES.indexOf(status) < 0) fail('invalid', 'Unknown status.');
  var e = (await pool.query('SELECT * FROM restaurant_events WHERE id = $1 AND company_id = $2', [id, company])).rows[0];
  if (!e) fail('notfound', 'That event is gone.');
  if (MOVES[e.status].indexOf(status) < 0) fail('conflict', 'That event is ' + e.status + ': it cannot be made ' + status + '.');
  if (status === 'quoted' && !(Number(e.total) > 0)) fail('invalid', 'Set its menu and price first.');
  if (status === 'quoted' && !e.phone) fail('invalid', 'Add their phone number to send it.');
  var up = (await pool.query('UPDATE restaurant_events SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, status])).rows[0];
  var refund = null;
  // Cancelled: a deposit paid online is given back.
  if (status === 'cancelled' && e.deposit_status === 'paid' && e.deposit_method === 'online') {
    var row = await depositRow(e.id);
    if (row && row.status === 'success') {
      row = await paystack().refund(row, 'The event was cancelled.');
      if (row.refund_status && row.refund_status !== 'failed') { await pool.query("UPDATE restaurant_events SET deposit_status = 'refunded' WHERE id = $1", [id]); refund = 'refunded'; } else refund = 'failed';
    }
  }
  await activity.log(pool, { companyId: company, employeeId: manager.id, app: 'settings', action: 'event.' + status,
    summary: ref(e.number) + ' (' + e.name + ', ' + whenText(e.starts_at) + ') ' + { quoted: 'sent to the guest', confirmed: 'booked', done: 'done', cancelled: 'cancelled' }[status] + ' by ' + nameOf(manager.first_name, manager.last_name) +
      (refund === 'refunded' ? '; its deposit given back' : refund === 'failed' ? '; give its deposit back by hand' : '') + '.', refType: 'event', refId: e.id });
  var what = { quoted: 'quoted', confirmed: 'confirmed', cancelled: 'cancelled' }[status];
  var told = what && up.phone ? await tell(pool, up, what).catch(function () { return null; }) : null;
  return told ? Object.assign(told, { refund: refund }) : refund ? { refund: refund } : null;
}

// A deposit taken by hand: cash goes in the drawer of the person signed in
// (theirs open), Mobile Money or a bank transfer as recorded.
async function depositByHand(session, manager, p) {
  var method = ['cash', 'mobile_money', 'bank'].indexOf(p.method) >= 0 ? p.method : fail('invalid', 'How was it paid?');
  await withTransaction(async function (client) {
    var e = (await client.query('SELECT * FROM restaurant_events WHERE id = $1 AND company_id = $2 FOR UPDATE', [p.id, session.posCompanyId])).rows[0];
    if (!e) fail('notfound', 'That event is gone.');
    if (e.deposit_status !== 'due') fail('conflict', e.deposit_status === 'paid' ? 'Its deposit is paid already.' : 'It has no deposit to pay: set one first.');
    if (e.status === 'cancelled' || e.status === 'done') fail('conflict', 'That event is ' + e.status + '.');
    if (method === 'cash') {
      var d = (await client.query("SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open'", [session.posEmployeeId])).rows[0];
      if (!d) fail('conflict', 'Cash goes in your cash drawer: open it first.');
      await client.query("INSERT INTO restaurant_drawer_movements (session_id, direction, amount, note, kind, by_id) VALUES ($1, 'in', $2, $3, 'event', $4)",
        [d.id, Number(e.deposit_amount), 'Deposit for ' + ref(e.number) + ', ' + e.name, session.posEmployeeId]);
    }
    await client.query("UPDATE restaurant_events SET deposit_status = 'paid', deposit_method = $2, deposit_paid_at = now(), status = CASE WHEN status IN ('enquiry', 'quoted') THEN 'confirmed' ELSE status END, updated_at = now() WHERE id = $1", [e.id, method]);
    await activity.log(client, { companyId: session.posCompanyId, employeeId: manager.id, app: 'settings', action: 'event.deposit',
      summary: 'Deposit of ' + Number(e.deposit_amount).toFixed(2) + ' for ' + ref(e.number) + ' (' + e.name + ') taken ' + { cash: 'in cash', mobile_money: 'by Mobile Money', bank: 'by bank transfer' }[method] + ': booked.', amount: Number(e.deposit_amount), refType: 'event', refId: e.id });
  });
}

// GET /api/pos/events — for the till: today's and the next week's booked
// events, with the plan of the day.
async function soon(token) {
  var s = await access.need(token, ['till', 'kds', 'stock', 'delivery']);
  var rows = (await pool.query(STAFF_SELECT + "WHERE e.company_id = $1 AND e.status IN ('quoted', 'confirmed') AND e.ends_at > now() AND e.starts_at < now() + interval '8 days' ORDER BY e.starts_at", [s.posCompanyId])).rows;
  var today = new Date().toISOString().slice(0, 10);
  return {
    events: rows.map(function (r) {
      var o = eventOut(r, true);
      delete o.phone; delete o.email; delete o.link; delete o.texted;
      o.today = dayOf(r.starts_at) === today || (new Date(r.starts_at) <= new Date() && new Date(r.ends_at) > new Date());
      return o;
    }),
    today: rows.filter(function (r) { return dayOf(r.starts_at) === today; }).length
  };
}

// The dishes of the day's booked events, for the prep list: Map menuItemId
// -> portions; and the events.
async function forPrep(companyId, day) {
  var rows = (await pool.query("SELECT * FROM restaurant_events WHERE company_id = $1 AND status = 'confirmed' AND (starts_at AT TIME ZONE 'UTC')::date = $2::date ORDER BY starts_at", [companyId, day])).rows;
  var dishes = new Map();
  rows.forEach(function (e) { (e.menu || []).forEach(function (l) { dishes.set(l.menuItemId, (dishes.get(l.menuItemId) || 0) + Math.ceil(Number(l.perGuest) * e.guests - 1e-9)); }); });
  return { dishes: dishes, events: rows.map(function (e) { return { id: e.id, ref: ref(e.number), name: e.name, occasion: e.occasion, at: e.starts_at, guests: e.guests }; }) };
}

module.exports = { STATUSES: STATUSES, LIVE: LIVE, settingsOf: settingsOf, publicOf: publicOf, ask: ask, guestView: guestView, payDeposit: payDeposit, settleDeposit: settleDeposit, manage: manage, soon: soon, forPrep: forPrep, _asked: asked };
