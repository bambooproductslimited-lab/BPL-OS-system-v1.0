var express = require('express');
var { requireAuth } = require('../middleware/auth');
var depreciation = require('../services/depreciation.service');

// Asset depreciation and disposals (depreciation.service.js, migration 0199).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return depreciation.view(req.ctx, req.query); }));
router.get('/export', async function (req, res, next) {
  try {
    var s = await depreciation.exportCsv(req.ctx, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + s.filename + '"');
    res.send('﻿' + s.csv);
  } catch (e) { next(e); }
});
router.put('/settings', h(function (req) { return depreciation.saveSettings(req.ctx, req.body); }));
router.get('/assets/:id', h(function (req) { return depreciation.schedule(req.ctx, req.params.id); }));
router.put('/assets/:id', h(function (req) { return depreciation.setPolicy(req.ctx, req.params.id, req.body); }));
router.post('/assets/:id/dispose', h(function (req) { return depreciation.dispose(req.ctx, req.params.id, req.body); }));
router.post('/assets/:id/undo', h(function (req) { return depreciation.undoDisposal(req.ctx, req.params.id); }));

module.exports = router;
