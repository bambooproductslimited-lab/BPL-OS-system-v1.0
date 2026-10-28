var express = require('express');
var { requireAuth } = require('../middleware/auth');
var bom = require('../services/bom.service');

// Bills of materials and product costing (bom.service.js, migration 0201).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return bom.overview(req.ctx); }));
router.get('/:id', h(function (req) { return bom.get(req.ctx, req.params.id, req.query); }));
router.put('/:id', h(function (req) { return bom.save(req.ctx, req.params.id, req.body); }));
router.post('/:id/use-cost', h(function (req) { return bom.useCost(req.ctx, req.params.id); }));

module.exports = router;
