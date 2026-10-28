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
// The week (Monday to Sunday) a day falls in: its key and its Monday, so a
// weekly alert is claimed once for the whole week, not once a day.
var MONDAY = 4 * 86400000; // 5 January 1970
function weekOf(day) {
  var idx = Math.floor((Date.parse(day + 'T00:00:00Z') - MONDAY) / (7 * 86400000));
  return { key: 'w' + idx, start: new Date(MONDAY + idx * 7 * 86400000).toISOString().slice(0, 10) };
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

// Staff certificates that run out within a month, or have: the person and
// whoever records training (training.service.js).
async function certAlerts(today, settings) {
  var rows = await require('../services/training.service').dueSoon(today);
  if (!rows.length) return 0;
  var keepers = (await staffAlerts.holdersOf(['training.manage'])).map(function (h) { return h.employee_id; });
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var c = rows[i], until = String(c.expires_on instanceof Date ? c.expires_on.toISOString() : c.expires_on).slice(0, 10);
    var left = daysBetween(today, until);
    if (!(await claim('cert', c.id, until, left, PAPER_MILESTONES))) continue;
    var who = (c.first_name + ' ' + (c.last_name || '')).trim();
    var title = c.type_name + (left < 0 ? ' ran out — ' : left === 0 ? ' runs out today — ' : ' runs out ' + inWords(left) + ' — ') + who;
    var body = who + '\'s ' + c.type_name.toLowerCase() + ' is valid until ' + fmtDate(until) + '. Renew it and add the new one.';
    var to = keepers.slice();
    if (to.indexOf(c.employee_id) < 0) to.push(c.employee_id);
    for (var j = 0; j < to.length; j++) { await staffAlerts.alert(to[j], title, body, to[j] === c.employee_id ? 'myspace' : 'training', settings); sent++; }
  }
  return sent;
}

// This month's budgets past the warning share, then past 100%: once each,
// to whoever manages the reports (budgets.service.js).
var BUDGET_LEVELS = [{ key: 'near', days: 1 }, { key: 'over', days: 0 }];
async function budgetAlerts(settings) {
  var rows = await require('../services/budgets.service').overruns();
  if (!rows.length) return 0;
  var keepers = (await staffAlerts.holdersOf(['report.manage'])).map(function (h) { return h.employee_id; });
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var b = rows[i];
    if (!(await claim('budget', b.id, b.month + '-01', b.over ? 0 : 1, BUDGET_LEVELS))) continue;
    var title = (b.over ? 'Over budget — ' : b.pct + '% of the budget spent — ') + b.category + ', ' + b.company;
    var body = b.company + ', ' + b.category + ' this month: GHS ' + b.actual.toFixed(2) + ' spent of a GHS ' + b.budget.toFixed(2) + ' budget (' + b.pct + '%).';
    for (var j = 0; j < keepers.length; j++) { await staffAlerts.alert(keepers[j], title, body, 'budgets', settings); sent++; }
  }
  return sent;
}

// Joiners' and leavers' steps due today, and once three days late: to
// whoever the step is for, or the team whose step it is (onboarding.service.js).
var STEP_MILESTONES = [{ key: 'due', days: 0 }, { key: 'late', days: -3 }];
async function onboardingAlerts(today, settings) {
  var onboarding = require('../services/onboarding.service');
  var rows = await onboarding.dueSteps();
  var teams = {};
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i], due = String(s.due_on instanceof Date ? s.due_on.toISOString() : s.due_on).slice(0, 10);
    var left = daysBetween(today, due);
    if (!(await claim('onboard', s.id, due, left, STEP_MILESTONES))) continue;
    var to = [];
    if (s.assignee_id) to = [s.assignee_id];
    else if (onboarding.OWNER_PERMS[s.owner]) {
      if (!teams[s.owner]) teams[s.owner] = (await staffAlerts.holdersOf(onboarding.OWNER_PERMS[s.owner])).map(function (h) { return h.employee_id; });
      to = teams[s.owner];
    }
    var who = (s.first_name + ' ' + (s.last_name || '')).trim();
    var title = (left < 0 ? 'Late: ' : 'Today: ') + s.title + ' — ' + who;
    var body = (s.kind === 'join' ? who + ' starts ' : who + ' leaves ') + 'soon; this step was due ' + fmtDate(due) + '.';
    for (var j = 0; j < to.length; j++) { await staffAlerts.alert(to[j], title, body, '/onboarding?list=' + s.list_id, settings); sent++; }
  }
  return sent;
}

