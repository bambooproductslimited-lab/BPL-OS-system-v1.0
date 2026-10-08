var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var { allowlistFilter } = require('../lib/uploadFilters');
var crm = require('../services/restaurantCrm.service');

// A restaurant's guest CRM (services/restaurantCrm.service.js): the
// overview, the order log with feedback and follow-ups, guests' profiles,
// and the order sheet import.
var router = express.Router();
router.use(requireAuth);

var sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: allowlistFilter(['xlsx'], 'Download the order sheet as Microsoft Excel (.xlsx) and upload that file.')
});

function h(fn, status) {
  return async function (req, res, next) { try { res.status(status || 200).json(await fn(req)); } catch (e) { next(e); } };
}

router.get('/overview', h(function (req) { return crm.overview(req.ctx, req.query); }));
router.get('/orders', h(function (req) { return crm.listOrders(req.ctx, req.query); }));
router.post('/orders', h(function (req) { return crm.createOrder(req.ctx, req.body); }, 201));
router.put('/orders/:id', h(function (req) { return crm.updateOrder(req.ctx, req.params.id, req.body); }));
router.delete('/orders/:id', h(function (req) { return crm.deleteOrder(req.ctx, req.params.id); }));
router.post('/orders/:id/follow-up', h(function (req) { return crm.setFollowUp(req.ctx, req.params.id, req.body); }));
router.get('/orders/:id/till', h(function (req) { return crm.tillCandidates(req.ctx, req.params.id); }));
router.post('/orders/:id/till', h(function (req) { return crm.linkTill(req.ctx, req.params.id, req.body); }));
router.get('/guests', h(function (req) { return crm.listGuests(req.ctx, req.query); }));
router.get('/guests/:id', h(function (req) { return crm.getGuest(req.ctx, req.params.id); }));
router.get('/duplicates', h(function (req) { return crm.duplicates(req.ctx, req.query); }));
router.post('/guests/merge', h(function (req) { return crm.mergeGuests(req.ctx, req.body); }));
router.post('/import/preview', sheetUpload.single('file'), h(function (req) { return crm.importPreview(req.ctx, req.body.companyId, req.file); }));
router.post('/import', sheetUpload.single('file'), h(function (req) { return crm.importRun(req.ctx, req.body.companyId, req.file); }));

module.exports = router;
