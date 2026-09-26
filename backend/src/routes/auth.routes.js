var express = require('express');
var rateLimit = require('express-rate-limit');
var authService = require('../services/auth.service');
var twoStep = require('../services/twoStep.service');
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
    if (result.twoStepRequired) {
      return res.json({
        twoStepRequired: true, challenge: result.challenge, methods: result.methods, smsTo: result.smsTo, emailTo: result.emailTo,
        codeSent: !!result.codeSent, codeSentVia: result.codeSentVia || null, codeError: result.codeError || null
      });
    }
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

// "Text me a code" / "Email me a code" during the second step
// ({ channel: 'sms' | 'email' }). Limited per IP here, and per account (one
// a minute, five per half hour) in twoStep.service.js.
router.post('/login/send-code', verifyLimiter, async function (req, res, next) {
  try {
    var channel = req.body.channel === 'email' || req.body.channel === 'sms' ? req.body.channel : null;
    res.json(await twoStep.sendLoginCode(req.body.challenge, channel));
  } catch (e) { next(e); }
});

// "Forgot your password?": send a code, then choose a new password with it.
// Their own per-IP limit on top of the per-account limits on codes and the
// login lockout.
var resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Try again later.' } }
});
// Which ways a reset code can go (email, text) — set up on the server or not.
router.get('/password/options', function (req, res) { res.json(twoStep.resetOptions()); });
router.post('/password/forgot', resetLimiter, async function (req, res, next) {
  try { res.json(await twoStep.sendResetCode(req.body.email, req.body.channel)); } catch (e) { next(e); }
});
router.post('/password/reset', resetLimiter, async function (req, res, next) {
  try { res.json(await authService.resetPassword(req.body.email, req.body.code, req.body.newPassword)); } catch (e) { next(e); }
});

// kernel.js: handlers['auth.logout'] -> POST /api/auth/logout
router.post('/logout', requireAuth, async function (req, res, next) {
  try {
    await authService.logout(req.ctx);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
