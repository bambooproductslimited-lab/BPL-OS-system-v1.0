var express = require('express');
var { requireAuth } = require('../middleware/auth');
var goals = require('../services/goals.service');

// Goals: objectives and key results (goals.service.js, migration 0200).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return goals.overview(req.ctx, req.query); }));
router.get('/mine', h(function (req) { return goals.mine(req.ctx); }));
router.post('/', h(function (req) { return goals.create(req.ctx, req.body); }));
router.post('/key-results/:id/checkin', h(function (req) { return goals.checkIn(req.ctx, req.params.id, req.body); }));
router.get('/:id', h(function (req) { return goals.get(req.ctx, req.params.id); }));
router.put('/:id', h(function (req) { return goals.update(req.ctx, req.params.id, req.body); }));
router.post('/:id/key-results', h(function (req) { return goals.addKeyResult(req.ctx, req.params.id, req.body); }));

module.exports = router;
