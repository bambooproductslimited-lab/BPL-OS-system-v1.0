var ExcelJS = require('exceljs');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Brings the workshop's work-order sheet into the OS (migration 0136): the
// Google Sheet behind the WO form, downloaded as .xlsx. Its tabs are
// recognised by their column headings, not their names:
//
//   Form Responses  (timestamp, customer name, Description of WO, Quantity,
//                    Project Manager, Team Members, Date Issued …) — the WOs
//   Stage           (Open Date, Est. Due Date, Closed, Status + the form's
//                    columns) — where each WO's status was kept
//   Arc Stage       (Date, Status, Number of workers, Number of days, Who +
//                    the form's columns) — the archive
//
// A row of Stage or Arc Stage is the WO on the form with the same
// timestamp. The sheet's copies of a timestamp can differ by a fraction of
// a second, so they are matched to the nearest second and a half. Names of
// staff are matched to the directory (a first name used by one person
// only, or a name someone has said is them); names that can't be matched
// are kept as written. Every WO keeps the form's timestamp, so importing
// the same workbook again adds nothing twice.
//
// WOs already brought in are brought up to date from the sheet — the
// workshop may still keep it while the OS catches on: status and the date
// it closed, the due and issued dates, the project manager and who
// prepared it. A WO changed in the OS since (its status, or the WO edited,
// or its project manager changed by hand) keeps what the OS has; the
// preview lists both.

