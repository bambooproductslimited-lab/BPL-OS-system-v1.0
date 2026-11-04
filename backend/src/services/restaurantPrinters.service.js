var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var ticketImage = require('../lib/ticketImage');
var printerBytes = require('../lib/printerBytes');

// The restaurant's printers on its network, as on Square: printers in the
// kitchens, at the bar and at the counter, each with a profile —
//   kitchen tickets for some stations (each kitchen prints only its own
//   dishes), the order summary for the cashier (every order sent, with
//   where each dish went), receipts and bills from the tills, and void
//   tickets when a dish already sent is taken off.
// A web page cannot reach a printer on the restaurant's network, so the
// printers fetch their work from this server instead (Star CloudPRNT):
// each printer, plugged into the router by Ethernet, is given the
// restaurant's printer link and asks it every few seconds whether there is
// anything to print. The first time a printer asks, it is added to the
// restaurant (by its MAC address) for a manager to name and set up in
// Till settings → Printers. What it prints is drawn as a picture
// (lib/ticketImage.js), so it prints the same on any Star CloudPRNT
// printer (mC-Print3, TSP100IV, TSP100III LAN…). A printer that is off or
// out of paper keeps its tickets until it is back; the tills say so.
//
// Kitchen tickets go out when the kitchen gets the order — sent from a
// till, a course called, paid, or from the website, a kiosk or a table's
// QR code with nobody at a till (restaurantPos keepTab, chargeOrder,
// fireCourse) — the same tickets the kitchen screen shows.

var ONLINE_SECONDS = 45;          // a printer asks every 5 seconds or so
var RESEND_SECONDS = 60;          // fetched but never said printed: sent again
var MAX_ATTEMPTS = 5;
var WHERE_EN = { togo: 'TO GO', pickup: 'PICKUP', delivery: 'DELIVERY' };
var ALLERGEN_EN = { gluten: 'gluten', crustaceans: 'crustaceans', eggs: 'eggs', fish: 'fish', peanuts: 'peanuts', soy: 'soy', milk: 'milk', nuts: 'tree nuts', celery: 'celery', mustard: 'mustard', sesame: 'sesame', sulphites: 'sulphites', lupin: 'lupin', molluscs: 'molluscs' };

function hhmm(d) { return new Date(d || Date.now()).toISOString().slice(11, 16); }
function colsOf(paperMm) { return Number(paperMm) === 58 ? 32 : 42; }
function L(text, o) { return Object.assign({ t: 'line', text: String(text == null ? '' : text), align: 'left', bold: false, scale: 1 }, o || {}); }
function wrap(text, width, indent) {
  var words = String(text || '').split(/\s+/).filter(Boolean), out = [], cur = '';
  words.forEach(function (w) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else { out.push(cur); cur = (indent || '') + w; }
  });
  if (cur) out.push(cur);
  return out.length ? out : [''];
}
function modsText(mods) {
  return (mods || []).map(function (m) { return m.how === 'no' ? 'No ' + m.name : m.how === 'extra' ? 'Extra ' + m.name : m.how === 'side' ? m.name + ' on the side' : m.name; }).join(', ');
}
function modsOf(text) {
  if (!text) return [];
  try { return JSON.parse(text).map(function (m) { return { how: m[0], name: m[1] }; }); } catch (e) { return []; }
}
function whereOf(t) {
  return WHERE_EN[t.fulfillment] || String(t.table_name || t.label || 'COUNTER').toUpperCase();
}

