var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Bank reconciliation (Finance → Bank reconciliation; migration 0198): each
// company's bank, Mobile Money and cash accounts; the bank's statement
// imported from its CSV (the columns found by their names, or chosen by
// hand); each line matched to the money already recorded in the OS — a
// customer's payment on an invoice, a supplier bill paid, a salary advance
// or a pay run paid out, a restaurant's takings banked from its till — by
// itself when there is one obvious match, or picked from the likely ones;
// what has no record (bank charges, interest, a transfer between our own
// accounts) explained in a word. Reconciled up to a day once nothing is
// left open before it.

var KINDS = ['bank', 'mobile_money', 'cash'];
var CATEGORIES = ['bank_charges', 'interest', 'transfer', 'owner', 'loan', 'tax', 'sales', 'refund', 'other'];
var DAY = /^\d{4}-\d{2}-\d{2}$/;
var MAX_CSV = 2 * 1024 * 1024, MAX_ROWS = 5000;
var WINDOW = 10; // days either side a match is looked for

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function money(n) { return 'GHS ' + round2(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : ''; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function need(ctx) { if (!ctx.can('bank.manage')) fail('forbidden', 'Your role does not allow this action (bank.manage).'); }
function words(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(function (w) { return w.length >= 4; }); }

// ── Reading a statement ──

// One CSV text into rows of cells: quotes, commas or semicolons or tabs.
function parseCsv(src) {
  src = String(src || '').replace(/^﻿/, '');
  var first = src.split(/\r?\n/).find(function (l) { return l.trim(); }) || '';
  var counts = { ',': 0, ';': 0, '\t': 0 };
  var q = false;
  for (var c = 0; c < first.length; c++) { if (first[c] === '"') q = !q; else if (!q && counts[first[c]] !== undefined) counts[first[c]]++; }
  var sep = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
  var rows = [], row = [], cell = '', inQ = false;
  for (var i = 0; i < src.length; i++) {
    var ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(function (x) { return String(x).trim(); })) rows.push(row.map(function (x) { return String(x).trim(); }));
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(function (x) { return String(x).trim(); })) rows.push(row.map(function (x) { return String(x).trim(); }));
  return rows;
}

var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
// A statement's day, in the ways Ghana's banks write it (day before month).
function parseDay(s) {
  s = String(s || '').trim();
  var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  var y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})[-/. ]([A-Za-z]{3,4})[A-Za-z]*[-/., ]+(\d{2,4})/.exec(s))) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3]; }
  else if ((m = /^([A-Za-z]{3,4})[A-Za-z]*[ -](\d{1,2}),?[ -](\d{2,4})/.exec(s))) { mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3]; }
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; if (mo > 12 && d <= 12) { var t = d; d = mo; mo = t; } }
  else return null;
  if (y < 100) y += 2000;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y < 2100)) return null;
  var iso = y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  return dayText(new Date(iso + 'T00:00:00Z')) === iso ? iso : null;
}
// "1,250.00", "(300.00)", "300.00 DR", "GHS 45" → a number, or null.
function parseAmount(s) {
  s = String(s == null ? '' : s).trim();
  if (!s || s === '-') return null;
  var neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /\bDR\b|\bD$/i.test(s);
  var n = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || !/[0-9]/.test(s)) return null;
  return round2(neg ? -n : n);
}

var GUESS = {
  date: /^(transaction |txn |trans |posting |value |book(ing)? )?date|^date|^dt$/i,
  description: /description|narration|narrative|details|particulars|remarks?|memo|transaction type|^type$/i,
  reference: /ref(erence)?|cheque|chq|transaction id|txn id|^id$|receipt/i,
  amount: /^(amount|amt|value|transaction amount)( ?\(?ghs\)?)?$/i,
  debit: /debit|withdraw|money out|paid out|^dr$|^out$/i,
  credit: /credit|deposit|money in|paid in|^cr$|^in$/i,
  balance: /balance|bal\.?$/i
};
// Which column is which, from the header row's words.
function guessMapping(header) {
  var map = {};
  header.forEach(function (h, i) {
    var name = String(h || '').trim();
    ['date', 'balance', 'debit', 'credit', 'amount', 'reference', 'description'].forEach(function (k) {
      if (map[k] == null && GUESS[k].test(name) && Object.keys(map).every(function (o) { return map[o] !== i; })) map[k] = i;
    });
  });
  return map;
}
// The row that names the columns: the first with a date-like heading.
function headerIndex(rows) {
  for (var i = 0; i < Math.min(rows.length, 30); i++) {
    var m = guessMapping(rows[i]);
    if (m.date != null && (m.amount != null || m.debit != null || m.credit != null)) return i;
  }
  return -1;
}

