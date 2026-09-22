var express = require('express');
var { requireAuth } = require('../middleware/auth');
var pushService = require('../services/push.service');

// Web Push device registration. Everything here is about the CALLER'S OWN
// device — there is deliberately no way to list, inspect or unsubscribe
// anyone else's, so no permission beyond being signed in applies.
var router = express.Router();
router.use(requireAuth);

// The server's public VAPID key, which a browser needs before it can
// subscribe. Public by nature — it is useless without the private half.
router.get('/public-key', async function (req, res, next) {
  try { res.json(await pushService.publicKey()); } catch (e) { next(e); }
});

router.post('/subscribe', async function (req, res, next) {
  try { res.json(await pushService.subscribe(req.ctx, req.body.subscription, req.get('user-agent'))); } catch (e) { next(e); }
});

router.post('/unsubscribe', async function (req, res, next) {
  try { res.json(await pushService.unsubscribe(req.ctx, req.body.endpoint)); } catch (e) { next(e); }
});

// "Send me one now" — so somebody can confirm the device works without
// waiting for a real event to happen to them.
router.post('/test', async function (req, res, next) {
  try { res.json(await pushService.sendTest(req.ctx)); } catch (e) { next(e); }
});

module.exports = router;
