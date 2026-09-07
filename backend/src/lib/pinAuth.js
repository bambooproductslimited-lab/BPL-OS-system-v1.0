var crypto = require('crypto');
var { fail } = require('../utils/errors');
var config = require('../config');

// Shared 4-digit-PIN authentication primitives for every unattended-device
// surface that resolves an employee's kiosk_pin_hash — the clock-in/out
// kiosk and the restaurant POS's till login both use the SAME PIN (one per
// employee, not a separate one per device), so they share ONE rate-limit
// counter too. Two independent counters would let an attacker double
// their effective guesses per time window by splitting attempts across
// endpoints, since both test the same 10,000-combination secret space.

var PIN_LENGTH = 4;

// Rate limiting: an in-memory sliding window keyed by IP. This app runs as
// a single Node process (Render web service, no horizontal scaling), so
// in-memory state is a real, sufficient limiter for this feature — it
// resets on a redeploy, which is an acceptable tradeoff for devices that
// are on a known, small set of IPs anyway.
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

function validatePinFormat(pin) {
  if (!new RegExp('^\\d{' + PIN_LENGTH + '}$').test(String(pin || ''))) fail('invalid', 'Enter a ' + PIN_LENGTH + '-digit PIN.');
}

module.exports = {
  PIN_LENGTH: PIN_LENGTH,
  checkRateLimit: checkRateLimit,
  recordFailure: recordFailure,
  recordSuccess: recordSuccess,
  hashPin: hashPin,
  validatePinFormat: validatePinFormat
};