function linesFrom(rows, start, map, flip) {
  var out = [], skipped = 0;
  for (var i = start; i < rows.length && out.length < MAX_ROWS; i++) {
    var r = rows[i];
    var day = parseDay(r[map.date]);
    var amount = null;
    if (map.amount != null) amount = parseAmount(r[map.amount]);
    else {
      var cr = map.credit != null ? parseAmount(r[map.credit]) : null, dr = map.debit != null ? parseAmount(r[map.debit]) : null;
      if (cr) amount = Math.abs(cr); else if (dr) amount = -Math.abs(dr);
    }
    if (amount != null && flip) amount = -amount;
    if (!day || !amount) { skipped++; continue; }
    out.push({
      day: day, amount: amount,
      description: text(map.description != null ? r[map.description] : '', 300),
      reference: text(map.reference != null ? r[map.reference] : '', 80),
      balance: map.balance != null ? parseAmount(r[map.balance]) : null
    });
  }
  return { lines: out, skipped: skipped };
}

async function accountOf(id) {
  var a = (await pool.query('SELECT a.*, c.name AS company_name, c.code AS company_code FROM bank_accounts a JOIN companies c ON c.id = a.company_id WHERE a.id = $1', [uuidOr(id)])).rows[0];
  if (!a) fail('notfound', 'That account is gone.');
  return a;
}
function accountOut(a, stats) {
  stats = stats || {};
  return {
    id: a.id, companyId: a.company_id, company: a.company_name, companyCode: a.company_code, name: a.name, kind: a.kind, bankName: a.bank_name, last4: a.last4, currency: a.currency,
    reconciledUntil: dayText(a.reconciled_until), reconciledBalance: a.reconciled_balance == null ? null : round2(a.reconciled_balance), active: a.active,
    lines: stats.n || 0, open: stats.open || 0, openIn: round2(stats.open_in), openOut: round2(stats.open_out), lastDay: dayText(stats.last_day), balance: stats.balance == null ? null : round2(stats.balance),
    matchedPct: stats.n ? Math.round((stats.n - (stats.open || 0)) / stats.n * 100) : null
  };
}
async function statsOf(ids) {
  var out = new Map();
  if (!ids.length) return out;
  (await pool.query(
    "SELECT account_id, count(*)::int AS n, count(*) FILTER (WHERE status = 'open')::int AS open, coalesce(sum(amount) FILTER (WHERE status = 'open' AND amount > 0), 0) AS open_in, " +
    "coalesce(-sum(amount) FILTER (WHERE status = 'open' AND amount < 0), 0) AS open_out, max(day) AS last_day, " +
    '(array_agg(balance ORDER BY day DESC, created_at DESC) FILTER (WHERE balance IS NOT NULL))[1] AS balance FROM bank_lines WHERE account_id = ANY($1::uuid[]) GROUP BY 1', [ids])).rows.forEach(function (r) { out.set(r.account_id, r); });
  return out;
}

// GET /api/bank
async function overview(ctx) {
  need(ctx);
  var rows = (await pool.query('SELECT a.*, c.name AS company_name, c.code AS company_code FROM bank_accounts a JOIN companies c ON c.id = a.company_id WHERE a.active ORDER BY c.name, a.name')).rows;
  var stats = await statsOf(rows.map(function (r) { return r.id; }));
  var accounts = rows.map(function (r) { return accountOut(r, stats.get(r.id)); });
  return {
    accounts: accounts,
    summary: { accounts: accounts.length, open: accounts.reduce(function (a, x) { return a + x.open; }, 0), openIn: round2(accounts.reduce(function (a, x) { return a + x.openIn; }, 0)), openOut: round2(accounts.reduce(function (a, x) { return a + x.openOut; }, 0)) },
    companies: (await pool.query("SELECT id, code, name FROM companies WHERE coalesce(status, 'active') = 'active' ORDER BY name")).rows,
    kinds: KINDS, categories: CATEGORIES, today: today()
  };
}

