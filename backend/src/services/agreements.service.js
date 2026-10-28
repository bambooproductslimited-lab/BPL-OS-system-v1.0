var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { keepFile } = require('./licences.service');

// Agreements (migration 0205): the leases and contracts the companies are
// bound by — the factory's lease, a supplier's supply contract, the
// security firm, a customer's framework deal, a loan, an insurance policy.
// Who with, from when to when, what it costs (a month, a quarter, a year or
// once), how much notice it takes to end or change it, whether it renews
// itself, and a copy. The notice date (the end less the notice) is the one
// that matters: after it, an agreement that renews itself is renewed, and
// one that does not simply ends. The owner and whoever keeps the agreements
// are reminded 60, 30, 14 and 7 days before the notice date and before the
// end (the daily alerts); one that renews itself is moved on to its next
// term on its own, with its yearly rise. Renewing keeps the term before in
// the history. Contracts customers sign online are kept apart (Contracts).

var KINDS = ['lease', 'supplier', 'service', 'customer', 'loan', 'insurance', 'other'];
var PERS = ['month', 'quarter', 'year', 'once'];
var INTENTS = ['renew', 'renegotiate', 'end'];
var PER_YEAR = { month: 12, quarter: 4, year: 1, once: 0 };
var MAX_FILES = 12;

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function dayOr(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function addMonths(day, n) {
  var d = new Date(day + 'T00:00:00Z'), want = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(want, last));
  return d.toISOString().slice(0, 10);
}
function daysTo(day) { return Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000); }
function ref(n) { return 'AG-' + String(n).padStart(4, '0'); }
function can(ctx) { return ctx.can('agreement.manage'); }
function need(ctx) { if (!can(ctx)) fail('forbidden', 'Your role does not allow this action (agreement.manage).'); }

// The last day to give notice: the end less the notice.
function noticeBy(a) { var end = dayText(a.ends_on); return end ? addDays(end, -(Number(a.notice_days) || 0)) : null; }

// Where an agreement stands today.
function stateOf(a) {
  if (a.status === 'ended') return 'ended';
  var end = dayText(a.ends_on);
  if (!end) return 'open_ended';
  if (daysTo(end) < 0) return 'lapsed';
  if (a.status === 'renegotiating') return 'renegotiating';
  var n = daysTo(noticeBy(a));
  if (n < 0) return a.auto_renews ? 'locked_in' : 'ending';
  if (n <= 30) return 'notice_due';
  return 'ok';
}

// What it costs in a year, in its own currency.
function yearly(a) { return round2(Number(a.value) * (PER_YEAR[a.per] || 0)); }

var SEL = 'SELECT a.*, c.name AS company, c.code AS company_code, o.first_name AS o_first, o.last_name AS o_last, s.name AS supplier_name, cu.name AS customer_name, ' +
  '(SELECT count(*)::int FROM agreement_periods p WHERE p.agreement_id = a.id) AS periods ' +
  'FROM agreements a LEFT JOIN companies c ON c.id = a.company_id LEFT JOIN employees o ON o.id = a.owner_id ' +
  'LEFT JOIN suppliers s ON s.id = a.supplier_id LEFT JOIN customers cu ON cu.id = a.customer_id ';

function out(a) {
  var end = dayText(a.ends_on), nb = noticeBy(a);
  return {
    id: a.id, ref: ref(a.number), kind: a.kind, title: a.title, party: a.party, reference: a.reference, site: a.site,
    supplier: a.supplier_id ? { id: a.supplier_id, name: a.supplier_name } : null,
    customer: a.customer_id ? { id: a.customer_id, name: a.customer_name } : null,
    company: a.company_id ? { id: a.company_id, name: a.company, code: a.company_code } : null,
    startsOn: dayText(a.starts_on), endsOn: end, daysLeft: end ? daysTo(end) : null,
    noticeDays: a.notice_days, noticeBy: nb, noticeLeft: nb ? daysTo(nb) : null,
    autoRenews: a.auto_renews, renewMonths: a.renew_months, value: Number(a.value), currency: a.currency, per: a.per, yearly: yearly(a),
    escalation: Number(a.escalation), owner: a.owner_id ? { id: a.owner_id, name: nameOf(a.o_first, a.o_last) } : null,
    intent: a.intent, status: a.status, state: stateOf(a), endedOn: dayText(a.ended_on), endNote: a.end_note, note: a.note, periods: a.periods || 0,
    files: (a.files || []).map(function (f, n) { return { n: n, name: f.name, type: f.type }; }), updatedAt: a.updated_at
  };
}

