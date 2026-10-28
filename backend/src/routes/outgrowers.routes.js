var express = require('express');
var { requireAuth } = require('../middleware/auth');
var outgrowers = require('../services/outgrowers.service');

// Bamboo outgrowers (outgrowers.service.js, migration 0203).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return outgrowers.overview(req.ctx); }));
router.post('/', h(function (req) { return outgrowers.save(req.ctx, null, req.body); }));
router.post('/deliveries', h(function (req) { return outgrowers.takeIn(req.ctx, req.body); }));
router.post('/pay', h(function (req) { return outgrowers.pay(req.ctx, req.body); }));
router.patch('/plots/:plotId', h(function (req) { return outgrowers.savePlot(req.ctx, null, req.params.plotId, req.body); }));
router.post('/plots/:plotId/harvested', h(function (req) { return outgrowers.harvested(req.ctx, req.params.plotId, req.body); }));
router.get('/:id', h(function (req) { return outgrowers.get(req.ctx, req.params.id); }));
router.patch('/:id', h(function (req) { return outgrowers.save(req.ctx, req.params.id, req.body); }));
router.post('/:id/plots', h(function (req) { return outgrowers.savePlot(req.ctx, req.params.id, null, req.body); }));
router.post('/:id/advances', h(function (req) { return outgrowers.advance(req.ctx, req.params.id, req.body); }));

module.exports = router;
