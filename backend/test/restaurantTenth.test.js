// The tenth batch on the restaurant side (migration 0191): time off and
// availability on the till and the rota, kitchen ticket times, and curbside
// pickup. Fake Zqw data only; nothing goes out.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var rota = require('../src/services/restaurantRota.service');
var times = require('../src/services/restaurantTicketTimes.service');
var online = require('../src/services/restaurantOnline.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7681', kojo: '7682' };
var IP = '10.9.8.51';
var company, dept, rice, grill, people = {}, tok = {}, mgr;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQW'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_online_orders WHERE company_id = ANY($1)', 'DELETE FROM restaurant_time_off WHERE company_id = ANY($1)', 'DELETE FROM restaurant_availability WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_rota_shifts WHERE company_id = ANY($1)', 'DELETE FROM restaurant_delivery_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', 'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM leave_requests WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQW-%')");
  await pool.query("DELETE FROM notifications WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQW-%')");
  await pool.query("DELETE FROM audit_logs WHERE entity = 'restaurant_time_off' AND summary LIKE '%Zqw%'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQW-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, role) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqw', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
  await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [company.id, people[key], role]);
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQW', 'Zqw Grill') RETURNING *")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQWF', 'Zqw Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQW-1', 'Ama', 'cashier');
  await person('kojo', 'ZQW-2', 'Kojo', 'manager');
  for (var k of ['ama', 'kojo']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  mgr = { id: people.kojo, first_name: 'Kojo', last_name: 'Zqw' };
  rice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqw jollof', 'Zqw Mains', 50, true) RETURNING id", [company.id])).rows[0].id;
  grill = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name) VALUES ($1, 'Zqw Grill station') RETURNING id", [company.id])).rows[0].id;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('time off: asked for on the till, decided on the rota; an approved day off (or leave) cannot be scheduled; availability flags the rota', async function () {
  var r = await rota.swaps(company.id, people.ama, { action: 'mine' });
  assert.deepEqual(r.timeOff, []);
  assert.deepEqual(r.availability, { daysOff: [], note: '' });
  await assert.rejects(rota.swaps(company.id, people.ama, { action: 'timeoff', from: day(-1), to: day(1) }), /today or later/);
  await assert.rejects(rota.swaps(company.id, people.ama, { action: 'timeoff', from: day(5), to: day(3) }), /on or after the first/);
  r = await rota.swaps(company.id, people.ama, { action: 'timeoff', from: day(3), to: day(5), reason: 'Zqw: a wedding in Kumasi' });
  assert.equal(r.timeOff.length, 1);
  assert.deepEqual([r.timeOff[0].status, r.timeOff[0].days], ['requested', 3]);
  await assert.rejects(rota.swaps(company.id, people.ama, { action: 'timeoff', from: day(4), to: day(4) }), /asked for/);
  var told = (await pool.query("SELECT title FROM notifications WHERE employee_id = $1 AND title LIKE '🌴 Ama Zqw asks%'", [people.kojo])).rows;
  assert.equal(told.length, 1);

  // The manager sees it on the rota, with a shift already on one of the days.
  await rota.tab(company.id, mgr, { action: 'save', shift: { employeeId: people.ama, day: day(4), starts: '10:00', ends: '18:00', role: 'Cashier' } });
  var w = await rota.tab(company.id, mgr, { action: 'week', weekOf: day(4) });
  assert.equal(w.timeOffOpen.length, 1);
  var id = w.timeOffOpen[0].id;
  var d = await rota.tab(company.id, mgr, { action: 'decideTimeOff', timeOffId: id, approve: true, weekOf: day(4) });
  assert.equal(d.clashes, 1, 'a shift on the days off, to change');
  assert.equal(d.timeOffOpen.length, 0);
  assert.ok(d.shifts.find(function (s) { return s.day === day(4); }).off);
  await assert.rejects(rota.tab(company.id, mgr, { action: 'decideTimeOff', timeOffId: id, approve: false }), /approved already/);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE employee_id = $1 AND title = '🌴 Time off approved'", [people.ama])).rows[0]);
  // A day off approved cannot be put on the rota.
  await assert.rejects(rota.tab(company.id, mgr, { action: 'save', shift: { employeeId: people.ama, day: day(5), starts: '10:00', ends: '18:00' } }), /Ama Zqw is off that day \(time off approved\)/);
  // Leave approved in the OS counts too.
  var lt = (await pool.query('SELECT id FROM leave_types LIMIT 1')).rows[0];
  await pool.query("INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, status) VALUES ($1, $2, $3, $3, 1, 'approved')", [people.kojo, lt.id, day(9)]);
  await assert.rejects(rota.tab(company.id, mgr, { action: 'save', shift: { employeeId: people.kojo, day: day(9), starts: '08:00', ends: '16:00' } }), /on leave/);
  w = await rota.tab(company.id, mgr, { action: 'week', weekOf: day(9) });
  assert.ok(w.timeOff.some(function (t) { return t.kind === 'leave' && t.employeeId === people.kojo; }));

  // Availability: the weekdays someone cannot work, shown on their shifts.
  var wd = new Date(day(11) + 'T00:00:00Z').getUTCDay();
  r = await rota.swaps(company.id, people.ama, { action: 'availability', daysOff: [wd, wd, 9], note: 'Zqw: church' });
  assert.deepEqual(r.availability, { daysOff: [wd], note: 'Zqw: church' });
  w = await rota.tab(company.id, mgr, { action: 'save', shift: { employeeId: people.ama, day: day(11), starts: '10:00', ends: '14:00' }, weekOf: day(11) });
  assert.equal(w.shifts.find(function (s) { return s.day === day(11) && s.employeeId === people.ama; }).unavailable, true);
  assert.deepEqual(w.availability[people.ama].daysOff, [wd]);

  // Cancelled by them: the manager is told it is off.
  r = await rota.swaps(company.id, people.ama, { action: 'timeoffCancel', id: id });
  assert.equal(r.timeOff.find(function (t) { return t.id === id; }), undefined);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE employee_id = $1 AND title = '🌴 Ama Zqw will work after all'", [people.kojo])).rows[0]);
  await rota.tab(company.id, mgr, { action: 'save', shift: { employeeId: people.ama, day: day(5), starts: '10:00', ends: '18:00' } });
});

