var ExcelJS = require('exceljs');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var codes = require('./employeeCodes.service');
var employees = require('./employees.service');

// Staff records from an HR sheet (.xlsx): each row a person — their name
// (or employee ID) — with any of their SSNIT number, Ghana Card number,
// TIN, the SSNIT they pay each month or their salary for SSNIT. preview()
// reads every row, says who it is and what would change; apply() sets the
// chosen ones, all or nothing. A cell left empty, or "N/A", leaves that
// field as it is; a value that doesn't look right is listed and left out.
//
// Columns are found by their headings. Columns with no heading before the
// first known one are the name, in order (first name, then surname). "SSNIT"
// alone is the amount the person pays (staff 5.5%): their salary for SSNIT
// is that over the staff rate, so 32.45 is a salary of 590.00.

var MAX_ROWS = 5000;
var HEADINGS = {
  name: ['name', 'full name', 'staff name', 'employee', 'employee name', 'names'],
  first: ['first name', 'firstname', 'given name', 'other names', 'other name'],
  last: ['surname', 'last name', 'lastname', 'family name'],
  code: ['employee id', 'staff id', 'staff no', 'staff number', 'employee no', 'employee number', 'id', 'code'],
  ssnitNumber: ['ssnit id', 'ssnt id', 'ssnit no', 'ssnit number', 'ssnit num', 'social security number', 'ssnit #'],
  ghanaCard: ['gh card', 'ghana card', 'ghanacard', 'gh card no', 'ghana card no', 'ghana card number', 'national id', 'nia', 'nia number'],
  tin: ['tin', 'tin no', 'tin number'],
  ssnitAmount: ['ssnit', 'ssnit amount', 'ssnit contribution', 'ssnit deduction', 'ssnit 5 5', 'ssnit 5 5 percent'],
  ssnitSalary: ['salary for ssnit', 'ssnit salary', 'ssnit basic']
};
function norm(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/%/g, ' percent').replace(/[^a-z0-9#]+/g, ' ').trim(); }
function roleOf(h) {
  var n = norm(h);
  if (!n) return null;
  for (var k in HEADINGS) if (HEADINGS[k].indexOf(n) >= 0) return k;
  return null;
}
function raw(v) { return v && typeof v === 'object' && !(v instanceof Date) && 'result' in v ? v.result : v; }
// A cell as text: empty for blanks, N/A, #N/A, "-", nil and the like.
function cell(v) {
  v = raw(v);
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) v = v.richText.map(function (t) { return t.text; }).join('');
    else if ('text' in v) v = v.text;
    else if ('error' in v) return '';
    else return '';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  var s = String(v).replace(/\s+/g, ' ').trim();
  if (/^(#?n\s*\/?\s*a|#n\/a|-+|nil|none|null|not available|\?)$/i.test(s)) return '';
  return s;
}
function amount(s) {
  var t = String(s).replace(/[,\s]|GHS|GH₵|₵/gi, '');
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  return Number(t);
}
function money(n) { return Math.round(n * 100) / 100; }

function personOut(e) {
  return {
    id: e.id, code: e.code, name: (e.first_name + ' ' + e.last_name).trim(), positionTitle: e.position_title || '',
    now: { ssnitNumber: e.ssnit_number || null, ghanaCard: e.ghana_card || null, tin: e.tin || null,
      ssnitSalary: e.ssnit_salary == null ? null : Number(e.ssnit_salary), basicSalary: e.basic_salary == null ? null : Number(e.basic_salary) }
  };
}

// The sheet: its heading row (one of the first five), the role of each
// column, and its rows of values as text.
async function readSheet(buffer) {
  var wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (e) { fail('invalid', 'That file could not be read as an Excel workbook (.xlsx).'); }
  var best = null;
  wb.eachSheet(function (ws) {
    for (var r = 1; r <= Math.min(5, ws.rowCount); r++) {
      var roles = {}, n = 0, last = 0;
      ws.getRow(r).eachCell({ includeEmpty: false }, function (c, col) {
        var role = roleOf(cell(c.value));
        if (role && !(role in roles)) { roles[role] = col; n++; }
        if (col > last) last = col;
      });
      var data = ['ssnitNumber', 'ghanaCard', 'tin', 'ssnitAmount', 'ssnitSalary'].filter(function (k) { return roles[k]; }).length;
      if (data && (!best || data > best.data)) best = { ws: ws, row: r, roles: roles, data: data };
      if (n) break;
    }
  });
  if (!best) fail('invalid', 'No column was found for an SSNIT number, Ghana Card, TIN or SSNIT amount. Give the columns headings such as Name, SSNIT ID, GH Card and SSNIT.');
  var ws = best.ws, roles = best.roles;
  // The name: a Name column, or First name + Surname, or else the columns
  // with no heading before the first known column.
  var nameCols = [];
  if (roles.name) nameCols = [roles.name];
  else if (roles.first || roles.last) nameCols = [roles.first, roles.last].filter(Boolean);
  else {
    var firstKnown = Math.min.apply(null, Object.keys(roles).map(function (k) { return roles[k]; }));
    for (var c = 1; c < firstKnown; c++) if (!cell(ws.getRow(best.row).getCell(c).value)) nameCols.push(c);
  }
  if (!nameCols.length && !roles.code) fail('invalid', 'No column was found for the names. Give it a heading such as Name, or put the names in the first columns.');
  var rows = [];
  var last = Math.min(ws.rowCount, best.row + MAX_ROWS);
  for (var r2 = best.row + 1; r2 <= last; r2++) {
    var row = ws.getRow(r2);
    var get = function (k) { return roles[k] ? cell(row.getCell(roles[k]).value) : ''; };
    var name = nameCols.map(function (col) { return cell(row.getCell(col).value); }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    var x = { row: r2, name: name, code: get('code'), ssnitNumber: get('ssnitNumber'), ghanaCard: get('ghanaCard'), tin: get('tin'), ssnitAmount: get('ssnitAmount'), ssnitSalary: get('ssnitSalary') };
    if (!name && !x.code && !x.ssnitNumber && !x.ghanaCard && !x.ssnitAmount && !x.ssnitSalary && !x.tin) continue;
    rows.push(x);
  }
  return { tab: ws.name, columns: Object.keys(roles), nameColumns: nameCols.length, rows: rows };
}

// The values on one row, tidied, and what was wrong with any of them.
function valuesOf(x, staffRate) {
  var v = {}, problems = [];
  if (x.ssnitNumber) {
    var sn = x.ssnitNumber.replace(/\s+/g, '').toUpperCase().replace(/\.0+$/, '');
    try { v.ssnitNumber = employees._idNumber(sn, 'SSNIT number'); } catch (e) { problems.push({ field: 'ssnitNumber', value: x.ssnitNumber, why: 'format' }); }
    if (v.ssnitNumber && !/^[A-Z]\d{12}$/.test(v.ssnitNumber)) problems.push({ field: 'ssnitNumber', value: v.ssnitNumber, why: 'unusual', kept: true });
  }
  if (x.ghanaCard) {
    var gh = x.ghanaCard.replace(/\s+/g, '').toUpperCase();
    try { v.ghanaCard = employees._ghanaCard(gh); } catch (e) { problems.push({ field: 'ghanaCard', value: x.ghanaCard, why: 'format' }); }
  }
  if (x.tin) {
    try { v.tin = employees._idNumber(x.tin.replace(/\.0+$/, ''), 'TIN'); } catch (e) { problems.push({ field: 'tin', value: x.tin, why: 'format' }); }
  }
  if (x.ssnitSalary) {
    var sal = amount(x.ssnitSalary);
    if (sal === null || sal < 0) problems.push({ field: 'ssnitSalary', value: x.ssnitSalary, why: 'format' });
    else v.ssnitSalary = money(sal);
  } else if (x.ssnitAmount) {
    var a = amount(x.ssnitAmount);
    if (a === null || a < 0) problems.push({ field: 'ssnitAmount', value: x.ssnitAmount, why: 'format' });
    else { v.ssnitAmount = money(a); v.ssnitSalary = money(a / (staffRate / 100)); }
  }
  return { values: v, problems: problems };
}

// POST /api/employees/records/preview (multipart file)
async function preview(ctx, file) {
  if (!ctx.can('payroll.manage')) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  if (!file || !file.buffer || !file.buffer.length) fail('invalid', 'Choose the staff sheet (.xlsx).');
  var sheet = await readSheet(file.buffer);
  if (!sheet.rows.length) fail('invalid', 'The sheet has no rows under its headings.');
  var settings = (await pool.query('SELECT payroll FROM settings WHERE id = 1')).rows[0].payroll;
  var staffRate = Number(settings.ssnitEmployeeRate) || 5.5;

  var staff = (await pool.query(
    "SELECT id, code, first_name, last_name, position_title, ssnit_number, ghana_card, tin, ssnit_salary, basic_salary FROM employees WHERE status <> 'terminated' ORDER BY first_name, last_name")).rows
    .map(function (e) { return Object.assign(personOut(e), { words: codes.words(e.first_name + ' ' + e.last_name) }); });
  var byCode = {};
  staff.forEach(function (s) { byCode[String(s.code).toUpperCase()] = s; });

  var rows = sheet.rows.map(function (x) {
    var byId = x.code ? byCode[x.code.toUpperCase()] : null;
    var w = codes.words(x.name);
    return Object.assign(x, valuesOf(x, staffRate), { words: w, byId: byId, exact: byId ? [byId] : staff.filter(function (s) { return w.length && codes.same(s.words, w); }) });
  });
  // Someone matched exactly by one row isn't offered to others as a maybe.
  var taken = {};
  rows.forEach(function (r) { if (r.exact.length === 1) taken[r.exact[0].id] = (taken[r.exact[0].id] || 0) + 1; });
  function within(a, b) { return a.every(function (x) { return b.indexOf(x) >= 0; }); }
  // The same number on two rows of the sheet: neither is used.
  var seen = { ssnitNumber: {}, ghanaCard: {}, tin: {} };
  rows.forEach(function (r) { ['ssnitNumber', 'ghanaCard', 'tin'].forEach(function (f) { if (r.values[f]) seen[f][r.values[f]] = (seen[f][r.values[f]] || 0) + 1; }); });

  var out = rows.map(function (r) {
    ['ssnitNumber', 'ghanaCard', 'tin'].forEach(function (f) {
      if (r.values[f] && seen[f][r.values[f]] > 1) { r.problems.push({ field: f, value: r.values[f], why: 'twice' }); delete r.values[f]; }
    });
    var status, candidates;
    if (r.exact.length === 1) { status = 'match'; candidates = r.exact; }
    else if (r.exact.length > 1) { status = 'several'; candidates = r.exact; }
    else {
      candidates = staff.filter(function (s) { return !taken[s.id] && r.words.length && s.words.length && (within(r.words, s.words) || within(s.words, r.words)); }).slice(0, 8);
      status = candidates.length ? 'maybe' : 'none';
    }
    return {
      row: r.row, name: r.name, code: r.code || null, by: r.byId ? 'id' : 'name', status: status,
      repeated: status === 'match' && taken[candidates[0].id] > 1,
      values: r.values, problems: r.problems,
      candidates: candidates.map(function (c) { return { id: c.id, code: c.code, name: c.name, positionTitle: c.positionTitle, now: c.now }; })
    };
  });
  return { tab: sheet.tab, columns: sheet.columns, staffRate: staffRate, rows: out };
}

// POST /api/employees/records/apply { changes: [{ employeeId, ssnitNumber?, ghanaCard?, tin?, ssnitSalary? }] }
async function apply(ctx, changes) {
  if (!ctx.can('payroll.manage')) fail('forbidden', 'Your role does not allow this action (payroll.manage).');
  if (!Array.isArray(changes) || !changes.length) fail('invalid', 'Choose at least one person to update.');
  if (changes.length > MAX_ROWS) fail('invalid', 'Too many at once.');
  var seen = {}, numbers = { ssnit_number: {}, ghana_card: {}, tin: {} };
  var list = changes.map(function (c) {
    var id = String((c && c.employeeId) || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) fail('invalid', 'Choose who each row is for.');
    if (seen[id]) fail('invalid', 'The same person was chosen twice.');
    seen[id] = true;
    var x = { id: id };
    if (c.ssnitNumber !== undefined && c.ssnitNumber !== null && c.ssnitNumber !== '') x.ssnit_number = employees._idNumber(c.ssnitNumber, 'SSNIT number');
    if (c.ghanaCard !== undefined && c.ghanaCard !== null && c.ghanaCard !== '') x.ghana_card = employees._ghanaCard(c.ghanaCard);
    if (c.tin !== undefined && c.tin !== null && c.tin !== '') x.tin = employees._idNumber(c.tin, 'TIN');
    if (c.ssnitSalary !== undefined && c.ssnitSalary !== null && c.ssnitSalary !== '') {
      var s = Number(c.ssnitSalary);
      if (!(s >= 0)) fail('invalid', 'A salary for SSNIT must be an amount of zero or more.');
      x.ssnit_salary = money(s);
    }
    ['ssnit_number', 'ghana_card', 'tin'].forEach(function (f) {
      if (!x[f]) return;
      if (numbers[f][x[f]]) fail('invalid', 'The same ' + (f === 'ghana_card' ? 'Ghana Card number' : f === 'tin' ? 'TIN' : 'SSNIT number') + ' is given to two people: ' + x[f] + '.');
      numbers[f][x[f]] = id;
    });
    return x;
  });

  return withTransaction(async function (client) {
    var found = (await client.query('SELECT id, first_name, last_name, status, ssnit_number, ghana_card, tin, ssnit_salary FROM employees WHERE id = ANY($1::uuid[]) FOR UPDATE', [list.map(function (c) { return c.id; })])).rows;
    var byId = {};
    found.forEach(function (e) { byId[e.id] = e; });
    var updated = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i], e = byId[c.id];
      if (!e) fail('notfound', 'One of the people chosen is no longer in the directory.');
      if (e.status === 'terminated') fail('invalid', e.first_name + ' ' + e.last_name + ' has left; their record stays as it is.');
      var sets = [], values = [c.id], what = [];
      ['ssnit_number', 'ghana_card', 'tin'].forEach(function (f) {
        if (c[f] === undefined || String(e[f] || '').toUpperCase() === c[f]) return;
        values.push(c[f]); sets.push(f + ' = $' + values.length);
        what.push(f === 'ssnit_number' ? 'SSNIT number' : f === 'ghana_card' ? 'Ghana Card number' : 'TIN');
      });
      if (c.ssnit_salary !== undefined && (e.ssnit_salary == null || Number(e.ssnit_salary) !== c.ssnit_salary)) {
        values.push(c.ssnit_salary); sets.push('ssnit_salary = $' + values.length); what.push('salary for SSNIT (GHS ' + c.ssnit_salary.toFixed(2) + ')');
      }
      if (!sets.length) continue;
      // Someone else outside this list with the same number.
      for (var f2 of ['ssnit_number', 'ghana_card', 'tin']) {
        if (!c[f2]) continue;
        var other = (await client.query('SELECT first_name, last_name FROM employees WHERE upper(' + f2 + ') = $1 AND id <> $2 AND NOT (id = ANY($3::uuid[]))', [c[f2], c.id, list.map(function (y) { return y.id; })])).rows[0];
        if (other) fail('conflict', (f2 === 'ghana_card' ? 'Ghana Card number ' : f2 === 'tin' ? 'TIN ' : 'SSNIT number ') + c[f2] + ' is already on ' + other.first_name + ' ' + other.last_name + '\'s record.');
      }
      await client.query('UPDATE employees SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $1', values);
      await audit(client, ctx, 'employee.update', 'employee', c.id, 'Set the ' + what.join(', ') + ' of ' + e.first_name + ' ' + e.last_name + ' from a staff sheet.');
      updated++;
    }
    return { updated: updated, unchanged: list.length - updated };
  });
}

module.exports = { preview: preview, apply: apply, _readSheet: readSheet };