// ── the tickets, as lines ──────────────────────────────────────────────
// One kitchen's ticket: its dishes of one order (Square's kitchen ticket).
function kitchenDoc(printer, t, items, o) {
  var cols = colsOf(printer.paper_mm), rule = '-'.repeat(cols);
  var lines = [L(String(printer.name || 'Kitchen').toUpperCase(), { align: 'center', bold: true }), L('#' + t.number, { align: 'center', bold: true, scale: 2 }),
    L(whereOf(t).slice(0, Math.floor(cols / 2)), { align: 'center', bold: true, scale: 2 })];
  if (WHERE_EN[t.fulfillment] && (t.label || t.guest_name)) lines.push(L(String(t.label || t.guest_name).slice(0, cols), { align: 'center', bold: true }));
  if (t.course && o.courseNames) lines.push(L('** ' + String(o.courseNames[t.course - 1] || 'Course ' + t.course).toUpperCase() + ' **', { align: 'center', bold: true }));
  lines.push(L(rule));
  if ((t.allergens || []).length || t.allergy) {
    wrap('!! ALLERGY: ' + (t.allergens || []).map(function (a) { return ALLERGEN_EN[a] || a; }).join(', '), cols).forEach(function (x) { lines.push(L(x, { bold: true })); });
    if (t.allergy) wrap(t.allergy, cols - 3).forEach(function (x) { lines.push(L('   ' + x)); });
    lines.push(L(rule));
  }
  if (t.guests) lines.push(L('Guests: ' + t.guests));
  if (t.waiter_name) lines.push(L('Waiter: ' + t.waiter_name));
  items.forEach(function (it) {
    wrap((it.seat ? '[S' + it.seat + '] ' : '') + Number(it.qty) + ' x ' + it.name, cols, '    ').forEach(function (x) { lines.push(L(x, { bold: true })); });
    var mods = modsText(modsOf(it.mods));
    if (mods) wrap('+ ' + mods, cols - 3).forEach(function (x) { lines.push(L('   ' + x)); });
    if (it.note) wrap('* ' + it.note, cols - 3).forEach(function (x) { lines.push(L('   ' + x)); });
    var clash = (it.allergens || []).filter(function (a) { return (t.allergens || []).indexOf(a) >= 0; });
    if (clash.length) lines.push(L('   !! has ' + clash.map(function (a) { return ALLERGEN_EN[a] || a; }).join(', '), { bold: true }));
  });
  if (t.note) { lines.push(L(rule)); wrap('Note: ' + t.note, cols).forEach(function (x) { lines.push(L(x)); }); }
  lines.push(L(rule), L('Sent ' + hhmm(t.fired_at || t.created_at) + (o.byName ? '  by ' + o.byName : '')));
  return { cols: cols, pages: [lines] };
}
// The order summary for the cashier (Square's ticket stub): the whole round
// sent, each dish under the kitchen it went to.
function stubDoc(printer, t, groups, o) {
  var cols = colsOf(printer.paper_mm), rule = '-'.repeat(cols);
  var lines = [L('ORDER SENT', { align: 'center', bold: true }), L(whereOf(t).slice(0, Math.floor(cols / 2)), { align: 'center', bold: true, scale: 2 }),
    L('#' + t.number + (WHERE_EN[t.fulfillment] && (t.label || t.guest_name) ? ' · ' + (t.label || t.guest_name) : ''), { align: 'center', bold: true })];
  lines.push(L(rule));
  if (t.waiter_name || t.guests) lines.push(L([t.waiter_name ? 'Waiter: ' + t.waiter_name : '', t.guests ? 'Guests: ' + t.guests : ''].filter(Boolean).join('   ')));
  groups.forEach(function (g) {
    lines.push(L('> ' + String(g.where).toUpperCase(), { bold: true }));
    g.items.forEach(function (it) {
      wrap(Number(it.qty) + ' x ' + it.name, cols - 2, '      ').forEach(function (x) { lines.push(L('  ' + x)); });
      var mods = modsText(modsOf(it.mods));
      if (mods) wrap('+ ' + mods, cols - 5).forEach(function (x) { lines.push(L('     ' + x)); });
    });
  });
  if ((t.allergens || []).length || t.allergy) lines.push(L(rule), L('!! ALLERGY: ' + ((t.allergens || []).map(function (a) { return ALLERGEN_EN[a] || a; }).join(', ') || t.allergy).slice(0, cols - 12), { bold: true }));
  lines.push(L(rule), L('Sent ' + hhmm(t.created_at) + (o.byName ? '  by ' + o.byName : '')));
  return { cols: cols, pages: [lines] };
}
// A dish taken off after it went to the kitchen.
function voidDoc(printer, t, items, o) {
  var cols = colsOf(printer.paper_mm), rule = '-'.repeat(cols);
  var lines = [L('*** VOID ***', { align: 'center', bold: true, scale: 2 }), L(String(printer.name || 'Kitchen').toUpperCase(), { align: 'center', bold: true }),
    L('#' + t.number + '  ' + whereOf(t), { align: 'center', bold: true, scale: 2 }), L(rule)];
  items.forEach(function (it) {
    wrap('-' + Number(it.qty) + ' x ' + it.name, cols, '     ').forEach(function (x) { lines.push(L(x, { bold: true })); });
    var mods = modsText(modsOf(it.mods));
    if (mods) wrap('+ ' + mods, cols - 3).forEach(function (x) { lines.push(L('   ' + x)); });
  });
  lines.push(L(rule), L('DO NOT MAKE', { align: 'center', bold: true }), L('Taken off ' + hhmm() + (o.byName ? '  by ' + o.byName : '')));
  return { cols: cols, pages: [lines] };
}
function testDoc(printer, companyName, stationNames) {
  var cols = colsOf(printer.paper_mm), rule = '-'.repeat(cols);
  var does = [];
  if (stationNames.length) does.push('Kitchen tickets: ' + stationNames.join(', '));
  if (printer.stubs) does.push('Order summary for the cashier');
  if (printer.receipts) does.push('Receipts and bills');
  if (printer.voids && stationNames.length) does.push('Void tickets');
  var lines = [L('TEST PRINT', { align: 'center', bold: true, scale: 2 }), L(String(printer.name || 'New printer').toUpperCase(), { align: 'center', bold: true }),
    L(String(companyName || '').slice(0, cols), { align: 'center' }), L(rule)];
  (does.length ? does : ['Nothing set up yet: choose what it prints in Till settings -> Printers.']).forEach(function (d) { wrap(d, cols - 2, '  ').forEach(function (x) { lines.push(L(x)); }); });
  // What it is and where: found by the print hub, its model and address;
  // a printer asking by itself, its MAC.
  var which = printer.via === 'hub' ? [printer.model || ({ epson: 'Epson', star: 'Star' })[printer.make] || 'Printer', printer.last_ip + (printer.port && printer.port !== 9100 ? ':' + printer.port : '')].filter(Boolean).join(' at ') : 'Printer ' + printer.mac;
  lines.push(L(rule));
  wrap(which, cols, '').forEach(function (x) { lines.push(L(x)); });
  if (printer.via === 'hub') lines.push(L('Through the Bamboo print hub'));
  lines.push(L('Printed ' + hhmm() + ' UTC'));
  return { cols: cols, pages: [lines] };
}