// POST /api/bank/accounts { id?, companyId, name, kind, bankName, last4, currency, active }
async function saveAccount(ctx, p) {
  need(ctx);
  p = p || {};
  var co = (await pool.query('SELECT id FROM companies WHERE id = $1', [uuidOr(p.companyId)])).rows[0];
  if (!co) fail('invalid', 'Whose account is it? Pick the company.');
  var name = text(p.name, 80);
  if (name.length < 2) fail('invalid', 'Name the account, e.g. Ecobank current.');
  var f = [co.id, name, KINDS.indexOf(p.kind) >= 0 ? p.kind : 'bank', text(p.bankName, 80), text(p.last4, 4).replace(/\D/g, ''), /^[A-Z]{3}$/.test(String(p.currency || '')) ? p.currency : 'GHS', p.active === undefined ? true : !!p.active];
  var id;
  if (p.id) {
    id = (await accountOf(p.id)).id;
    await pool.query('UPDATE bank_accounts SET company_id = $2, name = $3, kind = $4, bank_name = $5, last4 = $6, currency = $7, active = $8 WHERE id = $1', [id].concat(f));
  } else id = (await pool.query('INSERT INTO bank_accounts (company_id, name, kind, bank_name, last4, currency, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', f)).rows[0].id;
  await audit(pool, ctx, 'bank.account', 'bank_account', id, (p.id ? 'Changed' : 'Added') + ' the bank account ' + name + '.');
  return get(ctx, id, {});
}

// POST /api/bank/accounts/:id/preview { csv } — the columns found, the first rows read.
async function preview(ctx, id, p) {
  need(ctx);
  await accountOf(id);
  var csv = String((p || {}).csv || '');
  if (!csv.trim()) fail('invalid', 'That file is empty.');
  if (csv.length > MAX_CSV) fail('invalid', 'That statement is too big (2 MB of text at most): export a shorter period.');
  var rows = parseCsv(csv);
  var h = headerIndex(rows);
  var header = h >= 0 ? rows[h] : (rows[0] || []);
  var map = h >= 0 ? guessMapping(header) : {};
  var read = h >= 0 ? linesFrom(rows, h + 1, map, false) : { lines: [], skipped: rows.length };
  return { header: header, headerRow: h, mapping: map, sample: rows.slice(h + 1, h + 6), lines: read.lines.slice(0, 8), count: read.lines.length, skipped: read.skipped, found: h >= 0 };
}

// POST /api/bank/accounts/:id/import { csv, filename, mapping?, flip? }
async function importCsv(ctx, id, p) {
  need(ctx);
  p = p || {};
  var a = await accountOf(id);
  var csv = String(p.csv || '');
  if (!csv.trim()) fail('invalid', 'That file is empty.');
  if (csv.length > MAX_CSV) fail('invalid', 'That statement is too big (2 MB of text at most): export a shorter period.');
  var rows = parseCsv(csv);
  var h = headerIndex(rows);
  var map = p.mapping && typeof p.mapping === 'object' ? p.mapping : (h >= 0 ? guessMapping(rows[h]) : null);
  if (!map || map.date == null || (map.amount == null && map.debit == null && map.credit == null)) fail('invalid', 'Which column is the date, and which the amount? Choose them.');
  Object.keys(map).forEach(function (k) { if (map[k] === '' || map[k] == null) delete map[k]; else map[k] = Number(map[k]); });
  var read = linesFrom(rows, h + 1, map, !!p.flip);
  if (!read.lines.length) fail('invalid', 'No line could be read: check the date and amount columns.');
  var seen = {};
  var result = await withTransaction(async function (db) {
    var imp = (await db.query('INSERT INTO bank_imports (account_id, filename, rows, by_id) VALUES ($1, $2, $3, $4) RETURNING id', [a.id, text(p.filename, 120), read.lines.length, ctx.employee ? ctx.employee.id : null])).rows[0].id;
    var added = 0, dup = 0, from = null, to = null;
    for (var i = 0; i < read.lines.length; i++) {
      var l = read.lines[i];
      var base = [l.day, l.amount.toFixed(2), l.description.toLowerCase(), l.reference.toLowerCase(), l.balance == null ? '' : l.balance.toFixed(2)].join('|');
      seen[base] = (seen[base] || 0) + 1;
      var fp = crypto.createHash('sha1').update(base + '#' + seen[base]).digest('hex');
      var r = await db.query('INSERT INTO bank_lines (account_id, import_id, day, description, reference, amount, balance, fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id',
        [a.id, imp, l.day, l.description, l.reference, l.amount, l.balance, fp]);
      if (r.rowCount) { added++; from = !from || l.day < from ? l.day : from; to = !to || l.day > to ? l.day : to; } else dup++;
    }
    await db.query('UPDATE bank_imports SET added = $2, duplicates = $3, from_day = $4, to_day = $5 WHERE id = $1', [imp, added, dup, from, to]);
    return { importId: imp, added: added, duplicates: dup, skipped: read.skipped, from: from, to: to };
  });
  result.matched = await autoMatch(a.id, ctx);
  await pool.query('UPDATE bank_imports SET matched = $2 WHERE id = $1', [result.importId, result.matched]);
  await audit(pool, ctx, 'bank.import', 'bank_account', a.id, 'Imported a statement into ' + a.name + ': ' + result.added + ' new line(s), ' + result.duplicates + ' already there, ' + result.matched + ' matched by themselves.');
  var out = await get(ctx, a.id, {});
  out.done = result;
  return out;
}

