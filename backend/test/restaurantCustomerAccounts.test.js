// Customers' own accounts on the ordering website (migration 0170): made
// with a name, a phone and a password; signed in to on any phone; their
// orders theirs to follow, cancel while waiting and order again; slowed
// after wrong passwords. Fake Zqw data only.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var delivery = require('../src/services/restaurantDelivery.service');
var online = require('../src/services/restaurantOnline.service');
var accounts = require('../src/services/restaurantCustomerAccounts.service');
var pinAuth = require('../src/lib/pinAuth');

var PIN = '7571';
var IP = '10.9.9.1';
var HERE = { lat: 5.6037, lng: -0.187 };
var NEAR = { lat: 5.62, lng: -0.17 };
var PHONES = ['233200000901', '233200000902', '233200000903'];
var company, rice, boss;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQW'")).rows.map(function (r) { return r.id; });
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_online_orders WHERE company_id = ANY($1)', 'DELETE FROM restaurant_delivery_settings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', 'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
  }
  await pool.query('DELETE FROM restaurant_customer_accounts WHERE phone = ANY($1)', [PHONES]);
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQW-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
function order(extra) {
  return Object.assign({ fulfillment: 'delivery', address: 'Zqw Street 9', landmark: 'Green gate', lat: NEAR.lat, lng: NEAR.lng, payMethod: 'cash', items: [{ menuItemId: rice, qty: 1 }] }, extra || {});
}

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = $1', [pinAuth.hashPin(PIN)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQW', 'Zqw Kitchen') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQWF', 'Zqw Floor', $1) RETURNING id", [company.id])).rows[0].id;
  var emp = (await pool.query("INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ('ZQW-1', 'Kojo', 'Zqw', 'zqw-1@example.com', $1, current_date, 'active', 'permanent', $2) RETURNING id",
    [dept, pinAuth.hashPin(PIN)])).rows[0].id;
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager')", [company.id, emp]);
  rice = (await pool.query("INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, 'Zqw jollof', 'Zqw Mains', 50, true) RETURNING id", [company.id])).rows[0].id;
  boss = (await pos.login(PIN, IP, 'till')).token;
  await delivery.settings(boss, { settings: { open: true, location: { lat: HERE.lat, lng: HERE.lng, address: 'Zqw Road' }, phone: '0200000900', fee: { base: 10, perKm: 3 }, maxKm: 12, readyMinutes: 20 } }, IP);
});
test.after(async function () { await cleanup(); await pool.end(); });

test('a customer makes an account and signs in with it', async function () {
  accounts._tries.clear();
  await assert.rejects(accounts.signup({ name: 'Zqw Akua', phone: '020 000 0901', password: 'short' }, IP), /at least 8/);
  await assert.rejects(accounts.signup({ name: 'Zqw Akua', phone: '12', password: 'jollof-2026' }, IP), /phone number/);
  await assert.rejects(accounts.signup({ name: 'Z', phone: '020 000 0901', password: 'jollof-2026' }, IP), /your name/);
  var made = await accounts.signup({ name: 'Zqw Akua', phone: '020 000 0901', password: 'jollof-2026', email: 'ZQW.akua@example.com' }, IP);
  assert.ok(made.token);
  assert.deepEqual([made.account.name, made.account.phone, made.account.email], ['Zqw Akua', '233200000901', 'zqw.akua@example.com']);
  var row = (await pool.query('SELECT password_hash FROM restaurant_customer_accounts WHERE phone = $1', ['233200000901'])).rows[0];
  assert.ok(row.password_hash.indexOf('$2') === 0 && row.password_hash.indexOf('jollof') < 0);
  // One account per number, however it is written.
  await assert.rejects(accounts.signup({ name: 'Zqw Akua', phone: '+233 20 000 0901', password: 'another-pass' }, IP), /sign in instead/);
  await assert.rejects(accounts.login({ phone: '0200000901', password: 'jollof-2025' }, IP), /Wrong phone number or password/);
  await assert.rejects(accounts.login({ phone: '0200000999', password: 'jollof-2026' }, IP), /Wrong phone number or password/);
  var back = await accounts.login({ phone: '+233200000901', password: 'jollof-2026' }, IP);
  assert.equal(back.account.name, 'Zqw Akua');
  // Somebody else's token, or none, sees nothing.
  await assert.rejects(accounts.me(null), /Sign in again/);
  await assert.rejects(accounts.me(boss), /Sign in again/);
  await assert.rejects(accounts.me('not-a-token'), /Sign in again/);
});

