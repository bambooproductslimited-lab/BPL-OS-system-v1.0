var express = require('express');
var { requireAuth } = require('../middleware/auth');
var jobs = require('../services/productionJobs.service');

// Production jobs from the bill of materials (productionJobs.service.js,
// migration 0203); /api/jobs is the public careers page's.
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return jobs.overview(req.ctx, req.query); }));
router.post('/', h(function (req) { return jobs.create(req.ctx, req.body); }));
router.get('/:id', h(function (req) { return jobs.get(req.ctx, req.params.id); }));
router.patch('/:id', h(function (req) { return jobs.update(req.ctx, req.params.id, req.body); }));
router.post('/:id/start', h(function (req) { return jobs.start(req.ctx, req.params.id); }));
router.post('/:id/parts', h(function (req) { return jobs.issue(req.ctx, req.params.id, req.body); }));
router.post('/:id/finish', h(function (req) { return jobs.finish(req.ctx, req.params.id, req.body); }));
router.post('/:id/cancel', h(function (req) { return jobs.cancel(req.ctx, req.params.id, req.body); }));

module.exports = router;
