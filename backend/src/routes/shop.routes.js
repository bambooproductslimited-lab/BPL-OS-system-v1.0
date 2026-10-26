var express = require('express');
var rateLimit = require('express-rate-limit');
var { requireAuth } = require('../middleware/auth');
var multer = require('multer');
var shop = require('../services/shop.service');
var reviews = require('../services/shopReviews.service');
var quotes = require('../services/shopQuotes.service');
var restock = require('../services/shopRestock.service');
var fileStore = require('../lib/fileStore');
var { allowlistFilter } = require('../lib/uploadFilters');

var quotePhotos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: quotes.MAX_PHOTO_BYTES, files: quotes.MAX_PHOTOS, fields: 30 },
  fileFilter: allowlistFilter(['jpg', 'jpeg', 'png', 'webp'], 'Add photos (JPG, PNG or WebP).')
});

// Bamboo Products' online shop (shop.service.js): the shop's page, its
// photos and an order — public, the order limited per address — and, for
// staff, the orders and the shop's settings.

var router = express.Router();
function limiter() {
  return rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many tries. Wait a few minutes and try again.' } }
  });
}
// Each kind of request counted apart: orders, reviews, quote requests, back-in-stock asks.
var orderLimiter = limiter(), reviewLimiter = limiter(), quoteLimiter = limiter(), alertLimiter = limiter();

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
router.get('/shop/orders/:token', async function (req, res, next) {
  try { res.json(await shop.track(req.params.token)); } catch (e) { next(e); }
});
router.post('/shop/orders/:token/reviews', reviewLimiter, async function (req, res, next) {
  try { res.json(await reviews.rate(req.params.token, req.body)); } catch (e) { next(e); }
});
router.get('/shop/items/:id/reviews', async function (req, res, next) {
  try { res.json(await reviews.ofItem(req.params.id)); } catch (e) { next(e); }
});
// Sold out: told when it is back (shopRestock.service.js).
router.post('/shop/items/:id/alert', alertLimiter, async function (req, res, next) {
  try { res.status(201).json(await restock.ask(req.params.id, req.body, req.ip)); } catch (e) { next(e); }
});
// Ask for a quote: what to make, with up to four photos.
router.post('/shop/quotes', quoteLimiter, quotePhotos.array('photos', quotes.MAX_PHOTOS), async function (req, res, next) {
  try { res.status(201).json(await quotes.ask(req.body, req.files || [], req.ip)); } catch (e) { next(e); }
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
router.get('/shop-orders/restock', requireAuth, async function (req, res, next) {
  try { res.json(await restock.list(req.ctx)); } catch (e) { next(e); }
});
router.put('/shop-orders/restock/:id', requireAuth, async function (req, res, next) {
  try { res.json(await restock.setSoldOut(req.ctx, req.params.id, !!(req.body && req.body.soldOut))); } catch (e) { next(e); }
});
router.get('/shop-orders/reviews', requireAuth, async function (req, res, next) {
  try { res.json(await reviews.list(req.ctx, req.query)); } catch (e) { next(e); }
});
router.patch('/shop-orders/reviews/:id', requireAuth, async function (req, res, next) {
  try { res.json(await reviews.decide(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.get('/shop-orders/quotes', requireAuth, async function (req, res, next) {
  try { res.json(await quotes.list(req.ctx, req.query)); } catch (e) { next(e); }
});
router.get('/shop-orders/quotes/:id/photos/:n', requireAuth, async function (req, res, next) {
  try { var key = await quotes.photoKey(req.ctx, req.params.id, req.params.n); await fileStore.send(res, key, 'photo', true); } catch (e) { next(e); }
});
router.patch('/shop-orders/quotes/:id', requireAuth, async function (req, res, next) {
  try { res.json(await quotes.setStatus(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/shop-orders/quotes/:id/quotation', requireAuth, async function (req, res, next) {
  try { res.status(201).json(await quotes.makeQuotation(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.patch('/shop-orders/:id', requireAuth, async function (req, res, next) {
  try { res.json(await shop.setStatus(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/shop-orders/:id/remind', requireAuth, async function (req, res, next) {
  try { res.json(await shop.remind(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
