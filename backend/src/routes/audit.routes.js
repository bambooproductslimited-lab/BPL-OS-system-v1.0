var express = require('express');
var { requireAuth } = require('../middleware/auth');
var auditService = require('../services/audit.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['audit.list'] -> GET /api/audit?q=&group=&actorId=&from=&to=&kind=&before=
router.get('/', async function (req, res, next) {
  try { res.json(await auditService.list(req.ctx, req.query)); } catch (e) { next(e); }
});
// The last 30 days in numbers, for the Audit log page.
router.get('/summary', async function (req, res, next) {
  try { res.json(await auditService.summary(req.ctx)); } catch (e) { next(e); }
});

module.exports = router;
