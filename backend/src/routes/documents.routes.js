var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var documentsService = require('../services/documents.service');
var { allowlistFilter } = require('../lib/uploadFilters');

var DOC_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'jpg', 'jpeg', 'png', 'webp'];
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: allowlistFilter(DOC_EXTENSIONS, 'That file type isn’t supported for documents.')
});

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['documents.list'] -> GET /api/documents
router.get('/', async function (req, res, next) {
  try { res.json(await documentsService.list(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['documents.upload'] -> POST /api/documents (multipart/form-data)
router.post('/', upload.single('file'), async function (req, res, next) {
  try {
    var body = Object.assign({}, req.body, { file: req.file });
    res.status(201).json(await documentsService.upload(req.ctx, body));
  } catch (e) { next(e); }
});

// New: GET /api/documents/:id/download -> { url: <short-lived signed URL> }
router.get('/:id/download', async function (req, res, next) {
  try { res.json(await documentsService.getDownloadUrl(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['documents.delete'] -> DELETE /api/documents/:id
router.delete('/:id', async function (req, res, next) {
  try { res.json(await documentsService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
