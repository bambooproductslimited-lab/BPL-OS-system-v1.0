var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var fileStore = require('../lib/fileStore');

// Officers' expense sheets (migration 0141): the float each officer spends
// for the company, as their own running sheet.
//
// Who sees what: the officer their own sheet; the supervisor named on a
// sheet that sheet; expensesheet.read.all every sheet; expensesheet.manage
// (finance) every sheet, and runs them: opens a sheet for an officer, sets
// its supervisor and usual float, tops it up, checks it as the accountant,
// undoes the latest check, keeps the category and cost-centre lists.
//
// The officer (and finance) writes lines: an expense (what was bought, how
// many, who was paid, the category, the cost centre it was for, a vehicle
// or machine, a receipt) or money received (funding). The balance runs
// line by line in date order: positive is cash the officer holds, below
// zero the company owes them. A check (by the sheet's supervisor, or by
// finance) confirms the balance up to a date, with the cash counted if
// wanted, and locks every line up to then: nothing can be added, changed
// or removed on or before that date until finance undoes the check.

function today() { return new Date().toISOString().slice(0, 10); }
function dayStr(d) { return d ? (d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function money(v) { return Math.round(Number(v || 0) * 100) / 100; }
function fullName(first, last) { return ((first || '') + ' ' + (last || '')).trim(); }
function initialsOf(name) { return String(name || '').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).join('').slice(0, 3).toUpperCase(); }
function signed(r) { return r.kind === 'funding' ? Number(r.amount) : -Number(r.amount); }
function clip(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

// ── access ────────────────────────────────────────────────────────────
var SHEET_SQL =
  'SELECT s.*, e.first_name, e.last_name, e.position_title, e.photo_key, e.photo_updated_at, e.manager_id, d.name AS dept_name, ' +
  '  sup.first_name AS sup_first, sup.last_name AS sup_last FROM expense_sheets s JOIN employees e ON e.id = s.employee_id ' +
  'LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN employees sup ON sup.id = s.supervisor_id ';

function accessTo(ctx, s) {
  var own = s.employee_id === ctx.employee.id;
  var manage = ctx.can('expensesheet.manage');
  var supervise = !!s.supervisor_id && s.supervisor_id === ctx.employee.id;
  return {
    own: own, manage: manage, supervise: supervise,
    read: own || manage || supervise || ctx.can('expensesheet.read.all'),
    write: (own && s.status === 'open') || manage,
    check: supervise || manage
  };
}
async function sheetFor(ctx, id, need) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) fail('notfound', 'Expense sheet not found.');
  var s = (await pool.query(SHEET_SQL + 'WHERE s.id = $1', [id])).rows[0];
  if (!s) fail('notfound', 'Expense sheet not found.');
  var a = accessTo(ctx, s);
  if (!a.read) fail('notfound', 'Expense sheet not found.');
  if (need && !a[need]) {
    if (need === 'write' && a.own) fail('forbidden', 'This expense sheet is closed. Ask finance to reopen it.');
    fail('forbidden', need === 'check' ? 'Only the sheet\'s supervisor or finance can check it.' : need === 'manage' ? 'Only finance can do this (expensesheet.manage).' : 'You cannot change this expense sheet.');
  }
  return { s: s, a: a };
}
function sheetOut(s) {
  return {
    id: s.id, status: s.status, note: s.note, floatLimit: s.float_limit === null ? null : Number(s.float_limit), createdAt: s.created_at,
    employee: { id: s.employee_id, name: fullName(s.first_name, s.last_name), title: s.position_title || '', department: s.dept_name || '', photo: s.photo_key && s.photo_updated_at ? new Date(s.photo_updated_at).getTime() : null },
    supervisor: s.supervisor_id ? { id: s.supervisor_id, name: fullName(s.sup_first, s.sup_last) } : null
  };
}
async function lockDate(db, sheetId) {
  return dayStr((await db.query('SELECT max(upto_date) AS d FROM expense_sheet_checks WHERE sheet_id = $1', [sheetId])).rows[0].d);
}
async function financePeople() {
  return (await pool.query(
    "SELECT DISTINCT u.employee_id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id " +
    "WHERE rp.permission_key = 'expensesheet.manage' AND u.status = 'active' AND u.employee_id IS NOT NULL")).rows.map(function (r) { return r.employee_id; });
}

