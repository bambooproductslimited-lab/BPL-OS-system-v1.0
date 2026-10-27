var express = require('express');
var { requireAuth } = require('../middleware/auth');
var quality = require('../services/quality.service');
var fileStore = require('../lib/fileStore');

// Quality inspections (quality.service.js, migration 0200).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return quality.overview(req.ctx, req.query); }));
router.get('/checklists', h(function (req) { return quality.checklists(req.ctx); }));
router.post('/checklists', h(function (req) { return quality.saveChecklist(req.ctx, null, req.body); }));
router.put('/checklists/:id', h(function (req) { return quality.saveChecklist(req.ctx, req.params.id, req.body); }));
router.post('/', h(function (req) { return quality.inspect(req.ctx, req.body); }));
router.get('/:id', h(function (req) { return quality.get(req.ctx, req.params.id); }));
router.post('/:id/settle', h(function (req) { return quality.settle(req.ctx, req.params.id, req.body); }));
router.get('/:id/defects/:defectId/photo', async function (req, res, next) {
  try { var ph = await quality.photoOf(req.ctx, req.params.id, req.params.defectId); await fileStore.send(res, ph.key, 'defect', true); } catch (e) { next(e); }
});

module.exports = router;
