var express = require('express');
var { requireAuth } = require('../middleware/auth');
var visits = require('../services/bplVisits.service');
var fileStore = require('../lib/fileStore');

// Bamboo Products' deliveries, fitting and repairs (bplVisits.service,
// migration 0195): the week's visits and what waits for one, a visit planned
// and moved on by its crew, the repair requests, and the settings.
var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await visits.board(req.ctx, req.query)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.json(await visits.save(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/settings', async function (req, res, next) {
  try { res.json(await visits.saveSettings(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/services/:id', async function (req, res, next) {
  try { res.json(await visits.serviceUpdate(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.get('/services/:id/photos/:n', async function (req, res, next) {
  try { var f = await visits.servicePhotoKey(req.ctx, req.params.id, req.params.n); await fileStore.send(res, f.key, f.name, true); } catch (e) { next(e); }
});
router.get('/:id/photos/:n', async function (req, res, next) {
  try { var f = await visits.photoKey(req.ctx, req.params.id, req.params.n); await fileStore.send(res, f.key, f.name, true); } catch (e) { next(e); }
});
router.post('/:id/:action', async function (req, res, next) {
  try { res.json(await visits.act(req.ctx, req.params.id, req.params.action, req.body)); } catch (e) { next(e); }
});

module.exports = router;
