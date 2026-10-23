var jwt = require('jsonwebtoken');
var bcrypt = require('bcrypt');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var config = require('../config');
var { internationalNumber } = require('../utils/phone');

// Customers' own accounts on the ordering website (migration 0170;
// frontend pages/online/AccountSheet.jsx). A customer makes one with their
// name, phone number and a password, and signs in with the number and the
// password on any phone: their name, number and where they like their food
// brought fill in the checkout, and their orders — those placed signed in
// (restaurantOnline place, account_id) — are listed to follow and to order
// again. Not the OS's users: their own table and their own kind of token.
//
// Signing in is slowed after wrong passwords: a few tries a quarter-hour
// from one address, and an account rests for a quarter-hour after eight
// wrong ones in a row. A password is kept only as its bcrypt hash.

var TOKEN_DAYS = 90;
var MIN_PASSWORD = 8;
var LOCK_AFTER = 8, LOCK_MINUTES = 15;
var TRIES_PER_IP = 20, TRY_WINDOW_MS = 15 * 60000;
var tries = new Map(); // address -> [times]

function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function pointOf(lat, lng) {
  var a = Number(lat), b = Number(lng);
  return lat != null && lng != null && lat !== '' && lng !== '' && a >= -90 && a <= 90 && b >= -180 && b <= 180 ? { lat: a, lng: b } : null;
}
var dummy = null;
async function dummyHash() { if (!dummy) dummy = await bcrypt.hash('no account has this', 10); return dummy; }
function tokenFor(a) { return jwt.sign({ t: 'cust', a: a.id }, config.jwt.secret, { expiresIn: TOKEN_DAYS + 'd' }); }
// The account a website token is for, or null (none, expired, not one).
async function accountOf(token) {
  if (!token) return null;
  var p;
  try { p = jwt.verify(String(token), config.jwt.secret); } catch (e) { return null; }
  if (!p || p.t !== 'cust' || !p.a) return null;
  return (await pool.query('SELECT * FROM restaurant_customer_accounts WHERE id = $1', [p.a])).rows[0] || null;
}
async function need(token) {
  var a = await accountOf(token);
  if (!a) fail('auth', 'Sign in again to see your account.');
  return a;
}
function accountOut(a) {
  return { id: a.id, name: a.name, phone: a.phone, email: a.email || '', address: a.address || '', landmark: a.landmark || '',
    lat: a.lat == null ? null : Number(a.lat), lng: a.lng == null ? null : Number(a.lng), since: a.created_at };
}
function slowDown(ip) {
  var now = Date.now(), key = String(ip || '');
  var list = (tries.get(key) || []).filter(function (t) { return now - t < TRY_WINDOW_MS; });
  if (list.length >= TRIES_PER_IP) fail('ratelimited', 'Too many tries from here. Wait a quarter of an hour, then try again.');
  list.push(now);
  tries.set(key, list);
  if (tries.size > 5000) tries.clear();
}
function checkPassword(pw) {
  pw = String(pw == null ? '' : pw);
  if (pw.length < MIN_PASSWORD) fail('invalid', 'Choose a password of at least ' + MIN_PASSWORD + ' letters or numbers.');
  if (pw.length > 200) fail('invalid', 'That password is too long.');
  return pw;
}

// POST /api/pos/online/account/signup { name, phone, password, email }
async function signup(p, ip) {
  p = p || {};
  if (p.website) fail('invalid', 'Something went wrong. Please try again.');
  slowDown(ip);
  var name = cleanText(p.name, 80);
  if (name.length < 2) fail('invalid', 'Write your name.');
  var phone = internationalNumber(p.phone);
  if (!phone) fail('invalid', 'Give a phone number we can call you on.');
  var email = cleanText(p.email, 120).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('invalid', 'That email address does not look right.');
  var hash = await bcrypt.hash(checkPassword(p.password), 10);
  var a;
  try {
    a = (await pool.query('INSERT INTO restaurant_customer_accounts (phone, name, email, password_hash, last_login_at) VALUES ($1, $2, $3, $4, now()) RETURNING *',
      [phone, name, email || null, hash])).rows[0];
  } catch (e) {
    if (e.code === '23505') fail('conflict', 'There is an account with this number already: sign in instead.');
    throw e;
  }
  return { token: tokenFor(a), account: accountOut(a) };
}

