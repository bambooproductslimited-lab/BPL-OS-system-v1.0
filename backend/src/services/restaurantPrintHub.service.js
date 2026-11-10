var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var printers = require('./restaurantPrinters.service');
var printerBytes = require('../lib/printerBytes');
var access = require('./restaurantTillAccess.service');

// The Bamboo print hub (tools/print-hub): a small program on one computer
// that stays on at the restaurant. It looks through the restaurant's
// network by itself for receipt printers — Epson, Star and the others that
// take tickets on port 9100 — and asks here every few seconds, on the
// restaurant's printer link (the one Star printers use for CloudPRNT):
//   POST /api/print-hub/:token
//     { hub: { key, name, platform, version, networks, scanned },
//       printers: [{ mac, ip, port, make, model, state }],
//       done: [{ id, ok, error }] }
//   -> { hubId, jobs: [{ id, mac, ip, port, language, title, data }], pollMs, scanMs }
//     (hub.lan: where it answers on the restaurant's network — outage below)
// Each printer it finds shows up in Till settings → Printers as a new
// printer, to be named and given its work, as Square does; its tickets go
// back to the hub as the printer's own bytes (lib/printerBytes.js), base64.
// Nothing is set on the printers. A printer that also asks by itself
// (CloudPRNT) keeps doing so: the hub does not take its tickets.

var HUB_VERSION = '1.1.0';
var POLL_MS = 3000, SCAN_MS = 60000;
var HUB_ONLINE_SECONDS = 30;
var MAX_ATTEMPTS = 5;
var STATE_CODE = { ok: '200 OK', low: '200 Paper Low', paper: '410 Paper Empty', cover: '410 Cover Open', error: '500 Printer Error' };
var MAKES = ['star', 'epson', 'escpos'];

function str(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n); }
function ipOf(v) { var s = String(v || '').trim(); return /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every(function (n) { return Number(n) <= 255; }) ? s : ''; }
function macOf(v) {
  var m = String(v || '').trim().toLowerCase().replace(/-/g, ':');
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m) && m !== '00:00:00:00:00:00' ? m : '';
}

// An address on a restaurant's own network (10.x, 172.16–31.x, 192.168.x).
function privateIp(ip) { return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip); }
function portOf(v) { var n = Math.round(Number(v)); return n >= 1024 && n <= 65535 ? n : null; }
// Where the hub answers on the restaurant's network, for outage mode
// (migration 0216): its addresses there, its port for the tills (HTTPS),
// its setup page's, the key the tills give it, and the SHA-256 of the
// certificate authority each till trusts. A hub before 1.1 says nothing.
function lanOf(l) {
  l = l || {};
  var ips = (Array.isArray(l.ips) ? l.ips : []).map(ipOf).filter(privateIp).slice(0, 4);
  var port = portOf(l.port), key = String(l.key || '');
  if (!ips.length || !port || !/^[A-Za-z0-9_-]{24,64}$/.test(key)) return { ips: [], port: null, setupPort: null, key: '', ca: '' };
  return { ips: ips, port: port, setupPort: portOf(l.setupPort), key: key, ca: /^[0-9a-f]{64}$/i.test(String(l.ca || '')) ? String(l.ca).toLowerCase() : '' };
}

async function recordHub(companyId, h, ip) {
  h = h || {};
  var key = str(h.key, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) fail('invalid', 'The print hub did not say who it is.');
  var lan = lanOf(h.lan);
  return (await pool.query(
    'INSERT INTO restaurant_print_hubs (company_id, hub_key, name, platform, version, networks, last_seen_at, last_scan_at, last_ip, lan_ips, lan_port, lan_setup_port, lan_key, lan_ca) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,now(),CASE WHEN $7 THEN now() END,$8,$9,$10,$11,$12,$13) ' +
    'ON CONFLICT (company_id, hub_key) DO UPDATE SET name = EXCLUDED.name, platform = EXCLUDED.platform, version = EXCLUDED.version, networks = EXCLUDED.networks, last_seen_at = now(), ' +
    '  last_scan_at = coalesce(EXCLUDED.last_scan_at, restaurant_print_hubs.last_scan_at), last_ip = EXCLUDED.last_ip, ' +
    '  lan_ips = EXCLUDED.lan_ips, lan_port = EXCLUDED.lan_port, lan_setup_port = EXCLUDED.lan_setup_port, lan_key = EXCLUDED.lan_key, lan_ca = EXCLUDED.lan_ca RETURNING *',
    [companyId, key, str(h.name, 60), str(h.platform, 40), str(h.version, 20), str(h.networks, 120), !!h.scanned, str(ip, 60), lan.ips, lan.port, lan.setupPort, lan.key, lan.ca])).rows[0];
}

