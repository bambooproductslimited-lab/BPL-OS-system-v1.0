var express = require('express');
var { requireAuth } = require('../middleware/auth');
var aiService = require('../services/ai.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['ai.chat'] -> POST /api/ai/chat
// Ungated beyond requireAuth, matching navModel.js's assistant nav item
// (no perm) — every signed-in user can ask, and the answer is scoped to
// what their own permissions let ai.service.js's buildContext() see.
router.post('/chat', async function (req, res, next) {
  try { res.json(await aiService.chat(req.ctx, req.body.message, req.body.history)); } catch (e) { next(e); }
});

module.exports = router;
