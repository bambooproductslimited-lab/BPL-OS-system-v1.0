var { AppError } = require('../utils/errors');
var { verifyToken } = require('../services/auth.service');
var { buildContext } = require('../services/context.service');

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
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { requireAuth: requireAuth };