// What the hub found, and how each is. A printer it reaches is seen now;
// one it cannot is offline at once.
async function recordPrinters(companyId, hub, list) {
  var seen = 0;
  for (var i = 0; i < Math.min(64, list.length); i++) {
    var x = list[i] || {};
    var mac = macOf(x.mac), ip = ipOf(x.ip);
    if (!mac || !ip) continue;
    var state = STATE_CODE[x.state] ? x.state : 'offline';
    var make = MAKES.indexOf(x.make) >= 0 ? x.make : 'escpos';
    var port = Math.max(1, Math.min(65535, Math.round(Number(x.port) || 9100)));
    await pool.query(
      'INSERT INTO restaurant_printers (company_id, mac, via, make, model, last_ip, port, hub_id, status_code, last_seen_at) ' +
      "VALUES ($1,$2,'hub',$3,$4,$5,$6,$7,$8,CASE WHEN $9 THEN now() END) " +
      'ON CONFLICT (company_id, mac) DO UPDATE SET ' +
      // A printer that asks by itself (CloudPRNT, in the last 2 minutes) stays that way.
      "  via = CASE WHEN restaurant_printers.cloud_seen_at > now() - interval '2 minutes' THEN 'cloudprnt' ELSE 'hub' END, " +
      '  make = EXCLUDED.make, model = CASE WHEN EXCLUDED.model <> \'\' THEN EXCLUDED.model ELSE restaurant_printers.model END, ' +
      '  port = EXCLUDED.port, hub_id = EXCLUDED.hub_id, ' +
      "  last_ip = CASE WHEN restaurant_printers.cloud_seen_at > now() - interval '2 minutes' THEN restaurant_printers.last_ip ELSE EXCLUDED.last_ip END, " +
      "  status_code = CASE WHEN restaurant_printers.cloud_seen_at > now() - interval '2 minutes' THEN restaurant_printers.status_code ELSE EXCLUDED.status_code END, " +
      "  last_seen_at = CASE WHEN restaurant_printers.cloud_seen_at > now() - interval '2 minutes' THEN restaurant_printers.last_seen_at " +
      "    WHEN $9 THEN now() ELSE LEAST(coalesce(restaurant_printers.last_seen_at, now()), now() - interval '50 seconds') END",
      [companyId, mac, make, str(x.model, 60), ip, port, hub.id, state === 'offline' ? '' : STATE_CODE[state], state !== 'offline']);
    seen++;
  }
  return seen;
}

// Printed, or why not: tried again (paper put back, it prints), up to a
// point; then it waits for someone at a till to print it again.
async function recordDone(hub, list) {
  for (var i = 0; i < Math.min(100, list.length); i++) {
    var d = list[i] || {};
    if (!/^[0-9a-f-]{36}$/i.test(String(d.id || ''))) continue;
    var job = (await pool.query(
      "SELECT j.* FROM restaurant_print_jobs j JOIN restaurant_printers p ON p.id = j.printer_id WHERE j.id = $1 AND p.hub_id = $2 AND j.status = 'printing'", [d.id, hub.id])).rows[0];
    if (!job) continue;
    if (d.ok) await pool.query("UPDATE restaurant_print_jobs SET status = 'printed', done_at = now(), error = '' WHERE id = $1", [job.id]);
    else {
      await pool.query("UPDATE restaurant_print_jobs SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END, error = $3, done_at = CASE WHEN attempts >= $2 THEN now() END WHERE id = $1",
        [job.id, MAX_ATTEMPTS, str(d.error, 120) || 'Not printed']);
    }
  }
}

// The next ticket of each of this hub's printers that is there and ready.
// One that did not print waits a little longer each time (10 s, 20 s, …)
// before it is tried again.
async function jobsFor(hub) {
  var rows = (await pool.query(
    "SELECT * FROM restaurant_printers WHERE hub_id = $1 AND via = 'hub' AND NOT ignored AND name <> '' AND last_seen_at > now() - interval '45 seconds' " +
    "AND (status_code = '' OR status_code LIKE '2%')", [hub.id])).rows;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var pr = rows[i];
    var job = (await pool.query(
      "SELECT * FROM restaurant_print_jobs WHERE printer_id = $1 AND ((status = 'queued' AND (attempts = 0 OR sent_at IS NULL OR sent_at < now() - make_interval(secs => 10 * attempts))) " +
      "OR (status = 'printing' AND sent_at < now() - interval '60 seconds')) ORDER BY created_at LIMIT 1", [pr.id])).rows[0];
    if (!job) continue;
    await pool.query("UPDATE restaurant_print_jobs SET status = 'printing', sent_at = now(), attempts = attempts + 1 WHERE id = $1", [job.id]);
    out.push({
      id: job.id, mac: pr.mac, ip: pr.last_ip, port: pr.port || 9100, language: printerBytes.languageOf(pr), title: job.title,
      data: printerBytes.bytesFor(pr, job.doc, { kick: job.kick }).toString('base64')
    });
  }
  return out;
}