// Safety actions due today, and once three days late: to their owner
// (safety.service.js).
async function safetyAlerts(today, settings) {
  var rows = await require('../services/safety.service').dueActions();
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var a = rows[i], due = String(a.due_on instanceof Date ? a.due_on.toISOString() : a.due_on).slice(0, 10);
    var left = daysBetween(today, due);
    if (!a.owner_id || !(await claim('safety', a.id, due, left, STEP_MILESTONES))) continue;
    var ref = 'HS-' + String(a.number).padStart(4, '0');
    await staffAlerts.alert(a.owner_id, (left < 0 ? 'Late safety action: ' : 'Safety action due today: ') + a.title, 'From ' + ref + ', due ' + fmtDate(due) + '. Tick it off in My space when it is done.', '/myspace', settings);
    sent++;
  }
  return sent;
}

// PAYE, SSNIT, VAT and withholding returns: a week before they are due, the
// day before, and once late — to whoever files them (returns.service.js).
var RETURN_MILESTONES = [{ key: '7', days: 7 }, { key: '1', days: 1 }, { key: 'late', days: -1 }];
async function returnsAlerts(today, settings) {
  var rows = await require('../services/returns.service').dueSoon();
  if (!rows.length) return 0;
  var keepers = (await staffAlerts.holdersOf(['returns.manage'])).map(function (h) { return h.employee_id; });
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var left = daysBetween(today, r.due);
    if (!(await claim('return_' + r.kind, r.companyId, r.due, left, RETURN_MILESTONES))) continue;
    var title = r.name + ' for ' + r.period + ', ' + r.company + (left < 0 ? ' is late' : left === 0 ? ' is due today' : ' is due ' + inWords(left));
    var body = 'Due ' + fmtDate(r.due) + (r.amount != null ? ': GHS ' + Number(r.amount).toFixed(2) + '.' : '.') + ' Mark it filed and paid in Statutory returns.';
    for (var j = 0; j < keepers.length; j++) { await staffAlerts.alert(keepers[j], title, body, '/returns', settings); sent++; }
  }
  return sent;
}

// Goods out on a gate pass that were due back: the person who asked, and
// the front desk (visitors.service.js).
async function gatePassAlerts(today, settings) {
  var rows = await require('../services/visitors.service').latePasses();
  if (!rows.length) return 0;
  var desk = (await staffAlerts.holdersOf(['visitor.manage'])).map(function (h) { return h.employee_id; });
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var g = rows[i], due = String(g.back_by instanceof Date ? g.back_by.toISOString() : g.back_by).slice(0, 10);
    if (!(await claim('gatepass', g.id, due, daysBetween(today, due), [{ key: 'late', days: -1 }]))) continue;
    var ref = 'GP-' + String(g.number).padStart(4, '0');
    var what = (g.items || []).map(function (x) { return x.qty + ' × ' + x.what; }).join(', ').slice(0, 140);
    var to = desk.slice();
    if (g.requested_by && to.indexOf(g.requested_by) < 0) to.push(g.requested_by);
    for (var j = 0; j < to.length; j++) { await staffAlerts.alert(to[j], 'Not back yet: ' + ref, what + ' — due back ' + fmtDate(due) + '.', '/visitors?pass=' + g.id, settings); sent++; }
  }
  return sent;
}

