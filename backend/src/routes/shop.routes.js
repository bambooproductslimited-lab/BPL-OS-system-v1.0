var express = require('express');
var rateLimit = require('express-rate-limit');
var { requireAuth } = require('../middleware/auth');
var shop = require('../services/shop.service');
var fileStore = require('../lib/fileStore');

// Bamboo Products' online shop (shop.service.js): the shop's page, its
// photos and an order — public, the order limited per address — and, for
// staff, the orders and the shop's settings.

var router = express.Router();
var orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many tries. Wait a few minutes and try again.' } }
});

router.get('/shop', async function (req, res, next) {
  try { res.json(await shop.view()); } catch (e) { next(e); }
});
// The shop's page is on the OS's own address, the API on another: its
// photos are shown across the two, as the product sheets' are.
router.get('/shop/photos/:id', async function (req, res, next) {
  try {
    var key = await shop.photoKey(req.params.id);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    await fileStore.send(res, key, 'photo.jpg', true);
  } catch (e) { next(e); }
});
router.get('/shop/code', async function (req, res, next) {
  try { res.json(await shop.checkCode(req.query, req.ip)); } catch (e) { next(e); }
});
router.post('/shop/orders', orderLimiter, async function (req, res, next) {
  try { res.status(201).json(await shop.place(req.body, req.ip)); } catch (e) { next(e); }
});

router.get('/shop/settings', requireAuth, async function (req, res, next) {
  try { res.json(await shop.getSettings(req.ctx)); } catch (e) { next(e); }
});
router.put('/shop/settings', requireAuth, async function (req, res, next) {
  try { res.json(await shop.saveSettings(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/shop/make-days', requireAuth, async function (req, res, next) {
  try { res.json(await shop.saveMakeDays(req.ctx, req.body)); } catch (e) { next(e); }
});
router.get('/shop-orders', requireAuth, async function (req, res, next) {
  try { res.json(await shop.list(req.ctx, req.query)); } catch (e) { next(e); }
});
router.patch('/shop-orders/:id', requireAuth, async function (req, res, next) {
  try { res.json(await shop.setStatus(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
