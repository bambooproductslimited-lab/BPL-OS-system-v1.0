var { pool } = require('../db/pool');
var { todayISO } = require('../utils/documents');
var { buildContext } = require('../services/context.service');
var { documentVisible } = require('../services/documents.service');
var staffAlerts = require('../services/staffAlerts.service');
var sms = require('../services/sms.service');
var pokiReminders = require('../services/pokiReminders.service');
var reminders = require('../services/reminders.service');

// The OS's own daily round (every 15 minutes, doing only what is due):
//
//   - Things about to run out: company documents with an expiry date
//     (licences, permits, insurance, tax clearance …) and staff ID cards and
//     passports. Whoever looks after them is warned 60, 30, 14 and 7 days
//     before, and on the day it expires (expiry_alerts, migration 0077).
//   - Bookings ending: Poki staff are warned 90, 60, 30, 14 and 7 days
//     before (pokiReminders.service.js — until now that only ran when
//     someone opened the Poki screens).
//   - Automatic texts to customers and tenants, if turned on
//     (reminders.service.js autoTexts), only between 08:00 and 18:00.
//
// Ghana is on GMT all year, so these hours are UTC.

var INTERVAL_MS = 15 * 60 * 1000;
var ALERTS_FROM_HOUR = 7;
var TEXTS_FROM_HOUR = 8;
var TEXTS_UNTIL_HOUR = 18;

var MILESTONES = [
  { key: '60', days: 60 }, { key: '30', days: 30 }, { key: '14', days: 14 }, { key: '7', days: 7 }, { key: 'expired', days: 0 }
];
var WIDEST = MILESTONES[0].days;

