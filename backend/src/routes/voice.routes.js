var express = require('express');
var { requireAuth } = require('../middleware/auth');
var voice = require('../services/voice.service');

// Staff voice: pulse surveys and the ideas box (voice.service.js, migration 0200).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return voice.overview(req.ctx, req.query); }));
router.get('/mine', h(function (req) { return voice.mine(req.ctx); }));
router.post('/ideas', h(function (req) { return voice.shareIdea(req.ctx, req.body); }));
router.post('/ideas/:id/vote', h(function (req) { return voice.vote(req.ctx, req.params.id, req.body); }));
router.put('/ideas/:id', h(function (req) { return voice.answerIdea(req.ctx, req.params.id, req.body); }));
router.post('/surveys', h(function (req) { return voice.saveSurvey(req.ctx, null, req.body); }));
router.get('/surveys/:id', h(function (req) { return voice.survey(req.ctx, req.params.id); }));
router.put('/surveys/:id', h(function (req) { return voice.saveSurvey(req.ctx, req.params.id, req.body); }));
router.post('/surveys/:id/open', h(function (req) { return voice.setSurvey(req.ctx, req.params.id, 'open'); }));
router.post('/surveys/:id/close', h(function (req) { return voice.setSurvey(req.ctx, req.params.id, 'close'); }));
router.post('/surveys/:id/answer', h(function (req) { return voice.answer(req.ctx, req.params.id, req.body); }));

module.exports = router;
