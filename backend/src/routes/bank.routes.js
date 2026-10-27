var express = require('express');
var { requireAuth } = require('../middleware/auth');
var bank = require('../services/bank.service');

// Bank reconciliation (bank.service.js, migration 0198).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return bank.overview(req.ctx); }));
router.post('/accounts', h(function (req) { return bank.saveAccount(req.ctx, req.body); }));
router.get('/accounts/:id', h(function (req) { return bank.get(req.ctx, req.params.id, req.query); }));
router.post('/accounts/:id/preview', h(function (req) { return bank.preview(req.ctx, req.params.id, req.body); }));
router.post('/accounts/:id/import', h(function (req) { return bank.importCsv(req.ctx, req.params.id, req.body); }));
router.post('/accounts/:id/automatch', h(function (req) { return bank.rematch(req.ctx, req.params.id); }));
router.post('/accounts/:id/reconcile', h(function (req) { return bank.reconcile(req.ctx, req.params.id, req.body); }));
router.get('/lines/:id/candidates', h(function (req) { return bank.candidates(req.ctx, req.params.id); }));
router.post('/lines/:id/match', h(function (req) { return bank.match(req.ctx, req.params.id, req.body); }));
router.post('/lines/:id/explain', h(function (req) { return bank.explain(req.ctx, req.params.id, req.body); }));
router.post('/lines/:id/undo', h(function (req) { return bank.undo(req.ctx, req.params.id); }));

module.exports = router;