// ── What a line can be matched to ──

// Money recorded in the OS for this account's company, near this day and
// for this amount (in for money in, out for money out), not matched yet.
async function candidatesFor(a, line, opts) {
  opts = opts || {};
  var amt = Math.abs(Number(line.amount)), day = dayText(line.day);
  var from = addDays(day, -(opts.window || WINDOW)), to = addDays(day, opts.window || WINDOW);
  var isBpl = a.company_code === 'BPL';
  var out = [];
  var taken = "NOT EXISTS (SELECT 1 FROM bank_lines bl WHERE bl.match_type = $5 AND bl.match_id = x.id)";
  if (Number(line.amount) > 0) {
    (await pool.query(
      'SELECT x.id, x.date AS day, x.amount, x.method, x.reference, i.invoice_no, c.name AS who FROM payments x JOIN invoices i ON i.id = x.invoice_id LEFT JOIN customers c ON c.id = x.customer_id ' +
      'WHERE abs(x.amount - $1) < 0.005 AND x.date BETWEEN $2 AND $3 AND (i.company_id = $4 OR ($6 AND i.company_id IS NULL)) AND ' + taken,
      [amt, from, to, a.company_id, 'payment', isBpl])).rows.forEach(function (r) {
      out.push({ type: 'payment', id: r.id, day: dayText(r.day), amount: round2(r.amount), ref: r.invoice_no, who: r.who || '', reference: r.reference || '', method: r.method || '' });
    });
    (await pool.query(
      "SELECT x.id, x.created_at::date AS day, x.amount, x.bank, x.reference, c.name AS who FROM restaurant_safe_moves x JOIN companies c ON c.id = x.company_id " +
      "WHERE x.kind = 'deposit' AND abs(x.amount - $1) < 0.005 AND x.created_at::date BETWEEN $2 AND $3 AND x.company_id = $4 AND " + taken,
      [amt, from, to, a.company_id, 'deposit'])).rows.forEach(function (r) {
      out.push({ type: 'deposit', id: r.id, day: dayText(r.day), amount: round2(r.amount), ref: r.bank || '', who: r.who, reference: r.reference || '' });
    });
  } else {
    (await pool.query(
      'SELECT x.id, x.paid_on AS day, x.amount, x.method, x.account, x.reference, b.number, b.supplier_name AS who FROM supplier_bill_payments x JOIN supplier_bills b ON b.id = x.bill_id ' +
      'WHERE abs(x.amount - $1) < 0.005 AND x.paid_on BETWEEN $2 AND $3 AND b.company_id = $4 AND ' + taken,
      [amt, from, to, a.company_id, 'bill_payment'])).rows.forEach(function (r) {
      out.push({ type: 'bill_payment', id: r.id, day: dayText(r.day), amount: round2(r.amount), ref: 'B-' + String(r.number).padStart(4, '0'), who: r.who, reference: r.reference || '', method: r.method || '', account: r.account || '' });
    });
    (await pool.query(
      "SELECT x.id, x.paid_at AS day, x.amount, x.paid_method AS method, x.paid_reference AS reference, x.number, e.first_name, e.last_name FROM salary_advances x JOIN employees e ON e.id = x.employee_id " +
      "JOIN departments d ON d.id = e.department_id WHERE x.status IN ('paid', 'repaid') AND abs(x.amount - $1) < 0.005 AND x.paid_at BETWEEN $2 AND $3 AND d.company_id = $4 AND " + taken,
      [amt, from, to, a.company_id, 'advance'])).rows.forEach(function (r) {
      out.push({ type: 'advance', id: r.id, day: dayText(r.day), amount: round2(r.amount), ref: 'SA-' + String(r.number).padStart(4, '0'), who: nameOf(r.first_name, r.last_name), reference: r.reference || '', method: r.method || '' });
    });
    (await pool.query(
      "SELECT x.id, x.pay_date AS day, x.run_no, s.net, s.n FROM pay_runs x JOIN (SELECT pay_run_id, sum(net_pay) AS net, count(*)::int AS n FROM payslips GROUP BY 1) s ON s.pay_run_id = x.id " +
      "WHERE x.status = 'paid' AND abs(s.net - $1) < 0.005 AND x.pay_date BETWEEN $2 AND $3 AND x.company_id = $4 AND " + taken,
      [amt, from, to, a.company_id, 'pay_run'])).rows.forEach(function (r) {
      out.push({ type: 'pay_run', id: r.id, day: dayText(r.day), amount: round2(r.net), ref: r.run_no, who: r.n + ' staff', reference: '' });
    });
  }
  // The likeliest first: the same reference, the nearest day, a name in the description.
  var desc = String(line.description || '').toLowerCase() + ' ' + String(line.reference || '').toLowerCase();
  var lineWords = words(desc);
  out.forEach(function (c) {
    var score = 100 - Math.abs(daysBetween(day, c.day)) * 6;
    if (c.reference && (desc.indexOf(c.reference.toLowerCase()) >= 0 || (line.reference && String(line.reference).toLowerCase() === c.reference.toLowerCase()))) score += 40;
    if (c.ref && desc.indexOf(String(c.ref).toLowerCase()) >= 0) score += 30;
    if (words(c.who).some(function (w) { return lineWords.indexOf(w) >= 0; })) score += 15;
    if (c.account && a.name && c.account.toLowerCase() === a.name.toLowerCase()) score += 10;
    c.score = score;
    c.days = daysBetween(day, c.day);
  });
  return out.sort(function (x, y) { return y.score - x.score; });
}

