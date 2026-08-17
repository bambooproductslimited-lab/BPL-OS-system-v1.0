var express = require('express');
var { requireAuth } = require('../middleware/auth');
var invoicesService = require('../services/invoices.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['invoices.list'] -> GET /api/invoices
router.get('/', async function (req, res, next) {
  try { res.json(await invoicesService.list(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['invoices.createManual'] -> POST /api/invoices
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await invoicesService.createManual(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['invoices.createFromOrder'] -> POST /api/invoices/from-order
router.post('/from-order', async function (req, res, next) {
  try { res.status(201).json(await invoicesService.createFromOrder(req.ctx, req.body.salesOrderId)); } catch (e) { next(e); }
});

// kernel.js: handlers['invoices.createFromQuotation'] -> POST /api/invoices/from-quotation
router.post('/from-quotation', async function (req, res, next) {
  try { res.status(201).json(await invoicesService.createFromQuotation(req.ctx, req.body.quotationId, req.body.poReference)); } catch (e) { next(e); }
});

// kernel.js: handlers['invoices.update'] -> PATCH /api/invoices/:id
router.patch('/:id', async function (req, res, next) {
  try { res.json(await invoicesService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['invoices.delete'] -> DELETE /api/invoices/:id
router.delete('/:id', async function (req, res, next) {
  try { res.json(await invoicesService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['invoices.void'] -> POST /api/invoices/:id/void
router.post('/:id/void', async function (req, res, next) {
  try { res.json(await invoicesService.voidInvoice(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['invoices.markPaid'] -> POST /api/invoices/:id/mark-paid
router.post('/:id/mark-paid', async function (req, res, next) {
  try { res.json(await invoicesService.markPaid(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['invoices.recordPayment'] -> POST /api/invoices/:id/payments
router.post('/:id/payments', async function (req, res, next) {
  try { res.status(201).json(await invoicesService.recordPayment(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
