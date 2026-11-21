var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var pinAuth = require('../lib/pinAuth');

// Signing in to My Jobs, the maintenance & IT team's phone app (frontend
// /myjobs, migration 0218), with a kiosk code: the 4-digit PIN each person
// clocks in with (kiosk.service.js; the tills use it too, lib/pinAuth.js).
//
// A 4-digit code alone is too little on the open internet, so — as a till
// needs its restaurant's link before anyone signs in with their PIN — a
// phone first needs the team code: 8 letters and digits the work order
// managers see on the Maintenance & IT dashboard (and in the team's link,
// which fills it in). It is typed once per phone. A new team code ends every
// sign-in made with the old one.
//
// A kiosk-code sign-in is not an OS account: it reaches only the person's
// own jobs (routes/myJobs.routes.js) — the list, moving a job given to them
// along, marking it or their routine done with photos, those photos — with
// no permissions at all (can() is always false). Wrong team codes and
// wrong kiosk codes count against the same per-address limit as the kiosk
// and the tills (pinAuth): five tries, then a five-minute wait.

var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: easy to read out
var CODE_LENGTH = 8;
var SESSION_DAYS = 30;
var TEAM_WRONG = 'That team code is not right. Ask your manager for the current one.';
var PIN_WRONG = 'That kiosk code did not work. Try again.';
var SIGN_IN_AGAIN = 'Sign in again with your kiosk code.';

function newCode() {
  var bytes = crypto.randomBytes(CODE_LENGTH), s = '';
  for (var i = 0; i < CODE_LENGTH; i++) s += ALPHABET[bytes[i] % ALPHABET.length]; // 256 is a multiple of 32: no bias
  return s;
}
function norm(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function shown(code) { return code.slice(0, 4) + '-' + code.slice(4); }
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function same(a, b) {
  var x = Buffer.from(sha(a)), y = Buffer.from(sha(b));
  return crypto.timingSafeEqual(x, y);
}
function nameOf(e) { return ((e.first_name || '') + ' ' + (e.last_name || '')).trim(); }

async function activeLink(db) {
  return (await (db || pool).query('SELECT * FROM myjobs_links WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1')).rows[0] || null;
}
function linkOut(l) { return { code: shown(l.code), createdAt: l.created_at }; }
function needManage(ctx) { if (!ctx.can('task.manage')) fail('forbidden', 'Your role does not allow this action (task.manage).'); }

// ── the managers' side ──────────────────────────────────────────────────

// GET /api/maint-work-orders/myjobs-team — the team code, made the first
// time it is asked for.
async function teamCode(ctx) {
  needManage(ctx);
  return withTransaction(async function (client) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['myjobs_links']);
    var l = await activeLink(client);
    if (!l) {
      l = (await client.query('INSERT INTO myjobs_links (code, created_by) VALUES ($1, $2) RETURNING *', [newCode(), ctx.employee.id])).rows[0];
      await audit(client, ctx, 'myjobs.team_code', 'myjobs_link', l.id, 'Made the My Jobs team code.');
    }
    return linkOut(l);
  });
}

// POST /api/maint-work-orders/myjobs-team/renew — a new team code; every
// phone signed in with the old one is signed out.
async function renewTeamCode(ctx) {
  needManage(ctx);
  return withTransaction(async function (client) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['myjobs_links']);
    var ended = (await client.query('UPDATE myjobs_links SET revoked_at = now() WHERE revoked_at IS NULL RETURNING id')).rows.length;
    var l = (await client.query('INSERT INTO myjobs_links (code, created_by) VALUES ($1, $2) RETURNING *', [newCode(), ctx.employee.id])).rows[0];
    var gone = (await client.query('DELETE FROM myjobs_sessions s USING myjobs_links k WHERE k.id = s.link_id AND k.revoked_at IS NOT NULL')).rowCount;
    await audit(client, ctx, 'myjobs.team_code', 'myjobs_link', l.id, 'Made a new My Jobs team code' + (ended ? ': the old one stops working, ' + gone + ' phone(s) signed out.' : '.'));
    return linkOut(l);
  });
}

