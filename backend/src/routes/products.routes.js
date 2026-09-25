var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var productsService = require('../services/products.service');
var productImportService = require('../services/productImport.service');
var googleDriveService = require('../services/googleDrive.service');
var { allowlistFilter } = require('../lib/uploadFilters');
var fileStore = require('../lib/fileStore');

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

var photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: allowlistFilter(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'], 'That isn’t a photo.')
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
    res.json(await productImportService.commitWorkbook(req.ctx, req.file ? req.file.buffer : null, req.file ? req.file.originalname : '', req.body.month, req.body.mappings));
  } catch (e) { next(e); }
});
// Import from Google Drive — see googleDrive.service.js.
router.get('/import/drive', async function (req, res, next) {
  try { res.json(await googleDriveService.list(req.ctx, { all: req.query.all === '1' })); } catch (e) { next(e); }
});
router.post('/import/drive/:fileId/preview', async function (req, res, next) {
  try { res.json(await googleDriveService.preview(req.ctx, req.params.fileId, (req.body || {}).month)); } catch (e) { next(e); }
});
router.post('/import/drive/:fileId/commit', async function (req, res, next) {
  try { res.json(await googleDriveService.commit(req.ctx, req.params.fileId, (req.body || {}).month, (req.body || {}).mappings)); } catch (e) { next(e); }
});
router.post('/import/commit', async function (req, res, next) {
  try { res.json(await productImportService.commit(req.ctx, req.body.lines, req.body.countDate, req.body.source)); } catch (e) { next(e); }
});
router.put('/:id', async function (req, res, next) {
  try { res.json(await productsService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

// POST /api/products/:id/stock { mode: count|received|breakage|sold, qty, reason }
// — recorded on today's line of the daily stock sheet
router.post('/:id/stock', async function (req, res, next) {
  try { res.json(await productsService.adjustStock(req.ctx, req.params.id, req.body || {})); } catch (e) { next(e); }
});
// GET /api/products/:id/history — the last 60 days on the stock sheet and production
router.get('/:id/history', async function (req, res, next) {
  try { res.json(await productsService.history(req.ctx, req.params.id)); } catch (e) { next(e); }
});
// POST /api/products/:id/archive { archived: true|false }
router.post('/:id/archive', async function (req, res, next) {
  try { res.json(await productsService.setActive(req.ctx, req.params.id, !(req.body && req.body.archived))); } catch (e) { next(e); }
});
// The product's photo (GET), change it (POST multipart "photo"), remove it (DELETE)
router.get('/:id/photo', async function (req, res, next) {
  try { await fileStore.send(res, await productsService.photoFor(req.ctx, req.params.id), 'product.jpg', true); } catch (e) { next(e); }
});
router.post('/:id/photo', photoUpload.single('photo'), async function (req, res, next) {
  try { res.json(await productsService.setPhoto(req.ctx, req.params.id, req.file || undefined)); } catch (e) { next(e); }
});
router.delete('/:id/photo', async function (req, res, next) {
  try { res.json(await productsService.setPhoto(req.ctx, req.params.id, null)); } catch (e) { next(e); }
});

module.exports = router;