test('wrong passwords: the account rests a while, and one address cannot keep trying', async function () {
  accounts._tries.clear();
  await accounts.signup({ name: 'Zqw Kofi', phone: '020 000 0902', password: 'waakye-2026' }, '10.9.9.2');
  for (var i = 0; i < 8; i++) await assert.rejects(accounts.login({ phone: '0200000902', password: 'nope-nope-' + i }, '10.9.9.3'), /Wrong phone number or password/);
  await assert.rejects(accounts.login({ phone: '0200000902', password: 'waakye-2026' }, '10.9.9.4'), /Try again in a quarter of an hour/);
  await pool.query('UPDATE restaurant_customer_accounts SET locked_until = NULL, failed_logins = 0 WHERE phone = $1', ['233200000902']);
  for (var j = 0; j < 12; j++) await assert.rejects(accounts.login({ phone: '0200000999', password: 'x-x-x-x-x-x' }, '10.9.9.3'), /Wrong phone number or password/);
  await assert.rejects(accounts.login({ phone: '0200000902', password: 'waakye-2026' }, '10.9.9.3'), /Too many tries from here/);
  assert.ok((await accounts.login({ phone: '0200000902', password: 'waakye-2026' }, '10.9.9.5')).token);
});

test('signed in, an order is theirs: details filled in, followed, cancelled and listed; nobody else\'s', async function () {
  accounts._tries.clear();
  var akua = (await accounts.login({ phone: '0200000901', password: 'jollof-2026' }, IP)).token;
  var kofi = (await accounts.login({ phone: '0200000902', password: 'waakye-2026' }, IP)).token;
  // No name or number typed: the account's.
  var placed = await online.place('ZQW', order({ saveAddress: true }), '10.9.9.10', akua);
  var o = (await pool.query('SELECT * FROM restaurant_online_orders WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1', [company.id])).rows[0];
  assert.equal(o.customer_name, 'Zqw Akua');
  assert.equal(o.customer_phone, '233200000901');
  assert.ok(placed.token);
  var me = await accounts.me(akua);
  assert.equal(me.orders.length, 1);
  assert.equal(me.orders[0].ref, placed.ref);
  assert.equal(me.orders[0].items[0].name, 'Zqw jollof');
  assert.equal(me.account.address, 'Zqw Street 9');
  assert.equal(me.account.lat, NEAR.lat);
  // Followed from the account, on any phone; not from another account.
  var t = await online.trackMine(akua, me.orders[0].id);
  assert.equal(t.ref, placed.ref);
  await assert.rejects(online.trackMine(kofi, me.orders[0].id), /cannot find that order in your account/);
  await assert.rejects(online.cancel(me.orders[0].id, kofi), /cannot find that order in your account/);
  var gone = await online.cancel(me.orders[0].id, akua);
  assert.equal(gone.status, 'cancelled');
  assert.equal((await accounts.me(kofi)).orders.length, 0);
  // Placed without signing in: not in the account.
  await online.place('ZQW', order({ name: 'Zqw Akua', phone: '0200000901' }), '10.9.9.11');
  assert.equal((await accounts.me(akua)).orders.length, 1);
});

test('a customer changes their details and their password', async function () {
  accounts._tries.clear();
  var tok = (await accounts.login({ phone: '0200000901', password: 'jollof-2026' }, IP)).token;
  var up = await accounts.update(tok, { name: 'Zqw Akua M.', landmark: 'Opposite the Zqw school' });
  assert.equal(up.account.name, 'Zqw Akua M.');
  assert.equal(up.account.address, 'Zqw Street 9');
  await assert.rejects(accounts.update(tok, { password: { current: 'wrong-one', next: 'banku-2026!' } }), /password now is not right/);
  await assert.rejects(accounts.update(tok, { password: { current: 'jollof-2026', next: 'short' } }), /at least 8/);
  await accounts.update(tok, { password: { current: 'jollof-2026', next: 'banku-2026!' } });
  await assert.rejects(accounts.login({ phone: '0200000901', password: 'jollof-2026' }, IP), /Wrong phone number or password/);
  assert.ok((await accounts.login({ phone: '0200000901', password: 'banku-2026!' }, IP)).token);
});
