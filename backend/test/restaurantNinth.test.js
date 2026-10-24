// The ninth batch on the restaurant side (migration 0189): busy mode for
// the website (orders take longer, or are paused, for a while) and a text
// reminding a guest of their table. Fake Zqn data only; nothing goes out:
// texts go to a stand-in, never to mNotify.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var delivery = require('../src/services/restaurantDelivery.service');
var online = require('../src/services/restaurantOnline.service');
var bookings = require('../src/services/restaurantBookings.service');
var sms = require('../src/services/sms.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7671', kojo: '7672' };
var IP = '10.9.8.41';
var company, dept, rice, people = {}, tok = {};
var texts = [];
var real = { configured: sms.configured, send: sms.send };

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQN'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_online_orders WHERE company_id = ANY($1)', 'DELETE FROM restaurant_bookings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_delivery_settings WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', 'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQN-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, role) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqn', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
  await pool.query('INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3)', [company.id, people[key], role]);
}
function order(extra) {
  return Object.assign({ name: 'Zqn Akosua', phone: '0200000911', fulfillment: 'pickup', payMethod: 'cash', items: [{ menuItemId: rice, qty: 1 }] }, extra || {});
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQN', 'Zqn Kitchen') RETURNING *")).rows[0];
  dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQNF', 'Zqn Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQN-1', 'Ama', 'cashier');
  await person('kojo', 'ZQN-2', 'Kojo', 'manager');
  for (var k of ['ama', 'kojo']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
  rice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqn jollof', 'Zqn Mains', 50, true) RETURNING id", [company.id])).rows[0].id;
  sms.configured = function () { return true; };
  sms.send = async function (o) { texts.push(o); return { id: 'zqn-' + texts.length, to: o.to }; };
});
test.after(async function () {
  sms.configured = real.configured; sms.send = real.send;
  await cleanup(); await pool.end();
});

test('busy mode: website orders take longer for a while, or are paused (only for later); back to normal on its own', async function () {
  await assert.rejects(delivery.setBusy(tok.kojo, { mode: 'busy', minutes: 30, extraMinutes: 15 }), /does not take orders online yet/);
  await pool.query("INSERT INTO restaurant_delivery_settings (company_id, settings) VALUES ($1, $2)", [company.id, JSON.stringify({ open: true, delivery: false, pickup: true, readyMinutes: 20 })]);
  var b = await delivery.busy(tok.ama);
  assert.equal(b.busy, null);
  assert.equal(b.readyMinutes, 20);
  var m = await online.menu('ZQN');
  assert.equal(m.restaurant.busy, null);
  assert.equal(m.restaurant.readyMinutes, 20);

  await assert.rejects(delivery.setBusy(tok.ama, { mode: 'busy', minutes: 5, extraMinutes: 15 }), /15 minutes to 4 hours/);
  await assert.rejects(delivery.setBusy(tok.ama, { mode: 'busy', minutes: 30, extraMinutes: 7 }), /How much longer/);
  await assert.rejects(delivery.setBusy(tok.ama, { mode: 'loud' }), /Busy, paused/);
  // Busy: 15 minutes longer, for 30 minutes — the website says so, and an accepted order's time is the longer one.
  b = await delivery.setBusy(tok.ama, { mode: 'busy', minutes: 30, extraMinutes: 15 });
  assert.equal(b.busy.mode, 'busy');
  assert.equal(b.busy.extraMinutes, 15);
  assert.equal(b.busy.by, 'Ama');
  var until = new Date(b.busy.until).getTime();
  assert.ok(Math.abs(until - (Date.now() + 30 * 60000)) < 60000);
  m = await online.menu('ZQN');
  assert.equal(m.restaurant.busy.mode, 'busy');
  assert.equal(m.restaurant.readyMinutes, 35);
  var placed = await online.place('ZQN', order(), IP);
  assert.ok(placed.token || placed.number);
  var o = (await pool.query("SELECT id FROM restaurant_online_orders WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1", [company.id])).rows[0];
  var accepted = await online.accept(tok.kojo, o.id, {});
  var row = (await pool.query('SELECT ready_minutes FROM restaurant_online_orders WHERE id = $1', [o.id])).rows[0];
  assert.equal(row.ready_minutes, 35, 'accepted with the busy time');
  assert.ok(accepted);
  var logged = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'delivery.busy'", [company.id])).rows;
  assert.match(logged[0].summary, /15 min longer, for 30 min/);

  // Paused: no order now, one for later is still taken when later is on.
  await delivery.setBusy(tok.ama, { mode: 'paused', minutes: 20 });
  m = await online.menu('ZQN');
  assert.equal(m.restaurant.busy.mode, 'paused');
  assert.equal(m.restaurant.readyMinutes, 20, 'paused does not add minutes');
  await assert.rejects(online.place('ZQN', order(), IP), /very busy and is not taking orders for now/);

  // Its time is up: back to normal by itself.
  await pool.query("UPDATE restaurant_delivery_settings SET busy = jsonb_set(busy, '{until}', to_jsonb((now() - interval '1 minute')::text)) WHERE company_id = $1", [company.id]);
  m = await online.menu('ZQN');
  assert.equal(m.restaurant.busy, null);
  await online.place('ZQN', order({ name: 'Zqn Kwesi' }), IP);
  // And by hand.
  await delivery.setBusy(tok.ama, { mode: 'busy', minutes: 60, extraMinutes: 30 });
  b = await delivery.setBusy(tok.ama, { mode: 'off' });
  assert.equal(b.busy, null);
  assert.equal(delivery.busyNow({ mode: 'busy', extraMinutes: 10, until: new Date(Date.now() + 60000).toISOString() }).extraMinutes, 10);
  assert.equal(delivery.busyNow({ mode: 'other', until: new Date(Date.now() + 60000).toISOString() }), null);
});

