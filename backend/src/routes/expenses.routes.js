var express = require('express');
var { requireAuth } = require('../middleware/auth');
var multer = require('multer');
var { allowlistFilter } = require('../lib/uploadFilters');
var fileStore = require('../lib/fileStore');
var expensesService = require('../services/expenses.service');

// A receipt: a photo or a PDF, up to 10 MB.
var receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: allowlistFilter(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'], 'A receipt must be a photo or a PDF.')
});

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await expensesService.list(req.ctx)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await expensesService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.patch('/:id', async function (req, res, next) {
  try { res.json(await expensesService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/:id', async function (req, res, next) {
  try { res.json(await expensesService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/decision', async function (req, res, next) {
  try { res.json(await expensesService.decide(req.ctx, req.params.id, req.body.decision, req.body.note)); } catch (e) { next(e); }
});
router.post('/:id/mark-paid', async function (req, res, next) {
  try { res.json(await expensesService.markPaid(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/receipt', receiptUpload.single('file'), async function (req, res, next) {
  try { res.json(await expensesService.attachReceipt(req.ctx, req.params.id, req.file)); } catch (e) { next(e); }
});
router.get('/:id/receipt', async function (req, res, next) {
  try { var f = await expensesService.receiptFile(req.ctx, req.params.id); await fileStore.send(res, f.key, f.name, req.query.inline === '1'); } catch (e) { next(e); }
});

module.exports = router;
