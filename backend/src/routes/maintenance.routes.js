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

// Anyone signed in reports a problem with a machine or a piece of
// equipment (migration 0196): what can be reported on, and the report.
router.get('/report', async function (req, res, next) {
  try { res.json(await maintenanceService.reportChoices(req.ctx)); } catch (e) { next(e); }
});
router.post('/report', async function (req, res, next) {
  try { res.status(201).json(await maintenanceService.report(req.ctx, req.body)); } catch (e) { next(e); }
});
// POST /api/maintenance/:id/schedule — a reported problem's repair planned
router.post('/:id/schedule', async function (req, res, next) {
  try { res.json(await maintenanceService.schedule(req.ctx, req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.get('/:id/photos/:n', async function (req, res, next) {
  try { var f = await maintenanceService.photoKey(req.ctx, req.params.id, req.params.n); await require('../lib/fileStore').send(res, f.key, f.name, true); } catch (e) { next(e); }
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
