// The restaurant's network printers, Square-style (migration 0211,
// restaurantPrinters.service.js): a printer on the restaurant's network
// asks the restaurant's printer link for work (Star CloudPRNT, over HTTP as
// the printer does it), is set up by a manager with its profile — kitchen
// tickets for some stations, the order summary, receipts — and prints each
// kitchen's own dishes when an order goes to the kitchen, a void ticket when
// a dish is taken off, what a till sends it; the tills see a printer that
// is off or out of paper, and the cashier the orders others sent. Fake
// Zpr data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var app = require('../src/app');
var pos = require('../src/services/restaurantPos.service');
var printers = require('../src/services/restaurantPrinters.service');
var tables = require('../src/services/restaurantTableOrders.service');
var access = require('../src/services/restaurantTillAccess.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7731', kojo: '7732', yaw: '7733' };
var IP = '10.9.7.1';
var MAC = { grill: '00:11:62:aa:00:01', bar: '00:11:62:aa:00:02', counter: '00:11:62:aa:00:03' };
var company, people = {}, tok = {}, stew, juice, t1, t2, grill, bar, server, base, link, ids = {};

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZPR'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_print_jobs WHERE company_id = ANY($1)', 'DELETE FROM restaurant_printers WHERE company_id = ANY($1)', 'DELETE FROM restaurant_print_links WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)', 'DELETE FROM restaurant_table_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_payments WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_stock_moves WHERE company_id = ANY($1)', 'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_tables WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) {
      try { await pool.query(q, [cos]); } catch (e) { if (e.code !== '42P01') throw e; }
    }
  }
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZPR-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zpr', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
// The printer's side, as a Star CloudPRNT printer speaks it.
async function poll(mac, status) {
  var r = await fetch(link, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: '23 86 00 00 00 00 00 00 00 ', printerMAC: mac, statusCode: encodeURIComponent(status || '200 OK'), printingInProgress: false, clientAction: null }) });
  assert.equal(r.status, 200);
  return r.json();
}
async function take(mac, jobToken) {
  var r = await fetch(link + '?uid=1&type=image%2Fpng&mac=' + encodeURIComponent(mac) + (jobToken ? '&token=' + jobToken : ''));
  return { status: r.status, type: r.headers.get('content-type'), cut: r.headers.get('x-star-cut'), drawer: r.headers.get('x-star-cashdrawer'), body: Buffer.from(await r.arrayBuffer()) };
}
async function done(mac, jobToken, code) {
  var r = await fetch(link + '?mac=' + encodeURIComponent(mac) + '&code=' + encodeURIComponent(code || '200 OK') + (jobToken ? '&token=' + jobToken : ''), { method: 'DELETE' });
  assert.equal(r.status, 200);
}
// Everything a printer has: asked for, taken and printed. Returns the docs.
async function printAll(mac) {
  var docs = [];
  for (var i = 0; i < 10; i++) {
    var p = await poll(mac);
    if (!p.jobReady) break;
    var job = (await pool.query('SELECT kind, doc FROM restaurant_print_jobs WHERE id = $1', [p.jobToken])).rows[0];
    var got = await take(mac, p.jobToken);
    assert.equal(got.status, 200);
    assert.equal(got.type, 'image/png');
    assert.equal(got.body.subarray(1, 4).toString(), 'PNG');
    await done(mac, p.jobToken);
    docs.push({ kind: job.kind, text: job.doc.pages[0].map(function (l) { return l.text || ''; }).join('\n') });
  }
  return docs;
}
async function waiting(printerId) {
  return (await pool.query("SELECT kind, status FROM restaurant_print_jobs WHERE printer_id = $1 AND status IN ('queued', 'printing', 'failed') ORDER BY created_at", [printerId])).rows;
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZPR', 'Zpr Grill House') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZPRF', 'Zpr Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZPR-1', 'Ama', dept);
  await person('kojo', 'ZPR-2', 'Kojo', dept);
  await person('yaw', 'ZPR-3', 'Yaw', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'waiter')", [company.id, people.kojo, people.yaw]);
  stew = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zpr groundnut stew', 'Zpr Mains', 60, true) RETURNING id", [company.id])).rows[0].id;
  juice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zpr sobolo', 'Zpr Drinks', 15, true) RETURNING id", [company.id])).rows[0].id;
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name, qr_token) VALUES ($1, 'Zpr T1', 'zprqrtable0001') RETURNING id", [company.id])).rows[0].id;
  t2 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zpr T2') RETURNING id", [company.id])).rows[0].id;
  grill = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zpr Kitchen', '{}', true) RETURNING id", [company.id])).rows[0].id;
  // The bar had its tickets printed at the till before it got its own printer.
  bar = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else, print_tickets) VALUES ($1, 'Zpr Bar', '{\"Zpr Drinks\"}', false, true) RETURNING id", [company.id])).rows[0].id;
  for (var k of ['ama', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(async function () { await new Promise(function (r) { server.close(r); }); await cleanup(); await pool.end(); });

test('setting up: the printer link, printers found by themselves, named with their profiles; only a manager', async function () {
  await assert.rejects(printers.manage(tok.yaw, { action: 'list' }, IP, base), /manager/);
  var s = await printers.manage(tok.kojo, { action: 'list' }, IP, base);
  assert.ok(s.link.startsWith(base + '/api/cloudprnt/'));
  link = s.link;
  assert.deepEqual(s.printers, []);
  assert.deepEqual(s.stations.map(function (x) { return x.name; }).sort(), ['Zpr Bar', 'Zpr Kitchen']);
  // A link that is not the restaurant's is refused.
  var bad = await fetch(base + '/api/cloudprnt/notarealprinterlink00', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printerMAC: MAC.grill, statusCode: '200%20OK' }) });
  assert.equal(bad.status, 404);
  // Plugged in and given the link: each printer shows up, waiting for a name.
  for (var k of ['grill', 'bar', 'counter']) assert.deepEqual(await poll(MAC[k]), { jobReady: false });
  s = await printers.manage(tok.kojo, { action: 'list' }, IP, base);
  assert.equal(s.printers.length, 3);
  assert.ok(s.printers.every(function (p) { return p.isNew && p.online; }));
  ids = {};
  s.printers.forEach(function (p) { ids[Object.keys(MAC).find(function (k) { return MAC[k] === p.mac; })] = p.id; });
  await assert.rejects(printers.manage(tok.kojo, { action: 'save', id: ids.grill, name: ' ' }, IP, base), /Give the printer a name/);
  await printers.manage(tok.kojo, { action: 'save', id: ids.grill, name: 'Zpr Grill', stationIds: [grill], voids: true }, IP, base);
  await printers.manage(tok.kojo, { action: 'save', id: ids.bar, name: 'Zpr Bar printer', stationIds: [bar], voids: true, paper: 58 }, IP, base);
  await assert.rejects(printers.manage(tok.kojo, { action: 'save', id: ids.counter, name: 'zpr grill' }, IP, base), /called zpr grill already/);
  s = await printers.manage(tok.kojo, { action: 'save', id: ids.counter, name: 'Zpr Counter', stationIds: [], stubs: true, receipts: true, voids: false }, IP, base);
  var counter = s.printers.find(function (p) { return p.id === ids.counter; });
  assert.deepEqual([counter.stubs, counter.receipts, counter.voids, counter.isNew], [true, true, false, false]);
  assert.deepEqual(s.printers.find(function (p) { return p.id === ids.grill; }).stations, ['Zpr Kitchen']);
  // A test print says what it is set up to print.
  await printers.manage(tok.kojo, { action: 'test', id: ids.grill }, IP, base);
  var docs = await printAll(MAC.grill);
  assert.equal(docs.length, 1);
  assert.ok(/TEST PRINT/.test(docs[0].text) && /Kitchen tickets: Zpr Kitchen/.test(docs[0].text) && /Void tickets/.test(docs[0].text));
  var log = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'settings.printer' ORDER BY at", [company.id])).rows;
  assert.ok(/Set up a new printer as Zpr Grill: kitchen tickets for Zpr Kitchen/.test(log[0].summary));
});

