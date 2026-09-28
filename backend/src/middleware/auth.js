var { AppError } = require('../utils/errors');
var { verifyToken } = require('../services/auth.service');
var { buildContext } = require('../services/context.service');
var { pool } = require('../db/pool');

// Endpoints a user with must_change_password still needs to reach: reading
// their own session (so the frontend can show the forced-change screen with
// their name on it), actually changing the password, and signing out.
// Everything else is blocked until they set a new password — see the
// PROJECT_NOTES.md gap this closes: must_change_password was being set on
// new-employee accounts and admin password resets but never enforced.
var PASSWORD_CHANGE_ALLOWLIST = [
  { method: 'GET', path: '/api/me' },
  { method: 'POST', path: '/api/me/password' },
  { method: 'POST', path: '/api/auth/logout' }
];

// Ported from kernel.js's api.call()'s `needsAuth` check + session() lookup —
// every route except /api/auth/login requires a valid bearer token, and the
// resulting ctx (user + employee + permissions + can()) is what every
// downstream handler and RBAC check reads, exactly like the kernel's ctx.
async function requireAuth(req, res, next) {
  var header = req.headers.authorization || '';
  var match = /^Bearer (.+)$/.exec(header);
  if (!match) return next(new AppError('auth', 'Your session has ended. Please sign in again.'));

  var payload;
  try {
    payload = verifyToken(match[1]);
  } catch (e) {
    return next(new AppError('auth', 'Your session has ended. Please sign in again.'));
  }

  try {
    var ctx = await buildContext(payload.sub);
    if (!ctx) return next(new AppError('auth', 'Your session has ended. Please sign in again.'));
    req.ctx = ctx;
    // "Online" in chats: seen in the last two minutes (the notification
    // bell asks every 45 s). At most one write every 30 s per person, and
    // never in the way of the request.
    pool.query("UPDATE employees SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '30 seconds')", [ctx.employee.id]).catch(function () {});

    if (ctx.user.mustChangePassword) {
      var path = req.originalUrl.split('?')[0];
      var allowed = PASSWORD_CHANGE_ALLOWLIST.some(function (r) { return r.method === req.method && r.path === path; });
      if (!allowed) return next(new AppError('password_change_required', 'You must set a new password before continuing.'));
    }

    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { requireAuth: requireAuth };
