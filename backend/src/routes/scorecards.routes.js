var express = require('express');
var { requireAuth } = require('../middleware/auth');
var scorecards = require('../services/scorecards.service');

// Supplier scorecards (scorecards.service.js, migration 0201).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return scorecards.overview(req.ctx, req.query); }));
router.post('/rate', h(function (req) { return scorecards.rate(req.ctx, req.body); }));
router.get('/:kind/:id', h(function (req) { return scorecards.get(req.ctx, req.params.kind, req.params.id, req.query); }));

module.exports = router;
