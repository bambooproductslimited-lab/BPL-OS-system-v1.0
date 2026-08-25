var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var config = require('../config');
var attendanceService = require('./attendance.service');
var { audit } = require('../utils/audit');

// The clock-in/out kiosk (an unattended iPad, no login) — an employee
// enters a 4-digit PIN and nothing else identifies them, so the PIN alone
// has to resolve to exactly one active employee (see migration 0025's
// comment on the hashing choice). Every attempt is rate-limited per
// caller IP since a 4-digit space (10,000 combinations) is guessable
// online if nothing throttles it.

var PIN_LENGTH = 4;

// Rate limiting: an in-memory sliding window keyed by IP. This app runs as
// a single Node process (Render web service, no horizontal scaling), so
// in-memory state is a real, sufficient limiter for this feature — it
// resets on a redeploy, which is an acceptable tradeoff for a kiosk device
// that's on a known, small set of IPs anyway.
var MAX_ATTEMPTS = 5;
var WINDOW_MS = 2 * 60 * 1000; // 2 minutes
var LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes once tripped
var attemptsByIp = new Map(); // ip -> { count, windowStart, lockedUntil }

function checkRateLimit(ip) {
  var now = Date.now();
  var entry = attemptsByIp.get(ip);
  if (entry && entry.lockedUntil && now < entry.lockedUntil) {
    fail('ratelimited', 'Too many attempts — please wait a few minutes and try again.');
  }
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entry = { count: 0, windowStart: now, lockedUntil: 0 };
    attemptsByIp.set(ip, entry);
  }
  return entry;
}
function recordFailure(ip) {
  var entry = attemptsByIp.get(ip);
  if (!entry) return;
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = Date.now() + LOCKOUT_MS;
}
function recordSuccess(ip) { attemptsByIp.delete(ip); }

function hashPin(pin) {
  return crypto.createHmac('sha256', config.kioskPinPepper).update(pin).digest('hex');
}

// kiosk.setPin — admin sets/resets an employee's PIN (employees.routes.js,
// employee.write gated there). Exported here since the hashing/uniqueness
// concern belongs with the rest of the kiosk PIN logic.
async function setPin(ctx, employeeId, pin) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  if (!/^\d{4}$/.test(String(pin || ''))) fail('invalid', 'PIN must be exactly ' + PIN_LENGTH + ' digits.');
  var empRes = await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('notfound', 'Employee not found.');
  var hash = hashPin(pin);
  try {
    await pool.query('UPDATE employees SET kiosk_pin_hash = $1 WHERE id = $2', [hash, employeeId]);
  } catch (err) {
    if (err.code === '23505') fail('conflict', 'That PIN is already in use by another employee — choose a different one.');
    throw err;
  }
  await audit(pool, ctx, 'employee.kioskPin.set', 'employee', employeeId, 'Set a kiosk PIN for ' + emp.first_name + ' ' + emp.last_name + '.');
  return { ok: true };
}

async function clearPin(ctx, employeeId) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var empRes = await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('notfound', 'Employee not found.');
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE id = $1', [employeeId]);
  await audit(pool, ctx, 'employee.kioskPin.clear', 'employee', employeeId, 'Cleared the kiosk PIN for ' + emp.first_name + ' ' + emp.last_name + '.');
  return { ok: true };
}

// kiosk.clock — the public, unauthenticated endpoint the iPad calls.
// Toggles: no attendance row yet today -> clock in; a row with clock_in
// but no clock_out -> clock out; both set -> a clean "already done" error.
async function clock(pin, ip) {
  checkRateLimit(ip);
  if (!/^\d{4}$/.test(String(pin || ''))) {
    recordFailure(ip);
    fail('invalid', 'Enter a 4-digit PIN.');
  }
  var hash = hashPin(pin);
  var empRes = await pool.query(
    "SELECT id, first_name, last_name FROM employees WHERE kiosk_pin_hash = $1 AND status = 'active'", [hash]
  );
  var emp = empRes.rows[0];
  if (!emp) {
    recordFailure(ip);
    fail('invalid', 'Incorrect PIN.');
  }
  recordSuccess(ip);

  var existing = await pool.query("SELECT clock_out FROM attendance WHERE employee_id = $1 AND date = current_date", [emp.id]);
  var action, rec;
  if (!existing.rows[0]) {
    rec = await attendanceService.clockInEmployee(emp.id, 'kiosk');
    action = 'in';
  } else if (!existing.rows[0].clock_out) {
    rec = await attendanceService.clockOutEmployee(emp.id);
    action = 'out';
  } else {
    fail('conflict', 'You have already clocked in and out today.');
  }

  var time = (action === 'in' ? rec.clock_in : rec.clock_out).slice(0, 5);
  return { action: action, employeeName: emp.first_name + ' ' + emp.last_name, time: time, status: rec.status };
}

module.exports = { setPin: setPin, clearPin: clearPin, clock: clock };
