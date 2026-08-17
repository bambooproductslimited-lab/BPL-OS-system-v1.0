var express = require('express');
var rateLimit = require('express-rate-limit');
var authService = require('../services/auth.service');
var { requireAuth } = require('../middleware/auth');
var { serializeCtx } = require('./me.routes');

var router = express.Router();

// PROJECT_NOTES.md: "Add rate limiting on login attempts." — on top of the
// per-account lockout in auth.service.js, this bounds attempts per source IP.
var loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many login attempts. Try again later.' } }
});

// kernel.js: handlers['auth.login'] -> POST /api/auth/login
router.post('/login', loginLimiter, async function (req, res, next) {
  try {
    var result = await authService.login(req.body.email, req.body.password);
    res.json({ token: result.token, session: serializeCtx(result.ctx) });
  } catch (e) { next(e); }
});

// kernel.js: handlers['auth.logout'] -> POST /api/auth/logout
router.post('/logout', requireAuth, async function (req, res, next) {
  try {
    await authService.logout(req.ctx);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
