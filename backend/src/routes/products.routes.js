var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var productsService = require('../services/products.service');
var productImportService = require('../services/productImport.service');
var { allowlistFilter } = require('../lib/uploadFilters');

var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: allowlistFilter(['csv'], 'Download the count tab as CSV before uploading.')
});

// The whole month's workbook (.xlsx) — larger than one tab's CSV.
var workbookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: allowlistFilter(['xlsx'], 'Download the workbook as Microsoft Excel (.xlsx) before uploading.')
});

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await productsService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await productsService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
// Import a day's count from the Finish Inventory sheet — see
// productImport.service.js. The missing-file check is in the service, after
// its permission check (the same reasoning as suppliers.routes.js).
router.post('/import/preview', upload.single('file'), async function (req, res, next) {
  try {
    res.json(await productImportService.preview(req.ctx, req.file ? req.file.buffer : null, req.file ? req.file.originalname : ''));
  } catch (e) { next(e); }
});
router.post('/import/workbook/preview', workbookUpload.single('file'), async function (req, res, next) {
  try {
    res.json(await productImportService.previewWorkbook(req.ctx, req.file ? req.file.buffer : null, req.file ? req.file.originalname : '', req.body.month));
  } catch (e) { next(e); }
});
router.post('/import/workbook/commit', workbookUpload.single('file'), async function (req, res, next) {
  try {
    res.json(await productImportService.commitWorkbook(req.ctx, req.file ? req.file.buffer : null, req.file ? req.file.originalname : '', req.body.month));
  } catch (e) { next(e); }
});
router.post('/import/commit', async function (req, res, next) {
  try { res.json(await productImportService.commit(req.ctx, req.body.lines, req.body.countDate, req.body.source)); } catch (e) { next(e); }
});
router.put('/:id', async function (req, res, next) {
  try { res.json(await productsService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
