var express = require('express');
var { requireAuth } = require('../middleware/auth');
var aiService = require('../services/ai.service');
var aiActions = require('../ai/actions');

var router = express.Router();
router.use(requireAuth);

// POST /api/ai/chat
// Ungated beyond requireAuth, matching navModel.js's assistant nav item
// (no perm) — every signed-in user can ask. What Claude can look up or
// prepare is decided per tool by the asker's own permissions (src/ai/tools.js).
router.post('/chat', async function (req, res, next) {
  try { res.json(await aiService.chat(req.ctx, req.body.message, req.body.history, req.body.conversationId)); } catch (e) { next(e); }
});

// The page's overview, and the person's own saved conversations — nobody
// else's, whatever their role.
router.get('/overview', async function (req, res, next) {
  try { res.json(await aiService.overview(req.ctx)); } catch (e) { next(e); }
});
router.get('/conversations', async function (req, res, next) {
  try { res.json(await aiService.listConversations(req.ctx)); } catch (e) { next(e); }
});
router.get('/conversations/:id', async function (req, res, next) {
  try { res.json(await aiService.getConversation(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.patch('/conversations/:id', async function (req, res, next) {
  try { res.json(await aiService.renameConversation(req.ctx, req.params.id, req.body.title)); } catch (e) { next(e); }
});
router.delete('/conversations/:id', async function (req, res, next) {
  try { res.json(await aiService.deleteConversation(req.ctx, req.params.id)); } catch (e) { next(e); }
});
// Cuts off a Claude app connected as this person (the connector).
router.delete('/connections/:clientId', async function (req, res, next) {
  try { res.json(await aiService.disconnect(req.ctx, req.params.clientId)); } catch (e) { next(e); }
});

// The Confirm / Cancel buttons on a change the assistant prepared. Only the
// person it was prepared for can decide it (src/ai/actions.js).
router.post('/actions/:id/confirm', async function (req, res, next) {
  try { res.json(await aiActions.confirm(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/actions/:id/cancel', async function (req, res, next) {
  try { res.json(await aiActions.cancel(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
