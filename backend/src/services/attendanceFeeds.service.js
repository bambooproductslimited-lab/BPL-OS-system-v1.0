/*
 * Attendance feeds: one company's clock-ins and attendance, for an outside
 * system (e.g. a restaurant's own staff schedule tracker).
 *
 * Two ways, and a feed can do both:
 *   sending — every change is POSTed to their address as it happens
 *             (deliverDue, run by jobs/attendanceFeeds.js), signed with the
 *             feed's secret so they can tell it came from us; when their
 *             site is down it is tried again, later and later, until it
 *             answers, and nothing is skipped;
 *   reading — their system asks with the feed's read-only key for what
 *             changed since it last asked (changesFor), for a range of
 *             days (recordsFor), or for the staff list (staffFor).
 *
 * What changed comes from attendance_changes, which a database trigger
 * fills (migration 0124), so no way of writing attendance is missed.
 * A feed only ever covers its own company (and, if chosen, some of its
 * departments). GPS locations, photos, notes and pay are never sent.
 * Times are Ghana time, which is GMT (the same as UTC, no summer time).
 */
var crypto = require('crypto');
var dns = require('dns');
var net = require('net');
var http = require('http');
var https = require('https');
var { pool } = require('../db/pool');
var config = require('../config');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

var BATCH = 100;               // events per POST, and per page when read
var MAX_BATCHES_PER_RUN = 20;  // per feed, per run of the job
var TIMEOUT_MS = 10000;
var KEEP_DAYS = 35;            // how long the change log is kept
var MAX_RANGE_DAYS = 93;       // the most days asked for (or sent again) at once
var USER_AGENT = 'BambooOS-AttendanceFeed/1';

// ── the secret, kept encrypted ─────────────────────────────────────────
function cryptKey() { return crypto.createHmac('sha256', config.jwt.secret).update('attendance-feed:secret').digest(); }
function seal(text) {
  var iv = crypto.randomBytes(12);
  var c = crypto.createCipheriv('aes-256-gcm', cryptKey(), iv);
  var enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function unseal(blob) {
  var p = String(blob || '').split('.');
  if (p.length !== 3) return null;
  try {
    var d = crypto.createDecipheriv('aes-256-gcm', cryptKey(), Buffer.from(p[0], 'base64'));
    d.setAuthTag(Buffer.from(p[1], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[2], 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}
function newSecret() { return 'bfs_' + crypto.randomBytes(32).toString('base64url'); }
function newReadKey() { return 'bfk_' + crypto.randomBytes(32).toString('base64url'); }
function hashKey(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }

// The signature on each POST: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">.
function sign(secret, body, t) {
  var ts = t || Math.floor(Date.now() / 1000);
  return 't=' + ts + ',v1=' + crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
}

// ── their address: https only, and never somewhere inside our network ──
var allowLocalForTests = false;
function setAllowLocalForTests(v) { allowLocalForTests = !!v; }

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    var b = ip.split('.').map(Number);
    return b[0] === 10 || b[0] === 127 || b[0] === 0 || (b[0] === 169 && b[1] === 254) || (b[0] === 172 && b[1] >= 16 && b[1] <= 31)
      || (b[0] === 192 && b[1] === 168) || (b[0] === 100 && b[1] >= 64 && b[1] <= 127) || b[0] >= 224;
  }
  var x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateAddress(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
}

function checkUrl(raw) {
  var u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { fail('invalid', 'That address isn\'t a web address. It should look like https://their-site.com/path.'); }
  if (u.protocol !== 'https:' && !(allowLocalForTests && u.protocol === 'http:')) fail('invalid', 'The address must start with https:// so the attendance is sent encrypted.');
  if (u.username || u.password) fail('invalid', 'Leave the user name and password out of the address.');
  // A page like publicfigah.com/#board: the part after # never reaches their
  // server, so everything would land on their homepage and be thrown away.
  if (String(raw).indexOf('#') >= 0) fail('invalid', 'The part after # never reaches their server, so this would send everything to their homepage. Use the address of the code that receives the clock-ins, or leave it empty and let their page read the feed (Website that may read it).');
  if (u.port && u.port !== '443' && !allowLocalForTests) fail('invalid', 'Use the normal https port (no :number in the address).');
  if (!allowLocalForTests && (u.hostname === 'localhost' || net.isIP(u.hostname))) fail('invalid', 'Use the site\'s name (like their-site.com), not a number or localhost.');
  return u;
}

// Looks the name up once and connects to exactly that address, so it can't
// be pointed inside our network between the check and the send.
function resolveSafe(hostname) {
  return new Promise(function (resolve, reject) {
    dns.lookup(hostname, { all: true }, function (err, addrs) {
      if (err || !addrs || !addrs.length) return reject(new Error('Their site\'s name could not be found (' + hostname + ').'));
      var bad = addrs.find(function (a) { return privateAddress(a.address); });
      if (bad && !allowLocalForTests) return reject(new Error('Their site\'s name points to a private address, so nothing is sent.'));
      resolve(addrs[0]);
    });
  });
}

// Their answer as one short line of plain text.
var ANSWER_BYTES = 2048;
var ANSWER_CHARS = 300;
function answerText(buf) {
  var t = buf.toString('utf8').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, ANSWER_CHARS) : null;
}
// A whole web page (a homepage or a framework's catch-all) rather than a
// short reply from code written to receive the feed.
function looksLikePage(answer, type) {
  return /text\/html/i.test(type || '') || /^<(!doctype|html|head|body)\b/i.test(answer || '');
}

async function post(urlString, body, headers) {
  var u = checkUrl(urlString);
  var addr = await resolveSafe(u.hostname);
  var lib = u.protocol === 'http:' ? http : https;
  var started = Date.now();
  return new Promise(function (resolve) {
    var req = lib.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': USER_AGENT }, headers),
      lookup: function (h, o, cb) { if (o && o.all) cb(null, [addr]); else cb(null, addr.address, addr.family); },
      timeout: TIMEOUT_MS
    }, function (res) {
      // Only the start of their answer is kept, for the log.
      var chunks = [], kept = 0;
      res.on('data', function (c) { if (kept < ANSWER_BYTES) { chunks.push(c); kept += c.length; } });
      res.on('end', function () {
        var ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok: ok, status: res.statusCode, ms: Date.now() - started,
          answer: answerText(Buffer.concat(chunks).subarray(0, ANSWER_BYTES)), answerType: String(res.headers['content-type'] || '').slice(0, 100) || null,
          error: ok ? null : res.statusCode >= 300 && res.statusCode < 400 ? 'Their site answered with a redirect (' + res.statusCode + '); use the final address.' : 'Their site answered ' + res.statusCode + '.' });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('Their site did not answer within ' + TIMEOUT_MS / 1000 + ' seconds.')); });
    req.on('error', function (e) { resolve({ ok: false, status: null, ms: Date.now() - started, error: e.message }); });
    req.end(body);
  });
}

