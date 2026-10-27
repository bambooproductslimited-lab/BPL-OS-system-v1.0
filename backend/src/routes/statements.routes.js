var express = require('express');
var { requireAuth } = require('../middleware/auth');
var statements = require('../services/statements.service');

// Customer statements and credit limits (statements.service.js, migration 0197).
var router = express.Router();
router.use(requireAuth);

function sendPdf(res, f) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + f.filename.replace(/"/g, '') + '"');
  res.send(f.buffer);
}

router.get('/', async function (req, res, next) {
  try { res.json(await statements.overview(req.ctx, req.query)); } catch (e) { next(e); }
});
router.get('/customers/:id', async function (req, res, next) {
  try { res.json(await statements.get(req.ctx, req.params.id, req.query)); } catch (e) { next(e); }
});
router.get('/customers/:id/pdf', async function (req, res, next) {
  try { sendPdf(res, await statements.pdf(req.ctx, req.params.id, req.query)); } catch (e) { next(e); }
});
router.get('/customers/:id/credit', async function (req, res, next) {
  try {
    if (!req.ctx.can('invoice.read') && !req.ctx.can('invoice.manage')) return res.status(403).json({ error: { code: 'forbidden', message: 'Your role does not allow this action (invoice.read).' } });
    res.json(await statements.creditOf(req.params.id, req.query.currency));
  } catch (e) { next(e); }
});
router.put('/customers/:id', async function (req, res, next) {
  try { res.json(await statements.saveCustomer(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/customers/:id/link', async function (req, res, next) {
  try { res.json(await statements.link(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/customers/:id/send', async function (req, res, next) {
  try { res.json(await statements.send(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

// The customer's own page (online.bplghana.com/statement/<link>): the long
// random link is the key.
var publicRouter = express.Router();
publicRouter.get('/:token', async function (req, res, next) {
  try { res.json(await statements.publicView(req.params.token)); } catch (e) { next(e); }
});
publicRouter.get('/:token/pdf', async function (req, res, next) {
  try { sendPdf(res, await statements.publicPdf(req.params.token)); } catch (e) { next(e); }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
