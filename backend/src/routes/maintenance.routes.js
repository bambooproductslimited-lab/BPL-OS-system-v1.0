var express = require('express');
var { requireAuth } = require('../middleware/auth');
var maintenanceService = require('../services/maintenance.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await maintenanceService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await maintenanceService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// POST /api/maintenance/:id/complete — a planned service is done
router.post('/:id/complete', async function (req, res, next) {
  try { res.json(await maintenanceService.complete(req.ctx, req.params.id, req.body || {})); } catch (e) { next(e); }
});
// DELETE /api/maintenance/:id — a planned service that will not happen
router.delete('/:id', async function (req, res, next) {
  try { res.json(await maintenanceService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
