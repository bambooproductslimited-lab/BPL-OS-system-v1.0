// The kitchen screen's reports (restaurantTicketTimes.service.js kdsReport,
// GET /api/pos/kds/reports): ticket times for the whole kitchen or one
// station (its part of each ticket), what the kitchen made, what was taken
// off orders after it was sent, what was taken with no internet (counted,
// not timed), and what is on the screens right now. A screen set up for one
// station sees that station first. Fake Zkr data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var screens = require('../src/services/restaurantKdsScreens.service');
var times = require('../src/services/restaurantTicketTimes.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { esi: '7791', kojo: '7792' };
var IP = '10.9.7.91';
var company, people = {}, st = {}, tok = {}, n = 0;
function ago(min) { return new Date(Date.now() - min * 60000).toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZKR'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_screens WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', 'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) {
      try { await pool.query(q, [cos]); } catch (e) { if (e.code !== '42P01') throw e; }
    }
  }
  await pool.query("DELETE FROM restaurant_kds_screens WHERE status = 'waiting' AND device LIKE 'Zkr%'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZKR-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept, role) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zkr', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
  await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [company.id, people[key], role]);
}
// A ticket as the kitchen had it: sent so many minutes ago, its dishes
// [station, name, qty, status, done minutes ago], its state.
async function ticket(sentAgo, dishes, o) {
  o = o || {};
  n += 1;
  var t = (await pool.query(
    'INSERT INTO restaurant_kitchen_tickets (company_id, number, label, table_name, status, created_at, ready_at, served_at, fulfillment, offline_at, fired_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
    [company.id, n, '', 'Zkr T' + n, o.status || 'served', ago(sentAgo), o.readyAgo != null ? ago(o.readyAgo) : null, o.status === 'served' || !o.status ? ago(1) : null, 'dine_in',
      o.offline ? ago(sentAgo) : null, o.offline ? ago(sentAgo) : null])).rows[0].id;
  for (var d of dishes) {
    await pool.query('INSERT INTO restaurant_kitchen_items (ticket_id, station_id, name, category, qty, status, done_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [t, st[d[0]], d[1], d[0] === 'grill' ? 'Zkr Grill' : 'Zkr Mains', d[2], d[3], d[4] != null ? ago(d[4]) : null, ago(sentAgo)]);
  }
  return t;
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZKR', 'Zkr Kitchen Bar') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZKRK', 'Zkr Kitchen', $1) RETURNING id", [company.id])).rows[0].id;
  await person('esi', 'ZKR-1', 'Esi', dept, 'kitchen');
  await person('kojo', 'ZKR-2', 'Kojo', dept, 'manager');
  st.kitchen = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else, sort_order) VALUES ($1, 'Zkr Kitchen', '{}', true, 0) RETURNING id", [company.id])).rows[0].id;
  st.grill = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else, sort_order) VALUES ($1, 'Zkr Grill', '{\"Zkr Grill\"}', false, 1) RETURNING id", [company.id])).rows[0].id;
  // Two screens: one for the whole kitchen, one at the grill.
  for (var which of ['all', 'grill']) {
    var hello = await screens.hello(null, IP, 'Zkr tablet ' + which);
    await screens.claim(company.id, { id: people.kojo, first_name: 'Kojo', last_name: 'Zkr' }, { code: hello.code, name: 'Zkr ' + which + ' screen', stationId: which === 'grill' ? st.grill : null });
    tok[which] = (await pos.login(PINS.esi, IP, 'kds', hello.screenToken)).token;
  }
  // Today: a stew and a kebab (8 and 15 min), two stews (12 min), one still
  // cooking with a stew taken off it, and three stews taken with no internet.
  await ticket(30, [['kitchen', 'Zkr stew', 1, 'done', 22], ['grill', 'Zkr kebab', 1, 'done', 15]], { readyAgo: 15 });
  await ticket(20, [['kitchen', 'Zkr stew', 2, 'done', 8]], { status: 'ready', readyAgo: 8 });
  await ticket(6, [['grill', 'Zkr kebab', 1, 'cooking'], ['kitchen', 'Zkr stew', 1, 'cancelled']], { status: 'cooking' });
  await ticket(50, [['kitchen', 'Zkr stew', 3, 'done', 0]], { offline: true });
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the whole kitchen: ticket times without what was taken offline, what it made, what was taken off, right now', async function () {
  var r = await times.kdsReport(tok.all, { from: today(), to: today() });
  assert.equal(r.station, 'all');
  assert.equal(r.screenStation, 'all');
  assert.deepEqual(r.stations.map(function (s) { return s.name; }), ['Zkr Kitchen', 'Zkr Grill']);
  assert.equal(r.totals.tickets, 2, 'two tickets bumped ready; the one taken offline is not timed');
  assert.equal(r.totals.median, 13.5);
  assert.deepEqual(r.made.map(function (d) { return [d.name, d.qty]; }), [['Zkr stew', 6], ['Zkr kebab', 1]], 'every stew made, offline ones too');
  assert.equal(r.madeTotal, 7);
  assert.deepEqual(r.takenOff, [{ name: 'Zkr stew', qty: 1 }]);
  assert.deepEqual(r.offline, { tickets: 1, dishes: 3 });
  assert.deepEqual([r.now.cooking, r.now.ready], [1, 1]);
  assert.ok(r.now.oldestMinutes >= 5.9 && r.now.oldestMinutes < 7, 'the oldest still cooking: ' + r.now.oldestMinutes);
  // The back office's report leaves the offline ticket out of the times too.
  var office = await times.report(company.id, { from: today(), to: today() }, {});
  assert.equal(office.totals.tickets, 2);
});

test('one station: its part of each ticket; the grill\'s screen sees the grill first', async function () {
  var g = await times.kdsReport(tok.grill, { from: today(), to: today() });
  assert.equal(g.station, st.grill, 'the grill screen opens on the grill');
  assert.equal(g.totals.tickets, 1, 'the kebab done (the one still cooking is not counted)');
  assert.equal(g.totals.median, 15);
  assert.deepEqual(g.made.map(function (d) { return [d.name, d.qty]; }), [['Zkr kebab', 1]]);
  assert.deepEqual(g.takenOff, [], 'the stew taken off was the kitchen\'s');
  assert.deepEqual([g.now.cooking, g.offline.tickets], [1, 0]);
  var k = await times.kdsReport(tok.grill, { from: today(), to: today(), station: st.kitchen });
  assert.equal(k.totals.tickets, 2);
  assert.equal(k.totals.median, 10, 'its stews: 8 and 12 minutes');
  assert.deepEqual([k.now.cooking, k.now.ready], [0, 1]);
  assert.deepEqual(k.byStation.map(function (s) { return s.station; }), ['Zkr Kitchen']);
  var all = await times.kdsReport(tok.grill, { from: today(), to: today(), station: 'all' });
  assert.equal(all.totals.tickets, 2);
  await assert.rejects(times.kdsReport(tok.grill, { station: '00000000-0000-0000-0000-000000000000' }), /not set up any more/);
});

test('through the till\'s address: signed in to the kitchen screen only', async function () {
  var app = require('../src/app');
  var server = await new Promise(function (r) { var s = app.listen(0, function () { r(s); }); });
  try {
    var base = 'http://127.0.0.1:' + server.address().port + '/api/pos/kds/reports?from=' + today() + '&to=' + today();
    var res = await fetch(base, { headers: { Authorization: 'Bearer ' + tok.all } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).madeTotal, 7);
    assert.equal((await fetch(base)).status, 401);
  } finally { await new Promise(function (r) { server.close(r); }); }
});