// Lines with one obvious match are matched by themselves: the only one with
// that amount within three days, or the only one with the same reference.
async function autoMatch(accountId, ctx) {
  var a = await accountOf(accountId);
  var lines = (await pool.query("SELECT * FROM bank_lines WHERE account_id = $1 AND status = 'open' ORDER BY day", [a.id])).rows;
  var n = 0;
  for (var i = 0; i < lines.length; i++) {
    var c = await candidatesFor(a, lines[i]);
    var near = c.filter(function (x) { return Math.abs(x.days) <= 3; });
    var byRef = c.filter(function (x) { return x.score >= 130; });
    var pick = byRef.length === 1 ? byRef[0] : near.length === 1 && c.filter(function (x) { return x.score >= near[0].score - 20; }).length === 1 ? near[0] : null;
    if (!pick) continue;
    var r = await pool.query("UPDATE bank_lines SET status = 'matched', match_type = $2, match_id = $3, auto = true, done_by = $4, done_at = now() WHERE id = $1 AND status = 'open' AND NOT EXISTS (SELECT 1 FROM bank_lines WHERE match_type = $2 AND match_id = $3)",
      [lines[i].id, pick.type, pick.id, ctx && ctx.employee ? ctx.employee.id : null]).catch(function (e) { if (e.code === '23505') return { rowCount: 0 }; throw e; });
    if (r.rowCount) n++;
  }
  return n;
}

