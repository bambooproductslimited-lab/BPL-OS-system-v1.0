var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var { allowlistFilter } = require('../lib/uploadFilters');
var fileStore = require('../lib/fileStore');
var sheets = require('../services/expenseSheets.service');
var sheetImport = require('../services/expenseSheetImport.service');

// Officers' expense sheets (services/expenseSheets.service.js).

var receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: allowlistFilter(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'], 'A receipt must be a photo or a PDF.')
});
var workbookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: allowlistFilter(['xlsx'], 'Save the expense sheet as Microsoft Excel (.xlsx) before uploading.')
});

var router = express.Router();
router.use(requireAuth);
function h(fn) { return function (req, res, next) { Promise.resolve(fn(req, res)).then(function (out) { if (out !== undefined && !res.headersSent) res.json(out); }).catch(next); }; }

router.get('/', h(function (req) { return sheets.list(req.ctx); }));
router.get('/mine', h(function (req) { return sheets.mine(req.ctx); }));
router.get('/lists', h(function (req) { return sheets.getLists(req.ctx); }));
router.post('/lists', h(function (req) { return sheets.saveListItem(req.ctx, req.body || {}); }));
router.get('/report', h(function (req) { return sheets.report(req.ctx, req.query.year); }));
router.get('/topups', h(function (req) { return sheets.pendingTopups(req.ctx); }));
router.get('/export.csv', h(async function (req, res) {
  var csv = await sheets.exportCsv(req.ctx, req.query || {});
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="expense-sheets' + (req.query.year ? '-' + Number(req.query.year) : '') + '.csv"');
  res.send('﻿' + csv);
}));
router.post('/', h(function (req) { return sheets.create(req.ctx, req.body || {}); }));
// Someone with no sheet records what they paid from their own pocket.
router.post('/start', h(function (req) { return sheets.startOwn(req.ctx, req.body || {}); }));
router.get('/:id', h(function (req) { return sheets.get(req.ctx, req.params.id, req.query.year); }));
router.patch('/:id', h(function (req) { return sheets.update(req.ctx, req.params.id, req.body || {}); }));
router.post('/:id/lines', h(function (req) { return sheets.addLine(req.ctx, req.params.id, req.body || {}); }));
router.post('/:id/checks', h(function (req) { return sheets.check(req.ctx, req.params.id, req.body || {}); }));
router.post('/:id/topups', h(function (req) { return sheets.requestTopup(req.ctx, req.params.id, req.body || {}); }));
router.post('/:id/payback', h(function (req) { return sheets.payBack(req.ctx, req.params.id, req.body || {}); }));
router.post('/:id/import/preview', workbookUpload.single('file'), h(function (req) { return sheetImport.preview(req.ctx, req.params.id, req.file); }));
router.post('/:id/import', workbookUpload.single('file'), h(function (req) { return sheetImport.run(req.ctx, req.params.id, req.file, req.body && req.body.remove); }));
router.patch('/lines/:lineId', h(function (req) { return sheets.updateLine(req.ctx, req.params.lineId, req.body || {}); }));
router.delete('/lines/:lineId', h(function (req) { return sheets.removeLine(req.ctx, req.params.lineId); }));
router.post('/lines/:lineId/receipt', receiptUpload.single('file'), h(function (req) { return sheets.attachReceipt(req.ctx, req.params.lineId, req.file); }));
router.get('/lines/:lineId/receipt', h(async function (req, res) { var f = await sheets.receiptFile(req.ctx, req.params.lineId); await fileStore.send(res, f.key, f.name, req.query.inline === '1'); }));
router.delete('/checks/:checkId', h(function (req) { return sheets.undoCheck(req.ctx, req.params.checkId); }));
router.post('/topups/:topupId/decide', h(function (req) { return sheets.decideTopup(req.ctx, req.params.topupId, req.body || {}); }));
router.post('/topups/:topupId/cancel', h(function (req) { return sheets.cancelTopup(req.ctx, req.params.topupId); }));
// From the Approval centre: { decision: 'approved' | 'rejected', note }.
router.post('/topups/:topupId/decision', h(function (req) { return sheets.decideFromApprovals(req.ctx, req.params.topupId, req.body || {}); }));

module.exports = router;
