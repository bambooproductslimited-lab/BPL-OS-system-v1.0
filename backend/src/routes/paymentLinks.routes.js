var express = require('express');
var rateLimit = require('express-rate-limit');
var { requireAuth } = require('../middleware/auth');
var links = require('../services/paymentLinks.service');

// Payment links (paymentLinks.service.js): a link's page and paying it —
// public, limited per address — and, for staff, the links.

var router = express.Router();
var payLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many tries. Wait a few minutes and try again.' } }
});

router.get('/pay/:token', async function (req, res, next) {
  try { res.json(await links.view(req.params.token)); } catch (e) { next(e); }
});
router.post('/pay/:token', payLimiter, async function (req, res, next) {
  try { res.status(201).json(await links.pay(req.params.token, req.body, req.ip)); } catch (e) { next(e); }
});

router.get('/payment-links', requireAuth, async function (req, res, next) {
  try { res.json(await links.list(req.ctx, req.query)); } catch (e) { next(e); }
});
router.post('/payment-links', requireAuth, async function (req, res, next) {
  try { res.status(201).json(await links.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.get('/payment-links/:id', requireAuth, async function (req, res, next) {
  try { res.json(await links.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.patch('/payment-links/:id', requireAuth, async function (req, res, next) {
  try { res.json(await links.setStatus(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