// A ticket from a till (its receipt, bill or report, as the till reads its
// own printer bytes): only lines, feeds and QR codes, within reason.
function cleanDoc(doc) {
  if (!doc || !Array.isArray(doc.pages)) fail('invalid', 'Nothing to print.');
  var count = 0;
  var pages = doc.pages.slice(0, 10).map(function (p) {
    return (Array.isArray(p) ? p : []).slice(0, 400).map(function (x) {
      count++;
      if (!x || typeof x !== 'object') return null;
      if (x.t === 'feed') return { t: 'feed', n: Math.max(0, Math.min(10, Math.round(Number(x.n) || 0))) };
      if (x.t === 'qr') return { t: 'qr', data: String(x.data || '').slice(0, 400), align: ['left', 'center', 'right'].indexOf(x.align) >= 0 ? x.align : 'center' };
      return { t: 'line', text: String(x.text == null ? '' : x.text).slice(0, 120), align: ['left', 'center', 'right'].indexOf(x.align) >= 0 ? x.align : 'left', bold: !!x.bold, scale: Math.max(1, Math.min(4, Math.round(Number(x.scale) || 1))) };
    }).filter(Boolean);
  }).filter(function (p) { return p.length; });
  if (!pages.length || count > 2000) fail('invalid', 'Nothing to print.');
  return { cols: Math.max(24, Math.min(48, Math.round(Number(doc.cols) || 42))), pages: pages };
}