// ── the phone's side ────────────────────────────────────────────────────

async function teamOk(team, ip) {
  pinAuth.checkRateLimit(ip);
  var l = await activeLink();
  var c = norm(team);
  if (!l || c.length !== CODE_LENGTH || !same(c, l.code)) { pinAuth.recordFailure(ip); fail('invalid', TEAM_WRONG); }
  return l;
}

// POST /api/myjobs/team { team } — is this the team code? (the first
// screen on a new phone, before the kiosk code).
async function checkTeam(team, ip) {
  await teamOk(team, ip);
  return { ok: true };
}

// POST /api/myjobs/sign-in { team, pin } — the team code and a kiosk code:
// a sign-in for that person, for 30 days.
async function signIn(team, pin, ip, userAgent) {
  var l = await teamOk(team, ip);
  pinAuth.validatePinFormat(pin);
  var pinHash = pinAuth.hashPin(String(pin));
  var e = (await pool.query(
    "SELECT e.id, e.first_name, e.last_name, (SELECT u.id FROM users u WHERE u.employee_id = e.id ORDER BY u.created_at LIMIT 1) AS user_id " +
    "FROM employees e WHERE e.kiosk_pin_hash = $1 AND e.status = 'active'", [pinHash])).rows[0];
  if (!e) { pinAuth.recordFailure(ip); fail('auth', PIN_WRONG); }
  pinAuth.recordSuccess(ip);
  var token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    "INSERT INTO myjobs_sessions (employee_id, link_id, token_hash, pin_hash, ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)",
    [e.id, l.id, sha(token), pinHash, String(ip || '').slice(0, 60), String(userAgent || '').slice(0, 300), String(SESSION_DAYS)]);
  await audit(pool, { user: { id: e.user_id || null }, employee: e }, 'myjobs.sign_in', 'employee', e.id, nameOf(e) + ' signed in to My Jobs with their kiosk code.');
  return { token: token, name: nameOf(e), days: SESSION_DAYS };
}

// The person behind a My Jobs sign-in, as the maintenance service takes it:
// their own jobs only, no permissions.
async function contextOf(token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) fail('auth', SIGN_IN_AGAIN);
  var r = (await pool.query(
    'SELECT s.id AS session_id, s.last_seen_at, e.id, e.first_name, e.last_name, ' +
    '(SELECT u.id FROM users u WHERE u.employee_id = e.id ORDER BY u.created_at LIMIT 1) AS user_id ' +
    'FROM myjobs_sessions s JOIN myjobs_links l ON l.id = s.link_id AND l.revoked_at IS NULL ' +
    "JOIN employees e ON e.id = s.employee_id AND e.status = 'active' AND e.kiosk_pin_hash = s.pin_hash " +
    'WHERE s.token_hash = $1 AND s.expires_at > now()', [sha(token)])).rows[0];
  if (!r) fail('auth', SIGN_IN_AGAIN);
  if (Date.now() - new Date(r.last_seen_at).getTime() > 5 * 60 * 1000) {
    await pool.query('UPDATE myjobs_sessions SET last_seen_at = now() WHERE id = $1', [r.session_id]);
  }
  return {
    user: { id: r.user_id || null },
    employee: { id: r.id, first_name: r.first_name, last_name: r.last_name },
    can: function () { return false; },
    myJobs: true
  };
}

// POST /api/myjobs/sign-out — this phone's sign-in ends.
async function signOut(token) {
  if (token && /^[0-9a-f]{64}$/.test(token)) await pool.query('DELETE FROM myjobs_sessions WHERE token_hash = $1', [sha(token)]);
  return { ok: true };
}

module.exports = {
  teamCode: teamCode, renewTeamCode: renewTeamCode, checkTeam: checkTeam, signIn: signIn, contextOf: contextOf, signOut: signOut,
  CODE_LENGTH: CODE_LENGTH, SESSION_DAYS: SESSION_DAYS
};
