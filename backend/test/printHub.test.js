// The Bamboo print hub (migration 0213, restaurantPrintHub.service.js): a
// program on a computer at the restaurant finds the printers on the
// network by itself — Epson, Star and other receipt printers — and they show
// up in Till settings → Printers, to be named and given their work; their
// tickets go to the hub as each printer's own bytes (ESC/POS pictures, Star
// raster), it says what printed; a printer out of paper or off gets nothing
// until it is back; one that asks by itself (CloudPRNT) stays that way; one
// taken off stays hidden. Fake Zph data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var app = require('../src/app');
var pos = require('../src/services/restaurantPos.service');
var printers = require('../src/services/restaurantPrinters.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7741', kojo: '7742' };
var IP = '10.9.8.1';
var EPSON = { mac: '64:eb:8c:00:00:01', ip: '192.168.50.21', port: 9100, make: 'epson', model: 'TM-T20III' };
var STAR = { mac: '00:11:62:00:00:02', ip: '192.168.50.22', port: 9100, make: 'star', model: 'TSP143IIILAN' };
var company, people = {}, tok = {}, stew, kitchen, server, base, hubLink, ids = {};

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZPH'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_print_jobs WHERE company_id = ANY($1)', 'DELETE FROM restaurant_printers WHERE company_id = ANY($1)', 'DELETE FROM restaurant_print_hubs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_print_links WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_tables WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) {
      try { await pool.query(q, [cos]); } catch (e) { if (e.code !== '42P01') throw e; }
    }
  }
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZPH-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zph', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
// The hub's side, as tools/print-hub speaks it.
var HUB = { key: 'zphhub000000000001', name: 'ZPH-OFFICE-PC', platform: 'win32', version: '1.0.0', networks: '192.168.50.0/24' };
async function hub(found, done, url) {
  var r = await fetch(url || hubLink, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hub: HUB, printers: found, done: done || [] }) });
  return { status: r.status, body: await r.json() };
}
var both = function (eState, sState) { return [Object.assign({ state: eState || 'ok' }, EPSON), Object.assign({ state: sState || 'ok' }, STAR)]; };
// Takes and prints everything; returns the jobs (bytes decoded).
async function printAll(found) {
  var out = [];
  for (var i = 0; i < 10; i++) {
    var r = await hub(found || both());
    if (!r.body.jobs.length) break;
    r.body.jobs.forEach(function (j) { out.push(Object.assign({}, j, { bytes: Buffer.from(j.data, 'base64') })); });
    await hub(found || both(), r.body.jobs.map(function (j) { return { id: j.id, ok: true }; }));
  }
  return out;
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZPH', 'Zph Chop Bar') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZPHF', 'Zph Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZPH-1', 'Ama', dept);
  await person('kojo', 'ZPH-2', 'Kojo', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager')", [company.id, people.kojo]);
  stew = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zph light soup', 'Zph Mains', 55, true) RETURNING id", [company.id])).rows[0].id;
  kitchen = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zph Kitchen', '{}', true) RETURNING id", [company.id])).rows[0].id;
  for (var k of ['ama', 'kojo']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(async function () { await new Promise(function (r) { server.close(r); }); await cleanup(); await pool.end(); });

test('the hub finds the printers by itself: they show up to be named; the hub is shown working', async function () {
  var s = await printers.manage(tok.kojo, { action: 'list' }, IP, base);
  // One link for everything: the hub takes the printer link as it is.
  hubLink = s.link.replace('/api/cloudprnt/', '/api/print-hub/');
  assert.deepEqual(s.hubs, []);
  assert.equal((await hub(both(), [], base + '/api/print-hub/notarealprinterlink00')).status, 404);
  var noKey = await fetch(hubLink, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hub: { key: 'x' } }) });
  assert.equal(noKey.status, 400);

  var r = await hub(both());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.jobs, []);
  assert.ok(r.body.pollMs > 0 && r.body.scanMs > 0);
  s = await printers.manage(tok.kojo, { action: 'list' }, IP, base);
  assert.equal(s.printers.length, 2);
  var ep = s.printers.find(function (p) { return p.mac === EPSON.mac; });
  var st = s.printers.find(function (p) { return p.mac === STAR.mac; });
  assert.deepEqual([ep.isNew, ep.via, ep.make, ep.model, ep.ip, ep.online, ep.language], [true, 'hub', 'epson', 'TM-T20III', '192.168.50.21', true, 'escpos']);
  assert.deepEqual([st.via, st.make, st.model, st.language], ['hub', 'star', 'TSP143IIILAN', 'star']);
  assert.equal(s.hubs.length, 1);
  assert.deepEqual([s.hubs[0].name, s.hubs[0].online, s.hubs[0].found, s.hubs[0].networks, s.hubs[0].outdated], ['ZPH-OFFICE-PC', true, 2, '192.168.50.0/24', false]);
  ids.epson = ep.id; ids.star = st.id;
  await printers.manage(tok.kojo, { action: 'save', id: ids.epson, name: 'Zph Kitchen printer', stationIds: [kitchen] }, IP, base);
  await printers.manage(tok.kojo, { action: 'save', id: ids.star, name: 'Zph Counter', stubs: true, receipts: true }, IP, base);
});

