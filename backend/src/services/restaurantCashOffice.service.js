var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var fileStore = require('../lib/fileStore');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// The cash office (migration 0195). On the till, out of the drawer of the
// person signed in: cash put in the safe (a safe drop, a manager watching —
// signed in, or their PIN), and petty cash spent (what for, who it went to,
// a photo of the receipt; over the limit, a manager's PIN). Both come off
// what the drawer should hold when it is counted (restaurantPos.buildReport).
//
// In the back office, for a manager: the safe — what it should hold now,
// cash taken to the bank (the bank, the slip's number and its photo), the
// safe counted against what it should hold — and the petty cash spent, by
// what it was for. The end of the day (restaurantCloseDay) says the same.

var CATEGORIES = ['market', 'transport', 'gas', 'repairs', 'cleaning', 'staff', 'other'];
var DEFAULTS = { pettyLimit: 100, safeLimit: 5000, banks: [] };
var MAX_PHOTO = 4 * 1024 * 1024;

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : ''; }
function pos() { return require('./restaurantPos.service'); }

async function settingsOf(companyId, db) {
  var r = (await (db || pool).query("SELECT value FROM restaurant_more_settings WHERE company_id = $1 AND name = 'cashOffice'", [companyId])).rows[0];
  var v = (r && r.value) || {};
  return {
    pettyLimit: v.pettyLimit >= 0 ? round2(v.pettyLimit) : DEFAULTS.pettyLimit,
    safeLimit: v.safeLimit >= 0 ? round2(v.safeLimit) : DEFAULTS.safeLimit,
    banks: Array.isArray(v.banks) ? v.banks.map(function (b) { return text(b, 60); }).filter(Boolean).slice(0, 8) : []
  };
}

// A photo sent as a data URL (the till shrinks it first), kept in the file
// store: { key, type }. What it is comes from its first bytes.
async function photoFrom(dataUrl, name) {
  if (!dataUrl) return null;
  var m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl));
  if (!m) fail('invalid', 'That photo did not come through: take it again.');
  var buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > MAX_PHOTO) fail('invalid', 'That photo is too big: take it again.');
  var t = require('./shopQuotes.service').photoType(buf);
  if (!t) fail('invalid', 'Add a photo (JPG, PNG or WebP).');
  return { key: await fileStore.put(name + '.' + t.ext, buf, t.type), type: t.type };
}

// What the safe should hold: its last count, plus the drops since, less
// what went to the bank since.
async function safeOf(companyId, db) {
  db = db || pool;
  var last = (await db.query(
    "SELECT m.*, e.first_name, e.last_name FROM restaurant_safe_moves m LEFT JOIN employees e ON e.id = m.by_id WHERE m.company_id = $1 AND m.kind = 'count' ORDER BY m.created_at DESC LIMIT 1", [companyId])).rows[0] || null;
  var since = (await db.query(
    "SELECT coalesce(sum(amount) FILTER (WHERE kind = 'drop'), 0) AS drops, coalesce(sum(amount) FILTER (WHERE kind = 'deposit'), 0) AS deposits FROM restaurant_safe_moves " +
    "WHERE company_id = $1 AND kind <> 'count' AND ($2::timestamptz IS NULL OR created_at > $2)", [companyId, last ? last.created_at : null])).rows[0];
  var balance = round2((last ? Number(last.amount) : 0) + Number(since.drops) - Number(since.deposits));
  return {
    balance: balance,
    lastCount: last ? { at: last.created_at, amount: round2(last.amount), expected: last.expected == null ? null : round2(last.expected), by: nameOf(last.first_name, last.last_name) } : null
  };
}

// The drawer of the person signed in, and what it should hold now.
async function ownDrawer(client, session) {
  var d = (await client.query("SELECT * FROM restaurant_drawer_sessions WHERE cashier_id = $1 AND status = 'open' FOR UPDATE", [session.posEmployeeId])).rows[0];
  if (!d) fail('conflict', 'Open your cash drawer first: the cash comes out of it.');
  return { row: d, report: await pos().buildReport(d, client) };
}
function notMoreThan(amount, report) {
  if (amount > report.expected + 0.001) fail('invalid', 'Your drawer should hold only ' + report.expected.toFixed(2) + ': count it again.');
}