test('kitchen ticket times: median, slowest tenth and late tickets against the kitchen\'s targets, by day, hour, station and dish; forgotten ones apart', async function () {
  assert.equal(times.quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(times.quantile([], 0.5), null);
  var mk = async function (mins, ago, items) {
    var t = (await pool.query("INSERT INTO restaurant_kitchen_tickets (company_id, number, label, status, created_at, ready_at, fulfillment) VALUES ($1, $2, 'Zqw table', 'served', now() - ($3 || ' minutes')::interval, now() - ($3 || ' minutes')::interval + ($4 || ' minutes')::interval, 'dine_in') RETURNING id",
      [company.id, Math.floor(Math.random() * 900) + 100, String(ago), String(mins)])).rows[0].id;
    for (var it of items || []) {
      await pool.query("INSERT INTO restaurant_kitchen_items (ticket_id, station_id, name, qty, status, done_at) VALUES ($1, $2, $3, 1, 'done', (SELECT created_at FROM restaurant_kitchen_tickets WHERE id = $1) + ($4 || ' minutes')::interval)",
        [t, grill, it[0], String(it[1])]);
    }
  };
  await mk(6, 120, [['Zqw kebab', 5]]);
  await mk(8, 110, [['Zqw kebab', 7]]);
  await mk(12, 100, [['Zqw tilapia', 12]]);
  await mk(25, 90, [['Zqw tilapia', 24]]);
  await mk(300, 400);
  await pool.query("INSERT INTO restaurant_kitchen_tickets (company_id, number, status, created_at) VALUES ($1, 999, 'cooking', now())", [company.id]);
  var r = await times.report(company.id, {}, { kitchen: { warnAfter: 10, lateAfter: 20 } });
  assert.deepEqual([r.totals.tickets, r.totals.forgotten, r.totals.late, r.totals.slow], [4, 1, 1, 1]);
  assert.equal(r.totals.median, 10);
  assert.equal(r.totals.average, 12.8);
  assert.equal(r.totals.onTime, 50);
  assert.deepEqual(r.targets, { warnAfter: 10, lateAfter: 20 });
  assert.equal(r.byDay.length, 7);
  assert.equal(r.byStation[0].station, 'Zqw Grill station');
  assert.deepEqual(r.slowestDishes.map(function (x) { return [x.name, x.average]; }), [['Zqw tilapia', 18], ['Zqw kebab', 6]]);
  assert.equal(r.slowestTickets[0].minutes, 25);
  assert.ok(r.byHour.length >= 1);
  await assert.rejects(times.report(company.id, { from: '2020-01-01', to: '2026-01-01' }, {}), /a year at most/);
});

test('curbside pickup: the customer says they are outside; the till sees them, with their car, and brings it out', async function () {
  await pool.query("INSERT INTO restaurant_delivery_settings (company_id, settings) VALUES ($1, $2)", [company.id, JSON.stringify({ open: true, delivery: true, pickup: true, readyMinutes: 20, location: { lat: 5.6, lng: -0.18, address: 'Zqw' } })]);
  var placed = await online.place('ZQW', { name: 'Zqw Akosua', phone: '0200000951', fulfillment: 'pickup', payMethod: 'cash', items: [{ menuItemId: rice, qty: 1 }] }, IP);
  var t = await online.track(placed.token);
  assert.equal(t.canSayHere, false, 'not before the restaurant takes it');
  await assert.rejects(online.here(placed.token, {}), /not on its way yet/);
  var o = (await pool.query("SELECT id FROM restaurant_online_orders WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1", [company.id])).rows[0];
  await online.accept(tok.kojo, o.id, {});
  t = await online.track(placed.token);
  assert.equal(t.canSayHere, true);
  t = await online.here(placed.token, { note: 'Zqw: blue Corolla by the gate' });
  assert.equal(t.here.note, 'Zqw: blue Corolla by the gate');
  assert.ok(t.here.at);
  var c = await online.curbside(tok.ama);
  assert.equal(c.outside.length, 1);
  assert.deepEqual([c.outside[0].name, c.outside[0].note, c.outside[0].ready], ['Zqw Akosua', 'Zqw: blue Corolla by the gate', false]);
  var logged = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'online.here'", [company.id])).rows;
  assert.match(logged[0].summary, /Zqw Akosua is outside for/);
  c = await online.brought(tok.ama, c.outside[0].id);
  assert.equal(c.outside.length, 0);
  await assert.rejects(online.brought(tok.ama, o.id), /brought out already/);
  await assert.rejects(online.here(placed.token, {}), /brought out already/);
  t = await online.track(placed.token);
  assert.ok(t.here.broughtAt);
  // A delivery is brought to them.
  var del = await online.place('ZQW', { name: 'Zqw Kofi', phone: '0200000952', fulfillment: 'delivery', address: 'Zqw street', lat: 5.601, lng: -0.181, payMethod: 'cash', items: [{ menuItemId: rice, qty: 1 }] }, IP);
  await assert.rejects(online.here(del.token, {}), /delivered to you/);
});