async function rowOf(db, id) {
  var a = (await db.query(SEL + 'WHERE a.id = $1', [uuidOr(id)])).rows[0];
  if (!a) fail('notfound', 'That agreement is gone.');
  return a;
}

// GET /api/agreements?status=ended
async function overview(ctx, q) {
  need(ctx);
  q = q || {};
  var rows = (await pool.query(SEL + (q.status === 'ended' ? "WHERE a.status = 'ended' ORDER BY a.ended_on DESC NULLS LAST" : "WHERE a.status <> 'ended' ORDER BY a.ends_on NULLS LAST, a.title"))).rows.map(out);
  var live = q.status === 'ended' ? (await pool.query(SEL + "WHERE a.status <> 'ended'")).rows.map(out) : rows;
  // The next twelve months: notice dates and ends in each.
  var months = [];
  var first = new Date(today().slice(0, 7) + '-01T12:00:00Z');
  for (var i = 0; i < 12; i++) months.push({ month: new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1)).toISOString().slice(0, 7), notices: 0, ends: 0 });
  live.forEach(function (a) {
    var n = a.noticeBy && months.find(function (m) { return m.month === a.noticeBy.slice(0, 7); });
    if (n && a.noticeLeft >= 0) n.notices++;
    var e = a.endsOn && months.find(function (m) { return m.month === a.endsOn.slice(0, 7); });
    if (e) e.ends++;
  });
  // What they cost a year, by kind and by currency.
  var byKind = {}, byCurrency = {};
  live.forEach(function (a) {
    if (!a.yearly) return;
    byCurrency[a.currency] = round2((byCurrency[a.currency] || 0) + a.yearly);
    if (a.currency === 'GHS') byKind[a.kind] = round2((byKind[a.kind] || 0) + a.yearly);
  });
  var companies = (await pool.query('SELECT id, name, code FROM companies ORDER BY name')).rows;
  var people = (await pool.query("SELECT id, first_name, last_name FROM employees WHERE status = 'active' ORDER BY first_name, last_name")).rows.map(function (p) { return { id: p.id, name: nameOf(p.first_name, p.last_name) }; });
  var suppliers = (await pool.query("SELECT id, name FROM suppliers WHERE status IS DISTINCT FROM 'inactive' ORDER BY name LIMIT 500")).rows;
  return {
    agreements: rows, months: months, companies: companies, people: people, suppliers: suppliers, kinds: KINDS, pers: PERS,
    byKind: Object.keys(byKind).map(function (k) { return { kind: k, yearly: byKind[k] }; }).sort(function (a, b) { return b.yearly - a.yearly; }),
    byCurrency: Object.keys(byCurrency).map(function (c) { return { currency: c, yearly: byCurrency[c] }; }),
    summary: {
      live: live.length,
      noticeDue: live.filter(function (a) { return a.state === 'notice_due'; }).length,
      endingSoon: live.filter(function (a) { return a.daysLeft != null && a.daysLeft >= 0 && a.daysLeft <= 90; }).length,
      lapsed: live.filter(function (a) { return a.state === 'lapsed'; }).length,
      autoRenew: live.filter(function (a) { return a.autoRenews; }).length,
      yearlyGhs: byCurrency.GHS || 0,
      next: live.filter(function (a) { return a.noticeLeft != null && a.noticeLeft >= 0; }).sort(function (a, b) { return a.noticeLeft - b.noticeLeft; })[0] || null
    }
  };
}

// GET /api/agreements/:id — with the terms before this one.
async function get(ctx, id) {
  need(ctx);
  var a = out(await rowOf(pool, id));
  a.history = (await pool.query('SELECT p.*, e.first_name, e.last_name FROM agreement_periods p LEFT JOIN employees e ON e.id = p.by_id WHERE p.agreement_id = $1 ORDER BY p.ends_on DESC NULLS LAST, p.at DESC', [a.id])).rows.map(function (p) {
    return { id: p.id, startsOn: dayText(p.starts_on), endsOn: dayText(p.ends_on), value: Number(p.value), currency: p.currency, per: p.per, how: p.how, note: p.note, by: nameOf(p.first_name, p.last_name), at: p.at,
      files: (p.files || []).map(function (f, n) { return { n: n, name: f.name, type: f.type }; }) };
  });
  return a;
}