// ── putting work on the printers ───────────────────────────────────────
async function addJob(db, printer, kind, title, doc, o) {
  o = o || {};
  var n = kind === 'kitchen' || kind === 'void' ? printer.copies || 1 : 1;
  for (var i = 0; i < n; i++) {
    await db.query('INSERT INTO restaurant_print_jobs (company_id, printer_id, kind, title, doc, kick, ticket_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [printer.company_id, printer.id, kind, String(title || '').slice(0, 120), JSON.stringify(doc), !!o.kick, o.ticketId || null, o.by || null]);
  }
  return n;
}
async function printersOf(db, companyId) {
  return (await db.query("SELECT * FROM restaurant_printers WHERE company_id = $1 AND name <> '' ORDER BY name", [companyId])).rows;
}
async function nameOf(db, employeeId) {
  if (!employeeId) return '';
  var r = (await db.query("SELECT first_name || ' ' || last_name AS n FROM employees WHERE id = $1", [employeeId])).rows[0];
  return r ? r.n : '';
}

// The kitchen has these tickets now (sent, a course called, paid): each
// kitchen printer prints its own dishes of each, and the summary printers
// the whole round. Within the caller's transaction. Returns how many
// tickets were put on printers.
async function sendKitchen(db, companyId, ticketIds, o) {
  o = o || {};
  if (!ticketIds || !ticketIds.length) return 0;
  var printers = await printersOf(db, companyId);
  if (!printers.length) return 0;
  var tickets = (await db.query('SELECT * FROM restaurant_kitchen_tickets WHERE id = ANY($1::uuid[]) ORDER BY course, created_at', [ticketIds])).rows;
  var items = (await db.query(
    "SELECT i.*, s.name AS station_name FROM restaurant_kitchen_items i LEFT JOIN restaurant_kds_stations s ON s.id = i.station_id " +
    "WHERE i.ticket_id = ANY($1::uuid[]) AND i.status = 'cooking' ORDER BY s.sort_order, s.name, i.seat NULLS FIRST, i.created_at", [ticketIds])).rows;
  if (!items.length) return 0;
  var settings = await access.settingsOf(companyId, db);
  var courseNames = settings.courses && settings.courses.on ? settings.courses.names || [] : null;
  var made = 0;
  for (var k = 0; k < tickets.length; k++) {
    var t = tickets[k];
    var mine = items.filter(function (it) { return it.ticket_id === t.id; });
    if (!mine.length) continue;
    var byName = o.byName !== undefined ? o.byName : await nameOf(db, t.sent_by);
    for (var p = 0; p < printers.length; p++) {
      var pr = printers[p];
      var here = mine.filter(function (it) { return (pr.station_ids || []).indexOf(it.station_id) >= 0; });
      if (here.length) made += await addJob(db, pr, 'kitchen', '#' + t.number + ' ' + whereOf(t), kitchenDoc(pr, t, here, { courseNames: courseNames, byName: byName }), { ticketId: t.id, by: t.sent_by });
    }
  }
  // The summary: one per round, with every ticket of it.
  var stubs = printers.filter(function (pr) { return pr.stubs; });
  if (stubs.length) {
    var first = tickets[0];
    var groups = [];
    items.forEach(function (it) {
      var to = printers.filter(function (pr) { return (pr.station_ids || []).indexOf(it.station_id) >= 0; }).map(function (pr) { return pr.name; });
      var where = to.length ? to.join(' + ') : (it.station_name || 'Kitchen') + ' (screen)';
      var g = groups.find(function (x) { return x.where === where; });
      if (!g) groups.push(g = { where: where, items: [] });
      g.items.push(it);
    });
    var stubBy = o.byName !== undefined ? o.byName : await nameOf(db, first.sent_by);
    for (var s = 0; s < stubs.length; s++) made += await addJob(db, stubs[s], 'stub', 'Order #' + first.number + ' ' + whereOf(first), stubDoc(stubs[s], first, groups, { byName: stubBy }), { ticketId: first.id, by: first.sent_by });
  }
  return made;
}

// Dishes taken off after the kitchen had them ([{ ticketId, stationId,
// name, qty, mods }]): a void ticket on their kitchen's printer.
async function sendVoids(db, companyId, voided, o) {
  o = o || {};
  if (!voided || !voided.length) return 0;
  var printers = (await printersOf(db, companyId)).filter(function (pr) { return pr.voids; });
  if (!printers.length) return 0;
  var ids = Array.from(new Set(voided.map(function (v) { return v.ticketId; })));
  var tickets = (await db.query('SELECT * FROM restaurant_kitchen_tickets WHERE id = ANY($1::uuid[])', [ids])).rows;
  var byName = o.byName !== undefined ? o.byName : await nameOf(db, o.by);
  var made = 0;
  for (var k = 0; k < tickets.length; k++) {
    var t = tickets[k];
    for (var p = 0; p < printers.length; p++) {
      var pr = printers[p];
      var here = voided.filter(function (v) { return v.ticketId === t.id && (pr.station_ids || []).indexOf(v.stationId) >= 0; });
      if (here.length) made += await addJob(db, pr, 'void', 'VOID #' + t.number + ' ' + whereOf(t), voidDoc(pr, t, here, { byName: byName }), { ticketId: t.id, by: o.by });
    }
  }
  return made;
}

// ── the printers' side (Star CloudPRNT) ────────────────────────────────
async function linkCompany(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail('notfound', 'Not a printer link.');
  var r = (await pool.query('SELECT company_id FROM restaurant_print_links WHERE token = $1', [token])).rows[0];
  if (!r) fail('notfound', 'Not a printer link.');
  return r.company_id;
}
function macOf(v) {
  var m = String(v || '').trim().toLowerCase().replace(/-/g, ':');
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m) ? m : '';
}
function statusText(code) {
  try { return decodeURIComponent(String(code || '')).trim().slice(0, 80); } catch (e) { return String(code || '').slice(0, 80); }
}
async function nextJob(db, printerId) {
  return (await db.query(
    "SELECT * FROM restaurant_print_jobs WHERE printer_id = $1 AND (status = 'queued' OR (status = 'printing' AND sent_at < now() - make_interval(secs => $2))) ORDER BY created_at LIMIT 1",
    [printerId, RESEND_SECONDS])).rows[0];
}
// POST {link}: the printer asks (every few seconds) whether there is work,
// saying how it is (statusCode: "200 OK", "410 Paper Empty"…).
async function poll(token, body, ip) {
  var companyId = await linkCompany(token);
  body = body || {};
  var mac = macOf(body.printerMAC);
  if (!mac) fail('invalid', 'The printer did not say its MAC address.');
  var code = statusText(body.statusCode);
  var pr = (await pool.query(
    "INSERT INTO restaurant_printers (company_id, mac, status_code, last_seen_at, last_ip, via, cloud_seen_at) VALUES ($1,$2,$3,now(),$4,'cloudprnt',now()) " +
    "ON CONFLICT (company_id, mac) DO UPDATE SET status_code = EXCLUDED.status_code, last_seen_at = now(), last_ip = EXCLUDED.last_ip, via = 'cloudprnt', cloud_seen_at = now() RETURNING *",
    [companyId, mac, code, String(ip || '').slice(0, 60)])).rows[0];
  var job = /^2/.test(code) || !code ? await nextJob(pool, pr.id) : null;
  return job ? { jobReady: true, mediaTypes: ['image/png'], jobToken: job.id } : { jobReady: false };
}
// GET {link}?mac=…&type=image/png&token=…: the printer takes its next
// ticket, as a picture. { body, headers } or null (nothing to print).
async function fetchJob(token, q) {
  var companyId = await linkCompany(token);
  q = q || {};
  var mac = macOf(q.mac);
  var pr = (await pool.query('SELECT * FROM restaurant_printers WHERE company_id = $1 AND mac = $2', [companyId, mac])).rows[0];
  if (!pr) return null;
  var job = q.token && /^[0-9a-f-]{36}$/i.test(q.token)
    ? (await pool.query("SELECT * FROM restaurant_print_jobs WHERE id = $1 AND printer_id = $2 AND status IN ('queued', 'printing')", [q.token, pr.id])).rows[0]
    : await nextJob(pool, pr.id);
  if (!job) return null;
  await pool.query("UPDATE restaurant_print_jobs SET status = 'printing', sent_at = now(), attempts = attempts + 1 WHERE id = $1", [job.id]);
  var pages = await ticketImage.renderDoc(job.doc, { paperMm: pr.paper_mm });
  var headers = { 'Content-Type': 'image/png', 'X-Star-Cut': 'partial; feed=true', 'Cache-Control': 'no-store' };
  if (job.kick) headers['X-Star-CashDrawer'] = 'start';
  return { body: pages[0], headers: headers, jobId: job.id };
}
// DELETE {link}?mac=…&code=200%20OK&token=…: printed (or why not). Not
// printed: tried again (the paper put back, the printer prints it), up to
// a point; then it waits for someone at a till to print it again.
async function finishJob(token, q) {
  var companyId = await linkCompany(token);
  q = q || {};
  var mac = macOf(q.mac);
  var pr = (await pool.query('SELECT id FROM restaurant_printers WHERE company_id = $1 AND mac = $2', [companyId, mac])).rows[0];
  if (!pr) return { ok: true };
  var job = q.token && /^[0-9a-f-]{36}$/i.test(q.token)
    ? (await pool.query('SELECT * FROM restaurant_print_jobs WHERE id = $1 AND printer_id = $2', [q.token, pr.id])).rows[0]
    : (await pool.query("SELECT * FROM restaurant_print_jobs WHERE printer_id = $1 AND status = 'printing' ORDER BY sent_at LIMIT 1", [pr.id])).rows[0];
  if (!job || job.status !== 'printing') return { ok: true };
  var code = statusText(q.code || '200 OK');
  if (/^2/.test(code)) await pool.query("UPDATE restaurant_print_jobs SET status = 'printed', done_at = now(), error = '' WHERE id = $1", [job.id]);
  else {
    await pool.query("UPDATE restaurant_print_jobs SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END, error = $3, done_at = CASE WHEN attempts >= $2 THEN now() END WHERE id = $1",
      [job.id, MAX_ATTEMPTS, code]);
    await pool.query('UPDATE restaurant_printers SET status_code = $2 WHERE id = $1', [pr.id, code]);
  }
  return { ok: true };
}

