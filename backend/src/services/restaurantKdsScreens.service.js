var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// The kitchen's screens (migration 0158). A tablet that opens the kitchen
// screen link is unknown until a manager sets it up:
//
// 1. hello() — the tablet says hello with the secret token it keeps (none
//    the first time: it gets one, and a short code to show). Until it is
//    claimed it waits, showing its code.
// 2. A manager of the restaurant claims it in the till settings — by
//    typing its code, or picking it from the screens waiting on the same
//    network (the same internet address as the till) — and gives it a
//    name and its station (none: every station).
// 3. Cooks sign in on it with their own PIN (restaurantPos.login, app
//    'kds'): the session carries the screen, whose station the kitchen
//    board follows (restaurantKitchen.board). A manager can rename it,
//    move it to another station, or take it off (it waits again, with a
//    new code).
//
// Only the token's hash is stored. A browser whose data is cleared is a
// new screen and is set up again.

var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
var NEW_PER_HOUR = 20;
var newByIp = new Map();

function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function newCode() {
  var bytes = crypto.randomBytes(6), out = '';
  for (var i = 0; i < 6; i++) out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return out;
}
function cleanCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
// "Android tablet · Chrome" from the browser's user agent, for the manager to tell screens apart.
function deviceOf(ua) {
  ua = String(ua || '');
  var os = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
    : /Windows/.test(ua) ? 'Windows computer' : /Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux computer' : 'Device';
  var browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? os + ' · ' + browser : os;
}
function throttleNew(ip) {
  var now = Date.now(), list = (newByIp.get(ip) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= NEW_PER_HOUR) fail('ratelimited', 'Too many new screens from this network. Wait a while and try again.');
  list.push(now);
  newByIp.set(ip, list);
}

async function screenByToken(token, db) {
  if (!token) return null;
  return (await (db || pool).query(
    'SELECT k.*, s.name AS station_name, c.name AS company_name, c.code AS company_code FROM restaurant_kds_screens k ' +
    'LEFT JOIN restaurant_kds_stations s ON s.id = k.station_id LEFT JOIN companies c ON c.id = k.company_id WHERE k.token_hash = $1',
    [hashToken(token)])).rows[0] || null;
}
function helloOut(r, token) {
  var out = r.status === 'active'
    ? { status: 'active', screenId: r.id, name: r.name, stationId: r.station_id, stationName: r.station_name || null, companyName: r.company_name, companyCode: r.company_code }
    : { status: 'waiting', code: r.code };
  if (token) out.screenToken = token;
  return out;
}

// POST /api/pos/kds/screen { screenToken } — public: the tablet's state,
// or a new waiting screen (with its token, once) when it has none.
async function hello(screenToken, ip, userAgent) {
  var known = await screenByToken(screenToken);
  if (known) {
    if (Date.now() - new Date(known.last_seen_at).getTime() > 60000 || known.ip !== String(ip || '')) {
      await pool.query('UPDATE restaurant_kds_screens SET last_seen_at = now(), ip = $2, device = $3 WHERE id = $1', [known.id, String(ip || ''), deviceOf(userAgent)]);
    }
    return helloOut(known);
  }
  throttleNew(String(ip || ''));
  // Waiting screens nobody set up in three days are forgotten.
  await pool.query("DELETE FROM restaurant_kds_screens WHERE status = 'waiting' AND last_seen_at < now() - interval '3 days'");
  var token = crypto.randomBytes(24).toString('base64url');
  var row;
  for (var i = 0; i < 5 && !row; i++) {
    var code = newCode();
    var clash = (await pool.query("SELECT 1 FROM restaurant_kds_screens WHERE status = 'waiting' AND code = $1", [code])).rows[0];
    if (!clash) {
      row = (await pool.query('INSERT INTO restaurant_kds_screens (code, token_hash, device, ip) VALUES ($1, $2, $3, $4) RETURNING *',
        [code, hashToken(token), deviceOf(userAgent), String(ip || '')])).rows[0];
    }
  }
  if (!row) fail('error', 'Could not set up this screen. Reload the page.');
  return helloOut(row, token);
}

// The screen a cook signs in on (restaurantPos.login): set up, and at
// their restaurant.
async function forSignIn(screenToken, companyId, employeeId) {
  var s = await screenByToken(screenToken);
  if (!s) fail('forbidden', 'This screen is not set up. Reload the page to get its code, and ask a manager to set it up.');
  if (s.status !== 'active') fail('forbidden', 'This screen is waiting for a manager to set it up (code ' + s.code + ').');
  if (s.company_id !== companyId) fail('forbidden', 'This screen belongs to ' + s.company_name + '. Your PIN is for another restaurant.');
  await pool.query('UPDATE restaurant_kds_screens SET signed_in_id = $2, signed_in_at = now(), last_seen_at = now() WHERE id = $1', [s.id, employeeId]);
  return s;
}