test('a waiter sends an order: each kitchen prints its own dishes, the counter the summary; the cashier is told; a waiter cannot charge', async function () {
  var tab = await pos.saveTab(tok.yaw, { tableId: t1, waiterId: people.yaw, fulfillment: 'dine_in', guests: 2, items: [{ menuItemId: stew, qty: 2, note: 'Zpr extra pepper' }, { menuItemId: juice, qty: 1 }] });
  // The bar's tickets print on its own printer now, not at the till.
  assert.deepEqual(tab.chits, []);
  var g = await printAll(MAC.grill);
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, 'kitchen');
  assert.ok(/ZPR GRILL/.test(g[0].text) && /ZPR T1/.test(g[0].text) && /2 x Zpr groundnut stew/.test(g[0].text) && /\* Zpr extra pepper/.test(g[0].text) && !/sobolo/.test(g[0].text));
  assert.ok(/Waiter: Yaw Zpr/.test(g[0].text) && /Guests: 2/.test(g[0].text) && /by Yaw Zpr/.test(g[0].text));
  var b = await printAll(MAC.bar);
  assert.equal(b.length, 1);
  assert.ok(/1 x Zpr sobolo/.test(b[0].text) && !/stew/.test(b[0].text));
  var c = await printAll(MAC.counter);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'stub');
  assert.ok(/ORDER SENT/.test(c[0].text) && /> ZPR GRILL/.test(c[0].text) && /> ZPR BAR PRINTER/.test(c[0].text) && /2 x Zpr groundnut stew/.test(c[0].text));
  // The cashier's till hears of it; the waiter's own does not tell the waiter.
  var cashier = await tables.inbox(tok.ama);
  assert.equal(cashier.sent.length, 1);
  assert.deepEqual([cashier.sent[0].name, cashier.sent[0].by, cashier.sent[0].dishes, cashier.sent[0].tabId], ['Zpr T1', 'Yaw Zpr', 3, tab.id]);
  assert.equal(cashier.printers.length, 3);
  assert.deepEqual((await tables.inbox(tok.yaw)).sent, []);
  // A waiter takes orders and sends them; only a cashier or a manager charges.
  await assert.rejects(pos.createOrder(tok.yaw, { tabId: tab.id, tableId: t1, fulfillment: 'dine_in', payments: [{ method: 'cash', currency: 'GHS', tendered: 500 }],
    items: [{ menuItemId: stew, qty: 2 }, { menuItemId: juice, qty: 1 }] }), /cannot take payments/);
  // A dish taken off after it went: its kitchen prints a void ticket.
  await pos.saveTab(tok.yaw, { id: tab.id, tableId: t1, waiterId: people.yaw, fulfillment: 'dine_in', items: [{ menuItemId: stew, qty: 1, note: 'Zpr extra pepper' }, { menuItemId: juice, qty: 1 }] });
  var v = await printAll(MAC.grill);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'void');
  assert.ok(/VOID/.test(v[0].text) && /-1 x Zpr groundnut stew/.test(v[0].text) && /DO NOT MAKE/.test(v[0].text));
  assert.deepEqual(await printAll(MAC.bar), []);
  assert.deepEqual(await printAll(MAC.counter), []);
  // Paid by the cashier: nothing new to cook, nothing printed in the kitchens.
  await pos.createOrder(tok.ama, { tabId: tab.id, tableId: t1, fulfillment: 'dine_in', payments: [{ method: 'cash', currency: 'GHS', tendered: 500 }], items: [{ menuItemId: stew, qty: 1, note: 'Zpr extra pepper' }, { menuItemId: juice, qty: 1 }] });
  assert.deepEqual(await printAll(MAC.grill), []);
});