// ── how the printers are, for the tills ────────────────────────────────
function problemOf(p) {
  var seen = p.last_seen_at ? (Date.now() - new Date(p.last_seen_at).getTime()) / 1000 : Infinity;
  if (seen > ONLINE_SECONDS) return 'offline';
  var code = String(p.status_code || '');
  if (!code || /^2/.test(code)) return /low/i.test(code) ? 'low' : null;
  if (/paper/i.test(code)) return 'paper';
  if (/cover/i.test(code)) return 'cover';
  return 'error';
}
function printerOut(p, stations, counts) {
  var c = counts.get(p.id) || { waiting: 0, failed: 0 };
  return {
    id: p.id, name: p.name, mac: p.mac, isNew: !p.name, paper: p.paper_mm, stationIds: p.station_ids || [], stations: (p.station_ids || []).map(function (id) { return stations.get(id); }).filter(Boolean),
    stubs: p.stubs, receipts: p.receipts, voids: p.voids, copies: p.copies, lastSeenAt: p.last_seen_at, ip: p.last_ip, statusText: p.status_code || '',
    // How it is reached: asking by itself (CloudPRNT) or through the print
    // hub (restaurantPrintHub.service.js), and what it is.
    via: p.via || 'cloudprnt', make: p.make || '', model: p.model || '', port: p.port || null, hubId: p.hub_id || null,
    commandSet: p.command_set || '', language: p.via === 'hub' ? printerBytes.languageOf(p) : 'png',
    problem: problemOf(p), online: problemOf(p) !== 'offline', waiting: c.waiting, failed: c.failed
  };
}
async function listFor(companyId, includeNew) {
  var rows = (await pool.query('SELECT * FROM restaurant_printers WHERE company_id = $1 AND NOT ignored' + (includeNew ? '' : " AND name <> ''") + " ORDER BY name = '' DESC, name", [companyId])).rows;
  if (!rows.length) return [];
  var stations = new Map((await pool.query('SELECT id, name FROM restaurant_kds_stations WHERE company_id = $1', [companyId])).rows.map(function (s) { return [s.id, s.name]; }));
  var counts = new Map((await pool.query(
    "SELECT printer_id, count(*) FILTER (WHERE status IN ('queued', 'printing'))::int AS waiting, count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '12 hours')::int AS failed " +
    'FROM restaurant_print_jobs WHERE company_id = $1 GROUP BY 1', [companyId])).rows.map(function (r) { return [r.printer_id, r]; }));
  return rows.map(function (p) { return printerOut(p, stations, counts); });
}
// For the till's look every few seconds (restaurantTableOrders inbox).
function summary(companyId) { return listFor(companyId, false); }

