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
    var result = await authService.login(req.body.email, req.body.password, { deviceToken: req.body.deviceToken });
    if (result.twoStepRequired) return res.json({ twoStepRequired: true, challenge: result.challenge });
    res.json({ token: result.token, session: serializeCtx(result.ctx) });
  } catch (e) { next(e); }
});

// The second step of signing in, for accounts with two-step sign-in on. Its
// own per-IP limit; the per-account lockout covers password and code alike.
var verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Try again later.' } }
});
router.post('/login/verify', verifyLimiter, async function (req, res, next) {
  try {
    var result = await authService.verifyLogin(req.body.challenge, req.body.code, !!req.body.rememberDevice);
    res.json({ token: result.token, session: serializeCtx(result.ctx), deviceToken: result.deviceToken || null });
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
