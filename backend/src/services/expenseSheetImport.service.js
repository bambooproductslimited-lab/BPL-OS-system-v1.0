var ExcelJS = require('exceljs');
var { Readable } = require('stream');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var sheets = require('./expenseSheets.service');

// Brings an officer's expense workbook (.xlsx) into their expense sheet
// (migration 0141). The workbook kept one officer's float:
//
//   a funding tab   Date, Amt, Note, Payee (who gave the money), SEQ,
//                   Supervisor Audit, Balance
//   an expense tab  Date, Amt, Qty, UnitPrice, Note, Project, Asset, Payee,
//                   Category, No, Supervisor Audit, Balance
//   Balance         the running balance day by day
//   Staged …        the same rows again for the accountant — not read
//
// A funding line below zero is money passed on or handed back out of the
// float (payroll cash handed to staff, money returned): it comes in as is,
// lowering the balance without counting as spending.
//
// Tabs are found by their headings, not their names. Rows with a date but
// no amount (days filled in ahead) are left out, and so are rows of zero
// with nothing written. The unit price is the amount over the quantity, as
// the workbook's own formula has it; a typed-over unit price that does not
// match is listed in the preview. "Project" becomes the cost centre.
//
// The supervisor's stamps ("AW, 59, C01": initials, the balance confirmed
// that day, the check) become checks of the sheet on that line's date, and
// the preview says whether the balance the OS works out agrees with the
// stamp. "AC 5/17" is an accountant's check on that line's date. Anything
// else in the audit column is kept on the line as written.
//
// Each line remembers what it was on the workbook (kind, date, amount,
// note, payee and its place among identical rows), so importing a later
// copy of the same workbook adds only the new lines.

var MAX_ROWS = 20000;

