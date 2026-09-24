var express = require('express');
var { requireAuth } = require('../middleware/auth');
var remindersService = require('../services/reminders.service');

// Payment reminders and booking-ending notices — see reminders.service.js. Permissions are checked in
// the service, per company.
var router = express.Router();
router.use(requireAuth);

router.get('/bookings', async function (req, res, next) {
  try { res.json(await remindersService.bookingsEnding(req.ctx, { windowDays: req.query.days })); } catch (e) { next(e); }
});
router.post('/bookings/:bookingId/whatsapp', async function (req, res, next) {
  try { res.json(await remindersService.noticeBooking(req.ctx, req.params.bookingId, 'whatsapp')); } catch (e) { next(e); }
});
router.post('/bookings/:bookingId/sms', async function (req, res, next) {
  try { res.json(await remindersService.noticeBooking(req.ctx, req.params.bookingId, 'sms')); } catch (e) { next(e); }
});

router.get('/', async function (req, res, next) {
  try { res.json(await remindersService.due(req.ctx, { windowDays: req.query.days })); } catch (e) { next(e); }
});
router.post('/:invoiceId/whatsapp', async function (req, res, next) {
  try { res.json(await remindersService.prepare(req.ctx, req.params.invoiceId, req.body.origin)); } catch (e) { next(e); }
});
router.post('/:invoiceId/sms', async function (req, res, next) {
  try { res.json(await remindersService.sendSms(req.ctx, req.params.invoiceId, req.body.origin)); } catch (e) { next(e); }
});
router.get('/:invoiceId/history', async function (req, res, next) {
  try { res.json(await remindersService.history(req.ctx, req.params.invoiceId)); } catch (e) { next(e); }
});

module.exports = router;