test('tickets go to the hub as each printer\'s own bytes; printed is printed', async function () {
  await printers.manage(tok.kojo, { action: 'test', id: ids.epson }, IP, base);
  await printers.manage(tok.kojo, { action: 'test', id: ids.star }, IP, base);
  var jobs = await printAll();
  assert.equal(jobs.length, 2);
  var e = jobs.find(function (j) { return j.mac === EPSON.mac; }), s = jobs.find(function (j) { return j.mac === STAR.mac; });
  assert.deepEqual([e.ip, e.port, e.language], ['192.168.50.21', 9100, 'escpos']);
  assert.equal(e.bytes.subarray(0, 2).toString('hex'), '1b40');                 // ESC @
  assert.ok(e.bytes.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00, 72, 0])) > 0);   // GS v 0, 576 dots wide
  assert.equal(e.bytes.subarray(-4).toString('hex'), '1d564200');              // feed and cut
  assert.equal(s.language, 'star');
  assert.equal(s.bytes.subarray(0, 4).toString('latin1'), '\x1b*rA');          // Star raster
  assert.equal(s.bytes.subarray(-4).toString('latin1'), '\x1b*rB');
  var done = (await pool.query("SELECT status FROM restaurant_print_jobs WHERE company_id = $1", [company.id])).rows;
  assert.ok(done.every(function (j) { return j.status === 'printed'; }));

  // An order to the kitchen: the kitchen's printer its dishes, the counter the summary.
  await pos.saveTab(tok.ama, { fulfillment: 'togo', label: 'Zph Esi', items: [{ menuItemId: stew, qty: 2 }] });
  jobs = await printAll();
  assert.deepEqual(jobs.map(function (j) { return j.mac; }).sort(), [STAR.mac, EPSON.mac].sort());
  // A receipt from a till, with the cash drawer: the drawer opens first.
  await printers.tillPrint(tok.ama, ids.star, { kind: 'receipt', title: 'Zph receipt', kick: true, doc: { cols: 42, pages: [[{ t: 'line', text: 'Zph receipt' }]] } });
  jobs = await printAll();
  assert.equal(jobs[0].bytes[0], 0x07);
});

