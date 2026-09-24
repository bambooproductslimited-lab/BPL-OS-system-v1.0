var crypto = require('crypto');
var bcrypt = require('bcrypt');
var jwt = require('jsonwebtoken');
var config = require('../config');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var totp = require('../lib/totp');
var sms = require('./sms.service');
var { maskedNumber } = require('../utils/phone');

// Two-step sign-in (migrations 0075, 0077). Optional: each person turns it
// on in My space. Once on, signing in needs the password AND a six-digit
// code, which comes one of two ways — the person picks either or both:
//
//   - an authenticator app on their phone (Google Authenticator, Microsoft
//     Authenticator, Authy, 2FAS, Aegis, Bitwarden, 1Password … any app that
//     shows 30-second codes): free, works without signal, can't be
//     intercepted on the way;
//   - a text message to their phone, through mNotify (sms.service.js), on
//     the company's SMS credit.
//
// Ten one-use backup codes cover a lost phone. "Don't ask again on this
// device" skips the code for 30 days on that browser only.

var ISSUER = 'Bamboo OS';
var LOGIN_CHALLENGE_MINUTES = 5;
var TRUSTED_DEVICE_DAYS = 30;
var BACKUP_CODE_COUNT = 10;
var SMS_CODE_MINUTES = 10;
var SMS_CODE_TRIES = 5;          // wrong guesses before a texted code stops working
var SMS_RESEND_SECONDS = 60;     // between texts
var SMS_MAX_PER_WINDOW = 5;      // texts per person …
var SMS_WINDOW_MINUTES = 30;     // … in this long

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

// ---- texted codes --------------------------------------------------------------

function smsCodeHash(userId, code) {
  return crypto.createHmac('sha256', key('sms-code')).update(userId + ':' + String(code)).digest('hex');
}

function newSmsCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

// Texts a fresh code, after checking this person isn't being sent a flood of
// them (each costs credit, and a flood is someone trying their luck).
async function textCode(user, phone, purpose) {
  if (!sms.configured()) fail('unavailable', 'Codes by text message aren\'t available — text messages aren\'t set up on the server yet.');
  var recent = (await pool.query(
    "SELECT count(*)::int AS n, max(created_at) AS last FROM two_step_sms_codes WHERE user_id = $1 AND created_at > now() - ($2 || ' minutes')::interval",
    [user.id, String(SMS_WINDOW_MINUTES)]
  )).rows[0];
  if (recent.last && Date.now() - new Date(recent.last).getTime() < SMS_RESEND_SECONDS * 1000) {
    fail('ratelimited', 'A code was just sent. Wait a minute before asking for another.');
  }
  if (recent.n >= SMS_MAX_PER_WINDOW) {
    fail('ratelimited', 'Too many codes sent. Wait half an hour, or use your authenticator app or a backup code.');
  }
  var code = newSmsCode();
  // Only the newest code of each kind works.
  await pool.query("UPDATE two_step_sms_codes SET expires_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()", [user.id, purpose]);
  var row = (await pool.query(
    "INSERT INTO two_step_sms_codes (user_id, purpose, phone, code_hash, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval) RETURNING id",
    [user.id, purpose, phone, smsCodeHash(user.id, code), String(SMS_CODE_MINUTES)]
  )).rows[0];
  var text = purpose === 'setup'
    ? 'Your Bamboo OS code to confirm this phone is {code}. It expires in ' + SMS_CODE_MINUTES + ' minutes.'
    : 'Your Bamboo OS sign-in code is {code}. It expires in ' + SMS_CODE_MINUTES + ' minutes. Never share it — Bamboo staff will never ask for it.';
  try {
    await sms.send({
      to: phone, message: text.replace('{code}', code), logMessage: text.replace('{code}', '••••••'),
      purpose: 'two_step', refId: user.id, sentBy: user.employee_id || null
    });
  } catch (e) {
    await pool.query('DELETE FROM two_step_sms_codes WHERE id = $1', [row.id]);
    throw e;
  }
  return { sentTo: maskedNumber(phone), expiresInMinutes: SMS_CODE_MINUTES };
}