// What a matched line stands for, in words.
async function describeMatches(lines) {
  var by = {};
  lines.forEach(function (l) { if (l.match_id) (by[l.match_type] = by[l.match_type] || []).push(l.match_id); });
  var out = new Map();
  var put = function (type, rows, fn) { rows.forEach(function (r) { out.set(type + ':' + r.id, fn(r)); }); };
  if (by.payment) put('payment', (await pool.query('SELECT x.id, x.date, x.amount, x.method, x.reference, i.invoice_no, c.name FROM payments x JOIN invoices i ON i.id = x.invoice_id LEFT JOIN customers c ON c.id = x.customer_id WHERE x.id = ANY($1::uuid[])', [by.payment])).rows,
    function (r) { return { type: 'payment', ref: r.invoice_no, who: r.name || '', day: dayText(r.date), amount: round2(r.amount), method: r.method || '', reference: r.reference || '' }; });
  if (by.bill_payment) put('bill_payment', (await pool.query('SELECT x.id, x.paid_on, x.amount, x.method, x.reference, b.number, b.supplier_name, b.id AS bill_id FROM supplier_bill_payments x JOIN supplier_bills b ON b.id = x.bill_id WHERE x.id = ANY($1::uuid[])', [by.bill_payment])).rows,
    function (r) { return { type: 'bill_payment', ref: 'B-' + String(r.number).padStart(4, '0'), who: r.supplier_name, day: dayText(r.paid_on), amount: round2(r.amount), method: r.method || '', reference: r.reference || '', billId: r.bill_id }; });
  if (by.advance) put('advance', (await pool.query('SELECT x.id, x.number, x.paid_at, x.amount, x.paid_method, x.paid_reference, e.first_name, e.last_name FROM salary_advances x JOIN employees e ON e.id = x.employee_id WHERE x.id = ANY($1::uuid[])', [by.advance])).rows,
    function (r) { return { type: 'advance', ref: 'SA-' + String(r.number).padStart(4, '0'), who: nameOf(r.first_name, r.last_name), day: dayText(r.paid_at), amount: round2(r.amount), method: r.paid_method || '', reference: r.paid_reference || '', advanceId: r.id }; });
  if (by.pay_run) put('pay_run', (await pool.query('SELECT x.id, x.run_no, x.pay_date, (SELECT sum(net_pay) FROM payslips WHERE pay_run_id = x.id) AS net, (SELECT count(*)::int FROM payslips WHERE pay_run_id = x.id) AS n FROM pay_runs x WHERE x.id = ANY($1::uuid[])', [by.pay_run])).rows,
    function (r) { return { type: 'pay_run', ref: r.run_no, who: r.n + ' staff', day: dayText(r.pay_date), amount: round2(r.net), reference: '', payRunId: r.id }; });
  if (by.deposit) put('deposit', (await pool.query('SELECT x.id, x.created_at, x.amount, x.bank, x.reference, c.name FROM restaurant_safe_moves x JOIN companies c ON c.id = x.company_id WHERE x.id = ANY($1::uuid[])', [by.deposit])).rows,
    function (r) { return { type: 'deposit', ref: r.bank || '', who: r.name, day: dayText(r.created_at), amount: round2(r.amount), reference: r.reference || '' }; });
  return out;
}

// GET /api/bank/accounts/:id?status=open|matched|explained|all&month=YYYY-MM&q=
async function get(ctx, id, q) {
  need(ctx);
  q = q || {};
  var a = await accountOf(id);
  var status = ['open', 'matched', 'explained', 'all'].indexOf(q.status) >= 0 ? q.status : 'all';
  var where = ['l.account_id = $1'], args = [a.id];
  if (status !== 'all') { args.push(status); where.push('l.status = $' + args.length); }
  if (/^\d{4}-\d{2}$/.test(String(q.month || ''))) { args.push(q.month + '-01'); where.push("l.day >= $" + args.length + "::date AND l.day < ($" + args.length + "::date + interval '1 month')"); }
  if (q.q) { args.push('%' + String(q.q).toLowerCase().slice(0, 60) + '%'); where.push('(lower(l.description) LIKE $' + args.length + ' OR lower(l.reference) LIKE $' + args.length + ')'); }
  var rows = (await pool.query('SELECT l.*, e.first_name, e.last_name FROM bank_lines l LEFT JOIN employees e ON e.id = l.done_by WHERE ' + where.join(' AND ') + ' ORDER BY l.day DESC, l.created_at DESC LIMIT 600', args)).rows;
  var matches = await describeMatches(rows);
  var stats = (await statsOf([a.id])).get(a.id);
  var sums = (await pool.query("SELECT count(*) FILTER (WHERE status = 'matched')::int AS matched, count(*) FILTER (WHERE status = 'explained')::int AS explained, count(*) FILTER (WHERE status = 'matched' AND auto)::int AS auto, " +
    'coalesce(sum(amount) FILTER (WHERE amount > 0), 0) AS inn, coalesce(-sum(amount) FILTER (WHERE amount < 0), 0) AS out, min(day) AS first FROM bank_lines WHERE account_id = $1', [a.id])).rows[0];
  var months = (await pool.query("SELECT to_char(day, 'YYYY-MM') AS m, count(*)::int AS n, count(*) FILTER (WHERE status = 'open')::int AS open FROM bank_lines WHERE account_id = $1 GROUP BY 1 ORDER BY 1 DESC LIMIT 24", [a.id])).rows;
  return {
    account: accountOut(a, stats), status: status, month: q.month || '',
    lines: rows.map(function (l) {
      return {
        id: l.id, day: dayText(l.day), description: l.description, reference: l.reference, amount: round2(l.amount), balance: l.balance == null ? null : round2(l.balance),
        status: l.status, auto: l.auto, category: l.category, note: l.note, by: nameOf(l.first_name, l.last_name), at: l.done_at,
        match: l.match_id ? matches.get(l.match_type + ':' + l.match_id) || { type: l.match_type, ref: '?', who: '' } : null,
        locked: !!(a.reconciled_until && dayText(l.day) <= dayText(a.reconciled_until))
      };
    }),
    summary: { matched: sums.matched, explained: sums.explained, auto: sums.auto, in: round2(sums.inn), out: round2(sums.out), first: dayText(sums.first), open: stats ? stats.open : 0 },
    months: months.map(function (m) { return { month: m.m, lines: m.n, open: m.open }; }),
    imports: (await pool.query('SELECT i.*, e.first_name, e.last_name FROM bank_imports i LEFT JOIN employees e ON e.id = i.by_id WHERE i.account_id = $1 ORDER BY i.created_at DESC LIMIT 8', [a.id])).rows.map(function (i) {
      return { id: i.id, filename: i.filename, added: i.added, duplicates: i.duplicates, matched: i.matched, from: dayText(i.from_day), to: dayText(i.to_day), by: nameOf(i.first_name, i.last_name), at: i.created_at };
    }),
    categories: CATEGORIES
  };
}

