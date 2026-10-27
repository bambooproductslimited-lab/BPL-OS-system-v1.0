var express = require('express');
var { requireAuth } = require('../middleware/auth');
var visitors = require('../services/visitors.service');

// Visitors and gate passes (visitors.service.js, migration 0199).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return visitors.desk(req.ctx, req.query); }));
router.get('/mine', h(function (req) { return visitors.mine(req.ctx); }));
router.get('/rollcall', h(function (req) { return visitors.rollCall(req.ctx, req.query); }));
router.post('/expect', h(function (req) { return visitors.expect(req.ctx, req.body); }));
router.post('/in', h(function (req) { return visitors.signIn(req.ctx, req.body); }));
router.post('/passes', h(function (req) { return visitors.requestPass(req.ctx, req.body); }));
router.get('/passes/:id', h(function (req) { return visitors.getPass(req.ctx, req.params.id); }));
router.post('/passes/:id/decide', h(function (req) { return visitors.decide(req.ctx, req.params.id, req.body); }));
router.post('/passes/:id/out', h(function (req) { return visitors.gate(req.ctx, req.params.id, false); }));
router.post('/passes/:id/back', h(function (req) { return visitors.gate(req.ctx, req.params.id, true); }));
router.post('/:id/out', h(function (req) { return visitors.signOut(req.ctx, req.params.id); }));
router.post('/:id/cancel', h(function (req) { return visitors.cancel(req.ctx, req.params.id); }));

// The visitor's pass behind its link, no sign-in (/api/visit/:code).
var publicRouter = express.Router();
publicRouter.get('/:code', async function (req, res, next) {
  try { res.json(await visitors.pass(req.params.code)); } catch (e) { next(e); }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