// Discipline: a query not answered by its day (to whoever handles it), a
// hearing tomorrow (to the person and the panel), a warning that has just
// ended (to the person) — discipline.service.js.
async function disciplineAlerts(today, settings) {
  var d = await require('../services/discipline.service').dueItems();
  var refOf = require('../services/discipline.service').refOf;
  var sent = 0;
  var hr = null;
  for (var i = 0; i < d.late.length; i++) {
    var c = d.late[i], due = String(c.reply_due instanceof Date ? c.reply_due.toISOString() : c.reply_due).slice(0, 10);
    if (!(await claim('discipline_reply', c.id, due, daysBetween(today, due), [{ key: 'late', days: -1 }]))) continue;
    if (!c.handler_id && !hr) hr = (await staffAlerts.holdersOf(['discipline.manage'])).map(function (h) { return h.employee_id; });
    var to = c.handler_id ? [c.handler_id] : hr;
    for (var j = 0; j < to.length; j++) { await staffAlerts.alert(to[j], 'No reply yet: ' + refOf(c), ((c.first_name || '') + ' ' + (c.last_name || '')).trim() + ' was to reply by ' + fmtDate(due) + '.', '/discipline?case=' + c.id, settings); sent++; }
  }
  for (var k = 0; k < d.hearings.length; k++) {
    var h = d.hearings[k], day = new Date(h.hearing_at).toISOString().slice(0, 10);
    if (!(await claim('discipline_hearing', h.id, day, daysBetween(today, day), [{ key: '1', days: 1 }]))) continue;
    var when = new Date(h.hearing_at).toISOString().slice(11, 16) + (h.hearing_place ? ', ' + h.hearing_place : '');
    var people = [h.employee_id].concat((h.panel || []).map(function (x) { return x.id; })).concat(h.handler_id ? [h.handler_id] : []).filter(function (x, n, a) { return x && a.indexOf(x) === n; });
    for (var m = 0; m < people.length; m++) {
      await staffAlerts.alert(people[m], 'Hearing tomorrow: ' + refOf(h), when + '.', people[m] === h.employee_id ? '/myspace' : '/discipline?case=' + h.id, settings);
      sent++;
    }
  }
  for (var n = 0; n < d.ending.length; n++) {
    var w = d.ending[n], until = String(w.warning_until instanceof Date ? w.warning_until.toISOString() : w.warning_until).slice(0, 10);
    if (!(await claim('discipline_warning', w.id, until, daysBetween(today, until), [{ key: 'ended', days: -1 }]))) continue;
    await staffAlerts.alert(w.employee_id, 'Your warning has ended', refOf(w) + ' no longer counts from ' + fmtDate(until) + '.', '/myspace', settings);
    sent++;
  }
  return sent;
}

// Quality: a lot on hold or failed and not decided after two days — to
// whoever inspects (quality.service.js).
async function qualityAlerts(today, settings) {
  var rows = await require('../services/quality.service').staleHolds();
  if (!rows.length) return 0;
  var qc = (await staffAlerts.holdersOf(['quality.manage'])).map(function (h) { return h.employee_id; });
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], day = new Date(r.inspected_at).toISOString().slice(0, 10);
    if (!(await claim('qc_hold', r.id, day, daysBetween(today, day), [{ key: '2', days: -2 }]))) continue;
    var ref = 'QC-' + String(r.number).padStart(4, '0');
    for (var j = 0; j < qc.length; j++) { await staffAlerts.alert(qc[j], 'Still on hold: ' + ref, (r.batch_no ? 'Batch ' + r.batch_no : 'Lot ' + r.lot_ref) + ' has waited since ' + fmtDate(day) + ': release it, rework it or scrap it.', '/quality?inspection=' + r.id, settings); sent++; }
  }
  return sent;
}

// Staff voice: surveys past their day close; those closing tomorrow remind
// whoever has not answered yet (voice.service.js).
async function voiceAlerts(today, settings) {
  var voice = require('../services/voice.service');
  await voice.closeDue();
  var rows = await voice.closingTomorrow();
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i].survey, close = String(s.closes_on instanceof Date ? s.closes_on.toISOString() : s.closes_on).slice(0, 10);
    if (!(await claim('voice_survey', s.id, close, daysBetween(today, close), [{ key: '1', days: 1 }]))) continue;
    for (var j = 0; j < rows[i].waiting.length; j++) { await staffAlerts.alert(rows[i].waiting[j], 'Last day tomorrow: ' + s.title, (s.anonymous ? 'Anonymous, ' : '') + 'a couple of minutes, in My space.', '/myspace', settings); sent++; }
  }
  return sent;
}

// Goals: a key result nobody has checked in on for a week — to its owner,
// once a week (goals.service.js).
async function goalAlerts(today, settings) {
  var rows = await require('../services/goals.service').staleKeyResults();
  var week = weekOf(today);
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var k = rows[i];
    if (!(await claim('goal_checkin', k.id, week.start, 0, [{ key: week.key, days: 0 }]))) continue;
    await staffAlerts.alert(k.owner_id, 'Check in: ' + k.title, 'Where is it now, and how confident are you? — ' + k.o_title, '/myspace', settings);
    sent++;
  }
  return sent;
}

