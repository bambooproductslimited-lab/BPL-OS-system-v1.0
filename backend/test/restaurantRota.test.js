// The restaurant's rota (restaurantRota.service.js): shifts planned week by
// week by a manager in the till's back office, published to the staff, and
// who is on today shown on the till. Fake Zqr data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var access = require('../src/services/restaurantTillAccess.service');
var rota = require('../src/services/restaurantRota.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7651', kojo: '7652', yaw: '7653' };
var IP = '10.9.8.2';
var company, dept, people = {}, tok = {};

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQR'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_rota_shifts WHERE company_id = ANY($1)', 'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', 'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM notifications WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQR-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQR-%'");
  if (cos.length) {
    await pool.query('DELETE FROM shifts WHERE department_id IN (SELECT id FROM departments WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, role, rate) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash, hourly_rate) VALUES ($1, $2, 'Zqr', $3, $4, current_date, 'active', 'permanent', $5, $6) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key]), rate])).rows[0].id;
  await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [company.id, people[key], role]);
}
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function manager(p) { return Object.assign({ managerPin: PINS.kojo }, p); }

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQR', 'Zqr Diner') RETURNING *")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQRF', 'Zqr Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await pool.query("INSERT INTO shifts (department_id, name, start_time, end_time, status) VALUES ($1, 'Zqr Morning', '07:00', '15:00', 'active')", [dept]);
  await person('ama', 'ZQR-1', 'Ama', 'cashier', 20);
  await person('kojo', 'ZQR-2', 'Kojo', 'manager', 40);
  await person('yaw', 'ZQR-3', 'Yaw', 'waiter', null);
  for (var k of ['ama', 'kojo']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the week: shifts planned, checked, costed; published, each person told; the till shows who is on today', async function () {
  assert.equal(rota.mondayOf('2026-10-25'), '2026-10-19'); // a Sunday's week starts the Monday before
  assert.equal(rota.mondayOf('2026-10-19'), '2026-10-19');
  assert.equal(rota.hoursOf('22:00', '06:00'), 8);
  assert.equal(rota.hoursOf('08:00', '16:30'), 8.5);

  await assert.rejects(access.rota(tok.ama, { action: 'week' }, IP), /manager/i);
  var w = await access.rota(tok.kojo, { action: 'week', weekOf: day(0) }, IP);
  assert.equal(w.shifts.length, 0);
  assert.deepEqual(w.templates, [{ name: 'Zqr Morning', starts: '07:00', ends: '15:00' }]);
  assert.deepEqual(w.staff.map(function (p) { return p.name; }).sort(), ['Ama Zqr', 'Kojo Zqr', 'Yaw Zqr']);

  var save = function (s) { return access.rota(tok.ama, manager({ action: 'save', shift: s }), IP); };
  w = await save({ employeeId: people.ama, day: day(0), starts: '07:00', ends: '15:00', role: 'Cashier' });
  w = await save({ employeeId: people.yaw, day: day(0), starts: '16:00', ends: '00:30', role: 'Waiter', note: 'Zqr: close up' });
  w = await save({ employeeId: people.kojo, day: day(0), starts: '10:00', ends: '18:00', role: 'Manager' });
  await assert.rejects(save({ employeeId: people.ama, day: day(0), starts: '14:00', ends: '20:00' }), /already work 07:00–15:00/);
  await assert.rejects(save({ employeeId: people.ama, day: day(0), starts: '9:00', ends: '20:00' }), /like 08:00/);
  await assert.rejects(save({ employeeId: people.ama, day: day(0), starts: '06:00', ends: '23:30' }), /16 hours/);
  var stranger = (await pool.query("SELECT id FROM employees WHERE code NOT LIKE 'ZQR-%' AND status = 'active' LIMIT 1")).rows[0].id;
  await assert.rejects(save({ employeeId: stranger, day: day(0), starts: '07:00', ends: '15:00' }), /does not work at this restaurant/);

  assert.equal(w.shifts.filter(function (s) { return s.day === day(0); }).length, 3);
  assert.equal(w.drafts, 3);
  var todayRow = w.days.find(function (d) { return d.day === day(0); });
  assert.equal(todayRow.people, 3);
  assert.equal(todayRow.hours, 8 + 8.5 + 8);
  assert.equal(w.cost, 8 * 20 + 8 * 40);
  assert.equal(w.noRate, 1);
  assert.equal(w.staff.find(function (p) { return p.id === people.yaw; }).hours, 8.5);

  // Nothing on the till until it is published.
  assert.equal((await access.rotaToday(tok.ama)).shifts.length, 0);
  w = await access.rota(tok.kojo, { action: 'publish', weekOf: day(0) }, IP);
  assert.equal(w.published, 3);
  assert.equal(w.told, 3);
  assert.equal(w.drafts, 0);
  var told = (await pool.query('SELECT title, body FROM notifications WHERE employee_id = $1 ORDER BY at DESC LIMIT 1', [people.yaw])).rows[0];
  assert.match(told.title, /Your shifts at Zqr Diner/);
  assert.match(told.body, /16:00–00:30 \(Waiter\)/);
  var on = (await access.rotaToday(tok.ama)).shifts;
  assert.deepEqual(on.map(function (s) { return [s.name, s.starts, s.ends]; }), [['Ama Zqr', '07:00', '15:00'], ['Kojo Zqr', '10:00', '18:00'], ['Yaw Zqr', '16:00', '00:30']]);
  await assert.rejects(access.rota(tok.kojo, { action: 'publish', weekOf: day(0) }, IP), /Nothing new/);

  // Changed after publishing: waits to be published again.
  var yawShift = w.shifts.find(function (s) { return s.employeeId === people.yaw; });
  w = await access.rota(tok.kojo, { action: 'save', shift: Object.assign({}, yawShift, { ends: '23:00' }) }, IP);
  assert.equal(w.drafts, 1);
  assert.equal((await access.rotaToday(tok.ama)).shifts.length, 2);

  // Next week from this one.
  w = await access.rota(tok.kojo, { action: 'copy', weekOf: day(7) }, IP);
  assert.equal(w.copied, 3);
  assert.equal(w.shifts.length, 3);
  assert.ok(w.shifts.every(function (s) { return !s.published && s.day === day(7); }));
  w = await access.rota(tok.kojo, { action: 'copy', weekOf: day(7) }, IP);
  assert.equal(w.copied, 0);

  w = await access.rota(tok.kojo, { action: 'remove', id: w.shifts[0].id, weekOf: day(7) }, IP);
  assert.equal(w.shifts.length, 2);
  await assert.rejects(access.rota(tok.kojo, { action: 'remove', id: yawShift.id.replace(/.$/, yawShift.id.slice(-1) === '0' ? '1' : '0') }, IP), /gone/);
});