test('out of paper, off, or not printed: nothing goes, the tills see why; tried again, then left for a till', async function () {
  await printers.tillPrint(tok.ama, ids.star, { kind: 'receipt', title: 'Zph paper', doc: { cols: 42, pages: [[{ t: 'line', text: 'Zph paper' }]] } });
  var r = await hub(both('ok', 'paper'));
  assert.deepEqual(r.body.jobs, []);
  var st = await printers.tillStatus(tok.ama);
  assert.equal(st.printers.find(function (p) { return p.id === ids.star; }).problem, 'paper');
  r = await hub(both('ok', 'offline'));
  st = await printers.tillStatus(tok.ama);
  assert.equal(st.printers.find(function (p) { return p.id === ids.star; }).problem, 'offline');
  // Back with paper: it goes; the hub could not reach it: queued again.
  r = await hub(both());
  assert.equal(r.body.jobs.length, 1);
  await hub(both(), [{ id: r.body.jobs[0].id, ok: false, error: 'Could not reach the printer' }]);
  var job = (await pool.query('SELECT status, attempts, error FROM restaurant_print_jobs WHERE id = $1', [r.body.jobs[0].id])).rows[0];
  assert.deepEqual([job.status, job.attempts, job.error], ['queued', 1, 'Could not reach the printer']);
  // Not straight back: it waits 10 seconds, then 20, …
  assert.deepEqual((await hub(both())).body.jobs, []);
  var id = r.body.jobs[0].id;
  for (var i = 0; i < 4; i++) {
    await pool.query("UPDATE restaurant_print_jobs SET sent_at = now() - interval '1 hour' WHERE id = $1", [id]);
    r = await hub(both());
    assert.equal(r.body.jobs[0].id, id);
    await hub(both(), [{ id: id, ok: false, error: 'Could not reach the printer' }]);
  }
  job = (await pool.query('SELECT status FROM restaurant_print_jobs WHERE id = $1', [r.body.jobs[0].id])).rows[0];
  assert.equal(job.status, 'failed');
  assert.deepEqual((await hub(both())).body.jobs, []);
});

test('a printer that asks by itself stays so; the language can be chosen; one taken off stays hidden', async function () {
  // The Star printer has CloudPRNT on too: it asks by itself, the hub leaves its tickets.
  var cloud = await fetch(hubLink.replace('/api/print-hub/', '/api/cloudprnt/'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printerMAC: STAR.mac, statusCode: '200%20OK' }) });
  assert.equal(cloud.status, 200);
  await hub(both());
  var s = await printers.manage(tok.kojo, { action: 'list' }, IP, base);
  assert.equal(s.printers.find(function (p) { return p.id === ids.star; }).via, 'cloudprnt');
  await printers.manage(tok.kojo, { action: 'test', id: ids.star }, IP, base);
  assert.deepEqual((await hub(both())).body.jobs, []);
  await pool.query("UPDATE restaurant_print_jobs SET status = 'cancelled' WHERE printer_id = $1 AND status = 'queued'", [ids.star]);
  await pool.query("UPDATE restaurant_printers SET cloud_seen_at = now() - interval '10 minutes' WHERE id = $1", [ids.star]);
  await hub(both());
  // The Star printer set to ESC/POS: sent as ESC/POS.
  await printers.manage(tok.kojo, { action: 'save', id: ids.star, name: 'Zph Counter', stubs: true, receipts: true, commandSet: 'escpos' }, IP, base);
  await printers.manage(tok.kojo, { action: 'test', id: ids.star }, IP, base);
  var jobs = await printAll();
  assert.equal(jobs[0].language, 'escpos');
  assert.equal(jobs[0].bytes.subarray(0, 2).toString('hex'), '1b40');
  // Taken off (an office printer, say): the hub finds it again, it stays hidden.
  s = await printers.manage(tok.kojo, { action: 'remove', id: ids.star }, IP, base);
  assert.equal(s.printers.length, 1);
  assert.equal(s.hidden, 1);
  await hub(both());
  s = await printers.manage(tok.kojo, { action: 'list' }, IP, base);
  assert.equal(s.printers.length, 1);
  s = await printers.manage(tok.kojo, { action: 'unhide' }, IP, base);
  assert.equal(s.hidden, 0);
  assert.ok(s.printers.find(function (p) { return p.id === ids.star; }).isNew);
});