// Uniforms and PPE: a replacement due within the week (to the person), sizes
// running low in the store (to whoever keeps it, once a week) — ppe.service.js.
async function ppeAlerts(today, settings) {
  var ppe = require('../services/ppe.service');
  var due = await ppe.dueSoon();
  var sent = 0;
  for (var i = 0; i < due.length; i++) {
    var d = due[i], day = String(d.due_on instanceof Date ? d.due_on.toISOString() : d.due_on).slice(0, 10);
    if (!(await claim('ppe_due', d.id, day, daysBetween(today, day), [{ key: '7', days: 7 }]))) continue;
    await staffAlerts.alert(d.employee_id, 'Time for a new ' + d.name + (d.size ? ' (' + d.size + ')' : ''), 'Yours is due for replacing on ' + fmtDate(day) + '. Ask for one in My space.', '/myspace', settings);
    sent++;
  }
  var low = await ppe.lowStock();
  if (low.length) {
    var keepers = (await staffAlerts.holdersOf(['ppe.manage'])).map(function (h) { return h.employee_id; });
    var week = weekOf(today);
    for (var k = 0; k < low.length; k++) {
      if (!(await claim('ppe_low', low[k].id, week.start, 0, [{ key: week.key, days: 0 }]))) continue;
      for (var j = 0; j < keepers.length; j++) { await staffAlerts.alert(keepers[j], 'Running low: ' + low[k].name, 'In the store: ' + low[k].sizes.join(', ') + '.', '/ppe', settings); sent++; }
    }
  }
  return sent;
}

// Licences and permits: 60, 30, 14 and 7 days before one ends, and when it
// has — to its owner and whoever keeps the licences (licences.service.js).
async function licenceAlerts(today, settings) {
  var due = await require('../services/licences.service').dueSoon();
  var keepers = (await staffAlerts.holdersOf(['licence.manage'])).map(function (h) { return h.employee_id; });
  var sent = 0;
  for (var i = 0; i < due.length; i++) {
    var l = due[i], day = String(l.expires_on instanceof Date ? l.expires_on.toISOString() : l.expires_on).slice(0, 10), left = daysBetween(today, day);
    if (!(await claim('licence', l.id, day, left))) continue;
    var to = keepers.slice();
    if (l.owner_id && to.indexOf(l.owner_id) < 0) to.push(l.owner_id);
    var title = left < 0 ? 'Expired: ' + l.title : left === 0 ? 'Ends today: ' + l.title : l.title + ' ends ' + inWords(left);
    var body = [l.authority, l.number, l.company].filter(Boolean).join(' · ') + (l.status === 'renewing' && l.renewing_since ? ' — renewal applied for on ' + fmtDate(l.renewing_since) + '.' : ' — ' + fmtDate(day) + '. Renew it in Licences and permits.');
    for (var j = 0; j < to.length; j++) { await staffAlerts.alert(to[j], title, body, '/licences?licence=' + l.id, settings); sent++; }
  }
  return sent;
}

