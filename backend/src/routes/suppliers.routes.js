var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var suppliersService = require('../services/suppliers.service');
var supplierImportService = require('../services/supplierImport.service');
var { allowlistFilter } = require('../lib/uploadFilters');

var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: allowlistFilter(['csv'], 'Export the sheet as CSV before uploading.')
});

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await suppliersService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await suppliersService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
// Import from the sourcing team's farmer & supplier sheet — see
// supplierImport.service.js. Declared before /:id so "import" is never
// taken for a supplier id.
// The missing-file check lives in the service, after its permission check,
// not here: checked here first, a caller without supplier.manage got "No
// file uploaded" rather than "forbidden", which both tells them more than
// it should and hides the route from the authorization sweep.
router.post('/import/preview', upload.single('file'), async function (req, res, next) {
  try { res.json(await supplierImportService.preview(req.ctx, req.file ? req.file.buffer : null)); } catch (e) { next(e); }
});
router.post('/import/commit', async function (req, res, next) {
  try { res.json(await supplierImportService.commit(req.ctx, req.body.suppliers)); } catch (e) { next(e); }
});

// GET /api/suppliers/:id/deliveries — the raw bamboo batches they delivered
router.get('/:id/deliveries', async function (req, res, next) {
  try { res.json(await suppliersService.deliveries(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.put('/:id', async function (req, res, next) {
  try { res.json(await suppliersService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/:id', async function (req, res, next) {
  try { res.json(await suppliersService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
