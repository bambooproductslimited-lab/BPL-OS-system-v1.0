var crypto = require('crypto');
var bcrypt = require('bcrypt');
var jwt = require('jsonwebtoken');
var config = require('../config');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var totp = require('../lib/totp');

// Two-step sign-in with an authenticator app (migration 0075). Optional:
// each person turns it on in My space. Once on, signing in needs the
// password AND the six-digit code the app shows — or one of ten one-use
// backup codes, for a lost phone. "Don't ask again on this device" skips
// the code for 30 days on that browser only.
//
// Codes rather than texts: the company has no SMS or WhatsApp Business
// sending, and an app code is free, works without signal, and can't be
// intercepted on the way.

var ISSUER = 'Bamboo OS';
var LOGIN_CHALLENGE_MINUTES = 5;
var TRUSTED_DEVICE_DAYS = 30;
var BACKUP_CODE_COUNT = 10;

// Keys derived from the session secret, one per purpose, so none of these
// tokens can ever pass as another (or as a session token).
function key(purpose) { return crypto.createHmac('sha256', config.jwt.secret).update('two-step:' + purpose).digest(); }

function encrypt(text) {
  var iv = crypto.randomBytes(12);
  var cipher = crypto.createCipheriv('aes-256-gcm', key('secret'), iv);
  var enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decrypt(blob) {
  var parts = String(blob || '').split('.');
  if (parts.length !== 3) return null;
  try {
    var decipher = crypto.createDecipheriv('aes-256-gcm', key('secret'), Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

function hashCode(code) { return crypto.createHash('sha256').update(String(code).replace(/[\s-]/g, '').toUpperCase()).digest('hex'); }

// "4F7K-9QX2": easy to read out and type, no 0/O or 1/I to confuse.
function newBackupCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var bytes = crypto.randomBytes(8);
  var s = '';
  for (var i = 0; i < 8; i++) s += chars[bytes[i] % chars.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

async function replaceBackupCodes(db, userId) {
  await db.query('DELETE FROM user_backup_codes WHERE user_id = $1', [userId]);
  var codes = [];
  for (var i = 0; i < BACKUP_CODE_COUNT; i++) {
    var c = newBackupCode();
    codes.push(c);
    await db.query('INSERT INTO user_backup_codes (user_id, code_hash) VALUES ($1, $2)', [userId, hashCode(c)]);
  }
  return codes;
}

async function userRow(userId) {
  var r = (await pool.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
  if (!r) fail('notfound', 'Account not found.');
  return r;
}

async function checkPassword(user, password) {
  if (!(await bcrypt.compare(String(password || ''), user.password_hash))) fail('auth', 'That password is not right.');
}

// ---- My space --------------------------------------------------------------

async function status(ctx) {
  var u = await userRow(ctx.user.id);
  var left = (await pool.query('SELECT count(*)::int AS n FROM user_backup_codes WHERE user_id = $1 AND used_at IS NULL', [u.id])).rows[0].n;
  return { enabled: !!u.totp_enabled_at, enabledAt: u.totp_enabled_at, backupCodesLeft: u.totp_enabled_at ? left : 0 };
}

// Step 1: a new secret, held as pending until a code from the app proves it
// was scanned. Nothing changes for sign-in yet.
async function startSetup(ctx) {
  var u = await userRow(ctx.user.id);
  if (u.totp_enabled_at) fail('conflict', 'Two-step sign-in is already on. Turn it off first to set up a new phone.');
  var secret = totp.newSecret();
  await pool.query('UPDATE users SET totp_pending_enc = $1 WHERE id = $2', [encrypt(secret), u.id]);
  return { secret: secret, otpauthUri: totp.otpauthUri(secret, u.email, ISSUER) };
}

// Step 2: the first code turns it on and hands out the backup codes, once.
async function enable(ctx, code) {
  var u = await userRow(ctx.user.id);
  if (u.totp_enabled_at) fail('conflict', 'Two-step sign-in is already on.');
  var secret = decrypt(u.totp_pending_enc);
  if (!secret) fail('invalid', 'Start the set-up again — scan the new code with your app.');
  var step = totp.verify(secret, code);
  if (step === null) fail('invalid', 'That code is not right. Check the time on your phone is set automatically, and use the code showing now.');
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = now(), totp_last_step = $2, mfa_valid_after = now() WHERE id = $1',
      [u.id, step]
    );
    var codes = await replaceBackupCodes(client, u.id);
    await audit(client, ctx, 'auth.twoStep.on', 'user', u.id, 'Turned on two-step sign-in.');
    await client.query('COMMIT');
    return { enabled: true, backupCodes: codes };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function disable(ctx, password) {
  var u = await userRow(ctx.user.id);
  await checkPassword(u, password);
  await turnOff(u.id);
  await audit(pool, ctx, 'auth.twoStep.off', 'user', u.id, 'Turned off two-step sign-in.');
  return { enabled: false };
}

async function newBackupCodes(ctx, password) {
  var u = await userRow(ctx.user.id);
  if (!u.totp_enabled_at) fail('invalid', 'Two-step sign-in is off.');
  await checkPassword(u, password);
  var codes = await replaceBackupCodes(pool, u.id);
  await audit(pool, ctx, 'auth.twoStep.backupCodes', 'user', u.id, 'Made new backup codes (the old ones stop working).');
  return { backupCodes: codes };
}

async function turnOff(userId) {
  await pool.query(
    'UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, mfa_valid_after = now() WHERE id = $1',
    [userId]
  );
  await pool.query('DELETE FROM user_backup_codes WHERE user_id = $1', [userId]);
}

// An administrator turning it off for someone who lost their phone and their
// backup codes. They sign in with their password and can set it up again.
async function adminReset(ctx, userId) {
  if (!ctx.can('user.create')) fail('forbidden', 'Your role does not allow this action (user.create).');
  var u = await userRow(userId);
  if (!u.totp_enabled_at) fail('invalid', 'Two-step sign-in is not on for this account.');
  await turnOff(u.id);
  await audit(pool, ctx, 'auth.twoStep.reset', 'user', u.id, 'Turned off two-step sign-in for ' + u.email + '.');
  return { enabled: false };
}

// ---- signing in --------------------------------------------------------------

// After the password is right, for an account with two-step on: a short-lived
// ticket the code is checked against. Nothing it grants on its own.
function challengeFor(userId) {
  return jwt.sign({ sub: userId }, key('login'), { expiresIn: LOGIN_CHALLENGE_MINUTES * 60 });
}

function deviceTokenFor(userId) {
  return jwt.sign({ sub: userId }, key('device'), { expiresIn: TRUSTED_DEVICE_DAYS * 86400 });
}

// A "don't ask again" token from this browser, still good for this user:
// right signature, not expired, and issued after two-step was last turned on
// or reset.
function trustsDevice(user, deviceToken) {
  if (!deviceToken || !user.totp_enabled_at) return false;
  try {
    var p = jwt.verify(String(deviceToken), key('device'));
    if (p.sub !== user.id) return false;
    return !user.mfa_valid_after || p.iat * 1000 >= new Date(user.mfa_valid_after).getTime() - 1000;
  } catch (e) {
    return false;
  }
}

function required(user) { return !!user.totp_enabled_at; }

// Checks a code (or a backup code) for the ticket's user. A wrong one counts
// towards the same lockout as a wrong password, so a stolen password doesn't
// buy unlimited guesses at the code. Returns the user id.
async function checkLoginCode(challenge, code, maxAttempts, lockoutMinutes) {
  var p;
  try { p = jwt.verify(String(challenge || ''), key('login')); } catch (e) {
    fail('auth', 'That took too long. Sign in again.');
  }
  var u = await userRow(p.sub);
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    fail('auth', 'This account is temporarily locked after too many failed attempts. Try again later.');
  }
  if (u.status !== 'active' || !u.totp_enabled_at) fail('auth', 'Sign in again.');

  var entered = String(code || '').trim();
  var ok = false;
  if (/^\d{3}\s?\d{3}$/.test(entered)) {
    var secret = decrypt(u.totp_secret_enc);
    var step = secret ? totp.verify(secret, entered) : null;
    if (step !== null && (u.totp_last_step === null || step > Number(u.totp_last_step))) {
      // Claimed in one statement: the same code can't sign in twice.
      var claimed = await pool.query(
        'UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id', [u.id, step]);
      ok = claimed.rowCount === 1;
    }
  } else if (entered) {
    var used = await pool.query(
      'UPDATE user_backup_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id',
      [u.id, hashCode(entered)]
    );
    ok = used.rowCount === 1;
  }
  if (!ok) {
    var attempts = u.failed_login_attempts + 1;
    var lockedUntil = attempts >= maxAttempts ? new Date(Date.now() + lockoutMinutes * 60000) : null;
    await pool.query('UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3', [attempts, lockedUntil, u.id]);
    fail('auth', 'That code is not right.');
  }
  return u.id;
}

module.exports = {
  status: status, startSetup: startSetup, enable: enable, disable: disable, newBackupCodes: newBackupCodes, adminReset: adminReset,
  required: required, trustsDevice: trustsDevice, challengeFor: challengeFor, deviceTokenFor: deviceTokenFor, checkLoginCode: checkLoginCode,
  TRUSTED_DEVICE_DAYS: TRUSTED_DEVICE_DAYS
};