// ── what is sent ───────────────────────────────────────────────────────
function day(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null; }
function hm(t) { return t ? String(t).slice(0, 5) : null; }
function at(date, t) { return date && t ? date + 'T' + String(t).slice(0, 5) + ':00Z' : null; }

function recordOf(r) {
  var date = day(r.date);
  var outDate = day(r.clock_out_date) || (r.clock_out ? date : null);
  var inAt = at(date, r.clock_in), outAt = at(outDate, r.clock_out);
  var hours = inAt && outAt ? Math.round((new Date(outAt) - new Date(inAt)) / 36000) / 100 : null;
  return {
    id: r.id, date: date, shift: Number(r.shift_no || 1),
    clockIn: hm(r.clock_in), clockOut: hm(r.clock_out), clockOutDate: outDate,
    clockInAt: inAt, clockOutAt: outAt, hoursWorked: hours,
    status: r.status, autoClockedOut: !!r.auto_clocked_out, source: r.source, editedByHR: !!r.adjusted_by,
    employee: { id: r.employee_id, code: r.code, name: r.first_name + ' ' + r.last_name, department: r.department, position: r.position_title || '' }
  };
}

var RECORD_SQL = 'SELECT a.*, e.code, e.first_name, e.last_name, e.position_title, d.name AS department ' +
  'FROM attendance a JOIN employees e ON e.id = a.employee_id JOIN departments d ON d.id = e.department_id ';

// Changes are read only once they are SETTLE_MS old: two writes can be
// numbered in one order and saved in the other, and reading only settled
// ones means the slower one is never passed over.
var settleMs = 20000;
function setSettleMsForTests(ms) { settleMs = ms; }
async function settledSeq() {
  return Number((await pool.query("SELECT COALESCE(MAX(seq), 0) AS s FROM attendance_changes WHERE changed_at <= clock_timestamp() - make_interval(secs => $1)", [settleMs / 1000])).rows[0].s);
}

