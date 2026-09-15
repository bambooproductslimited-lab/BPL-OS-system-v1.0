var express = require('express');
var { requireAuth } = require('../middleware/auth');
var poki = require('../services/poki.service');
var billing = require('../services/pokiBilling.service');
var estimates = require('../services/pokiEstimates.service');
var reminders = require('../services/pokiReminders.service');
var pokiInvoices = require('../services/pokiInvoices.service');

// Poki (property rentals) — mounted at /api/poki. Every route is behind
// requireAuth; the poki.read / poki.manage gates live in the services so
// they apply however a handler is reached.

var router = express.Router();
router.use(requireAuth);

// ── overview & reports ──────────────────────────────────────────────────
router.get('/overview', async function (req, res, next) {
  try {
    await reminders.sweep();
    res.json(await poki.overview(req.ctx));
  } catch (e) { next(e); }
});
router.get('/rent-roll', async function (req, res, next) {
  try { res.json(await poki.rentRoll(req.ctx)); } catch (e) { next(e); }
});
router.get('/arrears', async function (req, res, next) {
  try { res.json(await billing.arrears(req.ctx)); } catch (e) { next(e); }
});

// ── properties ──────────────────────────────────────────────────────────
router.get('/properties', async function (req, res, next) {
  try { res.json(await poki.listProperties(req.ctx)); } catch (e) { next(e); }
});
router.post('/properties', async function (req, res, next) {
  try { res.status(201).json(await poki.createProperty(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/properties/:id', async function (req, res, next) {
  try { res.json(await poki.updateProperty(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/properties/:id', async function (req, res, next) {
  try { res.json(await poki.removeProperty(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// ── units ───────────────────────────────────────────────────────────────
router.get('/units', async function (req, res, next) {
  try { res.json(await poki.listUnits(req.ctx, { propertyId: req.query.propertyId, status: req.query.status })); } catch (e) { next(e); }
});
router.post('/units', async function (req, res, next) {
  try { res.status(201).json(await poki.createUnit(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/units/:id', async function (req, res, next) {
  try { res.json(await poki.updateUnit(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/units/:id', async function (req, res, next) {
  try { res.json(await poki.removeUnit(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// ── tenants ─────────────────────────────────────────────────────────────
router.get('/tenants', async function (req, res, next) {
  try { res.json(await poki.listTenants(req.ctx)); } catch (e) { next(e); }
});
router.post('/tenants', async function (req, res, next) {
  try { res.status(201).json(await poki.createTenant(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/tenants/:id', async function (req, res, next) {
  try { res.json(await poki.updateTenant(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/tenants/:id', async function (req, res, next) {
  try { res.json(await poki.removeTenant(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// ── leases ──────────────────────────────────────────────────────────────
router.get('/leases', async function (req, res, next) {
  try {
    await poki.autoExpireLeases();
    await reminders.sweep();
    res.json(await poki.listLeases(req.ctx, { status: req.query.status, tenantId: req.query.tenantId, unitId: req.query.unitId }));
  } catch (e) { next(e); }
});
router.get('/leases/:id', async function (req, res, next) {
  try { res.json(await poki.getLease(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/leases', async function (req, res, next) {
  try { res.status(201).json(await poki.createLease(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/leases/:id', async function (req, res, next) {
  try { res.json(await poki.updateLease(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/leases/:id/activate', async function (req, res, next) {
  try { res.json(await poki.activateLease(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/leases/:id/end', async function (req, res, next) {
  try { res.json(await poki.endLease(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/leases/:id/renew', async function (req, res, next) {
  try { res.status(201).json(await poki.renewLease(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/leases/:id/deposit', async function (req, res, next) {
  try { res.json(await poki.recordDeposit(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/leases/:id/deposit-refund', async function (req, res, next) {
  try { res.json(await poki.refundDeposit(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

// ── lease agreements ────────────────────────────────────────────────────
router.get('/agreement-templates', async function (req, res, next) {
  try {
    await billing.ensureDefaultTemplate(req.ctx);
    res.json(await billing.listTemplates(req.ctx));
  } catch (e) { next(e); }
});
router.post('/agreement-templates', async function (req, res, next) {
  try { res.status(201).json(await billing.saveTemplate(req.ctx, null, req.body)); } catch (e) { next(e); }
});
router.patch('/agreement-templates/:id', async function (req, res, next) {
  try { res.json(await billing.saveTemplate(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/leases/:id/agreement', async function (req, res, next) {
  try { res.json(await billing.generateAgreement(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.put('/leases/:id/agreement', async function (req, res, next) {
  try { res.json(await billing.saveAgreement(req.ctx, req.params.id, req.body.body)); } catch (e) { next(e); }
});

// ── rent billing ────────────────────────────────────────────────────────
router.get('/rent-run/preview', async function (req, res, next) {
  try { res.json(await billing.rentRunPreview(req.ctx, req.query.asOf)); } catch (e) { next(e); }
});
router.post('/rent-run', async function (req, res, next) {
  try { res.json(await billing.runRent(req.ctx, req.body)); } catch (e) { next(e); }
});

// ── utilities ───────────────────────────────────────────────────────────
router.get('/meters', async function (req, res, next) {
  try { res.json(await billing.listMeters(req.ctx, { unitId: req.query.unitId })); } catch (e) { next(e); }
});
router.post('/meters', async function (req, res, next) {
  try { res.status(201).json(await billing.createMeter(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/meters/:id', async function (req, res, next) {
  try { res.json(await billing.updateMeter(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.get('/readings', async function (req, res, next) {
  try {
    res.json(await billing.listReadings(req.ctx, { unbilledOnly: req.query.unbilled === 'true', meterId: req.query.meterId }));
  } catch (e) { next(e); }
});
router.post('/readings', async function (req, res, next) {
  try { res.status(201).json(await billing.recordReading(req.ctx, req.body)); } catch (e) { next(e); }
});
router.post('/readings/bill', async function (req, res, next) {
  try { res.json(await billing.billReadings(req.ctx, req.body)); } catch (e) { next(e); }
});

router.get('/master-bills', async function (req, res, next) {
  try { res.json(await billing.listMasterBills(req.ctx)); } catch (e) { next(e); }
});
router.post('/master-bills', async function (req, res, next) {
  try { res.status(201).json(await billing.createMasterBill(req.ctx, req.body)); } catch (e) { next(e); }
});
router.get('/master-bills/:id/split', async function (req, res, next) {
  try { res.json(await billing.masterBillSplit(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/master-bills/:id/bill', async function (req, res, next) {
  try { res.json(await billing.billMasterBill(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// ── invoices (Poki's side of the shared invoices table) ────────────────
router.get('/invoices', async function (req, res, next) {
  try { res.json(await billing.listInvoices(req.ctx, { docKind: req.query.docKind, leaseId: req.query.leaseId })); } catch (e) { next(e); }
});
// A one-off charge outside rent/utilities/maintenance (service charge, late
// fee, damages).
router.post('/invoices', async function (req, res, next) {
  try { res.status(201).json(await pokiInvoices.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.get('/invoices/:id', async function (req, res, next) {
  try { res.json(await pokiInvoices.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/invoices/:id/payments', async function (req, res, next) {
  try { res.status(201).json(await pokiInvoices.recordPayment(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/invoices/:id/void', async function (req, res, next) {
  try { res.json(await pokiInvoices.voidInvoice(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/invoices/:id/share', async function (req, res, next) {
  try { res.status(201).json(await pokiInvoices.createShareLink(req.ctx, req.params.id, req.body.expiresInDays)); } catch (e) { next(e); }
});
router.post('/invoices/:id/share/whatsapp', async function (req, res, next) {
  try { res.json(await pokiInvoices.shareViaWhatsApp(req.ctx, req.params.id, req.body.url)); } catch (e) { next(e); }
});

// ── maintenance ─────────────────────────────────────────────────────────
router.get('/maintenance', async function (req, res, next) {
  try { res.json(await billing.listRequests(req.ctx, { status: req.query.status, unitId: req.query.unitId })); } catch (e) { next(e); }
});
router.post('/maintenance', async function (req, res, next) {
  try { res.status(201).json(await billing.createRequest(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/maintenance/:id', async function (req, res, next) {
  try { res.json(await billing.updateRequest(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/maintenance/:id/charge', async function (req, res, next) {
  try { res.json(await billing.chargeRequestToTenant(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// ── estimates (letting offers, on the shared estimates table) ──────────
router.get('/estimates', async function (req, res, next) {
  try { res.json(await estimates.list(req.ctx, { status: req.query.status, unitId: req.query.unitId })); } catch (e) { next(e); }
});
router.get('/estimates/:id', async function (req, res, next) {
  try { res.json(await estimates.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});
// Costed offer for a unit, computed but not saved — the screen calls this
// when a unit is picked so the operator edits real figures, not a blank form.
router.post('/estimates/letting-draft', async function (req, res, next) {
  try { res.json(await estimates.lettingDraft(req.ctx, req.body)); } catch (e) { next(e); }
});
router.post('/estimates', async function (req, res, next) {
  try { res.status(201).json(await estimates.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/estimates/:id', async function (req, res, next) {
  try { res.json(await estimates.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/estimates/:id/status', async function (req, res, next) {
  try { res.json(await estimates.setStatus(req.ctx, req.params.id, req.body.status)); } catch (e) { next(e); }
});
router.post('/estimates/:id/share', async function (req, res, next) {
  try { res.status(201).json(await estimates.createShareLink(req.ctx, req.params.id, req.body.expiresInDays)); } catch (e) { next(e); }
});
router.post('/estimates/:id/share/whatsapp', async function (req, res, next) {
  try { res.json(await estimates.shareViaWhatsApp(req.ctx, req.params.id, req.body.url)); } catch (e) { next(e); }
});
router.post('/estimates/:id/convert-to-lease', async function (req, res, next) {
  try { res.status(201).json(await estimates.convertToLease(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/estimates/:id', async function (req, res, next) {
  try { res.json({ ok: await estimates.remove(req.ctx, req.params.id) }); } catch (e) { next(e); }
});

module.exports = router;
