var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var { allowlistFilter } = require('../lib/uploadFilters');
var crm = require('../services/crm.service');
var crmImport = require('../services/crmImport.service');

// The CRM (services/crm.service.js) and its spreadsheet import
// (services/crmImport.service.js).
var router = express.Router();
router.use(requireAuth);

var sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: allowlistFilter(['xlsx'], 'Download the Google Sheet as Microsoft Excel (.xlsx) and upload that file.')
});

function h(fn) {
  return async function (req, res, next) { try { res.json(await fn(req)); } catch (e) { next(e); } };
}

router.get('/overview', h(function (req) { return crm.overview(req.ctx, req.query); }));
router.get('/settings', h(function (req) { return crm.getSettings(req.ctx); }));
router.put('/settings', h(function (req) { return crm.saveSettings(req.ctx, req.body); }));
router.get('/people', h(function (req) { return crm.people(req.ctx); }));

router.get('/leads', h(function (req) { return crm.listLeads(req.ctx, req.query); }));
router.post('/leads', async function (req, res, next) { try { res.status(201).json(await crm.createLead(req.ctx, req.body)); } catch (e) { next(e); } });
router.get('/leads/:id', h(function (req) { return crm.getLead(req.ctx, req.params.id); }));
router.put('/leads/:id', h(function (req) { return crm.updateLead(req.ctx, req.params.id, req.body); }));
router.post('/leads/:id/stage', h(function (req) { return crm.setStage(req.ctx, req.params.id, req.body); }));
router.post('/leads/:id/notes', h(function (req) { return crm.addNote(req.ctx, req.params.id, req.body); }));
router.post('/leads/:id/customer', h(function (req) { return crm.toCustomer(req.ctx, req.params.id); }));
router.post('/leads/:id/deals', h(function (req) { return crm.linkInvoice(req.ctx, req.params.id, req.body); }));
router.delete('/leads/:id', h(function (req) { return crm.removeLead(req.ctx, req.params.id); }));

router.get('/invoices-to-link', h(function (req) { return crm.invoicesToLink(req.ctx, req.query); }));
router.get('/deals', h(function (req) { return crm.listDeals(req.ctx, req.query); }));
router.put('/deals/:id', h(function (req) { return crm.updateDeal(req.ctx, req.params.id, req.body); }));
router.post('/deals/:id/status', h(function (req) { return crm.setDealStatus(req.ctx, req.params.id, req.body.status); }));
router.delete('/deals/:id', h(function (req) { return crm.unlinkDeal(req.ctx, req.params.id); }));

router.get('/referrals', h(function (req) { return crm.listReferrals(req.ctx); }));
router.post('/referrals', h(function (req) { return crm.saveReferral(req.ctx, null, req.body); }));
router.put('/referrals/:id', h(function (req) { return crm.saveReferral(req.ctx, req.params.id, req.body); }));
router.post('/referrals/:id/status', h(function (req) { return crm.setReferralStatus(req.ctx, req.params.id, req.body.status); }));
router.delete('/referrals/:id', h(function (req) { return crm.removeReferral(req.ctx, req.params.id); }));

router.get('/prospects', h(function (req) { return crm.listProspects(req.ctx, req.query); }));
router.post('/prospects', h(function (req) { return crm.saveProspect(req.ctx, null, req.body); }));
router.put('/prospects/:id', h(function (req) { return crm.saveProspect(req.ctx, req.params.id, req.body); }));
router.post('/prospects/:id/lead', h(function (req) { return crm.prospectToLead(req.ctx, req.params.id, req.body); }));
router.delete('/prospects/:id', h(function (req) { return crm.removeProspect(req.ctx, req.params.id); }));

router.get('/visits', h(function (req) { return crm.listVisits(req.ctx, req.query); }));
router.post('/visits', h(function (req) { return crm.saveVisit(req.ctx, null, req.body); }));
router.put('/visits/:id', h(function (req) { return crm.saveVisit(req.ctx, req.params.id, req.body); }));
router.delete('/visits/:id', h(function (req) { return crm.removeVisit(req.ctx, req.params.id); }));

// The import: preview what a workbook holds, then import it.
router.post('/import/preview', sheetUpload.single('file'), h(function (req) { return crmImport.preview(req.ctx, req.file); }));
router.post('/import', sheetUpload.single('file'), h(function (req) { return crmImport.run(req.ctx, req.file); }));

module.exports = router;