// The changes after `afterSeq` that belong to this feed, as events: the
// row as it is now (several changes to one row become one event), or what
// was removed. lastSeq is where to carry on from: past every settled
// change, this feed's or not, unless the page was full.
async function eventsAfter(feed, afterSeq, limit) {
  var settled = await settledSeq();
  if (settled <= afterSeq) return { events: [], lastSeq: afterSeq, more: false };
  var ch = (await pool.query(
    'SELECT c.* FROM attendance_changes c JOIN departments d ON d.id = c.department_id ' +
    'WHERE c.seq > $1 AND c.seq <= $2 AND d.company_id = $3 AND (cardinality($4::uuid[]) = 0 OR c.department_id = ANY($4)) ORDER BY c.seq LIMIT $5',
    [afterSeq, settled, feed.company_id, feed.department_ids || [], limit])).rows;
  var full = ch.length === limit;
  var lastSeq = full ? Number(ch[ch.length - 1].seq) : settled;
  if (!ch.length) return { events: [], lastSeq: lastSeq, more: false };
  var ids = ch.filter(function (c) { return c.op === 'upsert'; }).map(function (c) { return c.attendance_id; });
  var rows = ids.length ? (await pool.query(RECORD_SQL + 'WHERE a.id = ANY($1)', [ids])).rows : [];
  var byId = Object.fromEntries(rows.map(function (r) { return [r.id, r]; }));
  var lastFor = {};
  ch.forEach(function (c) { lastFor[c.attendance_id] = c.seq; });
  var events = [];
  ch.forEach(function (c) {
    if (lastFor[c.attendance_id] !== c.seq) return; // a later change to the same row says it all
    if (c.op === 'upsert') {
      if (!byId[c.attendance_id]) return; // removed since: its delete follows
      events.push({ id: 'evt_' + c.seq, type: 'attendance.recorded', occurredAt: c.changed_at.toISOString(), attendance: recordOf(byId[c.attendance_id]) });
    } else {
      var b = c.before || {}, who = b.employee || {};
      events.push({ id: 'evt_' + c.seq, type: 'attendance.removed', occurredAt: c.changed_at.toISOString(),
        attendance: { id: c.attendance_id, date: day(b.date), shift: Number(b.shift_no || 1),
          employee: { id: c.employee_id, code: who.code || null, name: who.name || null, department: who.department || null, position: who.position || '' } } });
    }
  });
  return { events: events, lastSeq: lastSeq, more: full };
}

async function latestSeq() {
  return Number((await pool.query('SELECT COALESCE(MAX(seq), 0) AS s FROM attendance_changes')).rows[0].s);
}

function bodyOf(feed, events) {
  return JSON.stringify({ feed: { id: feed.id, name: feed.name }, sentAt: new Date().toISOString(), events: events });
}

