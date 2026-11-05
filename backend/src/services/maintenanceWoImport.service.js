var crypto = require('crypto');
var ExcelJS = require('exceljs');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var mwo = require('./maintenanceWorkOrders.service');
var { staffMatcher, readAliases } = require('./workOrderImport.service');

// Brings the maintenance team's Google Sheet, the IT work order tracker,
// into the OS (migration 0214), downloaded as .xlsx. Its tabs are known by
// their column headings, not their names:
//
//   WO Data   (Work Order ID, Request Date, Requested By, Location,
//              Category, Description, Priority, Status, Assigned To,
//              Scheduled Date, Completed Date, Estimated Cost, Actual
//              Cost, Notes) — the work orders
//   RT Data   (Index, Routine Name, Location, RT Scheduled, Description,
//              who, Frequency (days), Last Completion Date, Notes,
//              Links) — the routines
//   Arc RT …  the same headings, on a tab whose name starts "Arc" — put
//              away routines
//
// The sheet's other tabs (Incomplete, Last 7, Billing, Dashboard, RT
// Report) are worked out from these, and the OS works them out itself.
//
// Each row is known again by its number, its day and its words, so
// importing the same workbook twice adds nothing twice. A row already
// brought in is brought up to date from the sheet (the team may keep the
// sheet a while) unless it was changed in the OS since — then the OS keeps
// what it has. Names are matched to the directory (a first name used by
// one person only, or a misspelling of one); names that can't be matched
// are kept as written, unless the person importing says who they are —
// remembered for next time. A place that is one of our companies (BPL, Star
// Bar, Poki, BG) is tied to it.

var MAX_ROWS = 5000;

