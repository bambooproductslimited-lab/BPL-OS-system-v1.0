var express = require('express');
var { requireAuth } = require('../middleware/auth');
var auditService = require('../services/audit.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['audit.list'] -> GET /api/audit?q=
router.get('/', async function (req, res, next) {
  try { res.json(await auditService.list(req.ctx, req.query.q)); } catch (e) { next(e); }
});

module.exports = router;