// The screen of a kitchen session (restaurantKitchen.board and friends);
// refused when a manager has taken it off.
async function forSession(session) {
  if (!session.kdsScreenId) return null;
  var s = (await pool.query(
    'SELECT k.*, s.name AS station_name FROM restaurant_kds_screens k LEFT JOIN restaurant_kds_stations s ON s.id = k.station_id WHERE k.id = $1', [session.kdsScreenId])).rows[0];
  if (!s || s.status !== 'active' || s.company_id !== session.posCompanyId) fail('auth', 'A manager took this screen off. Set it up again.');
  if (Date.now() - new Date(s.last_seen_at).getTime() > 60000) await pool.query('UPDATE restaurant_kds_screens SET last_seen_at = now() WHERE id = $1', [s.id]);
  return s;
}

function screenOut(r) {
  return {
    id: r.id, name: r.name, stationId: r.station_id, stationName: r.station_name || null, status: r.status, code: r.status === 'waiting' ? r.code : null,
    device: r.device, lastSeenAt: r.last_seen_at, online: Date.now() - new Date(r.last_seen_at).getTime() < 3 * 60000,
    signedIn: r.signed_in_name || null, signedInAt: r.signed_in_at, claimedAt: r.claimed_at, createdAt: r.created_at
  };
}

// The settings' list: this restaurant's screens, and the screens waiting
// on the same network as the till right now.
async function list(companyId, ip) {
  var mine = (await pool.query(
    "SELECT k.*, s.name AS station_name, e.first_name || ' ' || e.last_name AS signed_in_name FROM restaurant_kds_screens k " +
    'LEFT JOIN restaurant_kds_stations s ON s.id = k.station_id LEFT JOIN employees e ON e.id = k.signed_in_id ' +
    'WHERE k.company_id = $1 ORDER BY k.name, k.created_at', [companyId])).rows;
  var waiting = (await pool.query(
    "SELECT * FROM restaurant_kds_screens WHERE status = 'waiting' AND ip = $1 AND last_seen_at > now() - interval '30 minutes' ORDER BY created_at DESC LIMIT 20",
    [String(ip || '')])).rows;
  var stations = (await pool.query('SELECT id, name FROM restaurant_kds_stations WHERE company_id = $1 AND active = true ORDER BY sort_order, name', [companyId])).rows;
  return { screens: mine.map(screenOut), waiting: waiting.map(screenOut), stations: stations };
}

async function stationOfCompany(companyId, stationId) {
  if (!stationId || stationId === 'all') return null;
  var s = (await pool.query('SELECT id FROM restaurant_kds_stations WHERE id = $1 AND company_id = $2 AND active = true', [stationId, companyId])).rows[0];
  if (!s) fail('invalid', 'That station is not set up any more. Pick another.');
  return s.id;
}
function nameOf(v) {
  var n = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!n) fail('invalid', 'Give the screen a name, e.g. Grill screen.');
  return n;
}
function who(m) { return { user: { id: null }, employee: { first_name: m.first_name, last_name: m.last_name } }; }

// A waiting screen becomes this restaurant's, by its code.
async function claim(companyId, manager, p) {
  p = p || {};
  var code = cleanCode(p.code);
  if (code.length !== 6) fail('invalid', 'Type the 6-letter code shown on the screen.');
  var name = nameOf(p.name);
  var stationId = await stationOfCompany(companyId, p.stationId);
  var up = await pool.query(
    "UPDATE restaurant_kds_screens SET company_id = $2, name = $3, station_id = $4, status = 'active', claimed_by = $5, claimed_at = now() " +
    "WHERE status = 'waiting' AND code = $1 RETURNING id", [code, companyId, name, stationId, manager.id]);
  if (!up.rows[0]) fail('notfound', 'No screen is waiting with the code ' + code + '. Check the code on the screen.');
  await audit(pool, who(manager), 'restaurant.kds.screen', 'company', companyId, 'Set up the kitchen screen ' + name + '.');
  return { id: up.rows[0].id, name: name };
}

async function update(companyId, manager, id, p) {
  p = p || {};
  var name = nameOf(p.name);
  var stationId = await stationOfCompany(companyId, p.stationId);
  var up = await pool.query('UPDATE restaurant_kds_screens SET name = $3, station_id = $4 WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId, name, stationId]);
  if (!up.rows[0]) fail('notfound', 'That screen is not set up here.');
  await audit(pool, who(manager), 'restaurant.kds.screen', 'company', companyId, 'Changed the kitchen screen ' + name + '.');
  return { id: id, name: name };
}

// Taken off: its token stops working, and the tablet waits again with a new code.
async function remove(companyId, manager, id) {
  var del = await pool.query('DELETE FROM restaurant_kds_screens WHERE id = $1 AND company_id = $2 RETURNING name', [id, companyId]);
  if (!del.rows[0]) fail('notfound', 'That screen is not set up here.');
  await audit(pool, who(manager), 'restaurant.kds.screen', 'company', companyId, 'Took off the kitchen screen ' + del.rows[0].name + '.');
  return { id: id, name: del.rows[0].name };
}

module.exports = { hello: hello, forSignIn: forSignIn, forSession: forSession, list: list, claim: claim, update: update, remove: remove, _deviceOf: deviceOf };
