var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var config = require('../config');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

// Staff ID cards (migration 0205): a card for each person, printed with
// their photo, name, role and a QR code. The code clocks them in and out at
// the kiosk (instead of their PIN — their face is still checked if they
// have one on file) and is scanned at the gate, where the guard sees who it
// is and whether the card is still good. One card is in force a person: a
// new one (lost, damaged) stops the one before, and a card can be stopped
// on its own (they left). The code is kept hashed, to find the card, and
// encrypted, to print it again; it is never shown on a screen.

var KEY = crypto.scryptSync(config.kioskPinPepper, 'bamboo-os-staff-card', 32);
var PREFIX = 'BPLID-';

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : ''; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function cardNo(n) { return 'ID-' + String(n).padStart(5, '0'); }
function hashOf(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
function encrypt(s) {
  var iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  var body = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function decrypt(s) {
  var raw = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
// What a scanner reads off a card: the code, maybe with stray spaces or a
// keyboard-wedge scanner's case changes undone.
function cleanCode(v) { var s = String(v || '').trim(); return /^bplid-/i.test(s) ? PREFIX + s.slice(6) : s; }

function canIssue(ctx) { return ctx.can('employee.write'); }
function canGate(ctx) { return ctx.can('visitor.manage') || ctx.can('employee.write'); }

var PEOPLE = 'SELECT e.id, e.code, e.first_name, e.last_name, e.position_title, e.status, e.photo_key, e.photo_updated_at, e.hire_date, d.name AS department, c.name AS company, c.code AS company_code, ' +
  'k.id AS card_id, k.number AS card_number, k.issued_at, k.printed_at, k.valid_until ' +
  'FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id ' +
  'LEFT JOIN staff_cards k ON k.employee_id = e.id AND k.revoked_at IS NULL ';

function personOut(r) {
  var valid = dayText(r.valid_until);
  return {
    id: r.id, code: r.code, name: nameOf(r.first_name, r.last_name), role: r.position_title || '', department: r.department || '', company: r.company || '', companyCode: r.company_code || '',
    photo: r.photo_key ? (r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : 1) : null, status: r.status,
    card: r.card_id ? { id: r.card_id, number: cardNo(r.card_number), issuedAt: r.issued_at, printedAt: r.printed_at, validUntil: valid, expired: !!(valid && valid < today()) } : null
  };
}

// Who is on site now: each person's last scan today, if it was in.
async function onSite() {
  return (await pool.query(
    "SELECT DISTINCT ON (s.employee_id) s.employee_id, s.direction, s.at, e.first_name, e.last_name FROM gate_scans s JOIN employees e ON e.id = s.employee_id " +
    "WHERE s.result = 'ok' AND s.at >= date_trunc('day', now()) ORDER BY s.employee_id, s.at DESC")).rows.filter(function (r) { return r.direction === 'in'; });
}

// GET /api/staff-cards — everyone with or without a card; the gate today.
async function overview(ctx) {
  if (!canIssue(ctx) && !canGate(ctx)) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var people = [];
  if (canIssue(ctx)) {
    var rows = (await pool.query(PEOPLE + "WHERE e.status = 'active' ORDER BY c.name NULLS LAST, d.name NULLS LAST, e.first_name, e.last_name")).rows;
    for (var i = 0; i < rows.length; i++) if (await visibleEmployee(ctx, await fetchEmployeeById(rows[i].id))) people.push(personOut(rows[i]));
  }
  var scans = (await pool.query(
    'SELECT s.*, e.first_name, e.last_name, e.photo_key, e.photo_updated_at, k.number AS card_number, b.first_name AS b_first, b.last_name AS b_last FROM gate_scans s ' +
    'LEFT JOIN employees e ON e.id = s.employee_id LEFT JOIN staff_cards k ON k.id = s.card_id LEFT JOIN employees b ON b.id = s.by_id ' +
    "WHERE s.at >= now() - interval '2 days' ORDER BY s.at DESC LIMIT 60")).rows.map(function (s) {
    return { id: s.id, at: s.at, direction: s.direction, result: s.result, gate: s.gate, by: nameOf(s.b_first, s.b_last),
      person: s.employee_id ? { id: s.employee_id, name: nameOf(s.first_name, s.last_name), photo: s.photo_key ? (s.photo_updated_at ? new Date(s.photo_updated_at).getTime() : 1) : null } : null,
      card: s.card_number ? cardNo(s.card_number) : null };
  });
  var here = await onSite();
  var revoked = Number((await pool.query("SELECT count(*) AS n FROM staff_cards WHERE revoked_at >= date_trunc('year', now())")).rows[0].n);
  var todayScans = scans.filter(function (s) { return dayText(s.at) === today(); });
  return {
    canIssue: canIssue(ctx), canGate: canGate(ctx), people: people, scans: scans,
    onSite: here.map(function (r) { return { id: r.employee_id, name: nameOf(r.first_name, r.last_name), since: r.at }; }),
    summary: {
      staff: people.length,
      carded: people.filter(function (p) { return p.card; }).length,
      noCard: people.filter(function (p) { return !p.card; }).length,
      notPrinted: people.filter(function (p) { return p.card && !p.card.printedAt; }).length,
      noPhoto: people.filter(function (p) { return !p.photo; }).length,
      revokedYear: revoked,
      onSite: here.length,
      scansToday: todayScans.length,
      turnedAway: todayScans.filter(function (s) { return s.result !== 'ok'; }).length
    }
  };
}

// POST /api/staff-cards { employeeIds, validUntil } — a new card for each;
// the one they had stops working.
async function issue(ctx, p) {
  if (!canIssue(ctx)) fail('forbidden', 'Your role does not allow this action (employee.write).');
  p = p || {};
  var ids = (Array.isArray(p.employeeIds) ? p.employeeIds : []).map(uuidOr).filter(Boolean).slice(0, 200);
  if (!ids.length) fail('invalid', 'Who are the cards for?');
  var valid = /^\d{4}-\d{2}-\d{2}$/.test(String(p.validUntil || '')) ? p.validUntil : null;
  if (valid && valid <= today()) fail('invalid', 'A card should be good beyond today.');
  for (var i = 0; i < ids.length; i++) {
    var e = (await pool.query('SELECT status FROM employees WHERE id = $1', [ids[i]])).rows[0];
    if (!e || e.status !== 'active') fail('invalid', 'Only people who work here get a card.');
    if (!(await visibleEmployee(ctx, await fetchEmployeeById(ids[i])))) fail('forbidden', 'That person is outside the people you can see.');
  }
  var made = [];
  await withTransaction(async function (db) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('staff_cards'))");
    for (var j = 0; j < ids.length; j++) {
      var replaced = (await db.query("UPDATE staff_cards SET revoked_at = now(), revoked_by = $2, revoke_reason = 'Replaced by a new card' WHERE employee_id = $1 AND revoked_at IS NULL RETURNING number", [ids[j], me(ctx)])).rows[0];
      var n = (await db.query('SELECT coalesce(max(number), 1000) + 1 AS n FROM staff_cards')).rows[0].n;
      var code = PREFIX + crypto.randomBytes(15).toString('base64url');
      var row = (await db.query('INSERT INTO staff_cards (number, employee_id, token_hash, token_enc, valid_until, issued_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [n, ids[j], hashOf(code), encrypt(code), valid, me(ctx)])).rows[0];
      await audit(db, ctx, 'card.issue', 'staff_card', row.id, 'Card ' + cardNo(n) + ' issued' + (replaced ? ', replacing ' + cardNo(replaced.number) : '') + '.');
      made.push(row.id);
    }
  });
  return { issued: made.length, cardIds: made };
}

// POST /api/staff-cards/print { cardIds } — what to print: each card's
// person and its code (for the QR). Marks them printed.
async function print(ctx, p) {
  if (!canIssue(ctx)) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var ids = ((p && p.cardIds) || []).map(uuidOr).filter(Boolean).slice(0, 200);
  if (!ids.length) fail('invalid', 'Which cards?');
  var rows = (await pool.query(PEOPLE.replace('LEFT JOIN staff_cards k ON k.employee_id = e.id AND k.revoked_at IS NULL ', 'JOIN staff_cards k ON k.employee_id = e.id ') + 'WHERE k.id = ANY($1::uuid[]) AND k.revoked_at IS NULL ORDER BY e.first_name, e.last_name', [ids])).rows;
  var enc = {};
  (await pool.query('SELECT id, token_enc FROM staff_cards WHERE id = ANY($1::uuid[])', [ids])).rows.forEach(function (r) { enc[r.id] = r.token_enc; });
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (!(await visibleEmployee(ctx, await fetchEmployeeById(rows[i].id)))) continue;
    var person = personOut(rows[i]);
    person.qr = decrypt(enc[rows[i].card_id]);
    person.hiredOn = dayText(rows[i].hire_date);
    out.push(person);
  }
  if (!out.length) fail('notfound', 'Those cards are no longer in force.');
  await pool.query('UPDATE staff_cards SET printed_at = now() WHERE id = ANY($1::uuid[])', [out.map(function (c) { return c.card.id; })]);
  await audit(pool, ctx, 'card.print', 'staff_card', out[0].card.id, out.length + ' card(s) printed: ' + out.map(function (c) { return c.card.number; }).join(', ') + '.');
  var company = (await pool.query("SELECT name, legal_name, phone, address FROM companies WHERE code = 'BPL'")).rows[0] || {};
  return { cards: out, returnTo: { name: company.legal_name || company.name || '', phone: company.phone || '', address: company.address || '' } };
}

// POST /api/staff-cards/:id/revoke { reason }
async function revoke(ctx, id, p) {
  if (!canIssue(ctx)) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var k = (await pool.query('SELECT * FROM staff_cards WHERE id = $1', [uuidOr(id)])).rows[0];
  if (!k) fail('notfound', 'That card is gone.');
  if (k.revoked_at) fail('conflict', 'That card has been stopped already.');
  var reason = text(p && p.reason, 200);
  if (reason.length < 3) fail('invalid', 'Why? e.g. lost, left the company.');
  if (!(await visibleEmployee(ctx, await fetchEmployeeById(k.employee_id)))) fail('forbidden', 'That person is outside the people you can see.');
  await pool.query('UPDATE staff_cards SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1', [k.id, me(ctx), reason]);
  await audit(pool, ctx, 'card.revoke', 'staff_card', k.id, 'Card ' + cardNo(k.number) + ' stopped: ' + reason);
  return { ok: true };
}

// The card a code belongs to, and whether it is good: ok, revoked (stopped
// or replaced), expired, inactive (they no longer work here) or unknown.
async function lookup(code) {
  var c = cleanCode(code);
  if (c.indexOf(PREFIX) !== 0 || c.length < 20 || c.length > 60) return { result: 'unknown', card: null, emp: null };
  var k = (await pool.query('SELECT * FROM staff_cards WHERE token_hash = $1', [hashOf(c)])).rows[0];
  if (!k) return { result: 'unknown', card: null, emp: null };
  var emp = (await pool.query(PEOPLE.replace('LEFT JOIN staff_cards k ON k.employee_id = e.id AND k.revoked_at IS NULL ', 'LEFT JOIN staff_cards k ON k.id = $2 ') + 'WHERE e.id = $1', [k.employee_id, k.id])).rows[0];
  var result = k.revoked_at ? 'revoked' : !emp || emp.status !== 'active' ? 'inactive' : (k.valid_until && dayText(k.valid_until) < today()) ? 'expired' : 'ok';
  return { result: result, card: k, emp: emp };
}

// POST /api/staff-cards/scan { code, direction, gate } — at the gate.
async function scan(ctx, p) {
  if (!canGate(ctx)) fail('forbidden', 'Your role does not allow this action (visitor.manage).');
  p = p || {};
  var direction = p.direction === 'out' ? 'out' : 'in';
  var found = await lookup(p.code);
  var last = found.emp ? (await pool.query("SELECT direction, at FROM gate_scans WHERE employee_id = $1 AND result = 'ok' ORDER BY at DESC LIMIT 1", [found.emp.id])).rows[0] : null;
  var row = (await pool.query('INSERT INTO gate_scans (card_id, employee_id, direction, result, gate, by_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, at',
    [found.card ? found.card.id : null, found.emp ? found.emp.id : null, direction, found.result, text(p.gate, 60), me(ctx)])).rows[0];
  if (found.result !== 'ok') await audit(pool, ctx, 'card.refused', 'staff_card', found.card ? found.card.id : null, 'A card was turned away at the gate (' + found.result + ')' + (found.emp ? ': ' + nameOf(found.emp.first_name, found.emp.last_name) : '') + '.');
  return {
    id: row.id, at: row.at, direction: direction, result: found.result,
    person: found.emp ? Object.assign(personOut(found.emp), { card: found.card ? { number: cardNo(found.card.number), validUntil: dayText(found.card.valid_until), revokedAt: found.card.revoked_at, reason: found.card.revoke_reason } : null }) : null,
    last: last ? { direction: last.direction, at: last.at } : null
  };
}

module.exports = { overview: overview, issue: issue, print: print, revoke: revoke, scan: scan, lookup: lookup, cleanCode: cleanCode, PREFIX: PREFIX, cardNo: cardNo };