// ── the list of sheets ────────────────────────────────────────────────
// kernel: expenseSheets.list — every sheet the person may see, with its
// balance, this month, the latest check and what is waiting.
async function list(ctx) {
  var all = ctx.can('expensesheet.manage') || ctx.can('expensesheet.read.all');
  var rows = (await pool.query(
    SHEET_SQL.replace('FROM expense_sheets s', ', agg.balance, agg.spent_month, agg.funded_month, agg.spent_year, agg.last_line, agg.lines, chk.upto, ' +
      '(SELECT count(*)::int FROM expense_sheet_lines x WHERE x.sheet_id = s.id AND x.date > coalesce(chk.upto, \'1900-01-01\')) AS unchecked, ' +
      "(SELECT count(*)::int FROM expense_sheet_topups t WHERE t.sheet_id = s.id AND t.status = 'pending') AS topups FROM expense_sheets s") +
    "LEFT JOIN LATERAL (SELECT coalesce(sum(CASE WHEN l.kind = 'funding' THEN l.amount ELSE -l.amount END), 0) AS balance, " +
    "  coalesce(sum(l.amount) FILTER (WHERE l.kind = 'expense' AND date_trunc('month', l.date) = date_trunc('month', CURRENT_DATE)), 0) AS spent_month, " +
    "  coalesce(sum(l.amount) FILTER (WHERE l.kind = 'funding' AND date_trunc('month', l.date) = date_trunc('month', CURRENT_DATE)), 0) AS funded_month, " +
    "  coalesce(sum(l.amount) FILTER (WHERE l.kind = 'expense' AND date_trunc('year', l.date) = date_trunc('year', CURRENT_DATE)), 0) AS spent_year, " +
    '  max(l.date) AS last_line, count(*)::int AS lines FROM expense_sheet_lines l WHERE l.sheet_id = s.id) agg ON true ' +
    'LEFT JOIN LATERAL (SELECT max(upto_date) AS upto FROM expense_sheet_checks c WHERE c.sheet_id = s.id) chk ON true ' +
    (all ? '' : 'WHERE s.employee_id = $1 OR s.supervisor_id = $1 ') + 'ORDER BY e.first_name, e.last_name', all ? [] : [ctx.employee.id])).rows;
  var lastChecks = {};
  if (rows.length) {
    (await pool.query(
      'SELECT DISTINCT ON (c.sheet_id) c.*, b.first_name, b.last_name FROM expense_sheet_checks c LEFT JOIN employees b ON b.id = c.by_id ' +
      'WHERE c.sheet_id = ANY($1) ORDER BY c.sheet_id, c.upto_date DESC, c.created_at DESC', [rows.map(function (r) { return r.id; })])).rows
      .forEach(function (c) { lastChecks[c.sheet_id] = checkOut(c); });
  }
  return rows.map(function (r) {
    return Object.assign(sheetOut(r), {
      balance: money(r.balance), spentThisMonth: money(r.spent_month), fundedThisMonth: money(r.funded_month), spentThisYear: money(r.spent_year),
      lastLineDate: dayStr(r.last_line), lines: r.lines, checkedUntil: dayStr(r.upto), uncheckedLines: r.unchecked, pendingTopups: r.topups,
      lastCheck: lastChecks[r.id] || null, mine: r.employee_id === ctx.employee.id, supervising: r.supervisor_id === ctx.employee.id
    });
  });
}

// ── one sheet ─────────────────────────────────────────────────────────
function lineOut(r, extra) {
  return Object.assign({
    id: r.id, kind: r.kind, seq: r.seq, date: dayStr(r.date), amount: money(r.amount), qty: Number(r.qty),
    unitPrice: money(Number(r.amount) / Number(r.qty || 1)), note: r.note, payee: r.payee, category: r.category, subcategory: r.subcategory,
    costCentre: r.cost_centre, companyId: r.company_id, asset: r.asset, assetId: r.asset_id, auditNote: r.audit_note, source: r.source,
    receipt: r.receipt_key ? { name: r.receipt_name || 'receipt', type: r.receipt_type || '' } : null
  }, extra || {});
}
function checkOut(c) {
  return {
    id: c.id, kind: c.kind, uptoDate: dayStr(c.upto_date), balance: money(c.balance), counted: c.counted === null ? null : money(c.counted),
    code: c.code, note: c.note, byInitials: c.by_initials, source: c.source, createdAt: c.created_at,
    by: c.by_id ? { id: c.by_id, name: fullName(c.first_name, c.last_name) } : null
  };
}
function topupOut(t) {
  return {
    id: t.id, amount: money(t.amount), reason: t.reason, status: t.status, requestedAt: t.requested_at, decidedAt: t.decided_at,
    decisionNote: t.decision_note, lineId: t.line_id, decidedBy: t.decided_by ? fullName(t.d_first, t.d_last) : null
  };
}
// The usual categories, and every company as a cost centre, when a list is
// still empty (a new database, or one reset).
var DEFAULT_CATEGORIES = ['Travel Expense', 'Auto Fuel', 'Communication', 'Marketing', 'Meals & Ent.', 'Office Supplies', 'Factory Supplies',
  'Gen Repair & Maint.', 'Utilities', 'Rent', 'Casuals', 'Medical Expense', 'Benefits', 'Professional Fees', 'Permits & Licenses', 'Finance Charges',
  'Export Charges', 'Construction', 'Gifts', 'Household Supplies', 'Supply', 'Sales Commission', 'Dash/Tips', 'Payroll Expense', 'Tax', 'R&D', 'COGS',
  'Land Development', 'IOU', 'Other Expense'];
async function ensureLists(db) {
  var n = (await db.query("SELECT count(*) FILTER (WHERE kind = 'category')::int AS c, count(*) FILTER (WHERE kind = 'cost_centre')::int AS cc FROM expense_sheet_lists")).rows[0];
  if (!n.c) await db.query("INSERT INTO expense_sheet_lists (kind, name) SELECT 'category', unnest($1::text[]) ON CONFLICT DO NOTHING", [DEFAULT_CATEGORIES]);
  if (!n.cc) await db.query("INSERT INTO expense_sheet_lists (kind, name, company_id) SELECT 'cost_centre', name, id FROM companies WHERE status = 'active' ON CONFLICT DO NOTHING");
}
async function lists() {
  await ensureLists(pool);
  var rows = (await pool.query('SELECT l.*, c.name AS company_name FROM expense_sheet_lists l LEFT JOIN companies c ON c.id = l.company_id ORDER BY l.kind, lower(l.name)')).rows;
  return {
    categories: rows.filter(function (r) { return r.kind === 'category'; }).map(function (r) { return { id: r.id, name: r.name, active: r.active }; }),
    costCentres: rows.filter(function (r) { return r.kind === 'cost_centre'; }).map(function (r) { return { id: r.id, name: r.name, active: r.active, companyId: r.company_id, companyName: r.company_name || '' }; })
  };
}

