var express = require('express');
var { requireAuth } = require('../middleware/auth');
var reviews = require('../services/reviews.service');

// Staff performance reviews (reviews.service.js, migration 0198).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return reviews.list(req.ctx, req.query); }));
router.get('/mine', h(function (req) { return reviews.mine(req.ctx); }));
router.post('/rounds', h(function (req) { return reviews.openRound(req.ctx, req.body); }));
router.post('/rounds/:id/close', h(function (req) { return reviews.closeRound(req.ctx, req.params.id); }));
router.get('/:id', h(function (req) { return reviews.get(req.ctx, req.params.id); }));
router.post('/:id/reviewer', h(function (req) { return reviews.setReviewer(req.ctx, req.params.id, req.body); }));
router.post('/:id/self', h(function (req) { return reviews.selfReview(req.ctx, req.params.id, req.body); }));
router.post('/:id/manager', h(function (req) { return reviews.managerReview(req.ctx, req.params.id, req.body); }));
router.post('/:id/sign', h(function (req) { return reviews.sign(req.ctx, req.params.id, req.body); }));

module.exports = router;
