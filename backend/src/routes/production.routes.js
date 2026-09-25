var express = require('express');
var { requireAuth } = require('../middleware/auth');
var productionService = require('../services/production.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await productionService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await productionService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// GET /api/production/:id — one batch
router.get('/:id', async function (req, res, next) {
  try { res.json(await productionService.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// POST /api/production/:id/cancel { reason } — undo a record entered by mistake
router.post('/:id/cancel', async function (req, res, next) {
  try { res.json(await productionService.cancel(req.ctx, req.params.id, req.body || {})); } catch (e) { next(e); }
});

module.exports = router;