var MAX_ROWS = 5000;
var NEAR_MS = 1500;

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if ('error' in v) return '';
    if (Array.isArray(v.richText)) return v.richText.map(function (t) { return t.text; }).join('');
    if ('text' in v) return String(v.text);
    if ('hyperlink' in v) return String(v.hyperlink);
    return '';
  }
  return String(v);
}
function raw(v) { return v && typeof v === 'object' && !(v instanceof Date) && 'result' in v ? v.result : v; }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
// "-", "#REF!", "N/A" and the like say nothing.
function clean(v, max) {
  var s = cellText(raw(v)).replace(/\s+/g, ' ').trim();
  if (/^(-+|#\w+!?|n\/?a|nil|none)$/i.test(s)) return '';
  return max ? s.slice(0, max) : s;
}
// A timestamp: a date cell, or a spreadsheet day number.
function stamp(v) {
  v = raw(v);
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number' && v > 30000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000));
  var s = cellText(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) { var d = new Date(s.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z')); return isNaN(d) ? null : d; }
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +(m[6] || 0)));
  return null;
}
function day(v) {
  var d = stamp(v);
  if (d) return d.toISOString().slice(0, 10);
  var s = cellText(raw(v)).trim(), m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return s;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  return null;
}

// The sheet's statuses (its Ref tab) → the OS's.
var STATUS = {
  'completed': 'completed', 'complete': 'completed', 'done': 'completed', 'closed': 'completed',
  'in process': 'in_progress', 'in progress': 'in_progress', 'ongoing': 'in_progress',
  'cancelled': 'cancelled', 'canceled': 'cancelled',
  'suspended': 'waiting', 'on hold': 'waiting',
  'awaiting mtl': 'awaiting_material', 'awaiting material': 'awaiting_material', 'awaiting materials': 'awaiting_material',
  'awaiting wo': 'discussing', 'discussing': 'discussing'
};
function statusOf(v) { return STATUS[norm(cellText(raw(v)))] || null; }

// ── reading the workbook ───────────────────────────────────────────────

function readSheet(ws) {
  for (var r = 1; r <= Math.min(ws.rowCount, 12); r++) {
    var vals = ws.getRow(r).values || [];
    var heads = {};
    for (var c = 1; c < vals.length; c++) { var t = norm(cellText(vals[c])); if (t && heads[t] === undefined) heads[t] = c; }
    if (heads['description of wo'] === undefined) continue;
    var tsCol = heads.timestamp !== undefined ? heads.timestamp : heads['0'];
    if (tsCol === undefined) continue;
    var kind = heads['number of workers'] !== undefined || (heads.date !== undefined && heads.status !== undefined) ? 'archive'
      : heads['open date'] !== undefined || heads.closed !== undefined || heads.status !== undefined ? 'stage' : 'form';
    var rows = [];
    for (var rr = r + 1; rr <= Math.min(ws.rowCount, r + MAX_ROWS); rr++) {
      var v = ws.getRow(rr).values || [];
      var ts = stamp(v[tsCol]);
      if (!ts) continue;
      var row = { ts: ts };
      Object.keys(heads).forEach(function (h) { row[h] = v[heads[h]]; });
      rows.push(row);
    }
    return { name: ws.name, kind: kind, rows: rows };
  }
  return null;
}

async function loadWorkbook(file) {
  if (!file) fail('invalid', 'Choose the .xlsx file to import.');
  var wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(file.buffer); } catch (e) { fail('invalid', 'That file couldn’t be read as an Excel workbook. In Google Sheets use File → Download → Microsoft Excel (.xlsx).'); }
  var sheets = [];
  wb.eachSheet(function (ws) { var s = readSheet(ws); if (s && s.rows.length) sheets.push(s); });
  if (!sheets.filter(function (s) { return s.kind === 'form' || s.kind === 'stage' || s.kind === 'archive'; }).length) {
    fail('invalid', 'No work orders were found in that workbook — check it has the form’s columns (timestamp, customer name, Description of WO …).');
  }
  return sheets;
}

// One WO as a row of any tab describes it.
function details(row) {
  var title = clean(row['description of wo']);
  return {
    title: title, customer: clean(row['customer name'], 120), so: clean(row['so link'], 40), item: clean(row['item number'], 60),
    quantity: clean(row.quantity, 60), spec: clean(row['specification and link'], 1000), materials: clean(row['material needed'], 1000),
    pm: clean(row['project manager'], 80), team: clean(row['team members'], 300), process: clean(row.process, 1000),
    preparedBy: clean(row['prepared by'], 80), issued: day(row['date issued']) || day(row['open date']),
    due: day(row['estimate date due']) || day(row['est due date']), matQty: clean(row['material quantity'], 200),
    matSpec: clean(row['material specification'], 500), contact: clean(row.contact, 120)
  };
}

// The WOs in the workbook: each form row, with its status, closing date and
// the work it took from Stage / Arc Stage; a Stage or Arc row with no form
// row is a WO of its own.
function merge(sheets) {
  var wos = [];
  function nearest(ts) {
    var best = null, gap = NEAR_MS + 1;
    for (var i = 0; i < wos.length; i++) { var g = Math.abs(wos[i].ts - ts); if (g < gap) { gap = g; best = wos[i]; } }
    return gap <= NEAR_MS ? best : null;
  }
  var order = { form: 0, stage: 1, archive: 2 };
  sheets.slice().sort(function (a, b) { return order[a.kind] - order[b.kind]; }).forEach(function (sh) {
    sh.rows.forEach(function (row) {
      var d = details(row);
      var w = nearest(row.ts);
      if (!w) {
        if (!d.title) return;
        w = { ts: row.ts, d: d, stage: null, archive: null };
        wos.push(w);
      } else {
        Object.keys(d).forEach(function (k) { if (!w.d[k] && d[k]) w.d[k] = d[k]; });
      }
      if (sh.kind === 'stage' && !w.stage) w.stage = { status: statusOf(row.status), closed: day(row.closed) };
      if (sh.kind === 'archive' && !w.archive) {
        w.archive = {
          status: statusOf(row.status), closed: day(row.date),
          workers: Number(cellText(raw(row['number of workers']))) || null, days: Number(cellText(raw(row['number of days']))) || null,
          who: clean(row.who, 300)
        };
      }
    });
  });
  return wos.sort(function (a, b) { return a.ts - b.ts; }).map(finish);
}
function finish(w) {
  var s = w.stage || {}, a = w.archive || {};
  // The working tab (Stage) speaks for the WO; the archive only when Stage
  // says nothing, or says open while the archive has it closed.
  var closed = ['completed', 'cancelled'];
  var from = s.status && (closed.indexOf(s.status) >= 0 || closed.indexOf(a.status) < 0) ? s : a.status ? a : s;
  var status = from.status || (from.closed ? 'completed' : 'not_started');
  var issued = w.d.issued || w.ts.toISOString().slice(0, 10);
  var team = splitNames(w.d.team);
  splitNames(a.who).forEach(function (n) { if (!team.some(function (t) { return norm(t) === norm(n); })) team.push(n); });
  return {
    ts: w.ts, d: w.d, status: status, saysStatus: !!(from.status || from.closed), issued: issued, due: w.d.due,
    closed: status === 'completed' || status === 'cancelled' ? (from.closed || s.closed || a.closed || w.d.due || issued) : null,
    workers: a.workers || null, workDays: a.days || null, team: team
  };
}
function splitNames(s) {
  return String(s || '').split(/\s*(?:,|&|\band\b|\/|;|\+)\s*/i).map(function (x) { return x.replace(/^\s*(mr|mrs|ms|miss|dr)\.?\s+/i, '').trim(); }).filter(Boolean);
}

// ── matching names ─────────────────────────────────────────────────────

function nameKey(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

// "Isreal" for "Israel": the same letters, two side by side swapped — how a
// name is most often misspelled. A first name that one person has while
// someone else has it misspelled is not taken for either: the person
// importing says who it is, once.
function swapped(a, b) {
  if (a.length !== b.length || a.length < 4 || a === b) return false;
  var i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

async function staffMatcher(extraAliases) {
  var emps = (await pool.query("SELECT id, first_name, last_name FROM employees WHERE status <> 'terminated'")).rows;
  var aliases = {};
  (await pool.query('SELECT name_key, employee_id FROM crm_name_aliases')).rows.forEach(function (r) { aliases[r.name_key] = r.employee_id; });
  Object.keys(extraAliases || {}).forEach(function (k) { aliases[nameKey(k)] = extraAliases[k]; });
  var byId = {};
  emps.forEach(function (e) { byId[e.id] = e; });
  var match = function (name) {
    var alias = aliases[nameKey(name)];
    if (alias && byId[alias]) return alias;
    var n = norm(name);
    if (!n) return null;
    var full = emps.filter(function (e) { return norm(e.first_name + ' ' + e.last_name) === n; });
    if (full.length === 1) return full[0].id;
    var first = emps.filter(function (e) { return norm(e.first_name) === n || norm(e.first_name).split(' ')[0] === n; });
    var lookAlike = emps.some(function (e) { return first.indexOf(e) < 0 && swapped(norm(e.first_name).split(' ')[0], n); });
    if (first.length === 1 && !lookAlike) return first[0].id;
    if (first.length || lookAlike) return null;
    var last = emps.filter(function (e) { return norm(e.last_name) === n; });
    return last.length === 1 ? last[0].id : null;
  };
  match.couldBe = function (name) {
    var n = norm(name);
    if (!n) return [];
    var w = n.split(' ')[0];
    return emps.filter(function (e) { var f = norm(e.first_name).split(' ')[0]; return f === w || swapped(f, w); })
      .slice(0, 6).map(function (e) { return { id: e.id, name: (e.first_name + ' ' + e.last_name).trim() }; });
  };
  return match;
}

// Who a WO is for: one of our companies ("BPL", "poki", "Star bar",
// "Bamboo garden 2"), a customer with exactly that name, or the name as
// written.
async function forMatcher() {
  var companies = (await pool.query('SELECT id, code, name FROM companies')).rows;
  var customers = (await pool.query('SELECT id, name FROM customers')).rows;
  var byName = {};
  customers.forEach(function (c) { var k = norm(c.name); byName[k] = byName[k] === undefined ? c : null; });
  return function (name) {
    var n = norm(name);
    if (!n) return null;
    for (var i = 0; i < companies.length; i++) {
      var co = companies[i], cn = norm(co.name), cc = norm(co.code);
      if (n === cc || n === cn || n.indexOf(cn + ' ') === 0 || (n.split(' ').length >= 2 && cn.indexOf(n + ' ') === 0)) return { companyId: co.id, label: co.name };
    }
    var cu = byName[n];
    return cu ? { customerId: cu.id, label: cu.name } : null;
  };
}

// ── preview and run ────────────────────────────────────────────────────

function need(ctx) {
  if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).');
}

async function plan(file, aliases) {
  var sheets = await loadWorkbook(file);
  var wos = merge(sheets);
  var stamps = (await pool.query('SELECT sheet_stamp FROM tasks WHERE sheet_stamp IS NOT NULL')).rows.map(function (r) { return new Date(r.sheet_stamp).getTime(); }).sort(function (a, b) { return a - b; });
  function already(ts) {
    var t = ts.getTime(), lo = 0, hi = stamps.length - 1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (Math.abs(stamps[mid] - t) <= NEAR_MS) return true; if (stamps[mid] < t) lo = mid + 1; else hi = mid - 1; }
    return false;
  }
  var matchStaff = await staffMatcher(aliases);
  var matchFor = await forMatcher();
  var fresh = wos.filter(function (w) { return !already(w.ts); });
  var known = await updates(wos.filter(function (w) { return already(w.ts); }), matchStaff);
  return { sheets: sheets, wos: wos, fresh: fresh, updates: known.updates, kept: known.kept, matchStaff: matchStaff, matchFor: matchFor, firstImport: stamps.length === 0 };
}

// ── WOs already in the OS: what changed on the sheet since ─────────────
function dayOf(v) { return v ? new Date(v).toISOString().slice(0, 10) : null; }
async function updates(sheetWos, matchStaff) {
  if (!sheetWos.length) return { updates: [], kept: [] };
  var rows = (await pool.query(
    'SELECT id, wo_no, title, status, completed_at, cancelled_at, due_date::text AS due, issued_on::text AS issued, project_manager_id, pm_name, created_by, prepared_by_name, sheet_stamp ' +
    'FROM tasks WHERE sheet_stamp IS NOT NULL ORDER BY sheet_stamp')).rows;
  var times = rows.map(function (r) { return new Date(r.sheet_stamp).getTime(); });
  function find(ts) {
    var t = ts.getTime(), lo = 0, hi = rows.length - 1, best = null, gap = NEAR_MS + 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, g = Math.abs(times[mid] - t);
      if (g < gap) { gap = g; best = rows[mid]; }
      if (times[mid] < t) lo = mid + 1; else hi = mid - 1;
    }
    return gap <= NEAR_MS ? best : null;
  }
  // What was changed in the OS since: the status, the project manager by
  // hand, or the WO edited (which may have changed anything).
  var edited = {};
  (await pool.query("SELECT entity_id, action, summary FROM audit_logs WHERE entity = 'task' AND action IN ('task.status', 'task.update') AND entity_id = ANY($1)",
    [rows.map(function (r) { return String(r.id); })])).rows.forEach(function (a) {
    var e = edited[a.entity_id] = edited[a.entity_id] || { status: false, pm: false, other: false };
    if (a.action === 'task.status') e.status = true;
    else if (/^Project manager of /.test(a.summary || '')) e.pm = true;
    else { e.other = true; e.pm = true; }
  });
  var out = [], kept = [];
  sheetWos.forEach(function (w) {
    var t = find(w.ts);
    if (!t) return;
    var e = edited[String(t.id)] || { status: false, pm: false, other: false };
    var ch = {}, keep = [];
    if (w.saysStatus && w.status !== t.status) {
      if (e.status || e.other) keep.push('status'); else ch.status = w.status;
    } else if (w.saysStatus && w.closed && (t.status === 'completed' || t.status === 'cancelled')) {
      var was = dayOf(t.status === 'completed' ? t.completed_at : t.cancelled_at);
      if (was !== w.closed) { if (e.status || e.other) keep.push('closed'); else ch.closed = w.closed; }
    }
    if (w.due && w.due !== t.due) { if (e.other) keep.push('due'); else ch.due = w.due; }
    if (w.issued && w.issued !== t.issued) { if (e.other) keep.push('issued'); else ch.issued = w.issued; }
    var pmId = w.d.pm ? matchStaff(w.d.pm) : null;
    if (pmId && pmId !== t.project_manager_id) { if (e.pm) keep.push('pm'); else ch.pm = pmId; }
    var prepId = w.d.preparedBy ? matchStaff(w.d.preparedBy) : null;
    if (prepId && prepId !== t.created_by) { if (e.other) keep.push('prepared'); else ch.prepared = prepId; }
    if (Object.keys(ch).length) out.push({ w: w, t: t, ch: ch });
    if (keep.length) kept.push({ w: w, t: t, keep: keep });
  });
  return { updates: out, kept: kept };
}

