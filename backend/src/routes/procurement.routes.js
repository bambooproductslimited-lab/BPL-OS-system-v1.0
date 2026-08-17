var express = require('express');
var { requireAuth } = require('../middleware/auth');
var procurementService = require('../services/procurement.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['procurement.list'] -> GET /api/procurement
router.get('/', async function (req, res, next) {
  try { res.json(await procurementService.list(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['procurement.request'] -> POST /api/procurement
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await procurementService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['procurement.decide'] -> POST /api/procurement/:id/decision
router.post('/:id/decision', async function (req, res, next) {
  try { res.json(await procurementService.decide(req.ctx, req.params.id, req.body.decision)); } catch (e) { next(e); }
});

module.exports = router;