// Orders sent to the kitchen by someone else in the last few minutes (a
// waiter, the website, a kiosk, a table's QR code), for the cashier's alert.
async function sentByOthers(companyId, employeeId) {
  return (await pool.query(
    "SELECT t.number, min(t.created_at) AS at, max(t.label) AS label, max(t.table_name) AS table_name, max(t.fulfillment) AS fulfillment, max(t.guest_name) AS guest_name, " +
    "  (array_agg(t.tab_id) FILTER (WHERE t.tab_id IS NOT NULL))[1] AS tab_id, max(e.first_name || ' ' || e.last_name) AS by_name, sum(i.qty)::float AS dishes " +
    "FROM restaurant_kitchen_tickets t JOIN restaurant_kitchen_items i ON i.ticket_id = t.id AND i.status <> 'cancelled' LEFT JOIN employees e ON e.id = t.sent_by " +
    "WHERE t.company_id = $1 AND t.created_at > now() - interval '10 minutes' AND t.status <> 'held' AND (t.sent_by IS NULL OR t.sent_by <> $2) " +
    'GROUP BY t.number, date_trunc(\'second\', t.created_at) ORDER BY min(t.created_at)', [companyId, employeeId || '00000000-0000-0000-0000-000000000000'])).rows
    .map(function (r) {
      return { key: r.number + ':' + new Date(r.at).getTime(), number: r.number, at: r.at, where: r.fulfillment && r.fulfillment !== 'dine_in' ? r.fulfillment : 'dine_in',
        name: r.table_name || r.label || r.guest_name || '', by: r.by_name || '', tabId: r.tab_id || null, dishes: Number(r.dishes) };
    });
}