// Agreements (agreements.service.js): one that renews itself and has passed
// its end moves on to its next term (its owner is told); the others remind
// their owner and whoever keeps the agreements 60, 30, 14 and 7 days before
// the last day to give notice, and — one that does not renew itself — 30
// and 7 days before it ends, and when it has.
var NOTICE_MILESTONES = [{ key: 'n60', days: 60 }, { key: 'n30', days: 30 }, { key: 'n14', days: 14 }, { key: 'n7', days: 7 }, { key: 'n0', days: 0 }];
var AGREEMENT_END = [{ key: 'e30', days: 30 }, { key: 'e7', days: 7 }, { key: 'ended', days: 0 }];
async function agreementAlerts(today, settings) {
  var svc = require('../services/agreements.service');
  var keepers = (await staffAlerts.holdersOf(['agreement.manage'])).map(function (h) { return h.employee_id; });
  var sent = 0;
  function people(a) { var to = keepers.slice(); if (a.owner_id && to.indexOf(a.owner_id) < 0) to.push(a.owner_id); return to; }
  var moved = await svc.rollOver(today);
  for (var m = 0; m < moved.length; m++) {
    var r = moved[m], to = people(r);
    for (var k = 0; k < to.length; k++) { await staffAlerts.alert(to[k], r.title + ' renewed itself', r.party + ' — now to ' + fmtDate(r.new_end) + '.', '/agreements?agreement=' + r.id, settings); sent++; }
  }
  var due = await svc.dueSoon();
  for (var i = 0; i < due.length; i++) {
    var a = due[i], end = String(a.ends_on instanceof Date ? a.ends_on.toISOString() : a.ends_on).slice(0, 10), nb = svc.noticeBy(a);
    var msg = null, noticeLeft = daysBetween(today, nb), endLeft = daysBetween(today, end);
    if (a.status !== 'renegotiating' && noticeLeft >= 0 && await claim('agreement_notice', a.id, nb, noticeLeft, NOTICE_MILESTONES)) {
      msg = [(noticeLeft === 0 ? 'Last day to give notice: ' : 'Notice due ' + inWords(noticeLeft) + ': ') + a.title,
        a.party + ' — ' + (a.auto_renews ? 'it renews itself for ' + a.renew_months + ' months on ' + fmtDate(end) + ' unless notice is given by ' + fmtDate(nb) + '.' : 'it ends on ' + fmtDate(end) + '; say by ' + fmtDate(nb) + ' whether to renew it.')];
    } else if (!a.auto_renews && await claim('agreement_end', a.id, end, endLeft, AGREEMENT_END)) {
      msg = [endLeft < 0 ? 'Ended: ' + a.title : endLeft === 0 ? 'Ends today: ' + a.title : a.title + ' ends ' + inWords(endLeft), a.party + ' — ' + fmtDate(end) + '. Renew it, or mark it ended, in Agreements.'];
    }
    if (!msg) continue;
    var tos = people(a);
    for (var j = 0; j < tos.length; j++) { await staffAlerts.alert(tos[j], msg[0], msg[1], '/agreements?agreement=' + a.id, settings); sent++; }
  }
  return sent;
}

// Kilns and tanks: a soak that has had its days, a charge running past its
// plan, a kiln not read for two days (kilns.service.js).
async function kilnAlerts(today, settings) {
  var kilns = require('../services/kilns.service');
  var charges = await kilns.runningCharges();
  if (!charges.length) return 0;
  var holders = (await staffAlerts.holdersOf(['production.manage'])).map(function (h) { return h.employee_id; });
  var week = weekOf(today);
  var sent = 0;
  for (var i = 0; i < charges.length; i++) {
    var c = charges[i], started = new Date(c.startedAt).toISOString().slice(0, 10);
    var to = holders.slice();
    if (c.startedById && to.indexOf(c.startedById) < 0) to.push(c.startedById);
    var link = '/kilns?charge=' + c.id, msg = null;
    if (c.kiln.kind === 'tank' && c.ready && await claim('kiln_soaked', c.id, started, 0, [{ key: 'done', days: 0 }])) msg = [c.kiln.name + ': the soak is done — ' + c.ref, c.description + ', ' + c.days + ' days. Take it out and record it.'];
    else if (c.late && await claim('kiln_late', c.id, started, 0, [{ key: 'late', days: 0 }])) {
      msg = [c.kiln.name + ': ' + c.ref + ' is taking longer than planned', 'Day ' + Math.floor(c.days) + ' of ' + c.plannedDays + (c.latestMoisture != null ? '; ' + c.latestMoisture + '% moisture, the target ' + c.targetMoisture + '%.' : '.')];
      // One message today, not a second for the missing readings.
      if (c.quiet) await claim('kiln_quiet', c.id, week.start, 0, [{ key: week.key, days: 0 }]);
    }
    else if (c.quiet && await claim('kiln_quiet', c.id, week.start, 0, [{ key: week.key, days: 0 }])) msg = [c.kiln.name + ': no reading for two days', c.ref + ' · ' + c.description + '. Read its moisture.'];
    if (!msg) continue;
    for (var j = 0; j < to.length; j++) { await staffAlerts.alert(to[j], msg[0], msg[1], link, settings); sent++; }
  }
  return sent;
}

