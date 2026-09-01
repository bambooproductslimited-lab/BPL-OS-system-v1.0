var express = require('express');
var { requireAuth } = require('../middleware/auth');
var leaveService = require('../services/leave.service');

var router = express.Router();

router.use(requireAuth);

// kernel.js: handlers['leave.types'] -> GET /api/leave/types
router.get('/types', async function (req, res, next) {
  try { res.json(await leaveService.listTypes()); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.list'] -> GET /api/leave?status=&companyId=&departmentId=
router.get('/', async function (req, res, next) {
  try {
    res.json(await leaveService.list(req.ctx, { status: req.query.status, companyId: req.query.companyId, departmentId: req.query.departmentId }));
  } catch (e) { next(e); }
});

// kernel.js: handlers['leave.request'] -> POST /api/leave
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await leaveService.requestLeave(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.decide'] -> POST /api/leave/:id/decision
router.post('/:id/decision', async function (req, res, next) {
  try { res.json(await leaveService.decide(req.ctx, req.params.id, req.body.decision, req.body.note)); } catch (e) { next(e); }
});

// kernel.js: handlers['leave.cancel'] -> POST /api/leave/:id/cancel
router.post('/:id/cancel', async function (req, res, next) {
  try { res.json(await leaveService.cancel(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
