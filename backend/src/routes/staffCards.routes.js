var express = require('express');
var { requireAuth } = require('../middleware/auth');
var cards = require('../services/staffCards.service');

// Staff ID cards and the gate (staffCards.service.js, migration 0205).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return cards.overview(req.ctx); }));
router.post('/', h(function (req) { return cards.issue(req.ctx, req.body); }));
router.post('/print', h(function (req) { return cards.print(req.ctx, req.body); }));
router.post('/scan', h(function (req) { return cards.scan(req.ctx, req.body); }));
router.post('/:id/revoke', h(function (req) { return cards.revoke(req.ctx, req.params.id, req.body); }));

module.exports = router;
