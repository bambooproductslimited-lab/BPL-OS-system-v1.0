var express = require('express');
var { requireAuth } = require('../middleware/auth');
var messagesService = require('../services/messages.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['messages.inbox'] -> GET /api/messages
router.get('/', async function (req, res, next) {
  try { res.json(await messagesService.inbox(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['messages.directory'] -> GET /api/messages/directory
router.get('/directory', async function (req, res, next) {
  try { res.json(await messagesService.directory(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['messages.unreadCount'] -> GET /api/messages/unread-count
router.get('/unread-count', async function (req, res, next) {
  try { res.json({ count: await messagesService.unreadCount(req.ctx) }); } catch (e) { next(e); }
});

// kernel.js: handlers['messages.thread'] -> GET /api/messages/:peerId
router.get('/:peerId', async function (req, res, next) {
  try { res.json(await messagesService.thread(req.ctx, req.params.peerId)); } catch (e) { next(e); }
});

// kernel.js: handlers['messages.send'] -> POST /api/messages/:peerId
router.post('/:peerId', async function (req, res, next) {
  try { res.status(201).json(await messagesService.send(req.ctx, req.params.peerId, req.body.body)); } catch (e) { next(e); }
});

module.exports = router;
