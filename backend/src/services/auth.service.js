var bcrypt = require('bcrypt');
var jwt = require('jsonwebtoken');
var config = require('../config');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { buildContext } = require('./context.service');
var twoStep = require('./twoStep.service');

var MAX_FAILED_ATTEMPTS = 5;
var LOCKOUT_MINUTES = 15;

function signToken(userId) {
  return jwt.sign({ sub: userId }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret); // throws on invalid/expired
}

// Ported from kernel.js's handlers['auth.login'] — real bcrypt verification,
// a signed JWT instead of Crypto.id('tok'), and a failed-attempt lockout
// that the prototype (deliberately) had no equivalent for.
// With two-step sign-in on (twoStep.service.js) and this browser not
// remembered, a right password doesn't sign in yet: it returns
// { twoStepRequired, challenge }, and verifyLogin() finishes with the code.
async function login(email, password, opts) {
  email = String(email || '').trim().toLowerCase();
  var res = await pool.query(
    'SELECT u.id, u.email, u.password_hash, u.status, u.failed_login_attempts, u.locked_until, u.totp_enabled_at, u.mfa_valid_after, u.sms_two_step_at, u.two_step_phone, u.email_two_step_at, ' +
    'e.first_name, e.last_name ' +
    'FROM users u JOIN employees e ON e.id = u.employee_id WHERE u.email = $1',
    [email]
  );
  var user = res.rows[0];

  // Constant-shape failure: don't reveal whether the email exists.
  if (!user) { await bcrypt.compare(password || '', '$2b$12$' + 'a'.repeat(53)); fail('auth', 'Incorrect email or password.'); }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    fail('auth', 'This account is temporarily locked after too many failed attempts. Try again later.');
  }

  var ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) {
    var attempts = user.failed_login_attempts + 1;
    var lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null;
    await pool.query('UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3', [attempts, lockedUntil, user.id]);
    fail('auth', 'Incorrect email or password.');
  }

  if (user.status !== 'active') fail('auth', 'This account is disabled. Contact HR.');

  // The failed-attempt count is only cleared once the code is right too, so
  // a known password doesn't reset the lockout on guessing codes.
  if (twoStep.required(user) && !twoStep.trustsDevice(user, opts && opts.deviceToken)) {
    var out = Object.assign({ twoStepRequired: true, challenge: twoStep.challengeFor(user.id) }, twoStep.loginOptions(user));
    // Someone without the authenticator app gets a code straight away —
    // by email if that's on (it's free), otherwise by text. If it can't be
    // sent (no credit, mail server down) they're told, and can still ask
    // for it the other way or use a backup code.
    if (out.methods.indexOf('app') < 0) {
      try {
        var sent = await twoStep.sendLoginCode(out.challenge);
        out.codeSent = true;
        out.codeSentVia = sent.channel;
      } catch (e) { out.codeError = e.message; }
    }
    return out;
  }
  return finishLogin(user.id);
}

// The second step: the code from the authenticator app or a text (or a
// backup code).
async function verifyLogin(challenge, code, rememberDevice) {
  var userId = await twoStep.checkLoginCode(challenge, code, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES);
  var result = await finishLogin(userId, 'Signed in with two-step sign-in.');
  if (rememberDevice) result.deviceToken = twoStep.deviceTokenFor(userId);
  return result;
}

async function finishLogin(userId, auditText) {
  await pool.query(
    'UPDATE users SET last_login_at = now(), failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
    [userId]
  );
  var ctx = await buildContext(userId);
  await audit(pool, ctx, 'auth.login', 'user', userId, auditText || 'Signed in.');
  return { token: signToken(userId), ctx: ctx };
}

// Self-service password change — distinct from users.service.js's
// setPassword (an admin resetting someone else's password without knowing
// the old one). Requires the current password so a hijacked-but-unlocked
// session (e.g. an unattended workstation) can't be used to lock the real
// owner out by silently changing their password.
async function changeOwnPassword(ctx, currentPassword, newPassword) {
  newPassword = String(newPassword || '');
  if (newPassword.length < 8) fail('invalid', 'New password must be at least 8 characters.');

  var res = await pool.query('SELECT password_hash FROM users WHERE id = $1', [ctx.user.id]);
  var user = res.rows[0];
  if (!user) fail('notfound', 'Account not found.');

  var ok = await bcrypt.compare(String(currentPassword || ''), user.password_hash);
  if (!ok) fail('auth', 'Current password is incorrect.');

  var hash = await bcrypt.hash(newPassword, config.bcryptRounds);
  await pool.query(
    'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2',
    [hash, ctx.user.id]
  );
  // A new password also disconnects Claude (src/mcp/) from the account.
  // Required here, not at the top, because mcp/oauth.js requires this file.
  await require('../mcp/oauth').revokeAllForUser(pool, ctx.user.id);
  await audit(pool, ctx, 'auth.password_change', 'user', ctx.user.id, 'Changed their own password.');
  return true;
}

async function logout(ctx) {
  await audit(pool, ctx, 'auth.logout', 'user', ctx.user.id, 'Signed out.');
  // JWTs are stateless — the client discards the token. Token lifetime is
  // bounded by JWT_EXPIRES_IN; a real deployment wanting immediate
  // server-side revocation would add a short-lived denylist/session table.
  return true;
}

module.exports = { login: login, verifyLogin: verifyLogin, logout: logout, signToken: signToken, verifyToken: verifyToken, changeOwnPassword: changeOwnPassword };
