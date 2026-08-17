var express = require('express');
var { requireAuth } = require('../middleware/auth');
var announcementsService = require('../services/announcements.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['announcements.list'] -> GET /api/announcements
router.get('/', async function (req, res, next) {
  try { res.json(await announcementsService.list(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['announcements.publish'] -> POST /api/announcements
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await announcementsService.publish(req.ctx, req.body)); } catch (e) { next(e); }
});

module.exports = router;
