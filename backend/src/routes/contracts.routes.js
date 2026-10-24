var express = require('express');
var rateLimit = require('express-rate-limit');
var { requireAuth } = require('../middleware/auth');
var contracts = require('../services/contracts.service');

// Contracts signed online (contracts.service.js): a contract's page, signing
// and declining it — public, limited per address — and, for staff, the
// contracts and their templates.

var router = express.Router();
var answerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many tries. Wait a few minutes and try again.' } }
});

router.get('/c/:token', async function (req, res, next) {
  try { res.json(await contracts.view(req.params.token)); } catch (e) { next(e); }
});
router.post('/c/:token/sign', answerLimiter, async function (req, res, next) {
  try { res.json(await contracts.sign(req.params.token, req.body, req.ip, req.get('user-agent'))); } catch (e) { next(e); }
});
router.post('/c/:token/decline', answerLimiter, async function (req, res, next) {
  try { res.json(await contracts.decline(req.params.token, req.body)); } catch (e) { next(e); }
});

router.get('/contract-templates', requireAuth, async function (req, res, next) {
  try { res.json(await contracts.templates(req.ctx)); } catch (e) { next(e); }
});
router.post('/contract-templates', requireAuth, async function (req, res, next) {
  try { res.json(await contracts.saveTemplate(req.ctx, req.body)); } catch (e) { next(e); }
});
router.delete('/contract-templates/:id', requireAuth, async function (req, res, next) {
  try { res.json(await contracts.deleteTemplate(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.get('/contracts', requireAuth, async function (req, res, next) {
  try { res.json(await contracts.list(req.ctx, req.query)); } catch (e) { next(e); }
});
router.post('/contracts', requireAuth, async function (req, res, next) {
  try { res.status(201).json(await contracts.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.get('/contracts/:id', requireAuth, async function (req, res, next) {
  try { res.json(await contracts.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.patch('/contracts/:id', requireAuth, async function (req, res, next) {
  try { res.json(await contracts.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/contracts/:id/send', requireAuth, async function (req, res, next) {
  try { res.json(await contracts.send(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/contracts/:id/void', requireAuth, async function (req, res, next) {
  try { res.json(await contracts.voidIt(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