async function newFiles(list) {
  var given = Array.isArray(list) ? list.slice(0, 6) : [], files = [];
  for (var i = 0; i < given.length; i++) if (given[i] && given[i].dataUrl) files.push(await keepFile(given[i].dataUrl, given[i].name, 'agreement'));
  return files;
}

function cleanTerms(p) {
  var starts = dayOr(p.startsOn), ends = dayOr(p.endsOn);
  if (starts && ends && ends < starts) fail('invalid', 'It cannot end before it starts.');
  var value = p.value === undefined || p.value === '' ? 0 : Number(p.value);
  if (!(value >= 0 && value < 1e10)) fail('invalid', 'What does it cost?');
  var per = PERS.indexOf(p.per) >= 0 ? p.per : 'month';
  var currency = /^[A-Z]{3}$/.test(String(p.currency || '')) ? p.currency : 'GHS';
  return { starts: starts, ends: ends, value: round2(value), per: per, currency: currency };
}

// POST /api/agreements, PUT /api/agreements/:id { kind, title, party,
// supplierId, customerId, companyId, site, reference, startsOn, endsOn,
// noticeDays, autoRenews, renewMonths, value, currency, per, escalation,
// ownerId, intent, note, addFiles: [{ dataUrl, name }], removeFiles: [n] }
async function save(ctx, id, p) {
  need(ctx);
  p = p || {};
  var title = text(p.title, 140);
  if (title.length < 3) fail('invalid', 'What is it? e.g. Factory lease, Tema.');
  var kind = KINDS.indexOf(p.kind) >= 0 ? p.kind : 'other';
  var supplierId = uuidOr(p.supplierId), customerId = uuidOr(p.customerId);
  var party = text(p.party, 160);
  if (supplierId) { var s = (await pool.query('SELECT name FROM suppliers WHERE id = $1', [supplierId])).rows[0]; if (!s) fail('invalid', 'Which supplier?'); party = party || s.name; }
  if (customerId) { var cu = (await pool.query('SELECT name FROM customers WHERE id = $1', [customerId])).rows[0]; if (!cu) fail('invalid', 'Which customer?'); party = party || cu.name; }
  if (party.length < 2) fail('invalid', 'Who is it with?');
  var company = uuidOr(p.companyId);
  if (company && !(await pool.query('SELECT 1 FROM companies WHERE id = $1', [company])).rows[0]) fail('invalid', 'Which company?');
  var t = cleanTerms(p);
  var notice = Math.round(Number(p.noticeDays));
  if (!(notice >= 0 && notice <= 730)) notice = 30;
  var renewMonths = Math.round(Number(p.renewMonths));
  if (!(renewMonths >= 1 && renewMonths <= 120)) renewMonths = 12;
  var esc = Number(p.escalation) || 0;
  if (!(esc >= 0 && esc <= 100)) fail('invalid', 'The yearly rise is a percentage between 0 and 100.');
  var auto = !!p.autoRenews;
  if (auto && !t.ends) fail('invalid', 'One that renews itself needs an end date.');
  var intent = INTENTS.indexOf(p.intent) >= 0 ? p.intent : null;
  var owner = uuidOr(p.ownerId);
  var added = await newFiles(p.addFiles);
  var args = [kind, title, party, supplierId, customerId, company, text(p.site, 120), text(p.reference, 80), t.starts, t.ends, notice, auto, renewMonths, t.value, t.currency, t.per, round2(esc), owner, intent, text(p.note, 2000)];
  var rowId;
  if (id) {
    var cur = await rowOf(pool, id);
    var files = (cur.files || []).filter(function (f, n) { return (p.removeFiles || []).indexOf(n) < 0; }).concat(added);
    if (files.length > MAX_FILES) fail('invalid', 'Twelve files at most.');
    rowId = (await pool.query(
      'UPDATE agreements SET kind = $2, title = $3, party = $4, supplier_id = $5, customer_id = $6, company_id = $7, site = $8, reference = $9, starts_on = $10, ends_on = $11, notice_days = $12, ' +
      'auto_renews = $13, renew_months = $14, value = $15, currency = $16, per = $17, escalation = $18, owner_id = $19, intent = $20, note = $21, files = $22, updated_at = now() WHERE id = $1 RETURNING id',
      [cur.id].concat(args, [JSON.stringify(files)]))).rows[0].id;
    await audit(pool, ctx, 'agreement.update', 'agreement', rowId, ref(cur.number) + ' "' + title + '" changed.');
  } else {
    rowId = await withTransaction(async function (db) {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('agreements'))");
      var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM agreements')).rows[0].n;
      var r = (await db.query(
        'INSERT INTO agreements (number, kind, title, party, supplier_id, customer_id, company_id, site, reference, starts_on, ends_on, notice_days, auto_renews, renew_months, value, currency, per, escalation, owner_id, intent, note, files, created_by) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id',
        [n].concat(args, [JSON.stringify(added), me(ctx)]))).rows[0];
      await audit(db, ctx, 'agreement.create', 'agreement', r.id, ref(n) + ' "' + title + '" with ' + party + ' added' + (t.ends ? ', ends ' + t.ends : '') + '.');
      return r.id;
    });
  }
  return get(ctx, rowId);
}