// GET /api/pos/printers — the printers and what has not printed.
async function tillStatus(token) {
  var session = await access.need(token, 'till');
  var company = session.posCompanyId;
  var jobs = (await pool.query(
    "SELECT j.id, j.printer_id, j.kind, j.title, j.status, j.error, j.attempts, j.created_at, j.done_at, p.name AS printer_name FROM restaurant_print_jobs j JOIN restaurant_printers p ON p.id = j.printer_id " +
    "WHERE j.company_id = $1 AND j.created_at > now() - interval '12 hours' ORDER BY j.created_at DESC LIMIT 40", [company])).rows
    .map(function (j) { return { id: j.id, printerId: j.printer_id, printerName: j.printer_name, kind: j.kind, title: j.title, status: j.status, error: j.error, attempts: j.attempts, at: j.created_at, doneAt: j.done_at }; });
  return { printers: await listFor(company, false), jobs: jobs };
}
// POST /api/pos/printers/:id/print { kind: 'receipt'|'bill'|'report'|'test', doc, kick, title }
// — a till's receipt, bill or report on a network printer (each page its
// own ticket, cut off).
async function tillPrint(token, printerId, p) {
  var session = await access.need(token, 'till');
  p = p || {};
  var pr = (await pool.query("SELECT * FROM restaurant_printers WHERE id = $1 AND company_id = $2 AND name <> ''", [printerId, session.posCompanyId])).rows[0];
  if (!pr) fail('notfound', 'That printer is not set up here any more.');
  var kind = ['receipt', 'bill', 'report', 'test'].indexOf(p.kind) >= 0 ? p.kind : 'receipt';
  if (!pr.receipts && kind !== 'test') fail('invalid', pr.name + ' does not print receipts: turn it on in Till settings → Printers.');
  var doc = cleanDoc(p.doc);
  var made = 0;
  for (var i = 0; i < doc.pages.length; i++) {
    made += await addJob(pool, pr, kind, String(p.title || kind).slice(0, 120), { cols: doc.cols, pages: [doc.pages[i]] }, { kick: !!p.kick && i === 0, by: session.posEmployeeId });
  }
  return { jobs: made, printer: pr.name };
}
// POST /api/pos/print-jobs/:id/again — printed once more (a lost ticket, a
// printer back with paper).
async function printAgain(token, jobId) {
  var session = await access.need(token, 'till');
  var job = (await pool.query('SELECT * FROM restaurant_print_jobs WHERE id = $1 AND company_id = $2', [jobId, session.posCompanyId])).rows[0];
  if (!job) fail('notfound', 'That ticket is not here any more.');
  return withTransaction(async function (client) {
    // Still waiting or failed: that one goes again; printed: a copy.
    if (job.status === 'failed' || job.status === 'cancelled') await client.query("UPDATE restaurant_print_jobs SET status = 'queued', attempts = 0, error = '', done_at = NULL WHERE id = $1", [job.id]);
    else if (job.status === 'printed') {
      await client.query('INSERT INTO restaurant_print_jobs (company_id, printer_id, kind, title, doc, kick, ticket_id, created_by) VALUES ($1,$2,$3,$4,$5,false,$6,$7)',
        [job.company_id, job.printer_id, job.kind, job.title, JSON.stringify(job.doc), job.ticket_id, session.posEmployeeId]);
    }
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.reprint', summary: 'Printed again: ' + job.title + '.', refType: 'print_job', refId: job.id });
    return { ok: true };
  });
}
// POST /api/pos/print-jobs/:id/cancel — not printed after all.
async function cancelJob(token, jobId) {
  var session = await access.need(token, 'till');
  var r = await pool.query("UPDATE restaurant_print_jobs SET status = 'cancelled', done_at = now() WHERE id = $1 AND company_id = $2 AND status IN ('queued', 'printing', 'failed') RETURNING title", [jobId, session.posCompanyId]);
  if (!r.rows[0]) fail('conflict', 'That ticket has printed already.');
  return { ok: true };
}

