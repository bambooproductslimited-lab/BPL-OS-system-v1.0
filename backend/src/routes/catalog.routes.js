var express = require('express');
var multer = require('multer');
var { requireAuth } = require('../middleware/auth');
var { allowlistFilter } = require('../lib/uploadFilters');
var fileStore = require('../lib/fileStore');
var catalogService = require('../services/catalog.service');

var photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
  fileFilter: allowlistFilter(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'], 'That isn’t a photo.')
});

var router = express.Router();
router.use(requireAuth);

// Flat picker list — Quotations/Estimates/Invoices/Waybills "from
// catalogue" dropdowns; unchanged shape from before the Item/Variation
// redesign so those screens needed no changes.
router.get('/', async function (req, res, next) {
  try { res.json(await catalogService.list(req.ctx)); } catch (e) { next(e); }
});

// Nested Item -> Variations view, for the Products & Services screen itself.
router.get('/items', async function (req, res, next) {
  try { res.json(await catalogService.listItems(req.ctx)); } catch (e) { next(e); }
});
router.post('/items', async function (req, res, next) {
  try { res.status(201).json(await catalogService.create(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/items/:id', async function (req, res, next) {
  try { res.json(await catalogService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/items/:id/active', async function (req, res, next) {
  try { res.json(await catalogService.setActive(req.ctx, req.params.id, req.body.active)); } catch (e) { next(e); }
});
router.delete('/items/:id', async function (req, res, next) {
  try { res.json(await catalogService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/items/:id/variations', async function (req, res, next) {
  try { res.status(201).json(await catalogService.addVariation(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

router.put('/variations/:id', async function (req, res, next) {
  try { res.json(await catalogService.updateVariation(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/variations/:id/active', async function (req, res, next) {
  try { res.json(await catalogService.setVariationActive(req.ctx, req.params.id, req.body.active)); } catch (e) { next(e); }
});
router.post('/variations/:id/stock', async function (req, res, next) {
  try { res.json(await catalogService.adjustStock(req.ctx, req.params.id, req.body.delta, req.body.note)); } catch (e) { next(e); }
});
router.delete('/variations/:id', async function (req, res, next) {
  try { res.json(await catalogService.removeVariation(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// Photos of an item: add (multipart "photos", optional variationId), show
// one, tag it to a variation or caption it, make it the cover, remove it.
router.post('/items/:id/photos', photoUpload.array('photos', 12), async function (req, res, next) {
  try { res.status(201).json(await catalogService.addPhotos(req.ctx, req.params.id, req.files, req.body && req.body.variationId)); } catch (e) { next(e); }
});
router.get('/photos/:id', async function (req, res, next) {
  try { await fileStore.send(res, await catalogService.photoFor(req.ctx, req.params.id), 'photo.jpg', true); } catch (e) { next(e); }
});
router.put('/photos/:id', async function (req, res, next) {
  try { res.json(await catalogService.updatePhoto(req.ctx, req.params.id, req.body || {})); } catch (e) { next(e); }
});
router.post('/photos/:id/cover', async function (req, res, next) {
  try { res.json(await catalogService.makeCover(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.delete('/photos/:id', async function (req, res, next) {
  try { res.json(await catalogService.removePhoto(req.ctx, req.params.id)); } catch (e) { next(e); }
});

router.get('/categories', async function (req, res, next) {
  try { res.json(await catalogService.listCategories(req.ctx)); } catch (e) { next(e); }
});
router.post('/categories', async function (req, res, next) {
  try { res.status(201).json(await catalogService.createCategory(req.ctx, req.body.name)); } catch (e) { next(e); }
});

module.exports = router;