// POST /api/agreements/:id/renew { startsOn, endsOn, value, per, currency,
// files, note } — the next term: the one before goes to the history.
async function renew(ctx, id, p) {
  need(ctx);
  p = p || {};
  var a = await rowOf(pool, id);
  if (a.status === 'ended') fail('conflict', 'It has ended: open it again first.');
  var t = cleanTerms(Object.assign({ value: a.value, per: a.per, currency: a.currency }, p));
  var oldEnd = dayText(a.ends_on);
  var starts = t.starts || (oldEnd ? addDays(oldEnd, 1) : today());
  if (!t.ends) fail('invalid', 'When does the new term end?');
  if (oldEnd && t.ends <= oldEnd) fail('invalid', 'The new term should end after ' + oldEnd + '.');
  var files = await newFiles(p.files);
  await withTransaction(async function (db) {
    await db.query('INSERT INTO agreement_periods (agreement_id, starts_on, ends_on, value, currency, per, files, how, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [a.id, a.starts_on, a.ends_on, a.value, a.currency, a.per, JSON.stringify(a.files || []), 'renewed', text(p.note, 1000), me(ctx)]);
    await db.query("UPDATE agreements SET starts_on = $2, ends_on = $3, value = $4, currency = $5, per = $6, files = CASE WHEN $7::jsonb = '[]'::jsonb THEN files ELSE $7::jsonb END, status = 'active', intent = NULL, updated_at = now() WHERE id = $1",
      [a.id, starts, t.ends, t.value, t.currency, t.per, JSON.stringify(files)]);
  });
  await audit(pool, ctx, 'agreement.renew', 'agreement', a.id, ref(a.number) + ' "' + a.title + '" renewed to ' + t.ends + ' at ' + t.value.toFixed(2) + ' ' + t.currency + ' a ' + t.per + '.');
  return get(ctx, a.id);
}

// POST /api/agreements/:id/intent { intent, note } — what we mean to do at
// the notice date; renegotiate marks it as being talked over.
async function setIntent(ctx, id, p) {
  need(ctx);
  p = p || {};
  var a = await rowOf(pool, id);
  if (a.status === 'ended') fail('conflict', 'It has ended.');
  var intent = INTENTS.indexOf(p.intent) >= 0 ? p.intent : null;
  var status = intent === 'renegotiate' ? 'renegotiating' : 'active';
  await pool.query("UPDATE agreements SET intent = $2, status = $3, note = CASE WHEN $4 = '' THEN note ELSE $4 END, updated_at = now() WHERE id = $1", [a.id, intent, status, text(p.note, 2000)]);
  await audit(pool, ctx, 'agreement.intent', 'agreement', a.id, ref(a.number) + ': ' + (intent ? 'we mean to ' + intent : 'no decision yet') + '.');
  return get(ctx, a.id);
}

// POST /api/agreements/:id/end { on, note } and /reopen.
async function setEnded(ctx, id, ended, p) {
  need(ctx);
  p = p || {};
  var a = await rowOf(pool, id);
  if (ended && a.status === 'ended') fail('conflict', 'It has ended already.');
  if (!ended && a.status !== 'ended') fail('conflict', 'It is in force.');
  var note = text(p.note, 500);
  if (ended && note.length < 3) fail('invalid', 'Why did it end? e.g. moved out, notice given on 1 March.');
  var on = dayOr(p.on) || today();
  await pool.query("UPDATE agreements SET status = $2, ended_on = $3, end_note = $4, intent = NULL, updated_at = now() WHERE id = $1", [a.id, ended ? 'ended' : 'active', ended ? on : null, ended ? note : '']);
  await audit(pool, ctx, ended ? 'agreement.end' : 'agreement.reopen', 'agreement', a.id, ref(a.number) + ' "' + a.title + '" ' + (ended ? 'ended on ' + on + ': ' + note : 'in force again') + '.');
  return get(ctx, a.id);
}

// GET /api/agreements/:id/files/:n?period=
async function fileOf(ctx, id, n, periodId) {
  need(ctx);
  var files;
  if (periodId) {
    var r = (await pool.query('SELECT files FROM agreement_periods WHERE id = $1 AND agreement_id = $2', [uuidOr(periodId), uuidOr(id)])).rows[0];
    if (!r) fail('notfound', 'That file is gone.');
    files = r.files || [];
  } else files = (await rowOf(pool, id)).files || [];
  var f = files[Math.round(Number(n))];
  if (!f) fail('notfound', 'That file is gone.');
  return f;
}

// Daily: an agreement that renews itself and has passed its end moves on to
// its next term (with its yearly rise). Returns the ones moved, for the
// alerts to tell their owners.
async function rollOver(asOf) {
  var day = asOf || today();
  var due = (await pool.query(SEL + "WHERE a.status <> 'ended' AND a.auto_renews AND a.ends_on IS NOT NULL AND a.ends_on < $1", [day])).rows;
  var moved = [];
  for (var i = 0; i < due.length; i++) {
    var a = due[i];
    await withTransaction(async function (db) {
      var cur = (await db.query('SELECT * FROM agreements WHERE id = $1 FOR UPDATE', [a.id])).rows[0];
      var end = dayText(cur.ends_on), value = Number(cur.value);
      // Every term it was let run, up to today.
      while (end < day) {
        var starts = addDays(end, 1), ends = addDays(addMonths(starts, cur.renew_months), -1);
        await db.query("INSERT INTO agreement_periods (agreement_id, starts_on, ends_on, value, currency, per, files, how, note) VALUES ($1,$2,$3,$4,$5,$6,$7,'auto','')",
          [cur.id, cur.starts_on, end, value, cur.currency, cur.per, JSON.stringify(cur.files || [])]);
        value = round2(value * (1 + Number(cur.escalation) / 100));
        cur.starts_on = starts; end = ends;
      }
      await db.query("UPDATE agreements SET starts_on = $2, ends_on = $3, value = $4, status = 'active', intent = NULL, updated_at = now() WHERE id = $1", [cur.id, cur.starts_on, end, value]);
      await audit(db, null, 'agreement.auto', 'agreement', cur.id, ref(cur.number) + ' "' + cur.title + '" renewed itself to ' + end + (Number(cur.escalation) ? ', up ' + Number(cur.escalation) + '%' : '') + '.');
      moved.push(Object.assign({}, a, { new_end: end, new_value: value }));
    });
  }
  return moved;
}

// For the daily alerts: in force with a notice date within 60 days, or
// ending within 30 days without renewing itself.
async function dueSoon() {
  return (await pool.query(SEL + "WHERE a.status <> 'ended' AND a.ends_on IS NOT NULL AND (a.ends_on - a.notice_days <= current_date + 60 OR (NOT a.auto_renews AND a.ends_on <= current_date + 30))")).rows;
}

module.exports = { overview: overview, get: get, save: save, renew: renew, setIntent: setIntent, setEnded: setEnded, fileOf: fileOf, rollOver: rollOver, dueSoon: dueSoon,
  stateOf: stateOf, noticeBy: noticeBy, KINDS: KINDS, ref: ref };
