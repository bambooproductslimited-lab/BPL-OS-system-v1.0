var express = require('express');
var { requireAuth } = require('../middleware/auth');
var sharesService = require('../services/shares.service');

// Mounted twice in app.js at two different paths with two different trust
// levels: POST /api/shares (staff generating a link, behind requireAuth)
// and GET /api/share/:token (whoever has the link, deliberately public —
// see shares.service.js's getSharedDocument for what that returns and
// doesn't). Same router, requireAuth applied per-route rather than via
// router.use(), since only one of the two needs it.

var router = express.Router();

router.post('/shares', requireAuth, async function (req, res, next) {
  try {
    res.status(201).json(await sharesService.createShareLink(req.ctx, req.body.documentType, req.body.documentId, req.body.expiresInDays));
  } catch (e) { next(e); }
});

router.get('/share/:token', async function (req, res, next) {
  try { res.json(await sharesService.getSharedDocument(req.params.token)); } catch (e) { next(e); }
});

router.post('/shares/whatsapp', requireAuth, async function (req, res, next) {
  try {
    res.json(await sharesService.shareViaWhatsApp(req.ctx, req.body.documentType, req.body.documentId, req.body.url));
  } catch (e) { next(e); }
});

module.exports = router;