// POST /api/pos/online/account/login { phone, password }
async function login(p, ip) {
  p = p || {};
  slowDown(ip);
  var phone = internationalNumber(p.phone);
  var a = phone ? (await pool.query('SELECT * FROM restaurant_customer_accounts WHERE phone = $1', [phone])).rows[0] : null;
  var wrong = 'Wrong phone number or password.';
  // No such account: as long to answer as a wrong password, so numbers cannot be found out.
  if (!a) { await bcrypt.compare(String(p.password || ''), await dummyHash()); fail('invalid', wrong); }
  if (a.locked_until && new Date(a.locked_until) > new Date()) fail('ratelimited', 'Too many wrong passwords. Try again in a quarter of an hour.');
  if (!(await bcrypt.compare(String(p.password || ''), a.password_hash))) {
    await pool.query("UPDATE restaurant_customer_accounts SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END WHERE id = $1",
      [a.id, LOCK_AFTER, String(LOCK_MINUTES)]);
    fail('invalid', wrong);
  }
  await pool.query('UPDATE restaurant_customer_accounts SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [a.id]);
  return { token: tokenFor(a), account: accountOut(a) };
}

// GET /api/pos/online/account — the account and its orders, newest first.
async function me(token) {
  var a = await need(token);
  var rows = (await pool.query(
    'SELECT o.id, o.number, o.status, o.fulfillment, o.items, o.total, o.created_at, o.scheduled_for, c.code AS company_code, c.name AS company_name ' +
    'FROM restaurant_online_orders o JOIN companies c ON c.id = o.company_id WHERE o.account_id = $1 ORDER BY o.created_at DESC LIMIT 30', [a.id])).rows;
  return {
    account: accountOut(a),
    // Their loyalty points at each restaurant, by their phone (restaurantLoyalty).
    points: await require('./restaurantLoyalty.service').forPhone(a.phone),
    orders: rows.map(function (o) {
      return { id: o.id, ref: 'W-' + String(o.number).padStart(4, '0'), status: o.status, fulfillment: o.fulfillment, total: Math.round(Number(o.total) * 100) / 100,
        placedAt: o.created_at, scheduledFor: o.scheduled_for, restaurant: { code: o.company_code, name: o.company_name },
        items: (o.items || []).map(function (l) { return { menuItemId: l.menuItemId, variationId: l.variationId || null, name: l.name, qty: l.qty, note: l.note || '', modifiers: l.modifiers || [] }; }) };
    })
  };
}

// PUT /api/pos/online/account { name, email, address, landmark, lat, lng,
// password: { current, next } } — what is sent is changed.
async function update(token, p) {
  var a = await need(token);
  p = p || {};
  var name = p.name !== undefined ? cleanText(p.name, 80) : a.name;
  if (name.length < 2) fail('invalid', 'Write your name.');
  var email = p.email !== undefined ? cleanText(p.email, 120).toLowerCase() : (a.email || '');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('invalid', 'That email address does not look right.');
  var point = p.lat !== undefined ? pointOf(p.lat, p.lng) : (a.lat == null ? null : { lat: Number(a.lat), lng: Number(a.lng) });
  var hash = a.password_hash;
  if (p.password) {
    if (!(await bcrypt.compare(String(p.password.current || ''), a.password_hash))) fail('invalid', 'Your password now is not right.');
    hash = await bcrypt.hash(checkPassword(p.password.next), 10);
  }
  var up = (await pool.query(
    'UPDATE restaurant_customer_accounts SET name = $2, email = $3, address = $4, landmark = $5, lat = $6, lng = $7, password_hash = $8, updated_at = now() WHERE id = $1 RETURNING *',
    [a.id, name, email || null, p.address !== undefined ? cleanText(p.address, 200) : a.address, p.landmark !== undefined ? cleanText(p.landmark, 200) : a.landmark,
      point ? point.lat : null, point ? point.lng : null, hash])).rows[0];
  return { account: accountOut(up) };
}

module.exports = { accountOf: accountOf, need: need, signup: signup, login: login, me: me, update: update, _tries: tries };
