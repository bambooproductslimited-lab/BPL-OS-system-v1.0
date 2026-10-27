var express = require('express');
var { requireAuth } = require('../middleware/auth');
var onboarding = require('../services/onboarding.service');

// Joiners and leavers (onboarding.service.js, migration 0199).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return onboarding.overview(req.ctx); }));
router.get('/mine', h(function (req) { return onboarding.mine(req.ctx); }));
router.post('/', h(function (req) { return onboarding.start(req.ctx, req.body); }));
router.put('/templates', h(function (req) { return onboarding.saveTemplate(req.ctx, req.body); }));
router.post('/steps/:id', h(function (req) { return onboarding.tick(req.ctx, req.params.id, req.body); }));
router.get('/:id', h(function (req) { return onboarding.get(req.ctx, req.params.id); }));
router.post('/:id/exit', h(function (req) { return onboarding.exitInterview(req.ctx, req.params.id, req.body); }));
router.post('/:id/cancel', h(function (req) { return onboarding.cancel(req.ctx, req.params.id); }));

module.exports = router;