function raw(v) { return v && typeof v === 'object' && !(v instanceof Date) && 'result' in v ? v.result : v; }
function text(v) {
  v = raw(v);
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(function (t) { return t.text; }).join('');
    if ('text' in v) return String(v.text);
    if ('error' in v) return '';
    return '';
  }
  return String(v);
}
function clean(v, max) {
  var s = text(v).replace(/\s+/g, ' ').trim();
  if (/^(-+|#\w+!?|n\/?a|nil|none)$/i.test(s)) return '';
  return max ? s.slice(0, max) : s;
}
function num(v) {
  v = raw(v);
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var s = text(v).replace(/[,\s]|GHS|GH₵|₵/gi, '');
  var neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  return (neg ? -1 : 1) * Number(s);
}
// A date cell, a spreadsheet day number, or written as d/m/yyyy or yyyy-mm-dd.
function dateOf(v) {
  v = raw(v);
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  var s = text(v).trim(), m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return null;
}
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function today() { return new Date().toISOString().slice(0, 10); }
var money = sheets._money;

// The workbook, read a row at a time, keeping only the tabs the import can
// use. The accountant's "Staged …" copies can run to tens of thousands of
// rows of formulas; loaded whole, one workbook took more memory than the
// server has. A kept tab offers what parse() reads: name, rowCount,
// getCell('A1'), getRow(r).getCell(c).value and getRow(r).eachCell().
function tabOf(name) {
  var rows = {};
  var tab = {
    name: name, rows: rows, rowCount: 0,
    getRow: function (r) {
      var v = rows[r] || {};
      return {
        getCell: function (c) { return { value: v[c] === undefined ? null : v[c] }; },
        eachCell: function (opts, fn) { Object.keys(v).forEach(function (c) { fn({ value: v[c] }, Number(c)); }); }
      };
    },
    getCell: function (ref) { var m = /^([A-Z])(\d+)$/.exec(ref); return tab.getRow(Number(m[2])).getCell(m[1].charCodeAt(0) - 64); }
  };
  return tab;
}
function staged(h) { return !h || !!(h.cols.payer || h.cols.expacc); }
async function readTabs(buffer) {
  var reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buffer]), { worksheets: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore', entries: 'ignore' });
  var tabs = [];
  for await (var ws of reader) {
    var tab = tabOf(ws.name), keep = null;
    for await (var row of ws) {
      if (keep === null && row.number > 5) keep = !staged(headings(tab));
      if (keep === false || row.number > 5 + MAX_ROWS) continue;
      var vals = {};
      row.eachCell({ includeEmpty: false }, function (cell, c) { vals[c] = cell.value; });
      tab.rows[row.number] = vals;
      tab.rowCount = row.number;
    }
    tabs.push(tab);
  }
  return tabs;
}

// The tab's heading row (one of the first five) and where each heading is.
function headings(ws) {
  for (var r = 1; r <= Math.min(5, ws.rowCount); r++) {
    var row = ws.getRow(r), cols = {}, n = 0;
    row.eachCell({ includeEmpty: false }, function (cell, c) { var k = norm(text(cell.value)); if (k && !(k in cols)) { cols[k] = c; n++; } });
    if (n >= 3) return { row: r, cols: cols };
  }
  return null;
}
function pick(cols, names) { for (var i = 0; i < names.length; i++) if (cols[names[i]]) return cols[names[i]]; return null; }

async function parse(file) {
  if (!file || !file.buffer || !file.buffer.length) fail('invalid', 'Choose the expense workbook (.xlsx).');
  var tabs;
  try { tabs = await readTabs(file.buffer); } catch (e) { fail('invalid', 'That file could not be read as an Excel workbook (.xlsx).'); }
  var funding = null, expense = null, balanceTab = null, officer = '';
  tabs.forEach(function (ws) {
    var a1 = clean(ws.getCell('A1').value, 60), b1 = norm(text(ws.getCell('B1').value));
    if (b1 === 'expense report handle' && a1) officer = a1;
    var h = headings(ws);
    if (!h) return;
    var c = h.cols;
    var has = function (k) { return !!c[k]; };
    if (has('payer') || has('expacc')) return; // the accountant's staged copies
    if (has('date') && (has('funding') || has('expense')) && has('balance') && !has('amt')) { balanceTab = { ws: ws, h: h }; return; }
    if (!has('date') || !(has('amt') || has('amount'))) return;
    if (has('category')) { if (!expense || /exp/i.test(ws.name)) expense = { ws: ws, h: h }; }
    else if (has('payee') && (!funding || /fund/i.test(ws.name))) funding = { ws: ws, h: h };
  });
  if (!funding && !expense) fail('invalid', 'No funding or expense tab was found. The workbook needs columns such as Date, Amt, Payee and Category.');

  var rows = [], skippedBlank = 0, future = [], unitDiffs = [];
  function read(tab, kind) {
    if (!tab) return;
    var c = tab.h.cols;
    var col = {
      date: pick(c, ['date']), amt: pick(c, ['amt', 'amount']), qty: pick(c, ['qty', 'quantity']), unit: pick(c, ['unitprice', 'unit price']),
      note: pick(c, ['note', 'notes', 'description']), project: pick(c, ['project', 'cost centre', 'cost center']), asset: pick(c, ['asset', 'vehicle']),
      payee: pick(c, ['payee', 'paid to', 'from']), category: pick(c, ['category']), sub: pick(c, ['subcategory', 'sub category']),
      no: pick(c, ['no', 'seq']), audit: pick(c, ['supervisor audit', 'audit']), bal: pick(c, ['balance'])
    };
    var last = Math.min(tab.ws.rowCount, tab.h.row + MAX_ROWS);
    for (var r = tab.h.row + 1; r <= last; r++) {
      var row = tab.ws.getRow(r);
      var g = function (k) { return col[k] ? row.getCell(col[k]).value : null; };
      var date = dateOf(g('date'));
      var amount = num(g('amt'));
      var note = clean(g('note'), 300);
      if (!date && amount === null) continue;
      if (!date) continue;
      if (amount === null || (amount === 0 && !note)) { skippedBlank++; continue; }
      if (date > today()) { future.push({ row: r, date: date, amount: money(amount), kind: kind }); continue; }
      var qty = num(g('qty'));
      if (!(qty > 0)) qty = 1;
      var unit = num(g('unit'));
      if (unit !== null && Math.abs(unit * qty - amount) > 0.01) unitDiffs.push({ row: r, tab: tab.ws.name, amount: money(amount), qty: qty, unitPrice: money(unit) });
      rows.push({
        kind: kind, tab: tab.ws.name, row: r, no: num(g('no')), date: date, amount: money(amount), qty: Math.round(qty * 1000) / 1000, note: note,
        costCentre: clean(g('project'), 80), asset: clean(g('asset'), 80), payee: clean(g('payee'), 120),
        category: kind === 'expense' ? clean(g('category'), 60) : '', subcategory: clean(g('sub'), 60), auditNote: clean(g('audit'), 200),
        sheetBalance: num(g('bal'))
      });
    }
  }
  read(funding, 'funding');
  read(expense, 'expense');
  rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? (a.no || a.row) - (b.no || b.row) : a.kind === 'funding' ? -1 : 1; });

  // One spelling for a payee written in different cases ("uber", "Uber"):
  // a capitalised one if there is one, else the most used.
  var spell = {};
  rows.forEach(function (r) { if (!r.payee) return; var k = r.payee.toLowerCase(); (spell[k] = spell[k] || {})[r.payee] = (spell[k][r.payee] || 0) + 1; });
  var merged = [];
  Object.keys(spell).forEach(function (k) {
    var forms = Object.keys(spell[k]);
    if (forms.length < 2) { spell[k] = forms[0]; return; }
    var best = forms.slice().sort(function (a, b) { return (/^[A-Z]/.test(b) ? 1 : 0) - (/^[A-Z]/.test(a) ? 1 : 0) || spell[k][b] - spell[k][a]; })[0];
    merged.push({ from: forms, to: best });
    spell[k] = best;
  });
  rows.forEach(function (r) { if (r.payee) r.payee = spell[r.payee.toLowerCase()]; });

  // Where each line was on the workbook, among identical ones.
  var seen = {};
  rows.forEach(function (r) {
    var base = r.kind + '|' + r.date + '|' + r.amount + '|' + norm(r.note) + '|' + norm(r.payee);
    seen[base] = (seen[base] || 0) + 1;
    r.key = 'xlsx:' + base + '|' + seen[base];
  });

  // The stamps in the audit column. A stamp is the balance just after its
  // line, so it is compared with that (with or without money received the
  // same day) as well as with the day's closing balance.
  function afterLine(r, withFunding) {
    return money(rows.reduce(function (t, x) {
      var before = x.date < r.date || (x.date === r.date && (x.kind === 'funding' ? withFunding : x.kind === r.kind && x.row <= r.row));
      return before ? t + (x.kind === 'funding' ? x.amount : -x.amount) : t;
    }, 0));
  }
  var checks = [];
  rows.forEach(function (r) {
    if (!r.auditNote) return;
    var re = /\b([A-Za-z]{2,3})\s*,\s*(\(\s*-?[\d,]*\.?\d+\s*\)|-?[\d,]*\.?\d+)\s*,\s*(C\s*0*\d+)/g, m, found = false;
    while ((m = re.exec(r.auditNote))) {
      if (/^ac$/i.test(m[1])) continue;
      found = true;
      checks.push({ kind: 'supervisor', date: r.date, initials: m[1].toUpperCase(), stamped: money(num(m[2])), note: r.auditNote, alts: [afterLine(r, false), afterLine(r, true)] });
    }
    var ac = /\bAC[,\s]+(\d{1,2})\/(\d{1,2})\b/i.exec(r.auditNote);
    if (ac) checks.push({ kind: 'accountant', date: r.date, initials: 'AC', stamped: null, note: r.auditNote });
    r.stamped = found;
  });
  // One check of each kind a day (the last one written).
  var byDay = {};
  checks.forEach(function (c) { byDay[c.kind + c.date] = c; });
  checks = Object.keys(byDay).map(function (k) { return byDay[k]; }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === 'supervisor' ? -1 : 1; });

  // The workbook's own balance, on the last day it has a line.
  var lastDate = rows.length ? rows[rows.length - 1].date : null, sheetBalance = null;
  if (balanceTab && lastDate) {
    var bc = balanceTab.h.cols;
    for (var r2 = balanceTab.h.row + 1; r2 <= Math.min(balanceTab.ws.rowCount, balanceTab.h.row + 5000); r2++) {
      var row2 = balanceTab.ws.getRow(r2);
      if (dateOf(row2.getCell(bc.date).value) === lastDate) { sheetBalance = num(row2.getCell(bc.balance).value); break; }
    }
  }
  if (sheetBalance === null && rows.length) {
    var withBal = rows.filter(function (x) { return x.date === lastDate && x.sheetBalance !== null; });
    if (withBal.length) sheetBalance = withBal[withBal.length - 1].sheetBalance;
  }
  return {
    officer: officer, tabs: { funding: funding ? funding.ws.name : null, expenses: expense ? expense.ws.name : null },
    rows: rows, checks: checks, skippedBlank: skippedBlank, future: future, unitDiffs: unitDiffs, payeesMerged: merged,
    sheetBalance: sheetBalance === null ? null : money(sheetBalance), lastDate: lastDate
  };
}

