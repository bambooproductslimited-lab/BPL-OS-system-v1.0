var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var itDevicesService = require('../services/itDevices.service');
var itDeviceImportService = require('../services/itDeviceImport.service');
var { fail } = require('../utils/errors');
var { allowlistFilter } = require('../lib/uploadFilters');

var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: allowlistFilter(['csv'], 'Export the sheet as CSV before uploading.')
});

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await itDevicesService.list(req.ctx)); } catch (e) { next(e); }
});

router.post('/', async function (req, res, next) {
  try { res.status(201).json(await itDevicesService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

router.put('/:id', async function (req, res, next) {
  try { res.json(await itDevicesService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

router.post('/import/preview', upload.single('file'), async function (req, res, next) {
  try {
    if (!req.file) fail('invalid', 'No file uploaded.');
    res.json(await itDeviceImportService.preview(req.ctx, req.file.buffer, { includeCredentials: req.body.includeCredentials === 'true' }));
  } catch (e) { next(e); }
});

router.post('/import/commit', async function (req, res, next) {
  try { res.json(await itDeviceImportService.commit(req.ctx, req.body.rows)); } catch (e) { next(e); }
});

module.exports = router;
