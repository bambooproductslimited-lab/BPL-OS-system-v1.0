var express = require('express');
var { requireAuth } = require('../middleware/auth');
var smsService = require('../services/sms.service');

// Text messages (mNotify) — see sms.service.js. Company settings only;
// permissions are checked in the service.
var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await smsService.status(req.ctx)); } catch (e) { next(e); }
});
router.patch('/settings', async function (req, res, next) {
  try { res.json(await smsService.saveSettings(req.ctx, req.body || {})); } catch (e) { next(e); }
});
router.post('/test', async function (req, res, next) {
  try { res.json(await smsService.sendTest(req.ctx, (req.body || {}).phone)); } catch (e) { next(e); }
});
// The sender ID: choose it ({ senderId }, null for the server's), check it
// with mNotify ({ name? }), or ask mNotify to approve it ({ name?, purpose }).
router.put('/sender', async function (req, res, next) {
  try { res.json(await smsService.saveSender(req.ctx, req.body || {})); } catch (e) { next(e); }
});
router.post('/sender/check', async function (req, res, next) {
  try { res.json(await smsService.checkSender(req.ctx, req.body || {})); } catch (e) { next(e); }
});
router.post('/sender/register', async function (req, res, next) {
  try { res.json(await smsService.registerSender(req.ctx, req.body || {})); } catch (e) { next(e); }
});

module.exports = router;