async function lineOf(id) {
  var l = (await pool.query('SELECT * FROM bank_lines WHERE id = $1', [uuidOr(id)])).rows[0];
  if (!l) fail('notfound', 'That statement line is gone.');
  var a = await accountOf(l.account_id);
  return { line: l, account: a };
}
function notLocked(x) {
  if (x.account.reconciled_until && dayText(x.line.day) <= dayText(x.account.reconciled_until)) fail('conflict', 'This line is in a reconciled period (up to ' + dayText(x.account.reconciled_until) + ').');
}

// GET /api/bank/lines/:id/candidates
async function candidates(ctx, id) {
  need(ctx);
  var x = await lineOf(id);
  return { line: { id: x.line.id, day: dayText(x.line.day), amount: round2(x.line.amount), description: x.line.description, reference: x.line.reference }, candidates: (await candidatesFor(x.account, x.line, { window: 21 })).slice(0, 12) };
}

// POST /api/bank/lines/:id/match { type, id }
async function match(ctx, id, p) {
  need(ctx);
  p = p || {};
  var x = await lineOf(id);
  notLocked(x);
  if (x.line.status !== 'open') fail('conflict', 'That line is ' + x.line.status + ' already: undo it first.');
  var c = (await candidatesFor(x.account, x.line, { window: 45 })).find(function (k) { return k.type === p.type && k.id === p.id; });
  if (!c) fail('invalid', 'That is not one of this line\'s possible matches (the same amount, near the same day, not matched yet).');
  try {
    await pool.query("UPDATE bank_lines SET status = 'matched', match_type = $2, match_id = $3, auto = false, category = NULL, done_by = $4, done_at = now() WHERE id = $1", [x.line.id, c.type, c.id, ctx.employee ? ctx.employee.id : null]);
  } catch (e) { if (e.code === '23505') fail('conflict', 'That is matched to another line already.'); throw e; }
  await audit(pool, ctx, 'bank.match', 'bank_line', x.line.id, x.account.name + ', ' + dayText(x.line.day) + ' ' + money(x.line.amount) + ': matched to ' + c.ref + (c.who ? ' · ' + c.who : '') + '.');
  return lineOut(x.line.id);
}
// POST /api/bank/lines/:id/explain { category, note }
async function explain(ctx, id, p) {
  need(ctx);
  p = p || {};
  var x = await lineOf(id);
  notLocked(x);
  if (x.line.status === 'matched') fail('conflict', 'That line is matched: undo it first.');
  var category = CATEGORIES.indexOf(p.category) >= 0 ? p.category : fail('invalid', 'What is it? Pick one.');
  var note = text(p.note, 200);
  if (category === 'other' && note.length < 3) fail('invalid', 'Say in a few words what it is.');
  await pool.query("UPDATE bank_lines SET status = 'explained', category = $2, note = $3, match_type = NULL, match_id = NULL, auto = false, done_by = $4, done_at = now() WHERE id = $1", [x.line.id, category, note, ctx.employee ? ctx.employee.id : null]);
  await audit(pool, ctx, 'bank.explain', 'bank_line', x.line.id, x.account.name + ', ' + dayText(x.line.day) + ' ' + money(x.line.amount) + ': ' + category + (note ? ' — ' + note : '') + '.');
  return lineOut(x.line.id);
}
// POST /api/bank/lines/:id/undo
async function undo(ctx, id) {
  need(ctx);
  var x = await lineOf(id);
  notLocked(x);
  await pool.query("UPDATE bank_lines SET status = 'open', match_type = NULL, match_id = NULL, category = NULL, note = '', auto = false, done_by = NULL, done_at = NULL WHERE id = $1", [x.line.id]);
  await audit(pool, ctx, 'bank.undo', 'bank_line', x.line.id, x.account.name + ', ' + dayText(x.line.day) + ' ' + money(x.line.amount) + ': back to open.');
  return lineOut(x.line.id);
}
async function lineOut(id) {
  var l = (await pool.query('SELECT l.*, e.first_name, e.last_name, a.reconciled_until FROM bank_lines l JOIN bank_accounts a ON a.id = l.account_id LEFT JOIN employees e ON e.id = l.done_by WHERE l.id = $1', [id])).rows[0];
  var m = await describeMatches([l]);
  return {
    id: l.id, day: dayText(l.day), description: l.description, reference: l.reference, amount: round2(l.amount), balance: l.balance == null ? null : round2(l.balance), status: l.status, auto: l.auto,
    category: l.category, note: l.note, by: nameOf(l.first_name, l.last_name), at: l.done_at, match: l.match_id ? m.get(l.match_type + ':' + l.match_id) || null : null,
    locked: !!(l.reconciled_until && dayText(l.day) <= dayText(l.reconciled_until))
  };
}