// Policies: those late to sign, once a week, and whoever keeps the policies
// (policies.service.js).
async function policyAlerts(today, settings) {
  var late = await require('../services/policies.service').lateSigners();
  var week = weekOf(today);
  var sent = 0;
  for (var emp in late.byPerson) {
    if (!(await claim('policy_sign', emp, week.start, 0, [{ key: week.key, days: 0 }]))) continue;
    var titles = late.byPerson[emp];
    await staffAlerts.alert(emp, titles.length === 1 ? 'A policy to sign: ' + titles[0] : titles.length + ' policies to sign', titles.join(', ') + '. Read and sign in My space.', '/myspace', settings);
    sent++;
  }
  if (late.byPolicy.length) {
    var keepers = (await staffAlerts.holdersOf(['policy.manage'])).map(function (h) { return h.employee_id; });
    for (var k = 0; k < late.byPolicy.length; k++) {
      var p = late.byPolicy[k];
      if (!(await claim('policy_late', p.id, week.start, 0, [{ key: week.key, days: 0 }]))) continue;
      for (var j = 0; j < keepers.length; j++) { await staffAlerts.alert(keepers[j], p.late + ' late to sign ' + p.title, p.late + ' of ' + p.of + ' have not signed it by their day.', '/policies?policy=' + p.id, settings); sent++; }
    }
  }
  return sent;
}

// Generators burning a quarter more fuel an hour than they should, or fuel
// bought for one that has not run — weekly, to whoever keeps the power log
// (power.service.js).
async function powerAlerts(today, settings) {
  var warn = await require('../services/power.service').fuelWarnings();
  if (!warn.length) return 0;
  var keepers = (await staffAlerts.holdersOf(['power.manage'])).map(function (h) { return h.employee_id; });
  var week = weekOf(today);
  var sent = 0;
  for (var i = 0; i < warn.length; i++) {
    var g = warn[i];
    if (!(await claim('power_fuel', g.id, week.start, 0, [{ key: week.key, days: 0 }]))) continue;
    var title = g.warn === 'high' ? 'Fuel use looks wrong: ' + g.name : 'Fuel bought, no hours run: ' + g.name;
    var body = g.warn === 'high'
      ? g.site + ': ' + g.lph + ' litres an hour over the last 30 days, against ' + g.expectedLph + ' (' + g.litres + ' L for ' + g.hours + ' hours).'
      : g.site + ': ' + g.litres + ' litres bought in 30 days and no run logged.';
    for (var j = 0; j < keepers.length; j++) { await staffAlerts.alert(keepers[j], title, body, '/power', settings); sent++; }
  }
  return sent;
}

// Production jobs past their day — weekly, to whoever runs production and
// the job's lead (productionJobs.service.js).
async function jobAlerts(today, settings) {
  var late = (await pool.query("SELECT id, number, lead_id, due_on, qty, (SELECT name FROM products p WHERE p.id = j.product_id) AS name FROM production_jobs j WHERE status IN ('planned', 'in_progress') AND due_on < $1", [today])).rows;
  if (!late.length) return 0;
  var managers = (await staffAlerts.holdersOf(['production.manage'])).map(function (h) { return h.employee_id; });
  var week = weekOf(today);
  var sent = 0;
  for (var i = 0; i < late.length; i++) {
    var j = late[i], ref = 'J-' + String(j.number).padStart(4, '0');
    if (!(await claim('job_late', j.id, week.start, 0, [{ key: week.key, days: 0 }]))) continue;
    var to = managers.slice();
    if (j.lead_id && to.indexOf(j.lead_id) < 0) to.push(j.lead_id);
    for (var k = 0; k < to.length; k++) { await staffAlerts.alert(to[k], 'Late: ' + ref + ', ' + Number(j.qty) + ' × ' + j.name, 'It was due on ' + fmtDate(String(j.due_on instanceof Date ? j.due_on.toISOString() : j.due_on).slice(0, 10)) + '.', '/production-jobs?job=' + j.id, settings); sent++; }
  }
  return sent;
}

var running = false;