// kernel: expenseSheets.get — a year of the sheet (the balance carried in
// from before), its checks and top-ups, what it was spent on by month,
// and the lists to pick from.
async function get(ctx, id, yearIn) {
  var x = await sheetFor(ctx, id);
  var year = Number(yearIn) || Number(today().slice(0, 4));
  var from = year + '-01-01', to = year + '-12-31';
  var all = (await pool.query('SELECT * FROM expense_sheet_lines WHERE sheet_id = $1 ORDER BY date, seq', [id])).rows;
  var locked = await lockDate(pool, id);
  var opening = 0, run = 0, lines = [];
  all.forEach(function (r) {
    var d = dayStr(r.date);
    run = money(run + signed(r));
    if (d < from) opening = run;
    else if (d <= to) lines.push(lineOut(r, { balance: run, locked: !!locked && d <= locked }));
  });
  var checks = (await pool.query('SELECT c.*, b.first_name, b.last_name FROM expense_sheet_checks c LEFT JOIN employees b ON b.id = c.by_id WHERE c.sheet_id = $1 ORDER BY c.upto_date DESC, c.created_at DESC', [id])).rows.map(checkOut);
  var topups = (await pool.query('SELECT t.*, d.first_name AS d_first, d.last_name AS d_last FROM expense_sheet_topups t LEFT JOIN employees d ON d.id = t.decided_by WHERE t.sheet_id = $1 ORDER BY t.requested_at DESC LIMIT 50', [id])).rows.map(topupOut);
  var years = (await pool.query("SELECT DISTINCT extract(year FROM date)::int AS y FROM expense_sheet_lines WHERE sheet_id = $1 ORDER BY 1", [id])).rows.map(function (r) { return r.y; });
  if (years.indexOf(year) < 0) years.push(year);

  // What it went on, month by month (the sheet's old pivot), and where.
  var monthSpent = new Array(12).fill(0), monthFunded = new Array(12).fill(0), cats = {}, centres = {}, payees = {};
  lines.forEach(function (l) {
    var m = Number(l.date.slice(5, 7)) - 1;
    if (l.kind === 'funding') { monthFunded[m] = money(monthFunded[m] + l.amount); return; }
    monthSpent[m] = money(monthSpent[m] + l.amount);
    var c = l.category || '—';
    if (!cats[c]) cats[c] = { name: c, months: new Array(12).fill(0), total: 0, count: 0 };
    cats[c].months[m] = money(cats[c].months[m] + l.amount); cats[c].total = money(cats[c].total + l.amount); cats[c].count++;
    var cc = l.costCentre || '—';
    if (!centres[cc]) centres[cc] = { name: cc, total: 0, count: 0 };
    centres[cc].total = money(centres[cc].total + l.amount); centres[cc].count++;
    var p = (l.payee || '—');
    var pk = p.toLowerCase();
    if (!payees[pk]) payees[pk] = { name: p, total: 0, count: 0 };
    payees[pk].total = money(payees[pk].total + l.amount); payees[pk].count++;
  });
  var byTotal = function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); };
  var mm = today().slice(0, 7);
  var payeeSugg = (await pool.query("SELECT payee, count(*) AS n FROM expense_sheet_lines WHERE sheet_id = $1 AND payee <> '' GROUP BY payee ORDER BY n DESC LIMIT 80", [id])).rows;
  var seenPayee = {};
  var assets = (await pool.query("SELECT id, asset_no, description FROM assets WHERE status <> 'retired' ORDER BY asset_no LIMIT 300")).rows;
  var usedAssets = (await pool.query("SELECT DISTINCT asset FROM expense_sheet_lines WHERE sheet_id = $1 AND asset <> '' AND asset_id IS NULL", [id])).rows;

  return Object.assign(sheetOut(x.s), {
    can: { write: x.a.write, fund: x.a.write, check: x.a.check, accountantCheck: x.a.manage, manage: x.a.manage, requestTopup: x.a.own && x.s.status === 'open' },
    year: year, years: years.sort(), openingBalance: opening, balance: all.length ? run : 0, lockedUntil: locked,
    lines: lines, checks: checks, topups: topups,
    thisMonth: {
      spent: money(all.filter(function (r) { return r.kind === 'expense' && dayStr(r.date).slice(0, 7) === mm; }).reduce(function (s, r) { return s + Number(r.amount); }, 0)),
      funded: money(all.filter(function (r) { return r.kind === 'funding' && dayStr(r.date).slice(0, 7) === mm; }).reduce(function (s, r) { return s + Number(r.amount); }, 0))
    },
    report: {
      monthSpent: monthSpent, monthFunded: monthFunded,
      categories: Object.keys(cats).map(function (k) { return cats[k]; }).sort(byTotal),
      costCentres: Object.keys(centres).map(function (k) { return centres[k]; }).sort(byTotal),
      payees: Object.keys(payees).map(function (k) { return payees[k]; }).sort(byTotal).slice(0, 12)
    },
    lists: await lists(),
    suggestions: {
      payees: payeeSugg.filter(function (r) { var k = r.payee.toLowerCase(); if (seenPayee[k]) return false; seenPayee[k] = true; return true; }).map(function (r) { return r.payee; }),
      assets: assets.map(function (a) { return { id: a.id, name: a.asset_no + (a.description ? ' · ' + a.description : '') }; })
        .concat(usedAssets.map(function (a) { return { id: null, name: a.asset }; }))
    }
  });
}