// What importing would do to this sheet.
async function plan(ctx, sheetId, file) {
  var x = await sheets._sheetFor(ctx, sheetId, 'write');
  var p = await parse(file);
  var have = {};
  (await pool.query('SELECT import_key FROM expense_sheet_lines WHERE sheet_id = $1 AND import_key IS NOT NULL', [sheetId])).rows.forEach(function (r) { have[r.import_key] = true; });
  var locked = await sheets._lockDate(pool, sheetId);
  var fresh = [], already = 0, inLocked = [];
  p.rows.forEach(function (r) {
    if (have[r.key]) { already++; return; }
    if (locked && r.date <= locked) { inLocked.push(r); return; }
    fresh.push(r);
  });
  // The balance the OS will show, day by day, with these lines added.
  var existing = (await pool.query('SELECT kind, amount, date FROM expense_sheet_lines WHERE sheet_id = $1', [sheetId])).rows
    .map(function (r) { return { kind: r.kind, amount: Number(r.amount), date: r.date.toISOString ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10) }; });
  var all = existing.concat(fresh);
  function balanceOn(d) { return money(all.filter(function (r) { return r.date <= d; }).reduce(function (s, r) { return s + (r.kind === 'funding' ? r.amount : -r.amount); }, 0)); }
  var checks = p.checks.filter(function (c) { return !locked || c.date > locked; }).map(function (c) {
    var computed = balanceOn(c.date);
    var near = c.stamped === null ? null : Math.min.apply(null, [computed].concat(c.alts || []).map(function (v) { return Math.abs(v - c.stamped); }));
    return Object.assign({}, c, { computed: computed, agrees: near === null ? null : near < 0.01, close: near !== null && near >= 0.01 && near < 1 });
  });
  await sheets._ensureLists(pool);
  var existingCats = {}, existingCentres = {};
  (await pool.query('SELECT kind, lower(name) AS n FROM expense_sheet_lists')).rows.forEach(function (r) { (r.kind === 'category' ? existingCats : existingCentres)[r.n] = true; });
  var newCats = {}, newCentres = {};
  fresh.forEach(function (r) {
    if (r.category && !existingCats[r.category.toLowerCase()]) newCats[r.category] = true;
    if (r.costCentre && !existingCentres[r.costCentre.toLowerCase()]) newCentres[r.costCentre] = true;
  });
  var sum = function (list, kind) { return money(list.filter(function (r) { return r.kind === kind; }).reduce(function (s, r) { return s + r.amount; }, 0)); };
  return {
    x: x, p: p, fresh: fresh, checks: checks, locked: locked,
    summary: {
      officerOnWorkbook: p.officer, sheetOwner: x.s.first_name + ' ' + x.s.last_name, tabs: p.tabs,
      funding: { lines: fresh.filter(function (r) { return r.kind === 'funding' && r.amount > 0; }).length, total: money(fresh.filter(function (r) { return r.kind === 'funding' && r.amount > 0; }).reduce(function (t, r) { return t + r.amount; }, 0)) },
      passedOn: { lines: fresh.filter(function (r) { return r.kind === 'funding' && r.amount < 0; }).length, total: money(-fresh.filter(function (r) { return r.kind === 'funding' && r.amount < 0; }).reduce(function (t, r) { return t + r.amount; }, 0)) },
      expenses: { lines: fresh.filter(function (r) { return r.kind === 'expense'; }).length, total: sum(fresh, 'expense'), moneyBack: fresh.filter(function (r) { return r.kind === 'expense' && r.amount < 0; }).length },
      already: already, inCheckedPeriod: inLocked.length, lockedUntil: locked, skippedBlank: p.skippedBlank,
      future: p.future, unitPriceDiffs: p.unitDiffs.slice(0, 20), payeesMerged: p.payeesMerged,
      checks: checks.map(function (c) { return { kind: c.kind, date: c.date, initials: c.initials, stamped: c.stamped, computed: c.computed, agrees: c.agrees, close: c.close }; }),
      newCategories: Object.keys(newCats).sort(), newCostCentres: Object.keys(newCentres).sort(), canGrowLists: x.a.manage,
      balance: { onWorkbook: p.sheetBalance, workbookDate: p.lastDate, afterImport: p.lastDate ? balanceOn(p.lastDate) : null, today: balanceOn(today()) },
      sample: fresh.slice(-8).map(function (r) { return { kind: r.kind, date: r.date, amount: r.amount, qty: r.qty, note: r.note, payee: r.payee, category: r.category, costCentre: r.costCentre }; })
    }
  };
}

