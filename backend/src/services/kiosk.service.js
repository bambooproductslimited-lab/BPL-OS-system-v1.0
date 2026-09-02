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

// Reversible copy of the PIN, stored alongside the hash above — see
// migration 0029's comment for why this exists as a second column instead
// of replacing the hash. Key is derived (scrypt, not used directly) from
// the same pepper so no separate secret needs configuring on Render; a
// fresh random IV per encryption means the same PIN encrypts differently
// every time it's set, so two employees sharing a PIN never show matching
// ciphertext.
var ENCRYPTION_KEY = crypto.scryptSync(config.kioskPinPepper, 'bamboo-os-kiosk-pin-encryption', 32);

function encryptPin(pin) {
  var iv = crypto.randomBytes(12);
  var cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  var ciphertext = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
  var authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptPin(encrypted) {
  var raw = Buffer.from(encrypted, 'base64');
  var iv = raw.subarray(0, 12);
  var authTag = raw.subarray(12, 28);
  var ciphertext = raw.subarray(28);
  var decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
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
  var encrypted = encryptPin(pin);
  try {
    await pool.query('UPDATE employees SET kiosk_pin_hash = $1, kiosk_pin_encrypted = $2 WHERE id = $3', [hash, encrypted, employeeId]);
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
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL, kiosk_pin_encrypted = NULL WHERE id = $1', [employeeId]);
  await audit(pool, ctx, 'employee.kioskPin.clear', 'employee', employeeId, 'Cleared the kiosk PIN for ' + emp.first_name + ' ' + emp.last_name + '.');
  return { ok: true };
}

// kiosk.getPin — reveal an employee's current PIN on demand. Gated the
// same as set/clear (employee.write): this doesn't hand PIN visibility to
// anyone new, only to people who could already learn any employee's PIN
// by resetting it. Every reveal is audit-logged, same principle as viewing
// an ID document — it's sensitive enough to leave a trail of who looked.
async function getPin(ctx, employeeId) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var empRes = await pool.query('SELECT id, first_name, last_name, kiosk_pin_hash, kiosk_pin_encrypted FROM employees WHERE id = $1', [employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('notfound', 'Employee not found.');
  // A PIN set before this feature existed (or via the TimeStation sync
  // before it was updated to store the recoverable copy too) only has the
  // hash — not recoverable, not a bug. HR resetting it via "Kiosk PIN" is
  // the only way to make an old PIN viewable going forward.
  if (!emp.kiosk_pin_hash) return { hasPin: false, pin: null };
  if (!emp.kiosk_pin_encrypted) return { hasPin: true, pin: null };
  await audit(pool, ctx, 'employee.kioskPin.view', 'employee', employeeId, 'Viewed the kiosk PIN for ' + emp.first_name + ' ' + emp.last_name + '.');
  return { hasPin: true, pin: decryptPin(emp.kiosk_pin_encrypted) };
}

// kiosk.clock — the public, unauthenticated endpoint the iPad calls.
// Toggles: no attendance row yet today -> clock in; a row with clock_in
// but no clock_out -> clock out; both set -> a clean "already done" error.
//
// occurredAt is set only when the kiosk's offline queue (KioskPage.jsx) is
// replaying a tap that happened while the device had no connectivity — a
// live tap always omits it and gets the server's own now(), unchanged from
// before. This is the one place a client-supplied timestamp is trusted at
// all, and only to correctly backdate an already-authenticated tap
// (attendance.service.js's resolveOccurredAt still bounds/validates it) —
// never to skip PIN verification itself.
async function clock(pin, ip, occurredAt, location) {
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

  var resolved = attendanceService.resolveOccurredAt(occurredAt);
  var source = occurredAt ? 'kiosk_offline' : 'kiosk';

  var existing = await pool.query('SELECT clock_out FROM attendance WHERE employee_id = $1 AND date = $2', [emp.id, resolved.date]);
  var action, rec;
  if (!existing.rows[0]) {
    rec = await attendanceService.clockInEmployee(emp.id, source, occurredAt, location);
    action = 'in';
  } else if (!existing.rows[0].clock_out) {
    rec = await attendanceService.clockOutEmployee(emp.id, occurredAt, location);
    action = 'out';
  } else {
    fail('conflict', 'You have already clocked in and out today.');
  }

  var time = (action === 'in' ? rec.clock_in : rec.clock_out).slice(0, 5);
  return { action: action, employeeName: emp.first_name + ' ' + emp.last_name, time: time, status: rec.status };
}

module.exports = { setPin: setPin, clearPin: clearPin, getPin: getPin, clock: clock };