// POST /api/pos/cash-office/drop { amount, note, managerPin } — cash from
// the drawer into the safe.
async function drop(token, p, ip) {
  p = p || {};
  var session = await access.need(token, 'charge');
  var amount = round2(p.amount);
  if (!(amount > 0 && amount <= 1000000)) fail('invalid', 'How much goes in the safe? More than 0.');
  var m = await access.settingsManager(token, p.managerPin, ip).catch(function (e) {
    if (e.code === 'forbidden' && !p.managerPin) fail('forbidden', 'A manager watches cash go in the safe: type a manager\'s PIN.');
    throw e;
  });
  var out = await withTransaction(async function (client) {
    var d = await ownDrawer(client, session);
    notMoreThan(amount, d.report);
    var note = text(p.note, 140);
    var mv = (await client.query("INSERT INTO restaurant_drawer_movements (session_id, direction, amount, note, kind, by_id, approved_by) VALUES ($1, 'out', $2, $3, 'drop', $4, $5) RETURNING id",
      [d.row.id, amount, note || 'Into the safe', session.posEmployeeId, m.manager.id])).rows[0];
    await client.query("INSERT INTO restaurant_safe_moves (company_id, kind, amount, movement_id, note, by_id, witness_id) VALUES ($1, 'drop', $2, $3, $4, $5, $6)",
      [session.posCompanyId, amount, mv.id, note, session.posEmployeeId, m.manager.id]);
    var safe = await safeOf(session.posCompanyId, client);
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.safe_drop',
      summary: amount.toFixed(2) + ' put in the safe from the drawer, ' + nameOf(m.manager.first_name, m.manager.last_name) + ' watching. The safe should hold ' + safe.balance.toFixed(2) + '.', amount: amount, refType: 'drawer', refId: d.row.id });
    return { drawer: await pos().buildReport(d.row, client), safe: safe };
  });
  return out;
}

// POST /api/pos/cash-office/petty { amount, category, paidTo, note, photo,
// managerPin } — petty cash spent from the drawer.
async function petty(token, p, ip) {
  p = p || {};
  var session = await access.need(token, 'charge');
  var amount = round2(p.amount);
  if (!(amount > 0 && amount <= 100000)) fail('invalid', 'How much was spent? More than 0.');
  var category = CATEGORIES.indexOf(p.category) >= 0 ? p.category : fail('invalid', 'Pick what it was for.');
  var paidTo = text(p.paidTo, 80);
  if (paidTo.length < 2) fail('invalid', 'Who was it paid to? e.g. the gas man, the market.');
  var s = await settingsOf(session.posCompanyId);
  var approver = null;
  if (amount > s.pettyLimit || session.access.role === 'manager') {
    if (session.access.role !== 'manager' && !p.managerPin) fail('forbidden', 'Over ' + s.pettyLimit.toFixed(2) + ', a manager agrees to petty cash: type a manager\'s PIN.');
    approver = (await access.settingsManager(token, p.managerPin, ip)).manager;
  }
  var photo = await photoFrom(p.photo, 'petty-cash-receipt');
  return withTransaction(async function (client) {
    var d = await ownDrawer(client, session);
    notMoreThan(amount, d.report);
    var note = text(p.note, 140);
    await client.query("INSERT INTO restaurant_drawer_movements (session_id, direction, amount, note, kind, category, paid_to, photo, by_id, approved_by) VALUES ($1, 'out', $2, $3, 'petty', $4, $5, $6, $7, $8)",
      [d.row.id, amount, note, category, paidTo, photo, session.posEmployeeId, approver ? approver.id : null]);
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.petty_cash',
      summary: 'Petty cash: ' + amount.toFixed(2) + ' to ' + paidTo + ' (' + category + ')' + (note ? ', ' + note : '') + (photo ? ', receipt photographed' : ', no receipt') + (approver ? ', agreed by ' + nameOf(approver.first_name, approver.last_name) : '') + '.',
      amount: amount, refType: 'drawer', refId: d.row.id });
    return { drawer: await pos().buildReport(d.row, client) };
  });
}

