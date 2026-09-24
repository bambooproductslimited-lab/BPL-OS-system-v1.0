var express = require('express');
var { requireAuth } = require('../middleware/auth');
var remindersService = require('../services/reminders.service');

// Payment reminders — see reminders.service.js. Permissions are checked in
// the service, per company.
var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await remindersService.due(req.ctx, { windowDays: req.query.days })); } catch (e) { next(e); }
});
router.post('/:invoiceId/whatsapp', async function (req, res, next) {
  try { res.json(await remindersService.prepare(req.ctx, req.params.invoiceId, req.body.origin)); } catch (e) { next(e); }
});
router.get('/:invoiceId/history', async function (req, res, next) {
  try { res.json(await remindersService.history(req.ctx, req.params.invoiceId)); } catch (e) { next(e); }
});

module.exports = router;