async function summary(p) {
  var byStatus = {}, forNames = {}, names = {};
  function note(name, role) {
    if (!name) return;
    var k = nameKey(name);
    names[k] = names[k] || { name: name, roles: [], n: 0, employeeId: p.matchStaff(name) };
    names[k].n++;
    if (names[k].roles.indexOf(role) < 0) names[k].roles.push(role);
  }
  p.fresh.forEach(function (w) {
    byStatus[w.status] = (byStatus[w.status] || 0) + 1;
    var f = w.d.customer || '';
    var fk = norm(f) || '';
    forNames[fk] = forNames[fk] || { name: f, n: 0, match: p.matchFor(f) };
    forNames[fk].n++;
  });
  // The names on the whole sheet (a name says who it is on the WOs already
  // in the OS too, which are brought up to date with it).
  p.wos.forEach(function (w) {
    note(w.d.pm, 'pm');
    w.team.forEach(function (n) { note(n, 'team'); });
    note(w.d.preparedBy, 'prepared');
  });
  var people = Object.keys(names).map(function (k) { return names[k]; });
  var ids = people.map(function (x) { return x.employeeId; }).filter(Boolean);
  p.updates.forEach(function (u) { [u.t.project_manager_id, u.ch.pm, u.t.created_by, u.ch.prepared].forEach(function (x) { if (x) ids.push(x); }); });
  var emps = {};
  if (ids.length) (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ANY($1)', [ids])).rows.forEach(function (e) { emps[e.id] = e.first_name + ' ' + e.last_name; });
  var days = p.fresh.map(function (w) { return w.issued; }).sort();
  function who(id, written) { return id ? emps[id] || '—' : written || '—'; }
  var toStatus = {}, pmMoves = {}, prepared = 0, dates = 0;
  p.updates.forEach(function (u) {
    if (u.ch.status) toStatus[u.ch.status] = (toStatus[u.ch.status] || 0) + 1;
    if (u.ch.pm) { var k = who(u.t.project_manager_id, u.t.pm_name) + '→' + who(u.ch.pm); pmMoves[k] = (pmMoves[k] || 0) + 1; }
    if (u.ch.prepared) prepared++;
    if (u.ch.due || u.ch.issued || u.ch.closed) dates++;
  });
  function woNo(n) { return 'WO-' + String(n).padStart(4, '0'); }
  var CHANGE = { status: 1, closed: 2, due: 3, issued: 4, pm: 5, prepared: 6 };
  return {
    tabs: p.sheets.map(function (s) { return { name: s.name, kind: s.kind, rows: s.rows.length }; }),
    found: p.wos.length, already: p.wos.length - p.fresh.length, toAdd: p.fresh.length,
    from: days[0] || null, to: days[days.length - 1] || null, byStatus: byStatus, renumber: p.firstImport && p.fresh.length > 0,
    requestedFor: Object.keys(forNames).map(function (k) { var x = forNames[k]; return { name: x.name, n: x.n, matched: x.match ? x.match.label : null }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 40),
    people: people.map(function (x) {
      return { name: x.name, n: x.n, roles: x.roles, employeeId: x.employeeId, employeeName: x.employeeId ? emps[x.employeeId] : null, couldBe: x.employeeId ? [] : p.matchStaff.couldBe(x.name) };
    }).sort(function (a, b) { return (a.employeeId ? 1 : 0) - (b.employeeId ? 1 : 0) || b.n - a.n; }),
    // WOs already in the OS that the sheet brings up to date.
    updates: {
      total: p.updates.length, toStatus: toStatus, prepared: prepared, dates: dates,
      pm: Object.keys(pmMoves).map(function (k) { var x = k.split('→'); return { from: x[0], to: x[1], n: pmMoves[k] }; }).sort(function (a, b) { return b.n - a.n; }),
      list: p.updates.slice().sort(function (a, b) { return b.t.wo_no - a.t.wo_no; }).slice(0, 60).map(function (u) {
        return {
          woNo: woNo(u.t.wo_no), title: u.t.title,
          changes: Object.keys(u.ch).sort(function (a, b) { return CHANGE[a] - CHANGE[b]; }).map(function (k) {
            if (k === 'status') return { what: 'status', from: u.t.status, to: u.ch.status };
            if (k === 'closed') return { what: 'closed', from: dayOf(u.t.status === 'completed' ? u.t.completed_at : u.t.cancelled_at), to: u.ch.closed };
            if (k === 'due') return { what: 'due', from: u.t.due, to: u.ch.due };
            if (k === 'issued') return { what: 'issued', from: u.t.issued, to: u.ch.issued };
            if (k === 'pm') return { what: 'pm', from: who(u.t.project_manager_id, u.t.pm_name), to: who(u.ch.pm) };
            return { what: 'prepared', from: who(u.t.created_by, u.t.prepared_by_name), to: who(u.ch.prepared) };
          })
        };
      }),
      kept: p.kept.length,
      keptList: p.kept.slice(0, 20).map(function (k) { return { woNo: woNo(k.t.wo_no), title: k.t.title, what: k.keep }; })
    }
  };
}

// Names the person importing has said are these staff members: { "Capi": employeeId }.
async function readAliases(raw) {
  var out = {};
  if (!raw) return out;
  var given;
  try { given = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { fail('invalid', 'The names given could not be read.'); }
  var ids = Object.keys(given || {}).map(function (k) { return given[k]; }).filter(Boolean);
  if (ids.some(function (id) { return !/^[0-9a-f-]{36}$/i.test(String(id)); })) fail('invalid', 'A staff member picked was not found.');
  var found = ids.length ? (await pool.query('SELECT id FROM employees WHERE id = ANY($1)', [ids])).rows.map(function (r) { return r.id; }) : [];
  Object.keys(given || {}).forEach(function (k) {
    if (!given[k]) return;
    if (found.indexOf(given[k]) < 0) fail('invalid', 'A staff member picked was not found.');
    if (nameKey(k)) out[nameKey(k)] = given[k];
  });
  return out;
}

async function preview(ctx, file, body) {
  need(ctx);
  return summary(await plan(file, await readAliases(body && body.aliases)));
}

async function run(ctx, file, body) {
  need(ctx);
  var aliases = await readAliases(body && body.aliases);
  var p = await plan(file, aliases);
  var s = await summary(p);
  var meId = ctx.employee.id;

  var added = await withTransaction(async function (db) {
    // One import at a time, and nobody adds a WO while the numbers are given out.
    await db.query('LOCK TABLE tasks IN SHARE ROW EXCLUSIVE MODE');
    var again = (await db.query('SELECT sheet_stamp FROM tasks WHERE sheet_stamp IS NOT NULL')).rows.map(function (r) { return new Date(r.sheet_stamp).getTime(); });
    var fresh = p.fresh.filter(function (w) { return !again.some(function (t) { return Math.abs(t - w.ts.getTime()) <= NEAR_MS; }); });

    for (var k in aliases) {
      await db.query('INSERT INTO crm_name_aliases (name_key, employee_id, created_by) VALUES ($1, $2, $3) ON CONFLICT (name_key) DO UPDATE SET employee_id = EXCLUDED.employee_id', [k, aliases[k], meId]);
    }
    var n = 0;
    for (var i = 0; i < fresh.length; i++) {
      var w = fresh[i], d = w.d;
      var forWho = p.matchFor(d.customer) || {};
      var pmId = d.pm ? p.matchStaff(d.pm) : null;
      var prepId = d.preparedBy ? p.matchStaff(d.preparedBy) : null;
      var teamIds = [], teamLeft = [];
      w.team.forEach(function (name) {
        var id = p.matchStaff(name);
        if (id && teamIds.indexOf(id) < 0) teamIds.push(id);
        else if (!id) teamLeft.push(name);
      });
      var title = d.title.length > 200 ? d.title.slice(0, 197) + '…' : d.title;
      var closedAt = w.closed ? w.closed + 'T12:00:00Z' : null;
      var r = (await db.query(
        'INSERT INTO tasks (title, description, priority, status, created_by, created_at, issued_on, due_date, completed_at, cancelled_at, ' +
        'for_company_id, customer_id, customer_name, contact, so_ref, item_code, quantity, specification, materials, material_quantity, material_spec, process, ' +
        'project_manager_id, pm_name, team_names, prepared_by_name, workers, work_days, sheet_stamp) ' +
        "VALUES ($1,$2,'medium',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$5) RETURNING id",
        [title || '(no description)', d.title.length > 200 ? d.title : '', w.status, prepId || meId, w.ts.toISOString(), w.issued, w.due,
          w.status === 'completed' ? closedAt : null, w.status === 'cancelled' ? closedAt : null,
          forWho.companyId || null, forWho.customerId || null, forWho.companyId || forWho.customerId ? '' : d.customer, d.contact, d.so, d.item,
          d.quantity, d.spec, d.materials, d.matQty, d.matSpec, d.process,
          pmId, pmId ? '' : d.pm, teamLeft.join(', '), prepId ? '' : d.preparedBy,
          w.workers && w.workers <= 500 ? Math.round(w.workers) : null, w.workDays && w.workDays <= 3650 ? w.workDays : null]
      )).rows[0];
      for (var j = 0; j < teamIds.length; j++) await db.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1,$2)', [r.id, teamIds[j]]);
      n++;
    }
    // The first time, every WO is numbered in date order, oldest first, so
    // the sheet's history reads WO-0001, WO-0002 …
    if (p.firstImport && n) {
      await db.query('SET CONSTRAINTS tasks_wo_no_key DEFERRED');
      await db.query('UPDATE tasks t SET wo_no = x.n FROM (SELECT id, row_number() OVER (ORDER BY created_at, wo_no) AS n FROM tasks) x WHERE x.id = t.id AND t.wo_no <> x.n');
    }
    await db.query("SELECT setval('tasks_wo_no_seq', greatest(coalesce((SELECT max(wo_no) FROM tasks), 0), 1), (SELECT count(*) > 0 FROM tasks))");

    // The WOs already in the OS, brought up to date with the sheet.
    var updated = 0, gained = {};
    if (!body || String(body.update) !== '0') {
      for (var u = 0; u < p.updates.length; u++) {
        var up = p.updates[u], c = up.ch, sets = [], vals = [], said = [];
        var set = function (col, v) { vals.push(v); sets.push(col + ' = $' + vals.length); };
        var closedAt = up.w.closed ? up.w.closed + 'T12:00:00Z' : null;
        if (c.status) {
          set('status', c.status);
          set('completed_at', c.status === 'completed' ? closedAt : null);
          set('cancelled_at', c.status === 'cancelled' ? closedAt : null);
          said.push('status ' + c.status.replace(/_/g, ' '));
        } else if (c.closed) {
          set(up.t.status === 'completed' ? 'completed_at' : 'cancelled_at', closedAt);
          said.push('closed on ' + c.closed);
        }
        if (c.due) { set('due_date', c.due); said.push('due ' + c.due); }
        if (c.issued) { set('issued_on', c.issued); said.push('issued ' + c.issued); }
        if (c.pm) { set('project_manager_id', c.pm); set('pm_name', ''); said.push('project manager'); gained[c.pm] = (gained[c.pm] || []).concat([up.t]); }
        if (c.prepared) { set('created_by', c.prepared); set('prepared_by_name', ''); said.push('prepared by'); }
        vals.push(up.t.id);
        await db.query('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = $' + vals.length, vals);
        await audit(db, ctx, 'task.sheet', 'task', up.t.id, 'Brought ' + 'WO-' + String(up.t.wo_no).padStart(4, '0') + ' up to date from the sheet: ' + said.join(', ') + '.');
        updated++;
      }
      // Each new project manager is told once.
      for (var pmKey in gained) {
        var list = gained[pmKey];
        if (pmKey === meId) continue;
        await notify(db, pmKey, list.length === 1 ? 'You manage WO-' + String(list[0].wo_no).padStart(4, '0') : 'You manage ' + list.length + ' more work orders',
          list.length === 1 ? 'From the work-order sheet: you are its project manager.' : 'From the work-order sheet: you are their project manager.', list.length === 1 ? 'tasks:' + list[0].id : 'tasks');
      }
    }
    await audit(db, ctx, 'task.import', 'task', 'sheet', 'Imported ' + n + ' work orders from the sheet' + (updated ? ', and brought ' + updated + ' up to date' : '') + '.');
    return { n: n, updated: updated };
  });
  return Object.assign(s, { added: added.n, updated: added.updated });
}

module.exports = { preview: preview, run: run, _merge: merge, _statusOf: statusOf };
