var express = require('express');
var { requireAuth } = require('../middleware/auth');
var discipline = require('../services/discipline.service');

// Discipline and grievances (discipline.service.js, migration 0200).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return discipline.overview(req.ctx, req.query); }));
router.get('/mine', h(function (req) { return discipline.mine(req.ctx); }));
router.post('/', h(function (req) { return discipline.open(req.ctx, req.body); }));
router.post('/grievance', h(function (req) { return discipline.grievance(req.ctx, req.body); }));
router.get('/:id', h(function (req) { return discipline.get(req.ctx, req.params.id); }));
router.post('/:id/note', h(function (req) { return discipline.note(req.ctx, req.params.id, req.body); }));
router.post('/:id/query', h(function (req) { return discipline.query(req.ctx, req.params.id, req.body); }));
router.post('/:id/reply', h(function (req) { return discipline.reply(req.ctx, req.params.id, req.body); }));
router.post('/:id/hearing', h(function (req) { return discipline.hearing(req.ctx, req.params.id, req.body); }));
router.post('/:id/decide', h(function (req) { return discipline.decide(req.ctx, req.params.id, req.body); }));
router.post('/:id/appeal', h(function (req) { return discipline.appeal(req.ctx, req.params.id, req.body); }));
router.post('/:id/appeal-result', h(function (req) { return discipline.appealResult(req.ctx, req.params.id, req.body); }));
router.post('/:id/close', h(function (req) { return discipline.setStatus(req.ctx, req.params.id, 'closed', req.body); }));
router.post('/:id/withdraw', h(function (req) { return discipline.setStatus(req.ctx, req.params.id, 'withdrawn', req.body); }));
router.post('/:id/reopen', h(function (req) { return discipline.setStatus(req.ctx, req.params.id, 'reopen', req.body); }));

module.exports = router;
