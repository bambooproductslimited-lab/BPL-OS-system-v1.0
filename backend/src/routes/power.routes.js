var express = require('express');
var { requireAuth } = require('../middleware/auth');
var power = require('../services/power.service');

// The generator and power log (power.service.js, migration 0203).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return power.overview(req.ctx, req.query); }));
router.post('/sources', h(function (req) { return power.saveSource(req.ctx, null, req.body); }));
router.patch('/sources/:id', h(function (req) { return power.saveSource(req.ctx, req.params.id, req.body); }));
router.post('/outages', h(function (req) { return power.outageStart(req.ctx, req.body); }));
router.post('/outages/:id/end', h(function (req) { return power.outageEnd(req.ctx, req.params.id, req.body); }));
router.post('/runs', h(function (req) { return power.runStart(req.ctx, req.body); }));
router.post('/runs/:id/end', h(function (req) { return power.runEnd(req.ctx, req.params.id, req.body); }));
router.post('/fuel', h(function (req) { return power.addFuel(req.ctx, req.body); }));
router.post('/topups', h(function (req) { return power.addTopup(req.ctx, req.body); }));
router.delete('/:kind/:id', h(function (req) { return power.remove(req.ctx, req.params.kind, req.params.id); }));

module.exports = router;
