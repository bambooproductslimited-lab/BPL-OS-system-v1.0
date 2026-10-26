var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Notes for the team on the till (migration 0193) — Square Team's
// announcements: a manager writes one ("No tilapia today", "Party of 20 at
// 8"), for a day or up to two weeks, urgent or good news if they like;
// whoever signs in to the till next sees the notes they have not read and
// taps "Got it". The manager sees who has read each and who has not (the
// people with a role on the till).

var MAX_DAYS = 14, MAX_LEN = 500, TONES = ['info', 'urgent', 'good'];

function text(v, max) { return String(v == null ? '' : v).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max); }
function nameOf(e) { return e ? (e.first_name + ' ' + (e.last_name || '')).trim() : ''; }

function noteOut(r, me) {
  return {
    id: r.id, body: r.body, tone: r.tone, pinned: r.pinned, until: r.until, at: r.created_at, by: r.by_name || '',
    read: me ? !!r.read_at : undefined
  };
}
var LIVE = 'n.company_id = $1 AND n.removed_at IS NULL AND n.until > now()';

// GET /api/pos/team-notes — the notes up now, and which this person has read.
async function mine(token) {
  var s = await access.need(token, ['till', 'kds', 'delivery', 'stock']);
  var rows = (await pool.query(
    "SELECT n.*, e.first_name || ' ' || coalesce(e.last_name, '') AS by_name, r.read_at FROM restaurant_team_notes n LEFT JOIN employees e ON e.id = n.created_by " +
    'LEFT JOIN restaurant_team_note_reads r ON r.note_id = n.id AND r.employee_id = $2 WHERE ' + LIVE + ' ORDER BY n.pinned DESC, n.created_at DESC LIMIT 20', [s.posCompanyId, s.posEmployeeId])).rows;
  var notes = rows.map(function (r) { return noteOut(r, true); });
  return { notes: notes, unread: notes.filter(function (n) { return !n.read; }).length, canWrite: s.access.role === 'manager' };
}
// POST /api/pos/team-notes/read { ids } — "Got it".
async function read(token, ids) {
  var s = await access.need(token, ['till', 'kds', 'delivery', 'stock']);
  ids = (Array.isArray(ids) ? ids : []).filter(function (id) { return /^[0-9a-f-]{36}$/i.test(String(id)); }).slice(0, 50);
  if (ids.length) {
    await pool.query(
      'INSERT INTO restaurant_team_note_reads (note_id, employee_id) SELECT id, $3 FROM restaurant_team_notes WHERE company_id = $1 AND id = ANY($2::uuid[]) ON CONFLICT DO NOTHING',
      [s.posCompanyId, ids, s.posEmployeeId]);
  }
  return mine(token);
}

// POST /api/pos/team-notes/manage { action: list | add | remove | pin,
// body, tone, days, id } — a manager: every note of the last two weeks with
// who has read it.
async function manage(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  if (p.action === 'add') {
    var body = text(p.body, MAX_LEN);
    if (body.length < 3) fail('invalid', 'Write the note for the team.');
    var days = Math.round(Number(p.days) || 1);
    if (!(days >= 1 && days <= MAX_DAYS)) fail('invalid', 'Up for 1 to ' + MAX_DAYS + ' days.');
    var tone = TONES.indexOf(p.tone) >= 0 ? p.tone : 'info';
    // Until the end of the last day (Ghana: UTC).
    var until = new Date(); until.setUTCHours(23, 59, 59, 0); until = new Date(until.getTime() + (days - 1) * 86400000);
    var row = (await pool.query('INSERT INTO restaurant_team_notes (company_id, body, tone, until, pinned, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [company, body, tone, until, !!p.pinned, m.manager.id])).rows[0];
    // Whoever wrote it has read it.
    await pool.query('INSERT INTO restaurant_team_note_reads (note_id, employee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.id, m.manager.id]);
    await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'till', action: 'till.team_note', summary: 'Note for the team: “' + body.slice(0, 120) + (body.length > 120 ? '…' : '') + '”.' });
  } else if (p.action === 'remove' || p.action === 'pin') {
    var n = (await pool.query('SELECT * FROM restaurant_team_notes WHERE id = $1 AND company_id = $2', [p.id, company])).rows[0];
    if (!n) fail('notfound', 'That note is gone.');
    if (p.action === 'remove') await pool.query('UPDATE restaurant_team_notes SET removed_at = now() WHERE id = $1', [n.id]);
    else await pool.query('UPDATE restaurant_team_notes SET pinned = NOT pinned WHERE id = $1', [n.id]);
  }
  var staff = (await pool.query(
    "SELECT e.id, e.first_name, e.last_name, s.role FROM restaurant_till_staff s JOIN employees e ON e.id = s.employee_id WHERE s.company_id = $1 AND e.status = 'active' ORDER BY e.first_name", [company])).rows;
  var rows = (await pool.query(
    "SELECT n.*, e.first_name || ' ' || coalesce(e.last_name, '') AS by_name FROM restaurant_team_notes n LEFT JOIN employees e ON e.id = n.created_by " +
    "WHERE n.company_id = $1 AND n.removed_at IS NULL AND n.until > now() - interval '14 days' ORDER BY (n.until > now()) DESC, n.pinned DESC, n.created_at DESC LIMIT 30", [company])).rows;
  var reads = rows.length ? (await pool.query('SELECT note_id, employee_id, read_at FROM restaurant_team_note_reads WHERE note_id = ANY($1::uuid[])', [rows.map(function (r) { return r.id; })])).rows : [];
  var notes = rows.map(function (r) {
    var mineReads = reads.filter(function (x) { return x.note_id === r.id; });
    var readIds = new Set(mineReads.map(function (x) { return x.employee_id; }));
    return Object.assign(noteOut(r), {
      live: new Date(r.until) > new Date(),
      readBy: staff.filter(function (e) { return readIds.has(e.id); }).map(function (e) { var x = mineReads.find(function (y) { return y.employee_id === e.id; }); return { name: nameOf(e), at: x.read_at }; }),
      notYet: staff.filter(function (e) { return !readIds.has(e.id); }).map(function (e) { return nameOf(e); })
    });
  });
  return { notes: notes, staff: staff.length, managerName: nameOf(m.manager), maxDays: MAX_DAYS };
}

module.exports = { mine: mine, read: read, manage: manage, MAX_DAYS: MAX_DAYS };
