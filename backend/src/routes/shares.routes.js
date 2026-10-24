var express = require('express');
var rateLimit = require('express-rate-limit');
var { requireAuth } = require('../middleware/auth');
var sharesService = require('../services/shares.service');
var documentAnswers = require('../services/documentAnswers.service');
var invoicePay = require('../services/invoicePay.service');

// Mounted twice in app.js at two different paths with two different trust
// levels: POST /api/shares (staff generating a link, behind requireAuth)
// and GET /api/share/:token (whoever has the link, deliberately public —
// see shares.service.js's getSharedDocument for what that returns and
// doesn't). Same router, requireAuth applied per-route rather than via
// router.use(), since only one of the two needs it.

var router = express.Router();

router.post('/shares', requireAuth, async function (req, res, next) {
  try {
    res.status(201).json(await sharesService.createShareLink(req.ctx, req.body.documentType, req.body.documentId, req.body.expiresInDays));
  } catch (e) { next(e); }
});

router.get('/share/:token', async function (req, res, next) {
  try { res.json(await sharesService.getSharedDocument(req.params.token)); } catch (e) { next(e); }
});

// What a customer does on the link: answer an estimate or a quotation, pay
// an invoice. Public like the link itself (its token is the credential),
// and limited per address.
var customerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many tries. Wait a few minutes and try again.' } }
});

router.post('/share/:token/answer', customerLimiter, async function (req, res, next) {
  try { res.json(await documentAnswers.answer(req.params.token, req.body, req.ip, req.get('user-agent'))); } catch (e) { next(e); }
});

router.post('/share/:token/pay', customerLimiter, async function (req, res, next) {
  try { res.status(201).json(await invoicePay.start(req.params.token, req.body)); } catch (e) { next(e); }
});

router.get('/share/:token/pay/:reference', async function (req, res, next) {
  try { res.json(await invoicePay.status(req.params.token, req.params.reference)); } catch (e) { next(e); }
});

// Paystack telling us an invoice was paid, signed with Bamboo Products' key.
router.post('/share/paystack/webhook', async function (req, res, next) {
  try { res.json(await invoicePay.webhook(req.rawBody, req.get('x-paystack-signature'))); } catch (e) { next(e); }
});

// Every answer a customer gave to a document, for staff.
router.get('/document-answers/:type/:id', requireAuth, async function (req, res, next) {
  try { res.json(await documentAnswers.list(req.ctx, req.params.type, req.params.id)); } catch (e) { next(e); }
});

router.post('/shares/whatsapp', requireAuth, async function (req, res, next) {
  try {
    res.json(await sharesService.shareViaWhatsApp(req.ctx, req.body.documentType, req.body.documentId, req.body.url));
  } catch (e) { next(e); }
});

module.exports = router;
