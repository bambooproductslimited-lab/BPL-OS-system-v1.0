var express = require('express');
var rateLimit = require('express-rate-limit');
var { requireAuth } = require('../middleware/auth');
var bookings = require('../services/bookings.service');

// Booking a consultation (bookings.service.js): the booking page's times, a
// booking and its own page — public, a booking limited per address — and,
// for staff, the appointments and the booking page's settings.

var router = express.Router();
var bookLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many tries. Wait a few minutes and try again.' } }
});

router.get('/book', async function (req, res, next) {
  try { res.json(await bookings.options(req.query)); } catch (e) { next(e); }
});
router.post('/book', bookLimiter, async function (req, res, next) {
  try { res.status(201).json(await bookings.book(req.body, req.ip)); } catch (e) { next(e); }
});
router.get('/book/:token', async function (req, res, next) {
  try { res.json(await bookings.view(req.params.token)); } catch (e) { next(e); }
});
router.post('/book/:token/cancel', bookLimiter, async function (req, res, next) {
  try { res.json(await bookings.cancel(req.params.token)); } catch (e) { next(e); }
});

router.get('/appointments/settings', requireAuth, async function (req, res, next) {
  try { res.json(await bookings.getSettings(req.ctx)); } catch (e) { next(e); }
});
router.put('/appointments/settings', requireAuth, async function (req, res, next) {
  try { res.json(await bookings.saveSettings(req.ctx, req.body)); } catch (e) { next(e); }
});
router.get('/appointments', requireAuth, async function (req, res, next) {
  try { res.json(await bookings.list(req.ctx, req.query)); } catch (e) { next(e); }
});
router.patch('/appointments/:id', requireAuth, async function (req, res, next) {
  try { res.json(await bookings.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
