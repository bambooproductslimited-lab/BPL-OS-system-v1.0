var express = require('express');
var { requireAuth } = require('../middleware/auth');
var vehicles = require('../services/vehicles.service');
var fileStore = require('../lib/fileStore');

// Vehicles and fuel (vehicles.service.js, migration 0197).
var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await vehicles.list(req.ctx, req.query)); } catch (e) { next(e); }
});
router.post('/', async function (req, res, next) {
  try { res.json(await vehicles.save(req.ctx, req.body)); } catch (e) { next(e); }
});
router.get('/fuel/:id/photo', async function (req, res, next) {
  try { var f = await vehicles.photoKey(req.ctx, req.params.id); await fileStore.send(res, f.key, f.name, true); } catch (e) { next(e); }
});
router.delete('/fuel/:id', async function (req, res, next) {
  try { res.json(await vehicles.removeFuel(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.get('/:id', async function (req, res, next) {
  try { res.json(await vehicles.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});
router.post('/:id/fuel', async function (req, res, next) {
  try { res.json(await vehicles.logFuel(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/:id/serviced', async function (req, res, next) {
  try { res.json(await vehicles.serviced(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

module.exports = router;