async function logDelivery(feedId, kind, events, r) {
  await pool.query('INSERT INTO attendance_feed_deliveries (feed_id, kind, events, status_code, ok, error, ms, answer, answer_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [feedId, kind, events, r.status, r.ok, r.error, r.ms, r.answer || null, r.answerType || null]);
}

async function send(feed, kind, events) {
  var secret = unseal(feed.signing_secret);
  if (!secret) return { ok: false, status: null, ms: 0, error: 'The signing secret can\'t be read any more. Make a new one and give it to them.' };
  var body = bodyOf(feed, events);
  var r;
  try {
    r = await post(feed.push_url, body, { 'X-Bamboo-Signature': sign(secret, body), 'X-Bamboo-Delivery': crypto.randomUUID(), 'X-Bamboo-Feed': feed.id });
  } catch (e) {
    r = { ok: false, status: null, ms: 0, error: e.message };
  }
  await logDelivery(feed.id, kind, events.length, r);
  return r;
}

// Waits after a failure: 30 s, 1 min, 2 min … up to an hour.
function backoffSeconds(failures) { return Math.min(3600, 30 * Math.pow(2, Math.max(0, failures - 1))); }

// One feed: send what is waiting, in order, a batch at a time.
async function deliverFeed(feed) {
  var sent = 0;
  for (var n = 0; n < MAX_BATCHES_PER_RUN; n++) {
    var batch = await eventsAfter(feed, Number(feed.cursor_seq), BATCH);
    if (batch.lastSeq <= Number(feed.cursor_seq)) break;
    if (batch.events.length) {
      var r = await send(feed, 'live', batch.events);
      if (!r.ok) {
        var failures = feed.failures + 1;
        await pool.query("UPDATE attendance_feeds SET failures = $2, next_attempt_at = now() + make_interval(secs => $3), failing_since = COALESCE(failing_since, now()), last_error = $4 WHERE id = $1",
          [feed.id, failures, backoffSeconds(failures), r.error]);
        return { sent: sent, failed: true, error: r.error };
      }
      sent += batch.events.length;
    }
    feed.cursor_seq = batch.lastSeq;
    feed.failures = 0;
    await pool.query("UPDATE attendance_feeds SET cursor_seq = $2, failures = 0, next_attempt_at = NULL, failing_since = NULL, last_error = NULL" +
      (batch.events.length ? ', last_success_at = now()' : '') + ' WHERE id = $1', [feed.id, batch.lastSeq]);
    if (!batch.more) break;
  }
  return { sent: sent, failed: false };
}

var running = false;
async function deliverDue() {
  if (running) return [];
  running = true;
  try {
    var feeds = (await pool.query("SELECT * FROM attendance_feeds WHERE active AND push_url IS NOT NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY created_at")).rows;
    var out = [];
    for (var f of feeds) out.push(Object.assign({ feedId: f.id }, await deliverFeed(f)));
    return out;
  } finally {
    running = false;
  }
}

// The change log is kept for KEEP_DAYS; a feed paused longer than that
// carries on from the oldest change still kept.
async function prune() {
  await pool.query("DELETE FROM attendance_changes WHERE changed_at < now() - make_interval(days => $1)", [KEEP_DAYS]);
  await pool.query("DELETE FROM attendance_feed_deliveries d WHERE d.id NOT IN (SELECT id FROM attendance_feed_deliveries x WHERE x.feed_id = d.feed_id ORDER BY id DESC LIMIT 200)");
}

// ── managing feeds (Integrations; settings.manage) ─────────────────────
function mustManage(ctx) { if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).'); }

async function loadFeed(id) {
  var f = (await pool.query('SELECT * FROM attendance_feeds WHERE id = $1', [id])).rows[0];
  if (!f) fail('notfound', 'Attendance feed not found.');
  return f;
}

async function cleanScope(companyId, departmentIds) {
  var c = (await pool.query('SELECT id, name FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!c) fail('invalid', 'Choose the company whose staff the feed is for.');
  var ids = Array.from(new Set((departmentIds || []).filter(Boolean)));
  if (ids.length) {
    var ok = (await pool.query('SELECT id FROM departments WHERE company_id = $1 AND id = ANY($2)', [companyId, ids])).rows.length;
    if (ok !== ids.length) fail('invalid', 'Those departments are not all in ' + c.name + '.');
  }
  return { company: c, departmentIds: ids };
}

function cleanName(name) {
  var n = String(name || '').trim();
  if (!n) fail('invalid', 'Give the feed a name, like "Star Bar schedule tracker".');
  if (n.length > 80) fail('invalid', 'Keep the name under 80 characters.');
  return n;
}
function cleanPushUrl(url) {
  var s = String(url || '').trim();
  if (!s) return null;
  if (s.length > 500) fail('invalid', 'That address is too long.');
  return checkUrl(s).toString();
}

// The website whose pages may read the feed from the browser: kept as its
// origin only (https://publicfigah.com), so "publicfigah.com/#board" works.
function cleanOrigin(raw) {
  var s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  var u;
  try { u = new URL(s); } catch (e) { fail('invalid', 'That website isn\'t a web address. It should look like https://their-site.com.'); }
  if (u.protocol !== 'https:' && !(allowLocalForTests && u.protocol === 'http:')) fail('invalid', 'The website must use https://.');
  if (!allowLocalForTests && (u.hostname === 'localhost' || net.isIP(u.hostname))) fail('invalid', 'Use the website\'s name (like their-site.com), not a number or localhost.');
  return u.origin;
}

var originsCache = null;
async function allowedOrigins() {
  if (originsCache && originsCache.until > Date.now()) return originsCache.set;
  var rows = (await pool.query('SELECT DISTINCT allowed_origin FROM attendance_feeds WHERE active AND allowed_origin IS NOT NULL AND read_key_hash IS NOT NULL')).rows;
  originsCache = { set: new Set(rows.map(function (r) { return r.allowed_origin; })), until: Date.now() + 30000 };
  return originsCache.set;
}
function forgetOrigins() { originsCache = null; }

function view(f, extra) {
  return Object.assign({
    id: f.id, name: f.name, companyId: f.company_id, departmentIds: f.department_ids || [], active: f.active,
    pushUrl: f.push_url, failures: f.failures, failingSince: f.failing_since, nextAttemptAt: f.next_attempt_at,
    lastError: f.last_error, lastSuccessAt: f.last_success_at,
    readKey: f.read_key_hash ? { hint: f.read_key_hint, lastReadAt: f.last_read_at, reads: Number(f.reads) } : null,
    allowedOrigin: f.allowed_origin || null,
    createdAt: f.created_at
  }, extra || {});
}

async function pendingFor(f) {
  if (!f.push_url || !f.active) return 0;
  return Number((await pool.query(
    'SELECT count(DISTINCT c.attendance_id) AS n FROM attendance_changes c JOIN departments d ON d.id = c.department_id ' +
    'WHERE c.seq > $1 AND d.company_id = $2 AND (cardinality($3::uuid[]) = 0 OR c.department_id = ANY($3))',
    [f.cursor_seq, f.company_id, f.department_ids || []])).rows[0].n);
}

function deliveryView(d) {
  return { id: Number(d.id), kind: d.kind, at: d.at, events: d.events, statusCode: d.status_code, ok: d.ok, error: d.error, ms: d.ms,
    answer: d.answer, answerType: d.answer_type, page: looksLikePage(d.answer, d.answer_type) };
}

async function list(ctx) {
  mustManage(ctx);
  var feeds = (await pool.query('SELECT f.*, c.name AS company FROM attendance_feeds f JOIN companies c ON c.id = f.company_id ORDER BY f.created_at')).rows;
  var out = [];
  for (var f of feeds) {
    var deliveries = (await pool.query('SELECT id, kind, at, events, status_code, ok, error, ms, answer, answer_type FROM attendance_feed_deliveries WHERE feed_id = $1 ORDER BY id DESC LIMIT 20', [f.id])).rows;
    var staff = Number((await pool.query(
      "SELECT count(*) AS n FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.status = 'active' AND d.company_id = $1 AND (cardinality($2::uuid[]) = 0 OR e.department_id = ANY($2))",
      [f.company_id, f.department_ids || []])).rows[0].n);
    var day = (await pool.query("SELECT COALESCE(SUM(events) FILTER (WHERE kind = 'live'), 0) AS live, COALESCE(SUM(events) FILTER (WHERE kind = 'resend'), 0) AS resent " +
      "FROM attendance_feed_deliveries WHERE feed_id = $1 AND ok AND at > now() - interval '24 hours'", [f.id])).rows[0];
    out.push(view(f, {
      company: f.company, staff: staff, pending: await pendingFor(f), sentLast24h: Number(day.live), resentLast24h: Number(day.resent),
      deliveries: deliveries.map(deliveryView)
    }));
  }
  var companies = (await pool.query('SELECT c.id, c.name, c.code FROM companies c ORDER BY c.name')).rows;
  var departments = (await pool.query('SELECT id, name, company_id FROM departments ORDER BY name')).rows;
  return {
    feeds: out,
    companies: companies.map(function (c) {
      return { id: c.id, name: c.name, code: c.code, departments: departments.filter(function (d) { return d.company_id === c.id; }).map(function (d) { return { id: d.id, name: d.name }; }) };
    })
  };
}

async function create(ctx, p) {
  mustManage(ctx);
  var name = cleanName(p.name);
  var scope = await cleanScope(p.companyId, p.departmentIds);
  var pushUrl = cleanPushUrl(p.pushUrl);
  var origin = cleanOrigin(p.allowedOrigin);
  var withKey = p.readKey !== false || !!origin;
  if (!pushUrl && !withKey) fail('invalid', 'Give their address, or let their system read with a key — or both.');
  var secret = newSecret();
  var key = withKey ? newReadKey() : null;
  // Starts from now: earlier days can be sent with "Send again".
  var f = (await pool.query(
    'INSERT INTO attendance_feeds (name, company_id, department_ids, push_url, signing_secret, cursor_seq, read_key_hash, read_key_hint, created_by, allowed_origin) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [name, scope.company.id, scope.departmentIds, pushUrl, seal(secret), await latestSeq(), key ? hashKey(key) : null, key ? key.slice(0, 10) : null, ctx.employee ? ctx.employee.id : null, origin])).rows[0];
  forgetOrigins();
  await audit(pool, ctx, 'attendance_feed.create', 'attendance_feed', f.id, 'Set up the attendance feed "' + name + '" for ' + scope.company.name + (pushUrl ? ', sending to ' + new URL(pushUrl).hostname : '') + (key ? ', with a read key' : '') + (origin ? ', readable from ' + origin + ' in the browser' : '') + '.');
  return view(f, { company: scope.company.name, signingSecret: secret, readKeyValue: key });
}

async function update(ctx, id, p) {
  mustManage(ctx);
  var f = await loadFeed(id);
  var name = p.name !== undefined ? cleanName(p.name) : f.name;
  var scope = p.departmentIds !== undefined ? await cleanScope(f.company_id, p.departmentIds) : { departmentIds: f.department_ids };
  var pushUrl = p.pushUrl !== undefined ? cleanPushUrl(p.pushUrl) : f.push_url;
  if (!pushUrl && !f.read_key_hash) fail('invalid', 'This feed has no read key, so it needs their address.');
  var active = p.active !== undefined ? !!p.active : f.active;
  var origin = p.allowedOrigin !== undefined ? cleanOrigin(p.allowedOrigin) : f.allowed_origin;
  // A new address starts afresh rather than retrying the old one's failures.
  var urlChanged = pushUrl !== f.push_url;
  var params = [id, name, scope.departmentIds, pushUrl, active, origin];
  var u = (await pool.query(
    'UPDATE attendance_feeds SET name = $2, department_ids = $3, push_url = $4, active = $5, allowed_origin = $6, updated_at = now()' +
    (urlChanged || (active && !f.active) ? ', failures = 0, next_attempt_at = NULL, failing_since = NULL, last_error = NULL' : '') +
    (urlChanged && !f.push_url ? ', cursor_seq = GREATEST(cursor_seq, $' + params.push(await latestSeq()) + ')' : '') + ' WHERE id = $1 RETURNING *',
    params)).rows[0];
  var what = [];
  if (name !== f.name) what.push('renamed');
  if (String(scope.departmentIds) !== String(f.department_ids)) what.push('departments changed');
  if (urlChanged) what.push(pushUrl ? 'sends to ' + new URL(pushUrl).hostname : 'stopped sending');
  if (active !== f.active) what.push(active ? 'resumed' : 'paused');
  if ((origin || null) !== (f.allowed_origin || null)) what.push(origin ? 'readable from ' + origin + ' in the browser' : 'no longer readable in the browser');
  forgetOrigins();
  await audit(pool, ctx, 'attendance_feed.update', 'attendance_feed', id, 'Attendance feed "' + name + '": ' + (what.join(', ') || 'saved') + '.');
  return view(u);
}

async function rotateSecret(ctx, id) {
  mustManage(ctx);
  var f = await loadFeed(id);
  var secret = newSecret();
  await pool.query('UPDATE attendance_feeds SET signing_secret = $2, updated_at = now() WHERE id = $1', [id, seal(secret)]);
  await audit(pool, ctx, 'attendance_feed.secret', 'attendance_feed', id, 'Made a new signing secret for the attendance feed "' + f.name + '". The old one stopped working.');
  return { signingSecret: secret };
}

async function rotateReadKey(ctx, id) {
  mustManage(ctx);
  var f = await loadFeed(id);
  var key = newReadKey();
  await pool.query('UPDATE attendance_feeds SET read_key_hash = $2, read_key_hint = $3, updated_at = now() WHERE id = $1', [id, hashKey(key), key.slice(0, 10)]);
  await audit(pool, ctx, 'attendance_feed.read_key', 'attendance_feed', id, (f.read_key_hash ? 'Made a new read key' : 'Turned on reading with a key') + ' for the attendance feed "' + f.name + '".' + (f.read_key_hash ? ' The old key stopped working.' : ''));
  return { readKeyValue: key };
}

async function removeReadKey(ctx, id) {
  mustManage(ctx);
  var f = await loadFeed(id);
  if (!f.push_url) fail('invalid', 'This feed only works by reading. Give their address first, or delete the feed.');
  await pool.query('UPDATE attendance_feeds SET read_key_hash = NULL, read_key_hint = NULL, updated_at = now() WHERE id = $1', [id]);
  await audit(pool, ctx, 'attendance_feed.read_key_off', 'attendance_feed', id, 'Turned off reading with a key for the attendance feed "' + f.name + '".');
  return true;
}

async function remove(ctx, id) {
  mustManage(ctx);
  var f = await loadFeed(id);
  await pool.query('DELETE FROM attendance_feeds WHERE id = $1', [id]);
  await audit(pool, ctx, 'attendance_feed.delete', 'attendance_feed', id, 'Deleted the attendance feed "' + f.name + '". Nothing more is sent, and its key stopped working.');
  return true;
}

async function deliveries(ctx, id) {
  mustManage(ctx);
  await loadFeed(id);
  return (await pool.query('SELECT id, kind, at, events, status_code, ok, error, ms, answer, answer_type FROM attendance_feed_deliveries WHERE feed_id = $1 ORDER BY id DESC LIMIT 100', [id])).rows
    .map(deliveryView);
}

// A test POST with one "feed.test" event: shows whether their side answers.
async function sendTest(ctx, id) {
  mustManage(ctx);
  var f = await loadFeed(id);
  if (!f.push_url) fail('invalid', 'This feed has no address to send to.');
  var r = await send(f, 'test', [{ id: 'evt_test_' + Date.now(), type: 'feed.test', occurredAt: new Date().toISOString(), message: 'A test from Bamboo OS. Nothing to record.' }]);
  return { ok: r.ok, statusCode: r.status, ms: r.ms, error: r.error, answer: r.answer || null, page: looksLikePage(r.answer, r.answerType) };
}

function cleanRange(from, to) {
  var re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(String(from || '')) || !re.test(String(to || ''))) fail('invalid', 'Choose the first and last day.');
  if (from > to) fail('invalid', 'The first day is after the last day.');
  var days = (new Date(to) - new Date(from)) / 86400000 + 1;
  if (days > MAX_RANGE_DAYS) fail('invalid', 'At most ' + MAX_RANGE_DAYS + ' days at a time.');
  return { from: from, to: to };
}

async function recordsIn(feed, range) {
  return (await pool.query(RECORD_SQL +
    'WHERE d.company_id = $1 AND (cardinality($2::uuid[]) = 0 OR e.department_id = ANY($2)) AND a.date BETWEEN $3 AND $4 ORDER BY a.date, e.code, a.shift_no',
    [feed.company_id, feed.department_ids || [], range.from, range.to])).rows.map(recordOf);
}

// Sends the days asked for again, as they are now (e.g. the days before the
// feed was set up, or after their system lost something).
async function resend(ctx, id, p) {
  mustManage(ctx);
  var f = await loadFeed(id);
  if (!f.push_url) fail('invalid', 'This feed has no address to send to.');
  var range = cleanRange(p.from, p.to);
  var records = await recordsIn(f, range);
  var sent = 0;
  for (var i = 0; i < records.length; i += BATCH) {
    var events = records.slice(i, i + BATCH).map(function (r) { return { id: 'evt_resend_' + r.id, type: 'attendance.recorded', occurredAt: new Date().toISOString(), resent: true, attendance: r }; });
    var r = await send(f, 'resend', events);
    if (!r.ok) {
      await audit(pool, ctx, 'attendance_feed.resend', 'attendance_feed', id, 'Sending ' + range.from + ' to ' + range.to + ' again to "' + f.name + '" stopped after ' + sent + ' record(s): ' + r.error);
      return { records: records.length, sent: sent, ok: false, error: r.error };
    }
    sent += events.length;
  }
  await audit(pool, ctx, 'attendance_feed.resend', 'attendance_feed', id, 'Sent ' + sent + ' attendance record(s) from ' + range.from + ' to ' + range.to + ' again to "' + f.name + '".');
  return { records: records.length, sent: sent, ok: true };
}

// ── reading with the key (their system) ───────────────────────────────
async function feedForKey(authHeader, origin) {
  var m = /^Bearer\s+(bfk_[A-Za-z0-9_-]{20,})$/.exec(String(authHeader || '').trim());
  if (!m) fail('auth', 'Send the feed\'s read key as "Authorization: Bearer bfk_…".');
  var f = (await pool.query('SELECT * FROM attendance_feeds WHERE read_key_hash = $1', [hashKey(m[1])])).rows[0];
  if (!f) fail('auth', 'That read key is not valid (it may have been replaced).');
  if (!f.active) fail('forbidden', 'This feed is paused in Bamboo OS.');
  // From a browser, only the feed's own website may use its key.
  if (origin && origin !== f.allowed_origin) fail('forbidden', 'This feed can\'t be read from ' + origin + '. In Bamboo OS, give the feed this website so its pages may read it.');
  await pool.query('UPDATE attendance_feeds SET last_read_at = now(), reads = reads + 1 WHERE id = $1', [f.id]);
  return f;
}

async function changesFor(authHeader, q, origin) {
  var f = await feedForKey(authHeader, origin);
  var after = /^\d+$/.test(String(q.after || '')) ? Number(q.after) : 0;
  var limit = Math.min(500, Math.max(1, Number(q.limit) || BATCH));
  var oldest = Number((await pool.query('SELECT COALESCE(MIN(seq), 0) AS s FROM attendance_changes')).rows[0].s);
  var batch = await eventsAfter(f, after, limit);
  return {
    feed: { id: f.id, name: f.name }, events: batch.events,
    // Ask again with this; it moves past other companies' changes too, so
    // the same change never comes twice.
    next: String(Math.max(after, batch.lastSeq)), more: batch.more,
    // Changes are kept KEEP_DAYS days; asking from before that may have
    // missed some: fetch those days with /records.
    gap: after > 0 && oldest > 0 && after < oldest - 1
  };
}

async function recordsFor(authHeader, q, origin) {
  var f = await feedForKey(authHeader, origin);
  return { feed: { id: f.id, name: f.name }, from: q.from, to: q.to, records: await recordsIn(f, cleanRange(q.from, q.to)) };
}

async function staffFor(authHeader, origin) {
  var f = await feedForKey(authHeader, origin);
  var rows = (await pool.query(
    "SELECT e.id, e.code, e.first_name, e.last_name, e.position_title, d.name AS department FROM employees e JOIN departments d ON d.id = e.department_id " +
    "WHERE e.status = 'active' AND d.company_id = $1 AND (cardinality($2::uuid[]) = 0 OR e.department_id = ANY($2)) ORDER BY e.code",
    [f.company_id, f.department_ids || []])).rows;
  return { feed: { id: f.id, name: f.name }, staff: rows.map(function (e) { return { id: e.id, code: e.code, name: e.first_name + ' ' + e.last_name, department: e.department, position: e.position_title || '' }; }) };
}

// Every day in a range, for each of the feed's staff: what the attendance
// screens show — present or late (with the clock-in and clock-out), or, with
// no clock-in, on leave, a day off, or absent. Any range: long ones come a
// month at a time, with `next` to ask for the rest. Days before someone was
// hired, and days still to come, are left out.
var DAYS_PER_PAGE = 31;
var MAX_DAYS = 5 * 366;
function addDays(dateISO, n) { var d = new Date(dateISO + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function daysFor(authHeader, q, origin) {
  var f = await feedForKey(authHeader, origin);
  var re = /^\d{4}-\d{2}-\d{2}$/;
  var from = String(q.from || ''), to = String(q.to || '');
  if (!re.test(from) || !re.test(to) || isNaN(new Date(from)) || isNaN(new Date(to))) fail('invalid', 'Give from and to as YYYY-MM-DD.');
  if (from > to) fail('invalid', 'from is after to.');
  if ((new Date(to) - new Date(from)) / 86400000 + 1 > MAX_DAYS) fail('invalid', 'That range is over 5 years; check the dates.');
  var today = new Date().toISOString().slice(0, 10);
  var end = to < today ? to : today;
  var out = { feed: { id: f.id, name: f.name }, from: from, to: to, days: [], next: null };
  if (from > end) return out;
  var pageEnd = addDays(from, DAYS_PER_PAGE - 1) < end ? addDays(from, DAYS_PER_PAGE - 1) : end;
  out.pageTo = pageEnd;
  out.next = pageEnd < end ? addDays(pageEnd, 1) : null;

  var staff = (await pool.query(
    "SELECT e.id, e.code, e.first_name, e.last_name, e.position_title, e.work_days, e.hire_date, e.status, d.name AS department, c.name AS company " +
    'FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id ' +
    'WHERE d.company_id = $1 AND (cardinality($2::uuid[]) = 0 OR e.department_id = ANY($2)) ' +
    "AND (e.status = 'active' OR e.id IN (SELECT employee_id FROM attendance WHERE date BETWEEN $3 AND $4)) ORDER BY e.code",
    [f.company_id, f.department_ids || [], from, pageEnd])).rows;
  if (!staff.length) return out;
  var ids = staff.map(function (e) { return e.id; });
  var recs = {};
  (await pool.query('SELECT * FROM attendance WHERE employee_id = ANY($1) AND date BETWEEN $2 AND $3 ORDER BY shift_no', [ids, from, pageEnd])).rows
    .forEach(function (r) { var k = r.employee_id + '|' + day(r.date); (recs[k] = recs[k] || []).push(r); });
  var leave = await attendanceRules().approvedLeaveDays(ids, from, pageEnd);
  for (var date = from; date <= pageEnd; date = addDays(date, 1)) {
    staff.forEach(function (e) {
      var who = { id: e.id, code: e.code, name: e.first_name + ' ' + e.last_name, department: e.department, position: e.position_title || '' };
      var rows = recs[e.id + '|' + date];
      if (rows) {
        rows.forEach(function (r) {
          var rec = recordOf(Object.assign({}, r, { code: e.code, first_name: e.first_name, last_name: e.last_name, position_title: e.position_title, department: e.department }));
          out.days.push({ date: date, status: r.status, shift: rec.shift, clockIn: rec.clockIn, clockOut: rec.clockOut, clockOutDate: rec.clockOutDate,
            hoursWorked: rec.hoursWorked, autoClockedOut: rec.autoClockedOut, editedByHR: rec.editedByHR, source: rec.source, attendanceId: r.id, employee: who });
        });
        return;
      }
      if (e.status !== 'active' || (e.hire_date && date < day(e.hire_date))) return;
      var status = leave[e.id + '|' + date] ? 'leave' : attendanceRules().isRestDay(e.company, e.department, date, e.work_days) ? 'off' : 'absent';
      out.days.push({ date: date, status: status, shift: 1, clockIn: null, clockOut: null, clockOutDate: null, hoursWorked: null,
        autoClockedOut: false, editedByHR: false, source: null, attendanceId: null, employee: who });
    });
  }
  return out;
}
// Loaded when first used: attendance.service.js loads a lot, and this file
// is also loaded by the job at start.
function attendanceRules() { return require('./attendance.service'); }

module.exports = {
  list: list, create: create, update: update, rotateSecret: rotateSecret, rotateReadKey: rotateReadKey, removeReadKey: removeReadKey,
  remove: remove, deliveries: deliveries, sendTest: sendTest, resend: resend,
  changesFor: changesFor, recordsFor: recordsFor, staffFor: staffFor, daysFor: daysFor, allowedOrigins: allowedOrigins,
  deliverDue: deliverDue, prune: prune, sign: sign, checkUrl: checkUrl, privateAddress: privateAddress,
  setAllowLocalForTests: setAllowLocalForTests, setSettleMsForTests: setSettleMsForTests, backoffSeconds: backoffSeconds
};