test('with nobody at a till: a table\'s QR order sent straight on prints in its kitchens; an order removed prints its voids', async function () {
  await access.saveSettings(tok.kojo, { settings: { qrOrders: { on: true, straightToKitchen: true } } }, IP);
  await tables.place('zprqrtable0001', { items: [{ menuItemId: stew, qty: 1 }, { menuItemId: juice, qty: 2 }] }, '10.9.7.40');
  var g = await printAll(MAC.grill), b = await printAll(MAC.bar), c = await printAll(MAC.counter);
  assert.ok(g.length === 1 && /1 x Zpr groundnut stew/.test(g[0].text) && /ZPR T1/.test(g[0].text));
  assert.ok(b.length === 1 && /2 x Zpr sobolo/.test(b[0].text));
  assert.ok(c.length === 1 && c[0].kind === 'stub');
  var open = (await pool.query('SELECT id FROM restaurant_open_tabs WHERE company_id = $1 AND table_id = $2', [company.id, t1])).rows[0].id;
  await pos.removeTab(tok.kojo, open);
  g = await printAll(MAC.grill); b = await printAll(MAC.bar);
  assert.ok(g.length === 1 && g[0].kind === 'void' && /-1 x Zpr groundnut stew/.test(g[0].text));
  assert.ok(b.length === 1 && b[0].kind === 'void' && /-2 x Zpr sobolo/.test(b[0].text));
  await access.saveSettings(tok.kojo, { settings: { qrOrders: { on: true, straightToKitchen: false } } }, IP);
});