async function poll(token, body, ip) {
  var companyId = await printers.linkCompany(token);
  body = body || {};
  var hub = await recordHub(companyId, body.hub, ip);
  if (Array.isArray(body.done)) await recordDone(hub, body.done);
  if (Array.isArray(body.printers)) await recordPrinters(companyId, hub, body.printers);
  return { hubId: hub.id, jobs: await jobsFor(hub), pollMs: POLL_MS, scanMs: SCAN_MS, latest: HUB_VERSION };
}

// The restaurant's hubs, for Till settings → Printers.
async function hubsOf(companyId) {
  return (await pool.query(
    'SELECT h.*, (SELECT count(*)::int FROM restaurant_printers p WHERE p.hub_id = h.id AND NOT p.ignored) AS found FROM restaurant_print_hubs h ' +
    "WHERE h.company_id = $1 AND h.last_seen_at > now() - interval '14 days' ORDER BY h.last_seen_at DESC", [companyId])).rows
    .map(function (h) {
      return {
        id: h.id, name: h.name || 'Print hub', platform: h.platform, version: h.version, networks: h.networks, ip: h.last_ip,
        lastSeenAt: h.last_seen_at, lastScanAt: h.last_scan_at, online: (Date.now() - new Date(h.last_seen_at).getTime()) / 1000 <= HUB_ONLINE_SECONDS,
        found: h.found, outdated: !!h.version && h.version !== HUB_VERSION
      };
    });
}

// GET /api/pos/kitchen/outage — what a till or a kitchen screen keeps on
// the device for when the internet is down (a power cut can keep it down
// for days): the kitchens and the categories each makes, the printers each
// prints on (the till draws their tickets itself then: ESC/POS, or Star
// raster), and where the print hub answers on the restaurant's network,
// with its key. The till sends the kitchen's tickets there; the hub prints
// them and the kitchen screens take them from it (tools/print-hub).
async function outage(token) {
  var session = await access.need(token, ['till', 'kds']);
  var company = session.posCompanyId;
  var stations = (await pool.query('SELECT id, name, categories, everything_else FROM restaurant_kds_stations WHERE company_id = $1 AND active ORDER BY sort_order, name', [company])).rows;
  var prs = (await pool.query("SELECT * FROM restaurant_printers WHERE company_id = $1 AND NOT ignored AND name <> '' AND cardinality(station_ids) > 0 ORDER BY name", [company])).rows;
  var hub = (await pool.query(
    "SELECT * FROM restaurant_print_hubs WHERE company_id = $1 AND lan_key <> '' AND cardinality(lan_ips) > 0 AND last_seen_at > now() - interval '14 days' ORDER BY last_seen_at DESC LIMIT 1", [company])).rows[0];
  var live = new Set(stations.map(function (s) { return s.id; }));
  return {
    stations: stations.map(function (s) { return { id: s.id, name: s.name, categories: s.categories || [], everythingElse: !!s.everything_else }; }),
    printers: prs.map(function (pr) {
      return { id: pr.id, name: pr.name, mac: pr.mac, ip: pr.via === 'hub' ? pr.last_ip || '' : '', port: pr.port || 9100, language: printerBytes.languageOf(pr),
        paper: Number(pr.paper_mm) === 58 ? 58 : 80, stationIds: (pr.station_ids || []).filter(function (id) { return live.has(id); }) };
    }).filter(function (pr) { return pr.stationIds.length; }),
    hub: hub ? {
      name: hub.name || 'Print hub', urls: hub.lan_ips.map(function (ip) { return 'https://' + ip + ':' + hub.lan_port; }),
      setupUrl: hub.lan_setup_port ? 'http://' + hub.lan_ips[0] + ':' + hub.lan_setup_port + '/' : '', key: hub.lan_key, ca: hub.lan_ca, version: hub.version
    } : null
  };
}

module.exports = { poll: poll, hubsOf: hubsOf, outage: outage, HUB_VERSION: HUB_VERSION };
