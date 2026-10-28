var express = require('express');
var { requireAuth } = require('../middleware/auth');
var overtime = require('../services/overtime.service');

// Overtime into payroll (overtime.service.js, migration 0205).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return overtime.overview(req.ctx, req.query); }));
router.put('/rules', h(function (req) { return overtime.saveRules(req.ctx, req.body); }));
router.get('/:id', h(function (req) { return overtime.get(req.ctx, req.params.id); }));
router.post('/', h(function (req) { return overtime.create(req.ctx, req.body); }));
// The Approval centre posts { decision, note } here, as it does for leave.
router.post('/:id/decision', h(function (req) { return overtime.decide(req.ctx, req.params.id, req.body && req.body.decision, req.body && req.body.note); }));
router.post('/:id/cancel', h(function (req) { return overtime.cancel(req.ctx, req.params.id); }));

module.exports = router;
