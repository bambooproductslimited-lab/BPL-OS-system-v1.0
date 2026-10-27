var express = require('express');
var { requireAuth } = require('../middleware/auth');
var ppe = require('../services/ppe.service');

// Uniforms and PPE (ppe.service.js, migration 0200).
var router = express.Router();
router.use(requireAuth);
function h(fn) { return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } }; }

router.get('/', h(function (req) { return ppe.overview(req.ctx); }));
router.get('/mine', h(function (req) { return ppe.mine(req.ctx); }));
router.put('/mine/sizes', h(function (req) { return ppe.saveSizes(req.ctx, req.body); }));
router.get('/person/:id', h(function (req) { return ppe.person(req.ctx, req.params.id); }));
router.post('/items', h(function (req) { return ppe.saveItem(req.ctx, null, req.body); }));
router.put('/items/:id', h(function (req) { return ppe.saveItem(req.ctx, req.params.id, req.body); }));
router.post('/stock', h(function (req) { return ppe.receive(req.ctx, req.body); }));
router.post('/issue', h(function (req) { return ppe.issue(req.ctx, req.body); }));
router.post('/issues/:id/return', h(function (req) { return ppe.giveBack(req.ctx, req.params.id, req.body); }));
router.post('/requests', h(function (req) { return ppe.request(req.ctx, req.body); }));
router.post('/requests/:id/decline', h(function (req) { return ppe.closeRequest(req.ctx, req.params.id, 'declined', req.body); }));
router.post('/requests/:id/cancel', h(function (req) { return ppe.closeRequest(req.ctx, req.params.id, 'cancelled', req.body); }));

module.exports = router;
