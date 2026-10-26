var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var bills = require('../services/bills.service');
var fileStore = require('../lib/fileStore');
var { allowlistFilter } = require('../lib/uploadFilters');

// Bills to pay (bills.service.js, migration 0196).
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 4 },
  fileFilter: allowlistFilter(['jpg', 'jpeg', 'png', 'webp', 'pdf'], 'Add a photo or a PDF of the bill.')
});

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await bills.list(req.ctx, req.query)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.status(req.body && req.body.id ? 200 : 201).json(await bills.save(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/settings', async function (req, res, next) {
  try { res.json(await bills.saveSettings(req.ctx, req.body)); } catch (e) { next(e); }
});
router.get('/payments/:id/photo', async function (req, res, next) {
  try { var f = await bills.paymentPhotoKey(req.ctx, req.params.id); await fileStore.send(res, f.key, f.name, true); } catch (e) { next(e); }
});
router.get('/:id', async function (req, res, next) {
  try { res.json(await bills.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/files', upload.array('files', 4), async function (req, res, next) {
  try { res.json(await bills.addFiles(req.ctx, req.params.id, req.files || [])); } catch (e) { next(e); }
});
router.get('/:id/files/:n', async function (req, res, next) {
  try { var f = await bills.fileKey(req.ctx, req.params.id, req.params.n); await fileStore.send(res, f.key, f.name, true); } catch (e) { next(e); }
});
router.post('/:id/approve', async function (req, res, next) {
  try { res.json(await bills.approve(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/pay', async function (req, res, next) {
  try { res.json(await bills.pay(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/:id/cancel', async function (req, res, next) {
  try { res.json(await bills.cancel(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
