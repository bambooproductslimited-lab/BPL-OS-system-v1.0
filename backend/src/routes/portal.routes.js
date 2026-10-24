var express = require('express');
var rateLimit = require('express-rate-limit');
var portal = require('../services/portal.service');

// "My account" on Bamboo Products' website (portal.service.js): a code to
// sign in with, then the customer's own things. Public, limited per address;
// the session goes in the X-Portal-Token header.

var router = express.Router();
var limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many tries. Wait a few minutes and try again.' } }
});
function tokenOf(req) { return String(req.get('x-portal-token') || ''); }

router.post('/portal/code', limiter, async function (req, res, next) {
  try { res.json(await portal.sendCode(req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/portal/signup', limiter, async function (req, res, next) {
  try { res.json(await portal.signup(req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/portal/login', limiter, async function (req, res, next) {
  try { res.json(await portal.login(req.body)); } catch (e) { next(e); }
});
router.get('/portal/me', async function (req, res, next) {
  try { res.json(await portal.me(tokenOf(req))); } catch (e) { next(e); }
});
router.post('/portal/logout', async function (req, res, next) {
  try { res.json(await portal.logout(tokenOf(req))); } catch (e) { next(e); }
});

module.exports = router;