test('a printer out of paper or off keeps its tickets, the tills say so, and they print when it is back or again', async function () {
  // Out of paper: told, nothing handed to it.
  var tab = await pos.saveTab(tok.yaw, { tableId: t2, waiterId: people.yaw, fulfillment: 'dine_in', items: [{ menuItemId: stew, qty: 1 }] });
  assert.deepEqual(await poll(MAC.grill, '410 Paper Empty'), { jobReady: false });
  var st = await printers.tillStatus(tok.ama);
  var gp = st.printers.find(function (p) { return p.id === ids.grill; });
  assert.deepEqual([gp.problem, gp.waiting, gp.statusText], ['paper', 1, '410 Paper Empty']);
  assert.equal((await tables.inbox(tok.yaw)).printers.find(function (p) { return p.id === ids.grill; }).problem, 'paper');
  // Paper back: it prints.
  var g = await printAll(MAC.grill);
  assert.ok(g.length === 1 && /ZPR T2/.test(g[0].text));
  // A printer that could not print it tries again, then gives up; a till prints it again.
  await pos.saveTab(tok.yaw, { id: tab.id, tableId: t2, waiterId: people.yaw, fulfillment: 'dine_in', items: [{ menuItemId: stew, qty: 1 }, { menuItemId: juice, qty: 1 }] });
  for (var i = 0; i < 5; i++) {
    var p = await poll(MAC.bar);
    assert.equal(p.jobReady, true);
    await take(MAC.bar, p.jobToken);
    await done(MAC.bar, p.jobToken, '520 Cutter Error');
  }
  assert.deepEqual(await poll(MAC.bar), { jobReady: false });
  var failed = (await printers.tillStatus(tok.ama)).jobs.find(function (j) { return j.printerId === ids.bar && j.status === 'failed'; });
  assert.ok(failed && failed.error === '520 Cutter Error');
  await printers.printAgain(tok.ama, failed.id);
  var b = await printAll(MAC.bar);
  assert.ok(b.length === 1 && /1 x Zpr sobolo/.test(b[0].text));
  // A printed ticket printed again: a copy.
  var printed = (await printers.tillStatus(tok.ama)).jobs.find(function (j) { return j.printerId === ids.bar && j.status === 'printed'; });
  await printers.printAgain(tok.ama, printed.id);
  assert.equal((await printAll(MAC.bar)).length, 1);
  // Fetched but never said printed (the printer lost power): handed out again.
  await printers.printAgain(tok.ama, printed.id);
  p = await poll(MAC.bar);
  await take(MAC.bar, p.jobToken);
  assert.deepEqual(await poll(MAC.bar), { jobReady: false });
  await pool.query("UPDATE restaurant_print_jobs SET sent_at = now() - interval '2 minutes' WHERE id = $1", [p.jobToken]);
  assert.equal((await poll(MAC.bar)).jobReady, true);
  await printAll(MAC.bar);
  // Not heard from: off.
  await pool.query("UPDATE restaurant_printers SET last_seen_at = now() - interval '5 minutes' WHERE id = $1", [ids.counter]);
  assert.equal((await printers.tillStatus(tok.ama)).printers.find(function (x) { return x.id === ids.counter; }).problem, 'offline');
  await poll(MAC.counter);
  await printAll(MAC.counter);
  await pos.removeTab(tok.kojo, tab.id);
  await printAll(MAC.grill); await printAll(MAC.bar);
});

test('a till prints its receipt on the counter printer, the drawer opening for cash; only on a printer that prints receipts', async function () {
  var doc = { cols: 42, pages: [[{ t: 'line', text: 'ZPR GRILL HOUSE', align: 'center', bold: true, scale: 1 }, { t: 'line', text: 'TOTAL  GHS 75.00', align: 'left', bold: true, scale: 2 },
    { t: 'qr', data: 'https://example.com/r/zpr', align: 'center' }, { t: 'feed', n: 2 }, { t: 'bogus' }]], kick: true };
  await assert.rejects(printers.tillPrint(tok.ama, ids.grill, { kind: 'receipt', doc: doc }), /does not print receipts/);
  await assert.rejects(printers.tillPrint(tok.ama, ids.counter, { kind: 'receipt', doc: { pages: [] } }), /Nothing to print/);
  var r = await printers.tillPrint(tok.ama, ids.counter, { kind: 'receipt', title: 'Receipt ZPR-1', doc: doc, kick: true });
  assert.deepEqual(r, { jobs: 1, printer: 'Zpr Counter' });
  var p = await poll(MAC.counter);
  var got = await take(MAC.counter, p.jobToken);
  assert.equal(got.drawer, 'start');
  assert.equal(got.cut, 'partial; feed=true');
  await done(MAC.counter, p.jobToken);
  var job = (await pool.query('SELECT status, doc FROM restaurant_print_jobs WHERE id = $1', [p.jobToken])).rows[0];
  assert.equal(job.status, 'printed');
  assert.deepEqual(job.doc.pages[0].map(function (l) { return l.t; }), ['line', 'line', 'qr', 'feed', 'line']);
  // A printer taken off is not printed on.
  await printers.manage(tok.kojo, { action: 'remove', id: ids.bar }, IP, base);
  await assert.rejects(printers.tillPrint(tok.ama, ids.bar, { kind: 'test', doc: doc }), /not set up here/);
  // The bar's tickets go back to the till.
  var tab = await pos.saveTab(tok.yaw, { tableId: t2, waiterId: people.yaw, fulfillment: 'dine_in', items: [{ menuItemId: juice, qty: 1 }] });
  assert.equal(tab.chits.length, 1);
  assert.equal(tab.chits[0].station, 'Zpr Bar');
  await pos.removeTab(tok.kojo, tab.id);
});
