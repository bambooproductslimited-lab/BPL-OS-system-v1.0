var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var codes = require('./employeeCodes.service');
var employees = require('./employees.service');

// Hire dates for many people at once, from a pasted list (a payroll or HR
// sheet): each line has a person — their employee ID, their name, or both —
// and the day they started. preview() reads every line and says who it is
// and what would change; apply() sets the chosen ones, all or nothing.
// People added from a list or the clock got the day they were added as
// their hire date, so this is how the real dates go in.

var MONTHS = {
  jan: 1, january: 1, janv: 1, janvier: 1, feb: 2, february: 2, fev: 2, fevr: 2, fevrier: 2, mar: 3, march: 3, mars: 3,
  apr: 4, april: 4, avr: 4, avril: 4, may: 5, mai: 5, jun: 6, june: 6, juin: 6, jul: 7, july: 7, juil: 7, juillet: 7,
  aug: 8, august: 8, aout: 8, sep: 9, sept: 9, september: 9, septembre: 9, oct: 10, october: 10, octobre: 10,
  nov: 11, november: 11, novembre: 11, dec: 12, december: 12, decembre: 12
};
function plain(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function pad(n) { return String(n).padStart(2, '0'); }
// A two-digit year: this century unless that would be in the future.
function fullYear(y) {
  if (y.length === 4) return Number(y);
  var n = Number(y), now = new Date().getUTCFullYear() % 100;
  return n <= now ? 2000 + n : 1900 + n;
}
function realDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  var iso = y + '-' + pad(m) + '-' + pad(d);
  var t = new Date(iso + 'T00:00:00Z');
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

// The date in one line, and the line without it. Numbers-only dates can be
// day/month or month/day: `order` says which ('dmy' or 'mdy'); `ambiguous`
// is true when both readings are real dates (03/04/2019).
function findDate(line, order) {
  var m, s = String(line);
  // 2019-03-11, 2019/3/11
  if ((m = s.match(/(^|[^\d])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/))) {
    return { iso: realDate(Number(m[2]), Number(m[3]), Number(m[4])), text: m[0].slice(m[1].length), ambiguous: false };
  }
  // 11/03/2019, 11-03-19, 11.03.2019
  if ((m = s.match(/(^|[^\d])(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/))) {
    var a = Number(m[2]), b = Number(m[3]), y = fullYear(m[4]);
    var dmy = realDate(y, b, a), mdy = realDate(y, a, b);
    var iso = order === 'mdy' ? (mdy || dmy) : (dmy || mdy);
    return { iso: iso, text: m[0].slice(m[1].length), ambiguous: !!(dmy && mdy && dmy !== mdy), dayFirstOnly: !!dmy && !mdy, monthFirstOnly: !!mdy && !dmy };
  }
  var p = plain(s);
  // 11 March 2019, 11-Mar-19, 11th of March 2019
  if ((m = p.match(/(^|[^a-z\d])(\d{1,2})(?:st|nd|rd|th|er)?(?:\s+of)?[\s\-/.]+([a-z]{3,9})\.?[\s\-/.,]+(\d{4}|\d{2})(?!\d)/)) && MONTHS[m[3]]) {
    return { iso: realDate(fullYear(m[4]), MONTHS[m[3]], Number(m[2])), text: s.substr(m.index + m[1].length, m[0].length - m[1].length), ambiguous: false };
  }
  // March 11, 2019; Mar 11 2019
  if ((m = p.match(/(^|[^a-z])([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/)) && MONTHS[m[2]]) {
    return { iso: realDate(Number(m[4]), MONTHS[m[2]], Number(m[3])), text: s.substr(m.index + m[1].length, m[0].length - m[1].length), ambiguous: false };
  }
  return null;
}

function person(e) {
  return { id: e.id, code: e.code, name: (e.first_name + ' ' + e.last_name).trim(), positionTitle: e.position_title || '', hireDate: String(e.hire_date).slice(0, 10) };
}

// POST /api/employees/hire-dates/preview { text, order? }
async function preview(ctx, text, order) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  if (!lines.length) fail('invalid', 'Paste the list of names and hire dates first.');
  if (lines.length > 2000) fail('invalid', 'That is more than 2,000 lines; paste it in parts.');

  // Day or month first: what the list itself shows (a 25/03 can only be
  // day first), unless the person chose; Ghana writes the day first.
  var found = lines.map(function (l) { return findDate(l, 'dmy'); });
  var dayFirst = found.some(function (f) { return f && f.dayFirstOnly; });
  var monthFirst = found.some(function (f) { return f && f.monthFirstOnly; });
  var used = order === 'mdy' || order === 'dmy' ? order : (monthFirst && !dayFirst ? 'mdy' : 'dmy');
  var ambiguous = found.some(function (f) { return f && f.ambiguous; });

  var staff = (await pool.query("SELECT id, code, first_name, last_name, position_title, hire_date FROM employees WHERE status <> 'terminated' ORDER BY first_name, last_name")).rows
    .map(function (e) { return Object.assign(person(e), { words: codes.words(e.first_name + ' ' + e.last_name) }); });
  var byCode = {};
  staff.forEach(function (s) { byCode[String(s.code).toUpperCase()] = s; });

  var skipped = [], rows = [];
  lines.forEach(function (line) {
    var f = findDate(line, used);
    if (!f) { skipped.push({ line: line, why: 'no-date' }); return; }
    if (!f.iso) { skipped.push({ line: line, why: 'bad-date' }); return; }
    var rest = line.replace(f.text, ' ').split(/[\t;,|]+/).map(function (c) { return c.trim(); }).filter(Boolean).join(' ');
    var tokens = rest.split(/\s+/).filter(Boolean);
    // An employee ID among the words, if one is someone's.
    var code = null, byId = null;
    tokens.forEach(function (t) { var k = t.toUpperCase(); if (!byId && /\d/.test(k) && byCode[k]) { byId = byCode[k]; code = k; } });
    var name = tokens.filter(function (t) { return !code || t.toUpperCase() !== code; }).join(' ').trim();
    if (!byId && !name) { skipped.push({ line: line, why: 'no-person' }); return; }
    var w = codes.words(name);
    rows.push({ line: line, date: f.iso, code: code, name: name, words: w, byId: byId, exact: byId ? [byId] : staff.filter(function (s) { return w.length && codes.same(s.words, w); }) });
  });

  // Someone matched exactly by one line isn't offered to the others as a maybe.
  var taken = {};
  rows.forEach(function (r) { if (r.exact.length === 1) taken[r.exact[0].id] = (taken[r.exact[0].id] || 0) + 1; });
  function within(a, b) { return a.every(function (x) { return b.indexOf(x) >= 0; }); }

  var out = rows.map(function (r) {
    var status, candidates;
    if (r.exact.length === 1) { status = 'match'; candidates = r.exact; }
    else if (r.exact.length > 1) { status = 'several'; candidates = r.exact; }
    else {
      candidates = staff.filter(function (s) { return !taken[s.id] && r.words.length && s.words.length && (within(r.words, s.words) || within(s.words, r.words)); });
      status = candidates.length ? 'maybe' : 'none';
    }
    return {
      line: r.line, date: r.date, name: r.name || (r.byId ? r.byId.name : ''), code: r.code, by: r.byId ? 'id' : 'name', status: status,
      // The same person on two lines: neither is set until one is left out.
      repeated: status === 'match' && taken[candidates[0].id] > 1,
      candidates: candidates.map(function (c) { return { id: c.id, code: c.code, name: c.name, positionTitle: c.positionTitle, hireDate: c.hireDate }; })
    };
  });
  return { rows: out, skipped: skipped, order: used, ambiguous: ambiguous };
}

// POST /api/employees/hire-dates/apply { changes: [{ employeeId, hireDate }] }
async function apply(ctx, changes) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  if (!Array.isArray(changes) || !changes.length) fail('invalid', 'Choose at least one person to set a hire date for.');
  if (changes.length > 2000) fail('invalid', 'Too many at once.');
  var seen = {};
  var list = changes.map(function (c) {
    var id = String((c && c.employeeId) || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) fail('invalid', 'Choose who each hire date is for.');
    if (seen[id]) fail('invalid', 'The same person was chosen twice.');
    seen[id] = true;
    return { id: id, date: employees.hireDay(c && c.hireDate) };
  });

  return withTransaction(async function (client) {
    var found = (await client.query('SELECT id, first_name, last_name, status, hire_date FROM employees WHERE id = ANY($1::uuid[])', [list.map(function (c) { return c.id; })])).rows;
    var byId = {};
    found.forEach(function (e) { byId[e.id] = e; });
    var updated = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i], e = byId[c.id];
      if (!e) fail('notfound', 'One of the people chosen is no longer in the directory.');
      if (e.status === 'terminated') fail('invalid', e.first_name + ' ' + e.last_name + ' has left; their record stays as it is.');
      var was = String(e.hire_date).slice(0, 10);
      if (was === c.date) continue;
      await client.query('UPDATE employees SET hire_date = $2, updated_at = now() WHERE id = $1', [c.id, c.date]);
      await audit(client, ctx, 'employee.update', 'employee', c.id, 'Hire date of ' + e.first_name + ' ' + e.last_name + ' changed from ' + was + ' to ' + c.date + ' (from a list).');
      updated++;
    }
    return { updated: updated, unchanged: list.length - updated };
  });
}

module.exports = { preview: preview, apply: apply, findDate: findDate };