function pettyOut(r) {
  return { id: r.id, at: r.created_at, amount: round2(r.amount), category: r.category, paidTo: r.paid_to, note: r.note, hasPhoto: !!r.photo,
    by: nameOf(r.by_first, r.by_last), approvedBy: nameOf(r.ok_first, r.ok_last) };
}
function safeMoveOut(r) {
  return { id: r.id, kind: r.kind, at: r.created_at, amount: round2(r.amount), expected: r.expected == null ? null : round2(r.expected),
    difference: r.kind === 'count' && r.expected != null ? round2(Number(r.amount) - Number(r.expected)) : null,
    bank: r.bank, reference: r.reference, note: r.note, hasPhoto: !!r.photo, by: nameOf(r.by_first, r.by_last), witness: nameOf(r.w_first, r.w_last) };
}

// Petty cash of some days, and the totals by what it was for.
async function pettyOf(companyId, from, to, db) {
  var rows = (await (db || pool).query(
    "SELECT m.*, b.first_name AS by_first, b.last_name AS by_last, k.first_name AS ok_first, k.last_name AS ok_last FROM restaurant_drawer_movements m " +
    'JOIN restaurant_drawer_sessions s ON s.id = m.session_id LEFT JOIN employees b ON b.id = coalesce(m.by_id, s.cashier_id) LEFT JOIN employees k ON k.id = m.approved_by ' +
    "WHERE s.company_id = $1 AND m.kind = 'petty' AND m.created_at >= $2::date AND m.created_at < $3::date + 1 ORDER BY m.created_at DESC LIMIT 500", [companyId, from, to])).rows;
  var by = {};
  rows.forEach(function (r) { by[r.category] = round2((by[r.category] || 0) + Number(r.amount)); });
  return {
    list: rows.map(pettyOut), total: round2(rows.reduce(function (a, r) { return a + Number(r.amount); }, 0)),
    byCategory: CATEGORIES.filter(function (c) { return by[c]; }).map(function (c) { return { category: c, amount: by[c] }; }),
    noReceipt: rows.filter(function (r) { return !r.photo; }).length
  };
}

// The day's cash for the end-of-day close.
async function dayOf(companyId, day) {
  var drops = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(amount), 0) AS sum FROM restaurant_safe_moves WHERE company_id = $1 AND kind = 'drop' AND created_at >= $2::date AND created_at < $2::date + 1", [companyId, day])).rows[0];
  var banked = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(amount), 0) AS sum FROM restaurant_safe_moves WHERE company_id = $1 AND kind = 'deposit' AND created_at >= $2::date AND created_at < $2::date + 1", [companyId, day])).rows[0];
  var p = await pettyOf(companyId, day, day);
  var safe = await safeOf(companyId);
  return { drops: { count: drops.n, amount: round2(drops.sum) }, banked: { count: banked.n, amount: round2(banked.sum) },
    petty: { count: p.list.length, amount: p.total, byCategory: p.byCategory, noReceipt: p.noReceipt }, safe: safe.balance };
}