// POST /api/bank/accounts/:id/automatch — look again (after recording payments).
async function rematch(ctx, id) {
  need(ctx);
  var a = await accountOf(id);
  var n = await autoMatch(a.id, ctx);
  var out = await get(ctx, a.id, {});
  out.done = { matched: n };
  return out;
}

// POST /api/bank/accounts/:id/reconcile { until, balance }
async function reconcile(ctx, id, p) {
  need(ctx);
  p = p || {};
  var a = await accountOf(id);
  var until = DAY.test(String(p.until || '')) ? p.until : fail('invalid', 'Reconciled up to which day?');
  if (until > today()) fail('invalid', 'Not a day to come.');
  var open = (await pool.query("SELECT count(*)::int AS n FROM bank_lines WHERE account_id = $1 AND status = 'open' AND day <= $2", [a.id, until])).rows[0].n;
  if (open) fail('conflict', open === 1 ? '1 line up to that day is still open: match or explain it first.' : open + ' lines up to that day are still open: match or explain them first.');
  var last = (await pool.query('SELECT balance FROM bank_lines WHERE account_id = $1 AND day <= $2 AND balance IS NOT NULL ORDER BY day DESC, created_at DESC LIMIT 1', [a.id, until])).rows[0];
  var bal = p.balance === '' || p.balance == null ? (last ? round2(last.balance) : null) : round2(p.balance);
  if (bal != null && last && Math.abs(round2(last.balance) - bal) >= 0.01) fail('conflict', 'The statement shows ' + money(last.balance) + ' on that day, not ' + money(bal) + '.');
  await pool.query('UPDATE bank_accounts SET reconciled_until = $2, reconciled_balance = $3, reconciled_by = $4, reconciled_at = now() WHERE id = $1', [a.id, until, bal, ctx.employee ? ctx.employee.id : null]);
  await audit(pool, ctx, 'bank.reconcile', 'bank_account', a.id, a.name + ' reconciled up to ' + until + (bal != null ? ', balance ' + money(bal) : '') + '.');
  return get(ctx, a.id, {});
}

module.exports = {
  overview: overview, saveAccount: saveAccount, preview: preview, importCsv: importCsv, get: get, candidates: candidates, match: match, explain: explain, undo: undo,
  rematch: rematch, reconcile: reconcile, parseCsv: parseCsv, parseDay: parseDay, parseAmount: parseAmount, guessMapping: guessMapping, CATEGORIES: CATEGORIES
};
