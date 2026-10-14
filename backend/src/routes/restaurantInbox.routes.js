var express = require('express');
var { requireAuth } = require('../middleware/auth');
var inbox = require('../services/restaurantInbox.service');

// A restaurant's message inbox in its Guest CRM
// (services/restaurantInbox.service.js): WhatsApp, Messenger and Instagram
// chats with guests, replies, and the restaurant's own connections.
var router = express.Router();
router.use(requireAuth);

function h(fn) {
  return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } };
}

router.get('/', h(function (req) { return inbox.list(req.ctx, req.query); }));
router.post('/whatsapp', h(function (req) { return inbox.connectWhatsapp(req.ctx, req.body || {}); }));
router.delete('/whatsapp', h(function (req) { return inbox.disconnectWhatsapp(req.ctx, req.query.companyId); }));
router.post('/meta/read', h(function (req) { return inbox.readMetaNow(req.ctx, req.body || {}); }));
router.get('/:id', h(function (req) { return inbox.get(req.ctx, req.params.id); }));
router.post('/:id/reply', h(function (req) { return inbox.reply(req.ctx, req.params.id, req.body || {}); }));
router.post('/:id/status', h(function (req) { return inbox.setStatus(req.ctx, req.params.id, req.body || {}); }));
router.post('/:id/guest', h(function (req) { return inbox.linkGuest(req.ctx, req.params.id, req.body || {}); }));

module.exports = router;