// kernel: expenseSheets.importPreview
async function preview(ctx, sheetId, file) {
  return (await plan(ctx, sheetId, file)).summary;
}

// kernel: expenseSheets.import — the new lines, then the checks found.
async function run(ctx, sheetId, file) {
  var pl = await plan(ctx, sheetId, file);
  if (!pl.fresh.length && !pl.checks.length) return Object.assign(pl.summary, { added: 0, checksAdded: 0 });
  var grow = pl.x.a.manage;
  var added = 0, checksAdded = 0;
  await withTransaction(async function (client) {
    await client.query('SELECT id FROM expense_sheets WHERE id = $1 FOR UPDATE', [sheetId]);
    if (grow) {
      var cats = {}, centres = {};
      pl.fresh.forEach(function (r) { if (r.category) cats[r.category] = true; if (r.costCentre) centres[r.costCentre] = true; });
      for (var c in cats) await client.query("INSERT INTO expense_sheet_lists (kind, name) VALUES ('category', $1) ON CONFLICT DO NOTHING", [c]);
      for (var cc in centres) await client.query("INSERT INTO expense_sheet_lists (kind, name) VALUES ('cost_centre', $1) ON CONFLICT DO NOTHING", [cc]);
    }
    var listed = {};
    (await client.query('SELECT kind, name, company_id FROM expense_sheet_lists')).rows.forEach(function (r) { listed[r.kind + '|' + r.name.toLowerCase()] = r; });
    var assets = (await client.query('SELECT id, asset_no, description FROM assets')).rows;
    var seq = (await client.query('SELECT coalesce(max(seq), 0) AS n FROM expense_sheet_lines WHERE sheet_id = $1', [sheetId])).rows[0].n;
    for (var i = 0; i < pl.fresh.length; i++) {
      var r = pl.fresh[i];
      var cat = r.category && listed['category|' + r.category.toLowerCase()];
      var cen = r.costCentre && listed['cost_centre|' + r.costCentre.toLowerCase()];
      var asset = r.asset ? assets.filter(function (a) { return a.asset_no.toLowerCase() === r.asset.toLowerCase() || (a.description || '').toLowerCase() === r.asset.toLowerCase(); }) : [];
      seq++;
      var ins = await client.query(
        'INSERT INTO expense_sheet_lines (sheet_id, kind, seq, date, amount, qty, note, payee, category, subcategory, cost_centre, company_id, asset, asset_id, audit_note, source, import_key, created_by) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'import',$16,$17) ON CONFLICT DO NOTHING RETURNING id",
        [sheetId, r.kind, seq, r.date, r.amount, r.qty, r.note, r.payee, cat ? cat.name : r.category, r.subcategory, cen ? cen.name : r.costCentre, cen ? cen.company_id : null,
          r.asset, asset.length === 1 ? asset[0].id : null, r.auditNote, r.key, ctx.employee.id]);
      if (ins.rows.length) added++; else seq--;
    }
    var n = (await client.query('SELECT count(*)::int AS n FROM expense_sheet_checks WHERE sheet_id = $1', [sheetId])).rows[0].n;
    var locked = await sheets._lockDate(client, sheetId);
    for (var k = 0; k < pl.checks.length; k++) {
      var ch = pl.checks[k];
      if (locked && ch.date < locked) continue;
      n++;
      await client.query(
        "INSERT INTO expense_sheet_checks (sheet_id, kind, upto_date, balance, code, note, by_initials, source) VALUES ($1,$2,$3,$4,$5,$6,$7,'import')",
        [sheetId, ch.kind, ch.date, ch.computed, 'C' + String(n).padStart(2, '0'), (ch.stamped !== null && !ch.agrees ? 'Workbook said ' + ch.stamped + '. ' : '') + ch.note, ch.initials]);
      checksAdded++;
      locked = ch.date;
    }
    await client.query('UPDATE expense_sheets SET updated_at = now() WHERE id = $1', [sheetId]);
    await audit(client, ctx, 'expensesheet.import', 'expense_sheet', sheetId,
      'Imported ' + added + ' line(s) and ' + checksAdded + ' check(s) into ' + pl.summary.sheetOwner + '\'s expense sheet from a workbook.');
  });
  return Object.assign(pl.summary, { added: added, checksAdded: checksAdded });
}

module.exports = { preview: preview, run: run, _parse: parse };
