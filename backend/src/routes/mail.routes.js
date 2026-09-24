var express = require('express');
var { requireAuth } = require('../middleware/auth');
var mailService = require('../services/mail.service');

// Outgoing email — see mail.service.js. Company settings only; permissions
// are checked in the service.
var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await mailService.status(req.ctx)); } catch (e) { next(e); }
});
router.post('/test', async function (req, res, next) {
  try { res.json(await mailService.sendTest(req.ctx)); } catch (e) { next(e); }
});

module.exports = router;
