var express = require('express');
var { requireAuth } = require('../middleware/auth');
var budgets = require('../services/budgets.service');

// Budgets against what was spent (budgets.service.js, migration 0198).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return budgets.view(req.ctx, req.query); }));
router.get('/spent', h(function (req) { return budgets.spent(req.ctx, req.query); }));
router.put('/', h(function (req) { return budgets.save(req.ctx, req.body); }));
router.put('/settings', h(function (req) { return budgets.saveSettings(req.ctx, req.body); }));

module.exports = router;