test('table reminders: a text before each booked table, once, when the till sends them; not for one just booked, nor one not booked', async function () {
  var now = new Date();
  var at = new Date(now.getTime() + 30 * 3600000); // in 30 hours
  var b = await bookings.save(tok.ama, { name: 'Zqn Kwame', phone: '0200000852', party: 4, at: at.toISOString(), note: 'Zqn birthday' });
  var plain = await bookings.save(tok.ama, { name: 'Zqn Efua', party: 2, at: new Date(at.getTime() + 3600000).toISOString() });
  var later = await bookings.save(tok.ama, { name: 'Zqn Yaw', phone: '0200000853', party: 2, at: new Date(at.getTime() + 2 * 3600000).toISOString() });
  await pool.query("UPDATE restaurant_bookings SET status = 'cancelled' WHERE id = $1", [later.id]);
  // Off by default: nothing.
  var soon = new Date(at.getTime() - 20 * 3600000);
  assert.equal(await bookings.remindDue(soon), 0);
  // On, the day before.
  await pool.query("INSERT INTO restaurant_till_settings (company_id, settings) VALUES ($1, $2) ON CONFLICT (company_id) DO UPDATE SET settings = EXCLUDED.settings",
    [company.id, JSON.stringify({ bookings: { remind: true, remindHours: 24 } })]);
  // Too early: not yet in the 24 hours.
  assert.equal(await bookings.remindDue(new Date(at.getTime() - 26 * 3600000)), 0);
  texts.length = 0;
  assert.equal(await bookings.remindDue(soon), 1);
  assert.equal(texts.length, 1);
  assert.match(texts[0].message, /^Zqn Kitchen: a reminder of your table for 4 on /);
  assert.equal(texts[0].purpose, 'booking');
  var row = (await pool.query('SELECT reminded_at, texted FROM restaurant_bookings WHERE id = $1', [b.id])).rows[0];
  assert.ok(row.reminded_at);
  assert.equal(row.texted[row.texted.length - 1].what, 'reminder');
  // Once.
  assert.equal(await bookings.remindDue(soon), 0);
  assert.equal((await pool.query('SELECT reminded_at FROM restaurant_bookings WHERE id = $1', [plain.id])).rows[0].reminded_at, null, 'no phone, no text');

  // One booked inside the 24 hours was just made: no reminder.
  var quick = await bookings.save(tok.ama, { name: 'Zqn Abena', phone: '0200000854', party: 2, at: new Date(now.getTime() + 5 * 3600000).toISOString() });
  assert.equal(await bookings.remindDue(new Date(now.getTime() + 60000)), 0);
  assert.equal((await pool.query('SELECT reminded_at FROM restaurant_bookings WHERE id = $1', [quick.id])).rows[0].reminded_at, null);

  // Texts not set up on the server: none is claimed.
  sms.configured = function () { return false; };
  await pool.query('UPDATE restaurant_bookings SET reminded_at = NULL WHERE id = $1', [b.id]);
  assert.equal(await bookings.remindDue(soon), 0);
  assert.equal((await pool.query('SELECT reminded_at FROM restaurant_bookings WHERE id = $1', [b.id])).rows[0].reminded_at, null);
  sms.configured = function () { return true; };

  // The settings keep it, and a wrong value falls back.
  var till = require('../src/services/restaurantTillAccess.service');
  var s = await till.settingsOf(company.id);
  assert.deepEqual([s.bookings.remind, s.bookings.remindHours], [true, 24]);
  var front = require('../src/services/restaurantTillFront.service');
  var out = front.defaults();
  front.merge(out, { bookings: { remind: true, remindHours: 7 } });
  assert.deepEqual([out.bookings.remind, out.bookings.remindHours], [true, 24]);
});
