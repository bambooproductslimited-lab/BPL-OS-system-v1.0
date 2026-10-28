var express = require('express');
var { requireAuth } = require('../middleware/auth');
var exportsSvc = require('../services/exports.service');

// Export papers (exports.service.js, migration 0205).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return exportsSvc.overview(req.ctx); }));
router.post('/', h(function (req) { return exportsSvc.create(req.ctx, req.body); }));
router.get('/:id', h(function (req) { return exportsSvc.get(req.ctx, req.params.id); }));
router.put('/:id', h(function (req) { return exportsSvc.update(req.ctx, req.params.id, req.body); }));
router.post('/:id/status', h(function (req) { return exportsSvc.setStatus(req.ctx, req.params.id, req.body); }));
// GET /api/exports/:id/pdf/proforma|packing|origin
router.get('/:id/pdf/:which', async function (req, res, next) {
  try {
    var made = await exportsSvc.document(req.ctx, req.params.id, req.params.which);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="' + made.filename + '"');
    res.send(made.buffer);
  } catch (e) { next(e); }
});

module.exports = router;