// POST /api/pos/settings/cash-office { action: view|deposit|count|settings,
// … , managerPin } — the back office's cash office.
async function office(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  var who = nameOf(m.manager.first_name, m.manager.last_name);
  if (p.action === 'deposit') {
    var amount = round2(p.amount);
    var bank = text(p.bank, 60), reference = text(p.reference, 60);
    if (!(amount > 0)) fail('invalid', 'How much went to the bank? More than 0.');
    if (bank.length < 2) fail('invalid', 'Which bank?');
    var photo = await photoFrom(p.photo, 'bank-slip');
    await withTransaction(async function (client) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('safe:' || $1))", [company]);
      var safe = await safeOf(company, client);
      if (amount > safe.balance + 0.001) fail('invalid', 'The safe should hold only ' + safe.balance.toFixed(2) + ': count it first if that is wrong.');
      await client.query("INSERT INTO restaurant_safe_moves (company_id, kind, amount, bank, reference, photo, note, by_id) VALUES ($1, 'deposit', $2, $3, $4, $5, $6, $7)",
        [company, amount, bank, reference, photo, text(p.note, 140), m.manager.id]);
      await activity.log(client, { companyId: company, employeeId: m.manager.id, app: 'settings', action: 'cash.banked',
        summary: amount.toFixed(2) + ' taken from the safe to ' + bank + (reference ? ' (slip ' + reference + ')' : '') + (photo ? ', slip photographed' : '') + ' by ' + who + '.', amount: amount });
    });
  } else if (p.action === 'count') {
    var counted = round2(p.amount);
    if (!(counted >= 0) || p.amount === '' || p.amount == null) fail('invalid', 'Count the safe and type what it holds.');
    await withTransaction(async function (client) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('safe:' || $1))", [company]);
      var safe = await safeOf(company, client);
      await client.query("INSERT INTO restaurant_safe_moves (company_id, kind, amount, expected, note, by_id) VALUES ($1, 'count', $2, $3, $4, $5)",
        [company, counted, safe.balance, text(p.note, 140), m.manager.id]);
      var diff = round2(counted - safe.balance);
      await activity.log(client, { companyId: company, employeeId: m.manager.id, app: 'settings', action: diff ? 'cash.safe_off' : 'cash.safe_counted',
        summary: 'The safe counted by ' + who + ': ' + counted.toFixed(2) + ', against ' + safe.balance.toFixed(2) + ' it should hold' + (diff ? ' (' + (diff > 0 ? diff.toFixed(2) + ' over' : (-diff).toFixed(2) + ' short') + ').' : ': right.'), amount: counted });
    });
  } else if (p.action === 'settings') {
    var v = { pettyLimit: Math.max(0, Math.min(100000, round2(p.pettyLimit) || 0)), safeLimit: Math.max(0, Math.min(10000000, round2(p.safeLimit) || 0)),
      banks: (Array.isArray(p.banks) ? p.banks : []).map(function (b) { return text(b, 60); }).filter(Boolean).slice(0, 8) };
    await pool.query("INSERT INTO restaurant_more_settings (company_id, name, value) VALUES ($1, 'cashOffice', $2) ON CONFLICT (company_id, name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [company, v]);
  }
  var today = new Date().toISOString().slice(0, 10);
  var from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  var moves = (await pool.query(
    'SELECT m.*, b.first_name AS by_first, b.last_name AS by_last, w.first_name AS w_first, w.last_name AS w_last FROM restaurant_safe_moves m ' +
    'LEFT JOIN employees b ON b.id = m.by_id LEFT JOIN employees w ON w.id = m.witness_id WHERE m.company_id = $1 AND m.created_at >= $2::date ORDER BY m.created_at DESC LIMIT 300', [company, from])).rows;
  var safe = await safeOf(company);
  var settings = await settingsOf(company);
  return {
    safe: Object.assign(safe, { over: settings.safeLimit > 0 && safe.balance > settings.safeLimit }),
    moves: moves.map(safeMoveOut), petty: await pettyOf(company, from, today), settings: settings, categories: CATEGORIES, managerName: who
  };
}

// GET /api/pos/cash-office/photo/:kind/:id — a receipt or a slip, for the
// restaurant's own till.
async function photoOf(token, kind, id) {
  var session = await access.need(token, ['till', 'stock']);
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) fail('notfound', 'No such photo.');
  var r = kind === 'safe'
    ? (await pool.query('SELECT photo FROM restaurant_safe_moves WHERE id = $1 AND company_id = $2', [id, session.posCompanyId])).rows[0]
    : (await pool.query('SELECT m.photo FROM restaurant_drawer_movements m JOIN restaurant_drawer_sessions s ON s.id = m.session_id WHERE m.id = $1 AND s.company_id = $2', [id, session.posCompanyId])).rows[0];
  if (!r || !r.photo) fail('notfound', 'No such photo.');
  return { key: r.photo.key, name: (kind === 'safe' ? 'bank-slip' : 'receipt') + (r.photo.type === 'image/png' ? '.png' : r.photo.type === 'image/webp' ? '.webp' : '.jpg') };
}

module.exports = { CATEGORIES: CATEGORIES, settingsOf: settingsOf, safeOf: safeOf, drop: drop, petty: petty, office: office, dayOf: dayOf, pettyOf: pettyOf, photoOf: photoOf, photoFrom: photoFrom };
