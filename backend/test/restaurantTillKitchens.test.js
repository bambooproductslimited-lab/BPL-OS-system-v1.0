// The kitchens set up on the till, as Square's printer profiles
// (restaurantPrinters.service.js manage: 'kitchen', 'removeKitchen'): from
// Till settings → Printers on any till — an iPad, a phone — a manager names
// a kitchen, picks the menu categories it makes (taken from the kitchen
// that made them before) and the printers its tickets print on; an order
// sent then prints each kitchen's own dishes on its own printer. Fake Zpk
// data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var printers = require('../src/services/restaurantPrinters.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7741', kojo: '7742', yaw: '7743' };
var IP = '10.9.8.1';
var BASE = 'http://zpk.example.test';
var MAC = { wok: '00:11:62:bb:00:01', grill: '00:11:62:bb:00:02' };
var company, people = {}, tok = {}, menu = {}, chinese, table, linkToken, ids = {};

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZPK'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_print_jobs WHERE company_id = ANY($1)', 'DELETE FROM restaurant_printers WHERE company_id = ANY($1)', 'DELETE FROM restaurant_print_links WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_tables WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) {
      try { await pool.query(q, [cos]); } catch (e) { if (e.code !== '42P01') throw e; }
    }
  }
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZPK-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zpk', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
async function dish(name, category) {
  menu[name] = (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, $2, $3, 40, true) RETURNING id', [company.id, name, category])).rows[0].id;
}
// What a printer has been given to print: each ticket's kind and text.
async function tickets(printerId) {
  var rows = (await pool.query("SELECT kind, doc FROM restaurant_print_jobs WHERE printer_id = $1 AND status = 'queued' ORDER BY created_at", [printerId])).rows;
  await pool.query("UPDATE restaurant_print_jobs SET status = 'printed', done_at = now() WHERE printer_id = $1 AND status = 'queued'", [printerId]);
  return rows.map(function (r) { return { kind: r.kind, text: r.doc.pages[0].map(function (l) { return l.text || ''; }).join('\n') }; });
}
function manage(body) { return printers.manage(tok.kojo, body, IP, BASE); }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZPK', 'Zpk Two Kitchens') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZPKF', 'Zpk Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZPK-1', 'Ama', dept);
  await person('kojo', 'ZPK-2', 'Kojo', dept);
  await person('yaw', 'ZPK-3', 'Yaw', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'waiter')", [company.id, people.kojo, people.yaw]);
  await dish('Zpk fried noodles', 'Zpk Noodles');
  await dish('Zpk suya', 'Zpk Grills');
  await dish('Zpk sobolo', 'Zpk Drinks');
  table = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zpk T1') RETURNING id", [company.id])).rows[0].id;
  // Set up in the app before: one kitchen making noodles and grills.
  chinese = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zpk Chinese', '{\"Zpk Noodles\",\"Zpk Grills\"}', false) RETURNING id", [company.id])).rows[0].id;
  for (var k of ['ama', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  await pos.openDrawerSession(tok.ama, 100);
  // Two printers plugged in, asking the restaurant's printer link.
  linkToken = await printers.linkOf(company.id);
  for (var m of Object.keys(MAC)) await printers.poll(linkToken, { printerMAC: MAC[m], statusCode: '200%20OK' }, '10.9.8.' + (m === 'wok' ? 21 : 22));
  var s = await manage({ action: 'list' });
  s.printers.forEach(function (p) { ids[Object.keys(MAC).find(function (k) { return MAC[k] === p.mac; })] = p.id; });
  await manage({ action: 'save', id: ids.wok, name: 'Zpk Wok printer', stationIds: [] });
  await manage({ action: 'save', id: ids.grill, name: 'Zpk Grill printer', stationIds: [] });
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the kitchens and where each category goes, on the till; only a manager', async function () {
  await assert.rejects(printers.manage(tok.yaw, { action: 'list' }, IP, BASE), /manager/);
  await assert.rejects(printers.manage(tok.yaw, { action: 'kitchen', name: 'Zpk Bar', categories: ['Zpk Drinks'] }, IP, BASE), /manager/);
  var s = await manage({ action: 'list' });
  assert.deepEqual(s.kitchens.map(function (k) { return [k.name, k.categories, k.everythingElse, k.printerIds]; }), [['Zpk Chinese', ['Zpk Noodles', 'Zpk Grills'], false, []]]);
  var where = {};
  s.categories.forEach(function (c) { where[c.name] = c.kitchenId; });
  assert.deepEqual(where, { 'Zpk Drinks': null, 'Zpk Grills': chinese, 'Zpk Noodles': chinese });
  assert.equal(s.kitchenSaved, null);
});