// ── setting them up (Till settings → Printers, a manager) ──────────────
async function linkOf(companyId) {
  var r = (await pool.query('SELECT token FROM restaurant_print_links WHERE company_id = $1', [companyId])).rows[0];
  if (r) return r.token;
  var token = crypto.randomBytes(18).toString('base64url');
  await pool.query('INSERT INTO restaurant_print_links (company_id, token) VALUES ($1, $2) ON CONFLICT (company_id) DO NOTHING', [companyId, token]);
  return (await pool.query('SELECT token FROM restaurant_print_links WHERE company_id = $1', [companyId])).rows[0].token;
}
// POST /api/pos/settings/printers { managerPin, action: 'list'|'save'|'remove'|'test', … }
// origin: this server's own address, for the printer link.
async function manage(token, p, ip, origin) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  var stations = (await pool.query('SELECT id, name FROM restaurant_kds_stations WHERE company_id = $1 AND active ORDER BY sort_order, name', [company])).rows;
  var mine = async function (id) {
    var pr = (await pool.query('SELECT * FROM restaurant_printers WHERE id = $1 AND company_id = $2', [id, company])).rows[0];
    if (!pr) fail('notfound', 'That printer is not here any more.');
    return pr;
  };
  var log = function (action, summary, id) {
    return activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'settings', action: action, summary: summary, refType: 'printer', refId: id });
  };
  if (p.action === 'save') {
    var pr = await mine(p.id);
    var name = String(p.name || '').trim().slice(0, 40);
    if (!name) fail('invalid', 'Give the printer a name, such as Kitchen, Grill, Bar or Counter.');
    var clash = (await pool.query('SELECT 1 FROM restaurant_printers WHERE company_id = $1 AND lower(name) = lower($2) AND id <> $3', [company, name, pr.id])).rows[0];
    if (clash) fail('conflict', 'Another printer is called ' + name + ' already.');
    var ids = Array.isArray(p.stationIds) ? p.stationIds.filter(function (id) { return stations.some(function (s) { return s.id === id; }); }) : pr.station_ids;
    // The printer language (a printer found by the hub): as its make says,
    // or Star raster / ESC/POS when a test print comes out wrong.
    var lang = p.commandSet === undefined ? pr.command_set : ['star', 'escpos'].indexOf(p.commandSet) >= 0 ? p.commandSet : '';
    await pool.query('UPDATE restaurant_printers SET name = $2, paper_mm = $3, station_ids = $4, stubs = $5, receipts = $6, voids = $7, copies = $8, command_set = $9, updated_at = now() WHERE id = $1',
      [pr.id, name, Number(p.paper) === 58 ? 58 : 80, ids, !!p.stubs, !!p.receipts, p.voids !== false, Math.max(1, Math.min(3, Math.round(Number(p.copies) || 1))), lang]);
    await log('settings.printer', (pr.name ? 'Changed the printer ' : 'Set up a new printer as ') + name + ': ' +
      [ids.length ? 'kitchen tickets for ' + stations.filter(function (s) { return ids.indexOf(s.id) >= 0; }).map(function (s) { return s.name; }).join(', ') : '', p.stubs ? 'the order summary' : '', p.receipts ? 'receipts and bills' : '']
        .filter(Boolean).join('; ') + '.', pr.id);
  } else if (p.action === 'remove') {
    var gone = await mine(p.id);
    // One the print hub found would be found again: it is hidden instead
    // (an office printer on the network, say), until shown again.
    if (gone.via === 'hub') {
      await pool.query("UPDATE restaurant_printers SET ignored = true, name = '', station_ids = '{}', stubs = false, receipts = false, updated_at = now() WHERE id = $1", [gone.id]);
      await pool.query("UPDATE restaurant_print_jobs SET status = 'cancelled', done_at = now() WHERE printer_id = $1 AND status IN ('queued', 'printing')", [gone.id]);
    } else {
      await pool.query('DELETE FROM restaurant_printers WHERE id = $1', [gone.id]);
    }
    await log('settings.printer', 'Took off the printer ' + (gone.name || gone.model || gone.mac) + '.', gone.id);
  } else if (p.action === 'unhide') {
    var back = await pool.query('UPDATE restaurant_printers SET ignored = false WHERE company_id = $1 AND ignored RETURNING id', [company]);
    if (back.rows.length) await log('settings.printer', 'Showed again ' + back.rows.length + ' printer(s) taken off before.', null);
  } else if (p.action === 'test') {
    var tp = await mine(p.id);
    var co = (await pool.query('SELECT name FROM companies WHERE id = $1', [company])).rows[0];
    await addJob(pool, tp, 'test', 'Test print', testDoc(tp, co && co.name, stations.filter(function (s) { return (tp.station_ids || []).indexOf(s.id) >= 0; }).map(function (s) { return s.name; })), { by: m.manager.id });
  }
  var hubs = require('./restaurantPrintHub.service');
  return {
    link: String(origin || '').replace(/\/$/, '') + '/api/cloudprnt/' + await linkOf(company),
    printers: await listFor(company, true), stations: stations.map(function (s) { return { id: s.id, name: s.name }; }),
    // The print hubs looking for printers, and those taken off (hidden).
    hubs: await hubs.hubsOf(company), hubVersion: hubs.HUB_VERSION,
    hidden: (await pool.query('SELECT count(*)::int AS n FROM restaurant_printers WHERE company_id = $1 AND ignored', [company])).rows[0].n
  };
}

module.exports = {
  poll: poll, fetchJob: fetchJob, finishJob: finishJob, sendKitchen: sendKitchen, sendVoids: sendVoids, summary: summary, sentByOthers: sentByOthers,
  tillStatus: tillStatus, tillPrint: tillPrint, printAgain: printAgain, cancelJob: cancelJob, manage: manage, linkOf: linkOf, linkCompany: linkCompany,
  kitchenDoc: kitchenDoc, cleanDoc: cleanDoc
};
