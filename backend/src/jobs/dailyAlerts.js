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
//   - Bills to pay (bills.service.js, migration 0196): whoever pays them is
//     told three days before one is due, on the day, and once it is late.
//   - Equipment due a service (assets' next service date): whoever looks
//     after assets is told a week before and on the day.
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
async function claim(kind, refId, expiresOn, daysLeft, milestones) {
  var passed = (milestones || MILESTONES).filter(function (m) { return daysLeft <= m.days; }).map(function (m) { return m.key; });
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

var BILL_MILESTONES = [{ key: '3', days: 3 }, { key: 'due', days: 0 }, { key: 'late', days: -1 }];
var SERVICE_MILESTONES = [{ key: '7', days: 7 }, { key: 'due', days: 0 }];
function money(n) { return 'GHS ' + (Math.round(Number(n) * 100) / 100).toFixed(2); }

// Bills to pay: due in three days, today, or late.
async function billAlerts(today, settings) {
  var rows = (await pool.query(
    "SELECT b.id, b.number, b.supplier_name, b.amount - b.paid AS balance, b.due_date::text AS due_date, b.status, c.name AS company FROM supplier_bills b JOIN companies c ON c.id = b.company_id " +
    "WHERE b.status IN ('to_approve', 'approved') AND b.due_date <= ($1::date + 3) ORDER BY b.due_date", [today])).rows;
  if (!rows.length) return 0;
  var payers = (await staffAlerts.holdersOf(['bill.manage'])).map(function (h) { return h.employee_id; });
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var b = rows[i];
    var left = daysBetween(today, b.due_date);
    if (!(await claim('bill', b.id, b.due_date, left, BILL_MILESTONES))) continue;
    var ref = 'B-' + String(b.number).padStart(4, '0');
    var title = (left < 0 ? 'Bill overdue — ' : left === 0 ? 'Bill due today — ' : 'Bill due ' + inWords(left) + ' — ') + b.supplier_name;
    var body = ref + ' · ' + money(b.balance) + ' to ' + b.supplier_name + ' (' + b.company + '), due ' + fmtDate(b.due_date) + (b.status === 'to_approve' ? '. It still waits to be approved.' : '.');
    for (var j = 0; j < payers.length; j++) { await staffAlerts.alert(payers[j], title, body, 'bills', settings); sent++; }
  }
  return sent;
}

// Equipment due a service: in a week, or today (and overdue, once).
async function serviceAlerts(today, settings) {
  var rows = (await pool.query(
    "SELECT a.id, a.asset_no, a.description, a.location, a.next_service_date::text AS due, c.name AS company FROM assets a LEFT JOIN companies c ON c.id = a.company_id " +
    "WHERE a.status <> 'retired' AND a.next_service_date IS NOT NULL AND a.next_service_date <= ($1::date + 7) " +
    "AND NOT EXISTS (SELECT 1 FROM maintenance_records m WHERE m.asset_id = a.id AND m.status = 'scheduled') ORDER BY a.next_service_date", [today])).rows;
  if (!rows.length) return 0;
  var keepers = (await staffAlerts.holdersOf(['asset.manage'])).map(function (h) { return h.employee_id; });
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var a = rows[i];
    var left = daysBetween(today, a.due);
    if (!(await claim('service', a.id, a.due, left, SERVICE_MILESTONES))) continue;
    var title = (left < 0 ? 'Service overdue — ' : left === 0 ? 'Service due today — ' : 'Service due ' + inWords(left) + ' — ') + a.description;
    var body = a.asset_no + ' · ' + a.description + (a.location ? ' (' + a.location + ')' : '') + (a.company ? ', ' + a.company : '') + ': its service is due ' + fmtDate(a.due) + '. Plan it, or log it once done.';
    for (var j = 0; j < keepers.length; j++) { await staffAlerts.alert(keepers[j], title, body, 'assets', settings); sent++; }
  }
  return sent;
}

