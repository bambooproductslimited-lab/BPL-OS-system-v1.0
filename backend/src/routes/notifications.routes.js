var express = require('express');
var { requireAuth } = require('../middleware/auth');
var notificationsService = require('../services/notifications.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['notifications.mine'] -> GET /api/notifications
router.get('/', async function (req, res, next) {
  try { res.json(await notificationsService.mine(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['notifications.markRead'] -> POST /api/notifications/read
router.post('/read', async function (req, res, next) {
  try { res.json(await notificationsService.markRead(req.ctx, req.body.id)); } catch (e) { next(e); }
});

module.exports = router;