// ── writing lines ─────────────────────────────────────────────────────
// The names a line uses keep one spelling: the list's, or the one already
// used on this sheet ("uber" becomes "Uber" if that is how it was written).
async function tidy(db, sheetId, p, canGrowLists) {
  await ensureLists(db);
  var out = { payee: clip(p.payee, 120), category: clip(p.category, 60), subcategory: clip(p.subcategory, 60), costCentre: clip(p.costCentre, 80), asset: clip(p.asset, 80), companyId: null, assetId: null };
  if (out.payee) {
    var pe = (await db.query("SELECT payee, count(*) AS n FROM expense_sheet_lines WHERE sheet_id = $1 AND lower(payee) = lower($2) GROUP BY payee ORDER BY n DESC LIMIT 1", [sheetId, out.payee])).rows[0];
    if (pe) out.payee = pe.payee;
  }
  async function listed(kind, name) {
    if (!name) return null;
    var hit = (await db.query('SELECT name, company_id FROM expense_sheet_lists WHERE kind = $1 AND lower(name) = lower($2)', [kind, name])).rows[0];
    if (hit) return hit;
    if (canGrowLists) await db.query('INSERT INTO expense_sheet_lists (kind, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [kind, name]);
    return { name: name, company_id: null };
  }
  var cat = await listed('category', out.category);
  if (cat) out.category = cat.name;
  var cc = await listed('cost_centre', out.costCentre);
  if (cc) { out.costCentre = cc.name; out.companyId = cc.company_id; }
  if (p.assetId && /^[0-9a-f-]{36}$/i.test(String(p.assetId))) {
    var a = (await db.query('SELECT id, asset_no, description FROM assets WHERE id = $1', [p.assetId])).rows[0];
    if (a) { out.assetId = a.id; out.asset = a.asset_no + (a.description ? ' · ' + a.description : ''); }
  } else if (out.asset) {
    var m = (await db.query('SELECT id FROM assets WHERE lower(asset_no) = lower($1) OR lower(description) = lower($1) LIMIT 2', [out.asset.split(' · ')[0]])).rows;
    if (m.length === 1) out.assetId = m[0].id;
  }
  return out;
}
function lineInput(p, kind) {
  var date = V.date(p.date, 'Date');
  if (date > today()) fail('invalid', 'The date cannot be in the future.');
  var amount = money(p.amount);
  if (!isFinite(amount) || amount === 0) fail('invalid', 'Enter the amount.');
  if (Math.abs(amount) > 10000000) fail('invalid', 'That amount is too large.');
  if (kind === 'funding' && amount < 0) fail('invalid', 'Money received must be more than zero.');
  var qty = p.qty === undefined || p.qty === null || p.qty === '' ? 1 : Number(p.qty);
  if (!(qty > 0) || qty > 100000) fail('invalid', 'The quantity must be more than zero.');
  var note = clip(p.note, 300);
  if (kind === 'expense' && amount < 0 && !note) fail('invalid', 'Say what the money coming back is for (a loan repaid, a refund).');
  return { date: date, amount: amount, qty: Math.round(qty * 1000) / 1000, note: note };
}
function ensureOpen(locked, date, what) {
  if (locked && date <= locked) fail('invalid', 'This sheet is checked up to ' + locked + '. ' + (what || 'Use a later date') + ', or ask finance to undo the check.');
}

// kernel: expenseSheets.addLine
async function addLine(ctx, sheetId, p) {
  var x = await sheetFor(ctx, sheetId, 'write');
  var kind = V.oneOf(p.kind || 'expense', ['expense', 'funding'], 'Kind');
  var v = lineInput(p, kind);
  if (kind === 'expense' && !clip(p.category, 60)) fail('invalid', 'Choose a category.');
  return withTransaction(async function (client) {
    await client.query('SELECT id FROM expense_sheets WHERE id = $1 FOR UPDATE', [sheetId]);
    ensureOpen(await lockDate(client, sheetId), v.date);
    var t = await tidy(client, sheetId, p, x.a.manage);
    var seq = (await client.query('SELECT coalesce(max(seq), 0) + 1 AS n FROM expense_sheet_lines WHERE sheet_id = $1', [sheetId])).rows[0].n;
    var r = (await client.query(
      'INSERT INTO expense_sheet_lines (sheet_id, kind, seq, date, amount, qty, note, payee, category, subcategory, cost_centre, company_id, asset, asset_id, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
      [sheetId, kind, seq, v.date, v.amount, v.qty, v.note, t.payee, kind === 'expense' ? t.category : '', t.subcategory, t.costCentre, t.companyId, t.asset, t.assetId, ctx.employee.id])).rows[0];
    await client.query('UPDATE expense_sheets SET updated_at = now() WHERE id = $1', [sheetId]);
    await audit(client, ctx, 'expensesheet.line', 'expense_sheet', sheetId,
      (kind === 'funding' ? 'Recorded GHS ' + v.amount + ' received' : 'Recorded an expense of GHS ' + v.amount) + ' on ' + fullName(x.s.first_name, x.s.last_name) + '\'s expense sheet.');
    return lineOut(r);
  });
}
async function lineFor(ctx, lineId, need) {
  if (!/^[0-9a-f-]{36}$/i.test(String(lineId))) fail('notfound', 'Line not found.');
  var l = (await pool.query('SELECT * FROM expense_sheet_lines WHERE id = $1', [lineId])).rows[0];
  if (!l) fail('notfound', 'Line not found.');
  var x = await sheetFor(ctx, l.sheet_id, need);
  return { l: l, s: x.s, a: x.a };
}
// kernel: expenseSheets.updateLine
async function updateLine(ctx, lineId, p) {
  var x = await lineFor(ctx, lineId, 'write');
  var merged = Object.assign({
    date: dayStr(x.l.date), amount: x.l.amount, qty: x.l.qty, note: x.l.note, payee: x.l.payee, category: x.l.category, subcategory: x.l.subcategory,
    costCentre: x.l.cost_centre, asset: x.l.asset, assetId: x.l.asset_id
  }, p || {});
  var v = lineInput(merged, x.l.kind);
  if (x.l.kind === 'expense' && !clip(merged.category, 60)) fail('invalid', 'Choose a category.');
  return withTransaction(async function (client) {
    var locked = await lockDate(client, x.l.sheet_id);
    ensureOpen(locked, dayStr(x.l.date), 'This line can no longer be changed');
    ensureOpen(locked, v.date);
    var t = await tidy(client, x.l.sheet_id, merged, x.a.manage);
    var r = (await client.query(
      'UPDATE expense_sheet_lines SET date = $2, amount = $3, qty = $4, note = $5, payee = $6, category = $7, subcategory = $8, cost_centre = $9, company_id = $10, ' +
      'asset = $11, asset_id = $12, updated_at = now() WHERE id = $1 RETURNING *',
      [lineId, v.date, v.amount, v.qty, v.note, t.payee, x.l.kind === 'expense' ? t.category : '', t.subcategory, t.costCentre, t.companyId, t.asset, t.assetId])).rows[0];
    await audit(client, ctx, 'expensesheet.line.edit', 'expense_sheet', x.l.sheet_id, 'Changed line ' + x.l.seq + ' of ' + fullName(x.s.first_name, x.s.last_name) + '\'s expense sheet.');
    return lineOut(r);
  });
}
// kernel: expenseSheets.removeLine
async function removeLine(ctx, lineId) {
  var x = await lineFor(ctx, lineId, 'write');
  ensureOpen(await lockDate(pool, x.l.sheet_id), dayStr(x.l.date), 'This line can no longer be removed');
  await pool.query('UPDATE expense_sheet_topups SET line_id = NULL WHERE line_id = $1', [lineId]);
  await pool.query('DELETE FROM expense_sheet_lines WHERE id = $1', [lineId]);
  if (x.l.receipt_key) await fileStore.del(x.l.receipt_key);
  await audit(pool, ctx, 'expensesheet.line.remove', 'expense_sheet', x.l.sheet_id,
    'Removed line ' + x.l.seq + ' (GHS ' + money(x.l.amount) + ', ' + x.l.kind + ') from ' + fullName(x.s.first_name, x.s.last_name) + '\'s expense sheet.');
  return { ok: true };
}
// A receipt: added or replaced while the line is not locked.
async function attachReceipt(ctx, lineId, file) {
  var x = await lineFor(ctx, lineId, 'write');
  ensureOpen(await lockDate(pool, x.l.sheet_id), dayStr(x.l.date), 'Its receipt can no longer be changed');
  if (!file || !file.buffer || !file.buffer.length) fail('invalid', 'Choose a photo or PDF of the receipt.');
  var key = await fileStore.put(file.originalname, file.buffer, file.mimetype);
  await pool.query('UPDATE expense_sheet_lines SET receipt_key = $1, receipt_name = $2, receipt_type = $3, updated_at = now() WHERE id = $4', [key, clip(file.originalname || 'receipt', 120), file.mimetype || '', lineId]);
  if (x.l.receipt_key) await fileStore.del(x.l.receipt_key);
  return { ok: true };
}
async function receiptFile(ctx, lineId) {
  var x = await lineFor(ctx, lineId);
  if (!x.l.receipt_key) fail('notfound', 'This line has no receipt.');
  return { key: x.l.receipt_key, name: x.l.receipt_name || 'receipt' };
}

// ── checks ────────────────────────────────────────────────────────────
// kernel: expenseSheets.check — the balance up to a date confirmed.
async function check(ctx, sheetId, p) {
  var x = await sheetFor(ctx, sheetId, 'check');
  var kind = V.oneOf(p.kind || (x.a.supervise ? 'supervisor' : 'accountant'), ['supervisor', 'accountant'], 'Kind');
  if (kind === 'accountant' && !x.a.manage) fail('forbidden', 'Only finance can check as the accountant.');
  var upto = V.date(p.uptoDate || today(), 'Checked up to');
  if (upto > today()) fail('invalid', 'A sheet can only be checked up to today.');
  var counted = p.counted === undefined || p.counted === null || p.counted === '' ? null : money(p.counted);
  return withTransaction(async function (client) {
    await client.query('SELECT id FROM expense_sheets WHERE id = $1 FOR UPDATE', [sheetId]);
    var locked = await lockDate(client, sheetId);
    if (locked && upto < locked) fail('invalid', 'This sheet is already checked up to ' + locked + '.');
    var bal = money((await client.query("SELECT coalesce(sum(CASE WHEN kind = 'funding' THEN amount ELSE -amount END), 0) AS b FROM expense_sheet_lines WHERE sheet_id = $1 AND date <= $2", [sheetId, upto])).rows[0].b);
    var n = (await client.query('SELECT count(*)::int AS n FROM expense_sheet_checks WHERE sheet_id = $1', [sheetId])).rows[0].n;
    var me = fullName(ctx.employee.first_name, ctx.employee.last_name);
    var c = (await client.query(
      'INSERT INTO expense_sheet_checks (sheet_id, kind, upto_date, balance, counted, code, note, by_id, by_initials) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [sheetId, kind, upto, bal, counted, 'C' + String(n + 1).padStart(2, '0'), clip(p.note, 300), ctx.employee.id, initialsOf(me)])).rows[0];
    var diff = counted === null ? null : money(counted - bal);
    await notify(client, x.s.employee_id, 'Your expense sheet was checked',
      me + ' checked it up to ' + upto + ' at a balance of GHS ' + bal + (diff ? ' (cash counted differs by GHS ' + diff + ')' : '') + '.', 'expensesheet:' + sheetId);
    await audit(client, ctx, 'expensesheet.check', 'expense_sheet', sheetId,
      'Checked ' + fullName(x.s.first_name, x.s.last_name) + '\'s expense sheet up to ' + upto + ' (' + kind + ', balance GHS ' + bal + ').');
    return checkOut(Object.assign(c, { first_name: ctx.employee.first_name, last_name: ctx.employee.last_name }));
  });
}
// kernel: expenseSheets.undoCheck — finance, the latest check only.
async function undoCheck(ctx, checkId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(checkId))) fail('notfound', 'Check not found.');
  var c = (await pool.query('SELECT * FROM expense_sheet_checks WHERE id = $1', [checkId])).rows[0];
  if (!c) fail('notfound', 'Check not found.');
  var x = await sheetFor(ctx, c.sheet_id, 'manage');
  var latest = (await pool.query('SELECT id FROM expense_sheet_checks WHERE sheet_id = $1 ORDER BY upto_date DESC, created_at DESC LIMIT 1', [c.sheet_id])).rows[0];
  if (latest.id !== c.id) fail('invalid', 'Only the latest check can be undone.');
  await pool.query('DELETE FROM expense_sheet_checks WHERE id = $1', [checkId]);
  await audit(pool, ctx, 'expensesheet.uncheck', 'expense_sheet', c.sheet_id, 'Undid check ' + c.code + ' of ' + fullName(x.s.first_name, x.s.last_name) + '\'s expense sheet.');
  return { ok: true };
}

// ── top-ups ───────────────────────────────────────────────────────────
// kernel: expenseSheets.requestTopup — the officer asks finance for money.
async function requestTopup(ctx, sheetId, p) {
  var x = await sheetFor(ctx, sheetId);
  if (!x.a.own) fail('forbidden', 'Only the sheet\'s officer can ask for a top-up.');
  if (x.s.status !== 'open') fail('invalid', 'This expense sheet is closed.');
  var amount = money(p.amount);
  if (!(amount > 0) || amount > 10000000) fail('invalid', 'Enter the amount you need.');
  var reason = clip(p.reason, 300);
  var t = (await pool.query('INSERT INTO expense_sheet_topups (sheet_id, amount, reason, requested_by) VALUES ($1,$2,$3,$4) RETURNING *', [sheetId, amount, reason, ctx.employee.id])).rows[0];
  var who = fullName(x.s.first_name, x.s.last_name);
  var people = await financePeople();
  for (var i = 0; i < people.length; i++) {
    if (people[i] !== ctx.employee.id) await notify(pool, people[i], who + ' asks for a top-up of GHS ' + amount, reason || 'For their expense sheet.', 'expensesheet:' + sheetId);
  }
  await audit(pool, ctx, 'expensesheet.topup', 'expense_sheet', sheetId, who + ' asked for a top-up of GHS ' + amount + '.');
  return topupOut(t);
}
// kernel: expenseSheets.decideTopup — approving adds the money to the sheet.
async function decideTopup(ctx, topupId, p) {
  if (!/^[0-9a-f-]{36}$/i.test(String(topupId))) fail('notfound', 'Top-up not found.');
  var t = (await pool.query('SELECT * FROM expense_sheet_topups WHERE id = $1', [topupId])).rows[0];
  if (!t) fail('notfound', 'Top-up not found.');
  var x = await sheetFor(ctx, t.sheet_id, 'manage');
  if (t.status !== 'pending') fail('invalid', 'This request has already been decided.');
  var approve = !!p.approve;
  var me = fullName(ctx.employee.first_name, ctx.employee.last_name);
  return withTransaction(async function (client) {
    var lineId = null;
    var amount = approve && p.amount ? money(p.amount) : money(t.amount);
    if (approve) {
      if (!(amount > 0)) fail('invalid', 'Enter the amount given.');
      var date = p.date ? V.date(p.date, 'Date') : today();
      if (date > today()) fail('invalid', 'The date cannot be in the future.');
      ensureOpen(await lockDate(client, t.sheet_id), date);
      var seq = (await client.query('SELECT coalesce(max(seq), 0) + 1 AS n FROM expense_sheet_lines WHERE sheet_id = $1', [t.sheet_id])).rows[0].n;
      lineId = (await client.query(
        "INSERT INTO expense_sheet_lines (sheet_id, kind, seq, date, amount, note, payee, source, created_by) VALUES ($1, 'funding', $2, $3, $4, $5, $6, 'topup', $7) RETURNING id",
        [t.sheet_id, seq, date, amount, clip('Top-up' + (t.reason ? ': ' + t.reason : ''), 300), me, ctx.employee.id])).rows[0].id;
    }
    var r = (await client.query("UPDATE expense_sheet_topups SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, line_id = $5, amount = $6 WHERE id = $1 RETURNING *",
      [topupId, approve ? 'approved' : 'declined', ctx.employee.id, clip(p.note, 300), lineId, amount])).rows[0];
    await notify(client, x.s.employee_id, approve ? 'Top-up of GHS ' + amount + ' approved' : 'Top-up request declined',
      approve ? me + ' added it to your expense sheet.' : (clip(p.note, 300) || me + ' declined it.'), 'expensesheet:' + t.sheet_id);
    await audit(client, ctx, 'expensesheet.topup.' + (approve ? 'approve' : 'decline'), 'expense_sheet', t.sheet_id,
      (approve ? 'Approved' : 'Declined') + ' a top-up of GHS ' + amount + ' for ' + fullName(x.s.first_name, x.s.last_name) + '.');
    return topupOut(Object.assign(r, { d_first: ctx.employee.first_name, d_last: ctx.employee.last_name }));
  });
}
async function cancelTopup(ctx, topupId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(topupId))) fail('notfound', 'Top-up not found.');
  var t = (await pool.query('SELECT * FROM expense_sheet_topups WHERE id = $1', [topupId])).rows[0];
  if (!t) fail('notfound', 'Top-up not found.');
  var x = await sheetFor(ctx, t.sheet_id);
  if (!x.a.own) fail('forbidden', 'Only the officer who asked can cancel it.');
  if (t.status !== 'pending') fail('invalid', 'This request has already been decided.');
  await pool.query("UPDATE expense_sheet_topups SET status = 'cancelled', decided_at = now() WHERE id = $1", [topupId]);
  return { ok: true };
}
// Everything waiting for finance, across sheets.
async function pendingTopups(ctx) {
  if (!ctx.can('expensesheet.manage')) fail('forbidden', 'Only finance decides top-ups (expensesheet.manage).');
  return (await pool.query(
    "SELECT t.*, s.employee_id, e.first_name, e.last_name, e.photo_key, e.photo_updated_at FROM expense_sheet_topups t JOIN expense_sheets s ON s.id = t.sheet_id " +
    "JOIN employees e ON e.id = s.employee_id WHERE t.status = 'pending' ORDER BY t.requested_at")).rows.map(function (t) {
    return Object.assign(topupOut(t), { sheetId: t.sheet_id, officer: { id: t.employee_id, name: fullName(t.first_name, t.last_name), photo: t.photo_key && t.photo_updated_at ? new Date(t.photo_updated_at).getTime() : null } });
  });
}

