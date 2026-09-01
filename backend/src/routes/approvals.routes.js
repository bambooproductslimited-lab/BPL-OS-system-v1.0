var express = require('express');
var { requireAuth } = require('../middleware/auth');
var approvalsService = require('../services/approvals.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['approvals.queue'] -> GET /api/approvals/queue?companyId=&departmentId=
router.get('/queue', async function (req, res, next) {
  try { res.json(await approvalsService.queue(req.ctx, { companyId: req.query.companyId, departmentId: req.query.departmentId })); } catch (e) { next(e); }
});

module.exports = router;