// Checks a texted code; true if right. Wrong guesses use up the code.
async function useSmsCode(userId, purpose, code) {
  var c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  var row = (await pool.query(
    'SELECT id, phone, code_hash, attempts FROM two_step_sms_codes WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1',
    [userId, purpose]
  )).rows[0];
  if (!row || row.attempts >= SMS_CODE_TRIES) return null;
  var expected = Buffer.from(row.code_hash, 'hex');
  var given = Buffer.from(smsCodeHash(userId, c), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) {
    await pool.query('UPDATE two_step_sms_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    return null;
  }
  // Claimed in one statement: the same code can't be used twice.
  var claimed = await pool.query('UPDATE two_step_sms_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING phone', [row.id]);
  return claimed.rowCount ? claimed.rows[0].phone : null;
}

// ---- My space --------------------------------------------------------------

function methodsOf(u) {
  var m = [];
  if (u.totp_enabled_at) m.push('app');
  if (u.sms_two_step_at) m.push('sms');
  return m;
}

async function status(ctx) {
  var u = await userRow(ctx.user.id);
  var on = methodsOf(u).length > 0;
  var left = (await pool.query('SELECT count(*)::int AS n FROM user_backup_codes WHERE user_id = $1 AND used_at IS NULL', [u.id])).rows[0].n;
  var since = [u.totp_enabled_at, u.sms_two_step_at].filter(Boolean).sort(function (a, b) { return new Date(a) - new Date(b); })[0] || null;
  var employeePhone = (await pool.query('SELECT phone FROM employees WHERE id = $1', [u.employee_id])).rows[0];
  return {
    enabled: on, enabledAt: since, backupCodesLeft: on ? left : 0,
    app: { on: !!u.totp_enabled_at, since: u.totp_enabled_at },
    sms: { on: !!u.sms_two_step_at, since: u.sms_two_step_at, phone: u.two_step_phone ? maskedNumber(u.two_step_phone) : null },
    smsAvailable: sms.configured(),
    // Offered as the number to use; the person can type another.
    suggestedPhone: employeePhone && employeePhone.phone ? employeePhone.phone : ''
  };
}

// The first way turned on hands out the backup codes (once); adding the
// second keeps the ones they already have.
async function afterTurningOn(client, u) {
  if (methodsOf(u).length) return null;
  return replaceBackupCodes(client, u.id);
}

// Authenticator app, step 1: a new secret, held as pending until a code from
// the app proves it was scanned. Nothing changes for sign-in yet.
async function startSetup(ctx) {
  var u = await userRow(ctx.user.id);
  if (u.totp_enabled_at) fail('conflict', 'The authenticator app is already set up. Turn it off first to move to a new phone.');
  var secret = totp.newSecret();
  await pool.query('UPDATE users SET totp_pending_enc = $1 WHERE id = $2', [encrypt(secret), u.id]);
  return { secret: secret, otpauthUri: totp.otpauthUri(secret, u.email, ISSUER) };
}

// Authenticator app, step 2: the first code turns it on.
async function enable(ctx, code) {
  var u = await userRow(ctx.user.id);
  if (u.totp_enabled_at) fail('conflict', 'The authenticator app is already set up.');
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
    var codes = await afterTurningOn(client, u);
    await audit(client, ctx, 'auth.twoStep.on', 'user', u.id, 'Turned on two-step sign-in with an authenticator app.');
    await client.query('COMMIT');
    return { enabled: true, backupCodes: codes };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Text message, step 1: text a code to the phone they gave.
async function startSmsSetup(ctx, phone) {
  var u = await userRow(ctx.user.id);
  if (u.sms_two_step_at) fail('conflict', 'Codes by text are already on. Turn them off first to change the phone number.');
  var number = sms.smsNumber(phone);
  if (!number) fail('invalid', 'Type a mobile number, e.g. 024 412 3456.');
  return textCode(u, number, 'setup');
}

// Text message, step 2: the code typed back proves the phone is theirs.
async function enableSms(ctx, code) {
  var u = await userRow(ctx.user.id);
  if (u.sms_two_step_at) fail('conflict', 'Codes by text are already on.');
  var phone = await useSmsCode(u.id, 'setup', code);
  if (!phone) fail('invalid', 'That code is not right, or it has expired. Send a new one.');
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET two_step_phone = $2, sms_two_step_at = now(), mfa_valid_after = now() WHERE id = $1', [u.id, phone]);
    var codes = await afterTurningOn(client, u);
    await audit(client, ctx, 'auth.twoStep.sms.on', 'user', u.id, 'Turned on two-step sign-in by text message (' + maskedNumber(phone) + ').');
    await client.query('COMMIT');
    return { enabled: true, backupCodes: codes };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Turns off one way ('app' or 'sms'), or all of two-step sign-in.
async function disable(ctx, password, method) {
  var u = await userRow(ctx.user.id);
  await checkPassword(u, password);
  if (method === 'app' || method === 'sms') {
    var left = methodsOf(u).filter(function (m) { return m !== method; });
    if (!left.length) {
      await turnOff(u.id);
    } else if (method === 'app') {
      await pool.query('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, mfa_valid_after = now() WHERE id = $1', [u.id]);
    } else {
      await pool.query('UPDATE users SET two_step_phone = NULL, sms_two_step_at = NULL, mfa_valid_after = now() WHERE id = $1', [u.id]);
    }
    await audit(pool, ctx, 'auth.twoStep.off', 'user', u.id, method === 'app' ? 'Removed the authenticator app from two-step sign-in.' : 'Stopped two-step sign-in codes by text.');
    return { enabled: left.length > 0 };
  }
  await turnOff(u.id);
  await audit(pool, ctx, 'auth.twoStep.off', 'user', u.id, 'Turned off two-step sign-in.');
  return { enabled: false };
}

async function newBackupCodes(ctx, password) {
  var u = await userRow(ctx.user.id);
  if (!methodsOf(u).length) fail('invalid', 'Two-step sign-in is off.');
  await checkPassword(u, password);
  var codes = await replaceBackupCodes(pool, u.id);
  await audit(pool, ctx, 'auth.twoStep.backupCodes', 'user', u.id, 'Made new backup codes (the old ones stop working).');
  return { backupCodes: codes };
}

async function turnOff(userId) {
  await pool.query(
    'UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, ' +
    'two_step_phone = NULL, sms_two_step_at = NULL, mfa_valid_after = now() WHERE id = $1',
    [userId]
  );
  await pool.query('DELETE FROM user_backup_codes WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM two_step_sms_codes WHERE user_id = $1', [userId]);
}

// An administrator turning it off for someone who lost their phone and their
// backup codes. They sign in with their password and can set it up again.
async function adminReset(ctx, userId) {
  if (!ctx.can('user.create')) fail('forbidden', 'Your role does not allow this action (user.create).');
  var u = await userRow(userId);
  if (!methodsOf(u).length) fail('invalid', 'Two-step sign-in is not on for this account.');
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
  if (!deviceToken || !required(user)) return false;
  try {
    var p = jwt.verify(String(deviceToken), key('device'));
    if (p.sub !== user.id) return false;
    return !user.mfa_valid_after || p.iat * 1000 >= new Date(user.mfa_valid_after).getTime() - 1000;
  } catch (e) {
    return false;
  }
}

function required(user) { return !!(user.totp_enabled_at || user.sms_two_step_at); }

// What the sign-in screen needs to know about the second step: which ways
// this person has, and where a texted code goes (masked).
function loginOptions(user) {
  return { methods: methodsOf(user), smsTo: user.sms_two_step_at && user.two_step_phone ? maskedNumber(user.two_step_phone) : null };
}

function challengeUser(challenge) {
  try { return jwt.verify(String(challenge || ''), key('login')).sub; } catch (e) {
    fail('auth', 'That took too long. Sign in again.');
  }
}

// "Text me a code" on the sign-in screen (and sent straight away for anyone
// whose only way is text).
async function sendLoginCode(challenge) {
  var u = await userRow(challengeUser(challenge));
  if (u.status !== 'active' || !u.sms_two_step_at || !u.two_step_phone) fail('invalid', 'Codes by text aren\'t set up for this account.');
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    fail('auth', 'This account is temporarily locked after too many failed attempts. Try again later.');
  }
  return textCode(u, u.two_step_phone, 'login');
}

// Checks a code — from the app, from a text, or a backup code — for the
// ticket's user. A wrong one counts towards the same lockout as a wrong
// password, so a stolen password doesn't buy unlimited guesses at the code.
// Returns the user id.
async function checkLoginCode(challenge, code, maxAttempts, lockoutMinutes) {
  var u = await userRow(challengeUser(challenge));
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    fail('auth', 'This account is temporarily locked after too many failed attempts. Try again later.');
  }
  if (u.status !== 'active' || !required(u)) fail('auth', 'Sign in again.');

  var entered = String(code || '').trim();
  var ok = false;
  if (/^\d{3}\s?\d{3}$/.test(entered)) {
    if (u.totp_enabled_at) {
      var secret = decrypt(u.totp_secret_enc);
      var step = secret ? totp.verify(secret, entered) : null;
      if (step !== null && (u.totp_last_step === null || step > Number(u.totp_last_step))) {
        // Claimed in one statement: the same code can't sign in twice.
        var claimed = await pool.query(
          'UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id', [u.id, step]);
        ok = claimed.rowCount === 1;
      }
    }
    if (!ok && u.sms_two_step_at) ok = !!(await useSmsCode(u.id, 'login', entered));
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
  status: status, startSetup: startSetup, enable: enable, startSmsSetup: startSmsSetup, enableSms: enableSms,
  disable: disable, newBackupCodes: newBackupCodes, adminReset: adminReset,
  required: required, loginOptions: loginOptions, sendLoginCode: sendLoginCode, trustsDevice: trustsDevice, challengeFor: challengeFor, deviceTokenFor: deviceTokenFor, checkLoginCode: checkLoginCode,
  TRUSTED_DEVICE_DAYS: TRUSTED_DEVICE_DAYS
};