// ── sheets and lists (finance) ───────────────────────────────────────
// kernel: expenseSheets.create — a sheet for an officer, checked by their
// manager unless someone else is named.
async function create(ctx, p) {
  if (!ctx.can('expensesheet.manage')) fail('forbidden', 'Only finance can open expense sheets (expensesheet.manage).');
  var emp = (await pool.query("SELECT id, first_name, last_name, manager_id, status FROM employees WHERE id = $1", [p.employeeId])).rows[0];
  if (!emp || emp.status === 'terminated') fail('invalid', 'Choose the officer.');
  if ((await pool.query('SELECT 1 FROM expense_sheets WHERE employee_id = $1', [emp.id])).rows.length) fail('invalid', fullName(emp.first_name, emp.last_name) + ' already has an expense sheet.');
  var supervisorId = p.supervisorId || emp.manager_id || null;
  if (supervisorId === emp.id) supervisorId = null;
  var limit = p.floatLimit === undefined || p.floatLimit === null || p.floatLimit === '' ? null : money(p.floatLimit);
  if (limit !== null && limit < 0) fail('invalid', 'The usual float cannot be below zero.');
  var s = (await pool.query('INSERT INTO expense_sheets (employee_id, supervisor_id, float_limit, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [emp.id, supervisorId, limit, clip(p.note, 300), ctx.employee.id])).rows[0];
  await notify(pool, emp.id, 'You have an expense sheet', 'Record what you spend for the company and the money you receive. Open Finance → Expense sheets.', 'expensesheet:' + s.id);
  await audit(pool, ctx, 'expensesheet.create', 'expense_sheet', s.id, 'Opened an expense sheet for ' + fullName(emp.first_name, emp.last_name) + '.');
  return get(ctx, s.id);
}
// kernel: expenseSheets.update — supervisor, usual float, note, open/closed.
async function update(ctx, id, p) {
  var x = await sheetFor(ctx, id, 'manage');
  var supervisorId = p.supervisorId === undefined ? x.s.supervisor_id : (p.supervisorId || null);
  if (supervisorId === x.s.employee_id) fail('invalid', 'An officer cannot check their own sheet.');
  var limit = p.floatLimit === undefined ? x.s.float_limit : (p.floatLimit === null || p.floatLimit === '' ? null : money(p.floatLimit));
  var status = p.status === undefined ? x.s.status : V.oneOf(p.status, ['open', 'closed'], 'Status');
  await pool.query('UPDATE expense_sheets SET supervisor_id = $2, float_limit = $3, note = $4, status = $5, updated_at = now() WHERE id = $1',
    [id, supervisorId, limit, p.note === undefined ? x.s.note : clip(p.note, 300), status]);
  await audit(pool, ctx, 'expensesheet.update', 'expense_sheet', id, 'Updated ' + fullName(x.s.first_name, x.s.last_name) + '\'s expense sheet.');
  return get(ctx, id);
}
async function getLists(ctx) {
  if (!ctx.can('expensesheet.manage') && !ctx.can('expensesheet.read.all') &&
    !(await pool.query('SELECT 1 FROM expense_sheets WHERE employee_id = $1 OR supervisor_id = $1 LIMIT 1', [ctx.employee.id])).rows.length) fail('forbidden', 'You have no expense sheet.');
  return lists();
}
async function saveListItem(ctx, p) {
  if (!ctx.can('expensesheet.manage')) fail('forbidden', 'Only finance can change the lists (expensesheet.manage).');
  var kind = V.oneOf(p.kind, ['category', 'cost_centre'], 'List');
  var name = V.text(p.name, 'Name', kind === 'category' ? 60 : 80);
  var companyId = kind === 'cost_centre' && p.companyId ? p.companyId : null;
  if (p.id) {
    var r = (await pool.query('UPDATE expense_sheet_lists SET name = $2, company_id = $3, active = $4 WHERE id = $1 AND kind = $5 RETURNING id', [p.id, name, companyId, p.active !== false, kind])).rows[0];
    if (!r) fail('notfound', 'Not found.');
  } else {
    var dup = (await pool.query('SELECT id FROM expense_sheet_lists WHERE kind = $1 AND lower(name) = lower($2)', [kind, name])).rows[0];
    if (dup) await pool.query('UPDATE expense_sheet_lists SET active = true, company_id = coalesce($2, company_id) WHERE id = $1', [dup.id, companyId]);
    else await pool.query('INSERT INTO expense_sheet_lists (kind, name, company_id) VALUES ($1,$2,$3)', [kind, name, companyId]);
  }
  return lists();
}

// ── across every sheet (finance) ──────────────────────────────────────
// kernel: expenseSheets.report — the year by category and month, by cost
// centre and by officer; the cash out with officers and what is owed to them.
async function report(ctx, yearIn) {
  if (!ctx.can('expensesheet.manage') && !ctx.can('expensesheet.read.all')) fail('forbidden', 'Your role does not allow this (expensesheet.read.all).');
  var year = Number(yearIn) || Number(today().slice(0, 4));
  var rows = (await pool.query(
    "SELECT l.kind, l.amount, l.date, l.category, l.cost_centre, l.sheet_id FROM expense_sheet_lines l WHERE extract(year FROM l.date) = $1", [year])).rows;
  var months = new Array(12).fill(0), funded = new Array(12).fill(0), cats = {}, centres = {}, bySheet = {};
  rows.forEach(function (r) {
    var m = Number(dayStr(r.date).slice(5, 7)) - 1, amt = Number(r.amount);
    if (!bySheet[r.sheet_id]) bySheet[r.sheet_id] = { spent: 0, funded: 0 };
    if (r.kind === 'funding') { funded[m] = money(funded[m] + amt); bySheet[r.sheet_id].funded = money(bySheet[r.sheet_id].funded + amt); return; }
    months[m] = money(months[m] + amt);
    bySheet[r.sheet_id].spent = money(bySheet[r.sheet_id].spent + amt);
    var c = r.category || '—';
    if (!cats[c]) cats[c] = { name: c, months: new Array(12).fill(0), total: 0 };
    cats[c].months[m] = money(cats[c].months[m] + amt); cats[c].total = money(cats[c].total + amt);
    var cc = r.cost_centre || '—';
    if (!centres[cc]) centres[cc] = { name: cc, total: 0 };
    centres[cc].total = money(centres[cc].total + amt);
  });
  var sheets = await list(ctx);
  var byTotal = function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); };
  return {
    year: year,
    totals: {
      withOfficers: money(sheets.filter(function (s) { return s.balance > 0; }).reduce(function (t, s) { return t + s.balance; }, 0)),
      owedToOfficers: money(sheets.filter(function (s) { return s.balance < 0; }).reduce(function (t, s) { return t - s.balance; }, 0)),
      spent: money(months.reduce(function (a, b) { return a + b; }, 0)), funded: money(funded.reduce(function (a, b) { return a + b; }, 0))
    },
    monthSpent: months, monthFunded: funded,
    categories: Object.keys(cats).map(function (k) { return cats[k]; }).sort(byTotal),
    costCentres: Object.keys(centres).map(function (k) { return centres[k]; }).sort(byTotal),
    officers: sheets.map(function (s) { return { sheetId: s.id, name: s.employee.name, photo: s.employee.photo, employeeId: s.employee.id, spent: (bySheet[s.id] || {}).spent || 0, funded: (bySheet[s.id] || {}).funded || 0, balance: s.balance }; })
      .sort(function (a, b) { return b.spent - a.spent; })
  };
}