function daysBetween(fromISO, toISO) {
  return Math.round((new Date(toISO + 'T00:00:00Z') - new Date(fromISO + 'T00:00:00Z')) / 86400000);
}
function fmtDate(iso) {
  return new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function inWords(daysLeft) {
  return daysLeft === 1 ? 'tomorrow' : 'in ' + daysLeft + ' days';
}

// Claims the most urgent milestone this item has passed and not yet been
// warned about, marking the earlier ones with it (a date typed in 10 days
// before expiry gets one warning, not four). Null if there is nothing new.
async function claim(kind, refId, expiresOn, daysLeft) {
  var passed = MILESTONES.filter(function (m) { return daysLeft <= m.days; }).map(function (m) { return m.key; });
  if (!passed.length) return null;
  var urgent = passed[passed.length - 1];
  var won = await pool.query(
    'INSERT INTO expiry_alerts (kind, ref_id, milestone, expires_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING milestone',
    [kind, refId, urgent, expiresOn]
  );
  if (!won.rowCount) return null;
  for (var i = 0; i < passed.length - 1; i++) {
    await pool.query('INSERT INTO expiry_alerts (kind, ref_id, milestone, expires_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [kind, refId, passed[i], expiresOn]);
  }
  return urgent;
}

// Company documents: everyone who manages documents and can see this one,
// and whoever uploaded it.
async function documentRecipients(doc, cache) {
  if (!cache.managers) {
    cache.managers = [];
    var holders = await staffAlerts.holdersOf(['document.manage']);
    for (var i = 0; i < holders.length; i++) {
      var ctx = await buildContext(holders[i].user_id);
      if (ctx) cache.managers.push(ctx);
    }
  }
  var who = cache.managers.filter(function (c) { return documentVisible(c, doc); }).map(function (c) { return c.employee.id; });
  var uploader = (await pool.query("SELECT id FROM employees WHERE id = $1 AND status = 'active'", [doc.uploaded_by])).rows[0];
  if (uploader && who.indexOf(uploader.id) < 0) who.push(uploader.id);
  return who;
}

async function expiryAlerts(today, settings) {
  var sent = 0;
  var cache = {};

  var docs = (await pool.query(
    'SELECT id, title, category, visibility, department_id, uploaded_by, expires_on::text AS expires_on FROM documents ' +
    'WHERE expires_on IS NOT NULL AND expires_on <= ($1::date + $2::integer) ORDER BY expires_on',
    [today, WIDEST]
  )).rows;
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    var left = daysBetween(today, d.expires_on);
    var m = await claim('document', d.id, d.expires_on, left);
    if (!m) continue;
    var name = d.title + (d.category ? ' (' + d.category + ')' : '');
    var title = left < 0 ? 'Document expired — ' + d.title : left === 0 ? 'Document expires today — ' + d.title : 'Document expires ' + inWords(left) + ' — ' + d.title;
    var body = left < 0 ? name + ' expired on ' + fmtDate(d.expires_on) + '. Renew it and upload the new copy.'
      : name + ' expires on ' + fmtDate(d.expires_on) + '. Renew it and upload the new copy.';
    var who = await documentRecipients(d, cache);
    for (var j = 0; j < who.length; j++) { await staffAlerts.alert(who[j], title, body, 'documents', settings); sent++; }
  }

  var ids = (await pool.query(
    "SELECT ed.id, ed.kind, ed.employee_id, ed.expires_on::text AS expires_on, e.first_name, e.last_name, u.status AS user_status " +
    'FROM employee_documents ed JOIN employees e ON e.id = ed.employee_id LEFT JOIN users u ON u.employee_id = e.id ' +
    "WHERE ed.expires_on IS NOT NULL AND e.status = 'active' AND ed.expires_on <= ($1::date + $2::integer) ORDER BY ed.expires_on",
    [today, WIDEST]
  )).rows;
  var hr = ids.length ? (await staffAlerts.holdersOf(['employee.write'])).map(function (h) { return h.employee_id; }) : [];
  for (var k = 0; k < ids.length; k++) {
    var r = ids[k];
    var daysLeft = daysBetween(today, r.expires_on);
    var ms = await claim('employee_document', r.id, r.expires_on, daysLeft);
    if (!ms) continue;
    var what = r.kind === 'passport' ? 'passport' : 'ID card';
    var person = r.first_name + ' ' + r.last_name;
    var when = daysLeft < 0 ? 'expired on ' + fmtDate(r.expires_on) : 'expires on ' + fmtDate(r.expires_on);
    var headline = daysLeft < 0 ? 'expired' : daysLeft === 0 ? 'expires today' : 'expires ' + inWords(daysLeft);
    for (var h = 0; h < hr.length; h++) {
      if (hr[h] === r.employee_id) continue;
      await staffAlerts.alert(hr[h], (what === 'passport' ? 'Passport ' : 'ID card ') + headline + ' — ' + person,
        person + '\'s ' + what + ' ' + when + '. Ask for the renewed one and upload it on their record.', 'people', settings);
      sent++;
    }
    // The person themselves, if they can sign in.
    if (r.user_status === 'active') {
      await staffAlerts.alert(r.employee_id, 'Your ' + what + ' ' + headline,
        'Your ' + what + ' ' + when + '. Please renew it and give HR a copy of the new one.', 'myspace', settings);
      sent++;
    }
  }
  return sent;
}

var running = false;

async function runOnce(now) {
  if (running) return null;
  running = true;
  var at = now || new Date();
  var hour = at.getUTCHours();
  var out = { expiry: 0, bookings: 0, texts: 0 };
  try {
    if (hour >= ALERTS_FROM_HOUR) {
      var settings = await sms.messaging();
      try { out.expiry = await expiryAlerts(todayISO(), settings); } catch (e) { console.error('Expiry alerts failed:', e.message); }
      out.bookings = await pokiReminders.sweep({ force: true });
    }
    if (hour >= TEXTS_FROM_HOUR && hour < TEXTS_UNTIL_HOUR) out.texts = await reminders.autoTexts();
    if (out.expiry || out.bookings || out.texts) console.log('Daily alerts:', JSON.stringify(out));
  } finally {
    running = false;
  }
  return out;
}

function start() {
  setTimeout(function () { runOnce().catch(function (e) { console.error('Daily alerts failed:', e.message); }); }, 90 * 1000).unref();
  setInterval(function () { runOnce().catch(function (e) { console.error('Daily alerts failed:', e.message); }); }, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce, expiryAlerts: expiryAlerts, MILESTONES: MILESTONES };