// A vehicle's papers (migration 0197): insurance and roadworthiness a month
// before they run out, a week before, on the day — to whoever looks after
// vehicles and its driver.
var PAPER_MILESTONES = [{ key: '30', days: 30 }, { key: '7', days: 7 }, { key: 'expired', days: 0 }];
async function vehicleAlerts(today, settings) {
  var rows = await require('../services/vehicles.service').papersDue(today);
  if (!rows.length) return 0;
  var keepers = (await staffAlerts.holdersOf(['vehicle.manage'])).map(function (h) { return h.employee_id; });
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i];
    var papersList = [['insurance', 'Insurance', v.insurance], ['roadworthy', 'Roadworthy certificate', v.roadworthy]];
    for (var k = 0; k < papersList.length; k++) {
      var until = papersList[k][2];
      if (!until) continue;
      var left = daysBetween(today, until);
      if (left > 30) continue;
      if (!(await claim('vehicle_' + papersList[k][0], v.id, until, left, PAPER_MILESTONES))) continue;
      var title = papersList[k][1] + (left < 0 ? ' ran out — ' : left === 0 ? ' runs out today — ' : ' runs out ' + inWords(left) + ' — ') + v.name + (v.plate ? ' (' + v.plate + ')' : '');
      var body = v.name + (v.plate ? ' · ' + v.plate : '') + ', ' + v.company + ': ' + papersList[k][1].toLowerCase() + ' until ' + fmtDate(until) + '. Renew it and put the new date on the vehicle.';
      var to = keepers.slice();
      if (v.driver_id && to.indexOf(v.driver_id) < 0) to.push(v.driver_id);
      for (var j = 0; j < to.length; j++) { await staffAlerts.alert(to[j], title, body, 'vehicles', settings); sent++; }
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
  var out = { expiry: 0, bills: 0, services: 0, vehicles: 0, statements: 0, bookings: 0, texts: 0, emails: 0 };
  try {
    if (hour >= ALERTS_FROM_HOUR) {
      var settings = await sms.messaging();
      try { out.expiry = await expiryAlerts(todayISO(), settings); } catch (e) { console.error('Expiry alerts failed:', e.message); }
      try { out.bills = await billAlerts(todayISO(), settings); } catch (e) { console.error('Bill alerts failed:', e.message); }
      try { out.services = await serviceAlerts(todayISO(), settings); } catch (e) { console.error('Service alerts failed:', e.message); }
      try { out.vehicles = await vehicleAlerts(todayISO(), settings); } catch (e) { console.error('Vehicle alerts failed:', e.message); }
      // Monthly statements to customers who asked for them (statements.service.js).
      try { out.statements = await require('../services/statements.service').monthly(todayISO()); } catch (e) { console.error('Monthly statements failed:', e.message); }
      out.bookings = await pokiReminders.sweep({ force: true });
      // Recurring Poki charges (CAM, flat utilities) are not billed here: a
      // recurring invoice only goes out when a person bills it (Rent &
      // utilities → Bill what is due / Bill now).
    }
    if (hour >= TEXTS_FROM_HOUR && hour < TEXTS_UNTIL_HOUR) {
      out.texts = await reminders.autoTexts();
      // The same reminders by email, to customers with an address on file.
      out.emails = await require('../services/documentEmails.service').autoReminders();
    }
    if (out.expiry || out.bills || out.services || out.vehicles || out.statements || out.bookings || out.texts || out.emails) console.log('Daily alerts:', JSON.stringify(out));
  } finally {
    running = false;
  }
  return out;
}

function start() {
  setTimeout(function () { runOnce().catch(function (e) { console.error('Daily alerts failed:', e.message); }); }, 90 * 1000).unref();
  setInterval(function () { runOnce().catch(function (e) { console.error('Daily alerts failed:', e.message); }); }, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce, expiryAlerts: expiryAlerts, billAlerts: billAlerts, serviceAlerts: serviceAlerts, vehicleAlerts: vehicleAlerts, MILESTONES: MILESTONES };