function raw(v) { return v && typeof v === 'object' && !(v instanceof Date) && 'result' in v ? v.result : v; }
function cellText(v) {
  v = raw(v);
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    if ('error' in v) return '';
    if (Array.isArray(v.richText)) return v.richText.map(function (t) { return t.text; }).join('');
    if ('text' in v) return String(v.text);
    if ('hyperlink' in v) return String(v.hyperlink);
    return '';
  }
  return String(v);
}
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function clean(v, max) {
  var s = cellText(v).replace(/[ \t]+/g, ' ').trim();
  if (/^(-+|#\w+!?|n\/?a)$/i.test(s)) return '';
  return max ? s.slice(0, max) : s;
}
function day(v) {
  v = raw(v);
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 30000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  var s = cellText(v).trim(), m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return m[1] + '-' + m[2] + '-' + m[3];
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  return null;
}
// An amount, and its currency from the cell's own format ("$#,##0.00").
function amount(cell) {
  if (!cell) return null;
  var v = raw(cell.value);
  var s = typeof v === 'number' ? String(v) : cellText(v);
  var n = Number(String(s).replace(/[^0-9.\-]/g, ''));
  if (s.trim() === '' || !isFinite(n) || n < 0) return null;
  var fmt = (cell.numFmt || '') + ' ' + (typeof v === 'string' ? v : '');
  var currency = /\$/.test(fmt) ? 'USD' : /€/.test(fmt) ? 'EUR' : /£/.test(fmt) ? 'GBP' : /¥|CNY|RMB/.test(fmt) ? 'CNY' : null;
  return { value: Math.round(n * 100) / 100, currency: currency };
}

var CATEGORY = { electrical: 'electrical', electric: 'electrical', plumbing: 'plumbing', hvac: 'hvac', 'a c': 'hvac', ac: 'hvac', facilities: 'facilities', facility: 'facilities', it: 'it', mason: 'mason', masonry: 'mason', other: 'other' };
var PRIORITY = { low: 'low', medium: 'medium', high: 'high', urgent: 'urgent' };
var STATUS = { new: 'new', scheduled: 'scheduled', 'in progress': 'in_progress', 'in process': 'in_progress', 'on hold': 'on_hold', hold: 'on_hold', completed: 'completed', complete: 'completed', done: 'completed', cancelled: 'cancelled', canceled: 'cancelled' };
function categoryOf(v) { return CATEGORY[norm(cellText(v))] || 'other'; }
function priorityOf(v) { return PRIORITY[norm(cellText(v))] || 'medium'; }
function statusOf(v) { return STATUS[norm(cellText(v))] || null; }

function key(parts) { return crypto.createHash('sha1').update(parts.map(norm).join('|')).digest('hex').slice(0, 32); }

// ── reading the workbook ───────────────────────────────────────────────

function headsOf(ws, r) {
  var vals = ws.getRow(r).values || [];
  var heads = {};
  for (var c = 1; c < vals.length; c++) { var t = norm(cellText(vals[c])); if (t && heads[t] === undefined) heads[t] = c; }
  return heads;
}
function col(heads, names) { for (var i = 0; i < names.length; i++) if (heads[names[i]] !== undefined) return heads[names[i]]; return undefined; }

function readSheet(ws) {
  for (var r = 1; r <= Math.min(ws.rowCount, 12); r++) {
    var heads = headsOf(ws, r);
    var isWo = heads['work order id'] !== undefined && heads.description !== undefined;
    var isRt = heads['routine name'] !== undefined;
    if (!isWo && !isRt) continue;
    var c = function (names) { return col(heads, names); };
    var cols = isWo ? {
      ref: c(['work order id']), asked: c(['request date']), askedBy: c(['requested by']), location: c(['location']), category: c(['category']),
      description: c(['description']), priority: c(['priority']), status: c(['status']), assigned: c(['assigned to']), scheduled: c(['scheduled date']),
      completed: c(['completed date']), est: c(['estimated cost']), actual: c(['actual cost']), notes: c(['notes'])
    } : {
      ref: c(['index']), name: c(['routine name']), location: c(['location']), when: c(['rt scheduled']), description: c(['description']),
      who: c(['who', 'assigned to']), every: c(['frequency days', 'frequency']), next: c(['next scheduled date']), last: c(['last completion date']),
      notes: c(['notes comments', 'notes']), link: c(['links', 'link'])
    };
    var rows = [];
    for (var rr = r + 1; rr <= Math.min(ws.rowCount, r + MAX_ROWS); rr++) {
      var row = ws.getRow(rr);
      var get = function (k) { return cols[k] === undefined ? null : row.getCell(cols[k]).value; };
      var cell = function (k) { return cols[k] === undefined ? null : row.getCell(cols[k]); };
      if (isWo) {
        var description = clean(get('description'), 2000);
        if (!description) continue;
        rows.push({
          line: rr, ref: clean(get('ref'), 20), requestedOn: day(get('asked')), requestedBy: clean(get('askedBy'), 80), location: clean(get('location'), 80),
          category: categoryOf(get('category')), description: description, priority: priorityOf(get('priority')), status: statusOf(get('status')),
          assignedTo: clean(get('assigned'), 80), scheduledOn: day(get('scheduled')), completedOn: day(get('completed')),
          est: amount(cell('est')), actual: amount(cell('actual')), notes: clean(get('notes'), 2000)
        });
      } else {
        var name = clean(get('name'), 120), desc = clean(get('description'), 1000);
        if (!name && !desc) continue;
        var every = Number(clean(get('every')));
        rows.push({
          line: rr, ref: clean(get('ref'), 20), name: name || desc.slice(0, 120), description: name ? desc : '', location: clean(get('location'), 80),
          scheduleNote: clean(get('when'), 80), who: clean(get('who'), 80), everyDays: Number.isInteger(every) && every >= 1 && every <= 3660 ? every : null,
          nextOn: day(get('next')), lastDoneOn: day(get('last')), notes: clean(get('notes'), 1000), link: clean(get('link'), 500)
        });
      }
    }
    return { name: ws.name, kind: isWo ? 'orders' : /^arc\b/i.test(ws.name.trim()) ? 'archived' : 'routines', rows: rows };
  }
  return null;
}

async function loadWorkbook(file) {
  if (!file) fail('invalid', 'Choose the .xlsx file to import.');
  var wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(file.buffer); } catch (e) { fail('invalid', 'That file couldn’t be read as an Excel workbook. In Google Sheets use File → Download → Microsoft Excel (.xlsx).'); }
  var sheets = [];
  wb.eachSheet(function (ws) { var s = readSheet(ws); if (s && s.rows.length) sheets.push(s); });
  if (!sheets.some(function (s) { return s.kind === 'orders'; }) && !sheets.some(function (s) { return s.kind !== 'orders'; })) {
    fail('invalid', 'No work orders found: the sheet needs a tab with the columns Work Order ID and Description (the WO Data tab), or Routine Name (RT Data).');
  }
  return sheets;
}

// ── what the sheet holds, against what the OS has ──────────────────────

function orderKey(o) { return 'wo:' + key([o.ref, o.requestedOn || '', o.description.slice(0, 120)]); }
function routineKey(r) { return 'rt:' + key([r.ref, r.name, r.description.slice(0, 120)]); }

// What an order or routine from the sheet sets, in the OS's columns.
function orderFields(o, people, places) {
  var asker = people(o.requestedBy), doer = people(o.assignedTo);
  var status = o.status || (o.completedOn ? 'completed' : o.scheduledOn ? 'scheduled' : 'new');
  var completedOn = status === 'completed' ? (o.completedOn || o.scheduledOn || o.requestedOn) : null;
  var cur = (o.actual && o.actual.currency) || (o.est && o.est.currency) || 'GHS';
  return {
    ref: o.ref, requested_on: o.requestedOn || completedOn || o.scheduledOn, requested_by_id: asker, requested_by_name: asker ? '' : o.requestedBy,
    location: o.location, company_id: places(o.location), category: o.category, description: o.description, priority: o.priority, status: status,
    assigned_to_id: doer, assigned_to_name: doer ? '' : o.assignedTo, scheduled_on: o.scheduledOn, completed_on: completedOn,
    currency: cur, estimated_cost: o.est ? o.est.value : null, actual_cost: o.actual ? o.actual.value : null, notes: o.notes
  };
}
function routineFields(r, people, places, archived) {
  var doer = people(r.who);
  return {
    ref: r.ref, name: r.name, description: r.description, location: r.location, company_id: places(r.location), schedule_note: r.scheduleNote,
    assigned_to_id: doer, assigned_to_name: doer ? '' : r.who, every_days: r.everyDays, last_done_on: r.lastDoneOn,
    next_on: r.nextOn || (r.everyDays && r.lastDoneOn ? addDays(r.lastDoneOn, r.everyDays) : null),
    notes: r.notes, link: r.link, archived: archived
  };
}
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function same(a, b) {
  if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}
function dayStr(v) { return v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null; }

var ORDER_COLS = ['ref', 'requested_on', 'requested_by_id', 'requested_by_name', 'location', 'company_id', 'category', 'description', 'priority', 'status',
  'assigned_to_id', 'assigned_to_name', 'scheduled_on', 'completed_on', 'currency', 'estimated_cost', 'actual_cost', 'notes'];
var ROUTINE_COLS = ['ref', 'name', 'description', 'location', 'company_id', 'schedule_note', 'assigned_to_id', 'assigned_to_name', 'every_days', 'last_done_on', 'next_on', 'notes', 'link'];
var DATE_COLS = { requested_on: 1, scheduled_on: 1, completed_on: 1, last_done_on: 1, next_on: 1 };

function differs(row, f, cols) {
  return cols.filter(function (c) { return !same(DATE_COLS[c] ? dayStr(row[c]) : row[c], f[c]); });
}

async function plan(file, aliases) {
  var sheets = await loadWorkbook(file);
  var people = await staffMatcher(aliases);
  var places = await mwo.companyMatcher();
  var names = {};
  function who(n) {
    if (!n) return null;
    var id = people(n);
    var k = norm(n);
    if (!names[k]) names[k] = { name: n, matched: !!id, id: id || null, couldBe: id ? [] : people.couldBe(n) };
    return id;
  }

  var existingOrders = {};
  (await pool.query('SELECT * FROM maint_work_orders WHERE sheet_key IS NOT NULL')).rows.forEach(function (r) { existingOrders[r.sheet_key] = r; });
  var existingRoutines = {};
  (await pool.query('SELECT * FROM maint_routines WHERE sheet_key IS NOT NULL')).rows.forEach(function (r) { existingRoutines[r.sheet_key] = r; });

  var out = { orders: { add: [], update: [], same: 0, kept: [] }, routines: { add: [], update: [], same: 0, kept: [] }, seen: {} };
  function sort(kind, item, existing, cols) {
    var bucket = out[kind];
    if (out.seen[item.key]) return; // the same row twice on the sheet
    out.seen[item.key] = true;
    if (!existing) { bucket.add.push(item); return; }
    var changed = differs(existing, item.fields, cols);
    if (kind === 'routines' && !!existing.archived_at !== item.fields.archived) changed.push('archived');
    if (!changed.length) { bucket.same++; return; }
    // Changed in the OS since the sheet last brought it up to date (a job
    // moved along, a routine marked done): the OS keeps what it has.
    var editedInOs = existing.sheet_synced_at && new Date(existing.updated_at).getTime() > new Date(existing.sheet_synced_at).getTime() + 2000;
    if (editedInOs) { bucket.kept.push({ item: item, existing: existing, changed: changed }); return; }
    bucket.update.push({ item: item, existing: existing, changed: changed });
  }
  sheets.forEach(function (s) {
    s.rows.forEach(function (row) {
      if (s.kind === 'orders') {
        var f = orderFields(row, who, places);
        if (!f.requested_on) return;
        var k = orderKey(row);
        sort('orders', { key: k, row: row, fields: f, sheet: s.name }, existingOrders[k], ORDER_COLS);
      } else {
        var rf = routineFields(row, who, places, s.kind === 'archived');
        var rk = routineKey(row);
        sort('routines', { key: rk, row: row, fields: rf, sheet: s.name }, existingRoutines[rk], ROUTINE_COLS);
      }
    });
  });
  out.sheets = sheets.map(function (s) { return { name: s.name, kind: s.kind, rows: s.rows.length }; });
  out.names = Object.keys(names).map(function (k) { return names[k]; });
  out.places = places;
  return out;
}

function need(ctx) { if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).'); }

function brief(item) {
  var f = item.fields;
  return item.row.name === undefined
    ? { ref: f.ref, day: f.requested_on, location: f.location, description: f.description.slice(0, 140), status: f.status, assignedTo: f.assigned_to_name || (f.assigned_to_id ? '✓' : '') }
    : { ref: f.ref, name: f.name, description: f.description.slice(0, 140), everyDays: f.every_days, nextOn: f.next_on, archived: f.archived };
}

// POST /api/maint-work-orders/import/preview — what importing would do.
async function preview(ctx, file, body) {
  need(ctx);
  var p = await plan(file, await readAliases(body && body.aliases));
  var count = function (b) { return { add: b.add.length, update: b.update.length, same: b.same, kept: b.kept.length }; };
  var o = p.orders.add.map(function (i) { return i.fields; });
  return {
    sheets: p.sheets,
    orders: count(p.orders), routines: count(p.routines),
    byStatus: o.reduce(function (acc, f) { acc[f.status] = (acc[f.status] || 0) + 1; return acc; }, {}),
    samples: { orders: p.orders.add.slice(0, 6).map(brief), routines: p.routines.add.slice(0, 6).map(brief) },
    updates: p.orders.update.slice(0, 20).map(function (u) { return { ref: u.existing.ref, description: u.existing.description.slice(0, 100), changed: u.changed }; }),
    kept: p.orders.kept.slice(0, 20).map(function (u) { return { ref: u.existing.ref, description: u.existing.description.slice(0, 100), changed: u.changed }; }),
    names: p.names.map(function (n) { return { name: n.name, matched: n.matched, employeeId: n.id, couldBe: n.couldBe }; }),
    places: Array.from(new Set(o.map(function (f) { return f.location; }).filter(Boolean))).map(function (l) { return { location: l, ours: !!p.places(l) }; })
  };
}

// POST /api/maint-work-orders/import — bring it in.
async function run(ctx, file, body) {
  need(ctx);
  var aliases = await readAliases(body && body.aliases);
  var p = await plan(file, aliases);
  return withTransaction(async function (client) {
    var now = new Date();
    for (var nk in aliases) {
      await client.query('INSERT INTO crm_name_aliases (name_key, employee_id, created_by) VALUES ($1, $2, $3) ON CONFLICT (name_key) DO UPDATE SET employee_id = EXCLUDED.employee_id',
        [nk, aliases[nk], ctx.employee.id]);
    }
    for (var i = 0; i < p.routines.add.length; i++) {
      var r = p.routines.add[i], rf = r.fields;
      var cols = ROUTINE_COLS.concat(['archived_at', 'sheet_key', 'sheet_synced_at', 'created_by', 'updated_at']);
      var vals = ROUTINE_COLS.map(function (c) { return rf[c]; }).concat([rf.archived ? now : null, r.key, now, ctx.employee.id, now]);
      if (!rf.ref) { cols.splice(0, 1); vals.splice(0, 1); }
      await client.query('INSERT INTO maint_routines (' + cols.join(', ') + ') VALUES (' + cols.map(function (c, j) { return '$' + (j + 1); }).join(', ') + ')', vals);
    }
    for (var u = 0; u < p.routines.update.length; u++) {
      var ru = p.routines.update[u];
      await client.query('UPDATE maint_routines SET ' + ROUTINE_COLS.map(function (c, j) { return c + ' = $' + (j + 2); }).join(', ') +
        ', archived_at = CASE WHEN $' + (ROUTINE_COLS.length + 2) + '::boolean THEN coalesce(archived_at, $' + (ROUTINE_COLS.length + 3) + ') ELSE NULL END, ' +
        'sheet_synced_at = $' + (ROUTINE_COLS.length + 3) + ', updated_at = $' + (ROUTINE_COLS.length + 3) + ' WHERE id = $1',
        [ru.existing.id].concat(ROUTINE_COLS.map(function (c) { return ru.item.fields[c]; })).concat([ru.item.fields.archived, now]));
    }
    for (var a = 0; a < p.orders.add.length; a++) {
      var o = p.orders.add[a], f = o.fields;
      var ocols = ORDER_COLS.concat(['sheet_key', 'sheet_synced_at', 'created_by', 'updated_at']);
      var ovals = ORDER_COLS.map(function (c) { return f[c]; }).concat([o.key, now, ctx.employee.id, now]);
      await client.query('INSERT INTO maint_work_orders (' + ocols.join(', ') + ') VALUES (' + ocols.map(function (c, j) { return '$' + (j + 1); }).join(', ') + ')', ovals);
    }
    for (var b = 0; b < p.orders.update.length; b++) {
      var ou = p.orders.update[b];
      await client.query('UPDATE maint_work_orders SET ' + ORDER_COLS.map(function (c, j) { return c + ' = $' + (j + 2); }).join(', ') +
        ', sheet_synced_at = $' + (ORDER_COLS.length + 2) + ', updated_at = $' + (ORDER_COLS.length + 2) + ' WHERE id = $1',
        [ou.existing.id].concat(ORDER_COLS.map(function (c) { return ou.item.fields[c]; })).concat([now]));
    }
    var summary = 'Imported the IT work order sheet: ' + p.orders.add.length + ' work orders added, ' + p.orders.update.length + ' brought up to date, ' +
      p.routines.add.length + ' routines added, ' + p.routines.update.length + ' routines brought up to date.';
    await audit(client, ctx, 'maintwo.import', 'maint_work_order', null, summary);
    return {
      orders: { added: p.orders.add.length, updated: p.orders.update.length, same: p.orders.same, kept: p.orders.kept.length },
      routines: { added: p.routines.add.length, updated: p.routines.update.length, same: p.routines.same },
      unmatched: p.names.filter(function (n) { return !n.matched; }).map(function (n) { return n.name; })
    };
  });
}

module.exports = { preview: preview, run: run, _readSheet: readSheet };