test('a new kitchen with its categories and printer: a category moves from the kitchen that had it', async function () {
  await assert.rejects(manage({ action: 'kitchen', name: '  ', categories: [] }), /Give the kitchen a name/);
  await assert.rejects(manage({ action: 'kitchen', name: 'zpk chinese', categories: [] }), /called zpk chinese already/);
  var s = await manage({ action: 'kitchen', name: 'Zpk Grill', categories: ['Zpk Grills', ' zpk grills '], printerIds: [ids.grill] });
  var grill = s.kitchens.find(function (k) { return k.name === 'Zpk Grill'; });
  assert.deepEqual([grill.categories, grill.printerIds, s.kitchenSaved.moved], [['Zpk Grills'], [ids.grill], 1]);
  assert.deepEqual(s.kitchens.find(function (k) { return k.id === chinese; }).categories, ['Zpk Noodles']);
  assert.equal(s.categories.find(function (c) { return c.name === 'Zpk Grills'; }).kitchenId, grill.id);
  assert.deepEqual(s.printers.find(function (p) { return p.id === ids.grill; }).stations, ['Zpk Grill']);
  // The kitchen from the app gets its printer and takes everything else.
  s = await manage({ action: 'kitchen', kitchenId: chinese, name: 'Zpk Chinese', categories: ['Zpk Noodles'], everythingElse: true, printerIds: [ids.wok] });
  assert.equal(s.categories.find(function (c) { return c.name === 'Zpk Drinks'; }).kitchenId, chinese);
  assert.deepEqual(s.printers.find(function (p) { return p.id === ids.wok; }).stationIds, [chinese]);
  var log = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'settings.kitchen' ORDER BY at", [company.id])).rows.map(function (r) { return r.summary; });
  assert.ok(/^Set up the kitchen Zpk Grill: Zpk Grills; prints at Zpk Grill printer \(moved: Zpk Grills from Zpk Chinese\)\.$/.test(log[0]), log[0]);
  assert.ok(/^Changed the kitchen Zpk Chinese: Zpk Noodles; everything else; prints at Zpk Wok printer\.$/.test(log[1]), log[1]);
});

test('an order sent: each kitchen\'s own dishes print on its own printer', async function () {
  await pos.saveTab(tok.yaw, { tableId: table, waiterId: people.yaw, fulfillment: 'dine_in', items: [{ menuItemId: menu['Zpk fried noodles'], qty: 2 }, { menuItemId: menu['Zpk suya'], qty: 1 }, { menuItemId: menu['Zpk sobolo'], qty: 3 }] });
  var wok = await tickets(ids.wok), grill = await tickets(ids.grill);
  assert.equal(wok.length, 1);
  assert.ok(/2 x Zpk fried noodles/.test(wok[0].text) && /3 x Zpk sobolo/.test(wok[0].text) && !/suya/.test(wok[0].text), wok[0].text);
  assert.equal(grill.length, 1);
  assert.ok(/1 x Zpk suya/.test(grill[0].text) && !/noodles|sobolo/.test(grill[0].text), grill[0].text);
});

test('a kitchen\'s printers changed, then the kitchen taken off: its printer prints nothing of it', async function () {
  var s = await manage({ action: 'kitchen', kitchenId: chinese, name: 'Zpk Chinese', categories: ['Zpk Noodles'], printerIds: [ids.wok, ids.grill] });
  assert.deepEqual(s.kitchens.find(function (k) { return k.id === chinese; }).printerIds.sort(), [ids.wok, ids.grill].sort());
  // Not sent: the kitchen keeps what it took (everything else) as before.
  assert.equal(s.kitchens.find(function (k) { return k.id === chinese; }).everythingElse, true);
  var grill = s.kitchens.find(function (k) { return k.name === 'Zpk Grill'; });
  await assert.rejects(manage({ action: 'removeKitchen', kitchenId: '00000000-0000-0000-0000-000000000000' }), /not set up any more/);
  s = await manage({ action: 'removeKitchen', kitchenId: grill.id });
  assert.deepEqual(s.kitchens.map(function (k) { return k.name; }), ['Zpk Chinese']);
  assert.deepEqual(s.printers.find(function (p) { return p.id === ids.grill; }).stationIds, [chinese]);
  // Its grills now go to the kitchen taking everything else.
  assert.equal(s.categories.find(function (c) { return c.name === 'Zpk Grills'; }).kitchenId, chinese);
  s = await manage({ action: 'kitchen', kitchenId: chinese, name: 'Zpk Chinese', categories: ['Zpk Noodles'], printerIds: [] });
  assert.deepEqual(s.printers.map(function (p) { return p.stationIds; }), [[], []]);
});
