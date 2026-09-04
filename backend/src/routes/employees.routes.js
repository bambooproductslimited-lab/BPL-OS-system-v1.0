var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var employeesService = require('../services/employees.service');
var employeeDocumentsService = require('../services/employeeDocuments.service');
var employeeImportService = require('../services/employeeImport.service');
var kioskService = require('../services/kiosk.service');
var { fail } = require('../utils/errors');
var { allowlistFilter } = require('../lib/uploadFilters');

var ID_DOC_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic'];
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: allowlistFilter(ID_DOC_EXTENSIONS, 'That file type isn’t supported for ID documents.')
});

var uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: allowlistFilter(['csv'], 'Export the sheet as CSV before uploading.')
});

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['employees.list'] -> GET /api/employees?q=&departmentId=&includeTerminated=
router.get('/', async function (req, res, next) {
  try {
    res.json(await employeesService.list(req.ctx, {
      q: req.query.q, departmentId: req.query.departmentId, includeTerminated: req.query.includeTerminated === 'true'
    }));
  } catch (e) { next(e); }
});

// kernel.js: handlers['employees.create'] -> POST /api/employees
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await employeesService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['employees.purgeTerminated'] -> POST /api/employees/purge-terminated
router.post('/purge-terminated', async function (req, res, next) {
  try { res.json(await employeesService.purgeTerminated(req.ctx)); } catch (e) { next(e); }
});

router.post('/import/preview', uploadCsv.single('file'), async function (req, res, next) {
  try {
    if (!req.file) fail('invalid', 'No file uploaded.');
    res.json(await employeeImportService.preview(req.ctx, req.file.buffer));
  } catch (e) { next(e); }
});

router.post('/import/commit', async function (req, res, next) {
  try { res.json(await employeeImportService.commit(req.ctx, req.body.rows)); } catch (e) { next(e); }
});

// kernel.js: handlers['employees.get'] -> GET /api/employees/:id
router.get('/:id', async function (req, res, next) {
  try { res.json(await employeesService.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['employees.profile'] -> GET /api/employees/:id/profile
router.get('/:id/profile', async function (req, res, next) {
  try { res.json(await employeesService.profile(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['employees.update'] -> PATCH /api/employees/:id
router.patch('/:id', async function (req, res, next) {
  try { res.json(await employeesService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['employees.terminate'] -> POST /api/employees/:id/terminate
router.post('/:id/terminate', async function (req, res, next) {
  try { res.json(await employeesService.terminate(req.ctx, req.params.id, req.body.reason)); } catch (e) { next(e); }
});

// ID/passport document slots (front of ID, back of ID, passport) -> GET/POST/GET download
router.get('/:id/id-documents', async function (req, res, next) {
  try { res.json(await employeeDocumentsService.list(req.ctx, req.params.id)); } catch (e) { next(e); }
});

router.post('/:id/id-documents/:kind', upload.single('file'), async function (req, res, next) {
  try { res.status(201).json(await employeeDocumentsService.upload(req.ctx, req.params.id, req.params.kind, req.file)); } catch (e) { next(e); }
});

router.get('/:id/id-documents/:kind/download', async function (req, res, next) {
  try { res.json(await employeeDocumentsService.getDownloadUrl(req.ctx, req.params.id, req.params.kind)); } catch (e) { next(e); }
});

// Kiosk PIN — admin-set/reset only (see kiosk.service.js's module comment
// for why there's no employee self-service path for this one).
router.get('/:id/kiosk-pin', async function (req, res, next) {
  try { res.json(await kioskService.getPin(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/kiosk-pin', async function (req, res, next) {
  try { res.json(await kioskService.setPin(req.ctx, req.params.id, req.body.pin)); } catch (e) { next(e); }
});
router.delete('/:id/kiosk-pin', async function (req, res, next) {
  try { res.json(await kioskService.clearPin(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// Kiosk face match — same admin-only gate as the PIN above.
router.get('/:id/kiosk-face', async function (req, res, next) {
  try { res.json(await kioskService.getFaceStatus(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/kiosk-face', async function (req, res, next) {
  try { res.json(await kioskService.enrollFace(req.ctx, req.params.id, req.body.descriptor)); } catch (e) { next(e); }
});
router.delete('/:id/kiosk-face', async function (req, res, next) {
  try { res.json(await kioskService.clearFace(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