async function runOnce(now) {
  if (running) return null;
  running = true;
  var at = now || new Date();
  var hour = at.getUTCHours();
  var out = { expiry: 0, bills: 0, services: 0, vehicles: 0, certs: 0, budgets: 0, steps: 0, safety: 0, returns: 0, passes: 0, discipline: 0, quality: 0, voice: 0, goals: 0, ppe: 0, licences: 0, kilns: 0, policies: 0, power: 0, jobs: 0, report: 0, statements: 0, bookings: 0, texts: 0, emails: 0 };
  try {
    if (hour >= ALERTS_FROM_HOUR) {
      var settings = await sms.messaging();
      try { out.expiry = await expiryAlerts(todayISO(), settings); } catch (e) { console.error('Expiry alerts failed:', e.message); }
      try { out.bills = await billAlerts(todayISO(), settings); } catch (e) { console.error('Bill alerts failed:', e.message); }
      try { out.services = await serviceAlerts(todayISO(), settings); } catch (e) { console.error('Service alerts failed:', e.message); }
      try { out.vehicles = await vehicleAlerts(todayISO(), settings); } catch (e) { console.error('Vehicle alerts failed:', e.message); }
      try { out.certs = await certAlerts(todayISO(), settings); } catch (e) { console.error('Certificate alerts failed:', e.message); }
      try { out.budgets = await budgetAlerts(settings); } catch (e) { console.error('Budget alerts failed:', e.message); }
      try { out.steps = await onboardingAlerts(todayISO(), settings); } catch (e) { console.error('Joiner and leaver alerts failed:', e.message); }
      try { out.safety = await safetyAlerts(todayISO(), settings); } catch (e) { console.error('Safety alerts failed:', e.message); }
      try { out.returns = await returnsAlerts(todayISO(), settings); } catch (e) { console.error('Return alerts failed:', e.message); }
      try { out.passes = await gatePassAlerts(todayISO(), settings); } catch (e) { console.error('Gate pass alerts failed:', e.message); }
      try { out.discipline = await disciplineAlerts(todayISO(), settings); } catch (e) { console.error('Discipline alerts failed:', e.message); }
      try { out.quality = await qualityAlerts(todayISO(), settings); } catch (e) { console.error('Quality alerts failed:', e.message); }
      try { out.voice = await voiceAlerts(todayISO(), settings); } catch (e) { console.error('Staff voice alerts failed:', e.message); }
      try { out.goals = await goalAlerts(todayISO(), settings); } catch (e) { console.error('Goal alerts failed:', e.message); }
      try { out.ppe = await ppeAlerts(todayISO(), settings); } catch (e) { console.error('PPE alerts failed:', e.message); }
      try { out.licences = await licenceAlerts(todayISO(), settings); } catch (e) { console.error('Licence alerts failed:', e.message); }
      try { out.agreements = await agreementAlerts(todayISO(), settings); } catch (e) { console.error('Agreement alerts failed:', e.message); }
      try { out.kilns = await kilnAlerts(todayISO(), settings); } catch (e) { console.error('Kiln alerts failed:', e.message); }
      try { out.policies = await policyAlerts(todayISO(), settings); } catch (e) { console.error('Policy alerts failed:', e.message); }
      try { out.power = await powerAlerts(todayISO(), settings); } catch (e) { console.error('Power alerts failed:', e.message); }
      try { out.jobs = await jobAlerts(todayISO(), settings); } catch (e) { console.error('Job alerts failed:', e.message); }
      // The month's management report to the owners, on the 1st (managementReport.service.js).
      try { out.report = await require('../services/managementReport.service').autoSend(todayISO()); } catch (e) { console.error('Management report failed:', e.message); }
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
    if (out.expiry || out.bills || out.services || out.vehicles || out.certs || out.budgets || out.steps || out.safety || out.returns || out.passes || out.discipline || out.quality || out.voice || out.goals || out.ppe || out.licences || out.agreements || out.kilns || out.policies || out.power || out.jobs || out.report || out.statements || out.bookings || out.texts || out.emails) console.log('Daily alerts:', JSON.stringify(out));
  } finally {
    running = false;
  }
  return out;
}

function start() {
  setTimeout(function () { runOnce().catch(function (e) { console.error('Daily alerts failed:', e.message); }); }, 90 * 1000).unref();
  setInterval(function () { runOnce().catch(function (e) { console.error('Daily alerts failed:', e.message); }); }, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce, expiryAlerts: expiryAlerts, billAlerts: billAlerts, serviceAlerts: serviceAlerts, vehicleAlerts: vehicleAlerts, certAlerts: certAlerts, budgetAlerts: budgetAlerts, onboardingAlerts: onboardingAlerts, safetyAlerts: safetyAlerts, returnsAlerts: returnsAlerts, gatePassAlerts: gatePassAlerts, disciplineAlerts: disciplineAlerts, qualityAlerts: qualityAlerts, voiceAlerts: voiceAlerts, goalAlerts: goalAlerts, ppeAlerts: ppeAlerts, licenceAlerts: licenceAlerts, agreementAlerts: agreementAlerts, kilnAlerts: kilnAlerts, policyAlerts: policyAlerts, powerAlerts: powerAlerts, jobAlerts: jobAlerts, weekOf: weekOf, MILESTONES: MILESTONES };