// kernel: expenseSheets.export — one table of every line the person may
// see (or one sheet's), as the accountant's consolidated sheet had it.
async function exportCsv(ctx, q) {
  var sheetIds;
  if (q.sheet) sheetIds = [(await sheetFor(ctx, q.sheet)).s.id];
  else sheetIds = (await list(ctx)).map(function (s) { return s.id; });
  var year = q.year ? Number(q.year) : null;
  var rows = sheetIds.length ? (await pool.query(
    'SELECT l.*, e.first_name, e.last_name FROM expense_sheet_lines l JOIN expense_sheets s ON s.id = l.sheet_id JOIN employees e ON e.id = s.employee_id ' +
    'WHERE l.sheet_id = ANY($1) ORDER BY e.first_name, e.last_name, l.sheet_id, l.date, l.seq', [sheetIds])).rows : [];
  var checks = sheetIds.length ? (await pool.query('SELECT * FROM expense_sheet_checks WHERE sheet_id = ANY($1) ORDER BY upto_date', [sheetIds])).rows : [];
  function stampFor(sheetId, date, kind) {
    var c = checks.filter(function (k) { return k.sheet_id === sheetId && k.kind === kind && dayStr(k.upto_date) >= date; })[0];
    return c ? c.by_initials + ' ' + c.code + ' ' + dayStr(c.upto_date) : '';
  }
  var head = ['Officer', 'Date', 'Kind', 'Amount', 'Qty', 'Unit price', 'Note', 'Cost centre', 'Asset', 'Payee', 'Category', 'Subcategory', 'Balance', 'No', 'Supervisor check', 'Accountant check'];
  var out = [head], run = {}, sheetOf = null;
  rows.forEach(function (r) {
    if (sheetOf !== r.sheet_id) { sheetOf = r.sheet_id; run[r.sheet_id] = 0; }
    run[r.sheet_id] = money(run[r.sheet_id] + signed(r));
    var d = dayStr(r.date);
    if (year && Number(d.slice(0, 4)) !== year) return;
    out.push([fullName(r.first_name, r.last_name), d, r.kind === 'funding' ? 'Funding' : 'Expense', money(r.amount), Number(r.qty), money(Number(r.amount) / Number(r.qty || 1)),
      r.note, r.cost_centre, r.asset, r.payee, r.category, r.subcategory, run[r.sheet_id], r.seq, stampFor(r.sheet_id, d, 'supervisor'), stampFor(r.sheet_id, d, 'accountant')]);
  });
  return out.map(function (row) {
    return row.map(function (v) { var s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',');
  }).join('\n') + '\n';
}

// The officer's own sheet, if they have one (for the menu and My space).
async function mine(ctx) {
  var r = (await pool.query('SELECT id FROM expense_sheets WHERE employee_id = $1', [ctx.employee.id])).rows[0];
  return { sheetId: r ? r.id : null };
}

module.exports = {
  list: list, get: get, mine: mine, create: create, update: update,
  addLine: addLine, updateLine: updateLine, removeLine: removeLine, attachReceipt: attachReceipt, receiptFile: receiptFile,
  check: check, undoCheck: undoCheck, requestTopup: requestTopup, decideTopup: decideTopup, cancelTopup: cancelTopup, pendingTopups: pendingTopups,
  getLists: getLists, saveListItem: saveListItem, report: report, exportCsv: exportCsv,
  // for the workbook import
  _sheetFor: sheetFor, _lockDate: lockDate, _money: money, _initialsOf: initialsOf, _ensureLists: ensureLists
};
