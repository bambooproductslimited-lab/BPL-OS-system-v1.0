var express = require('express');
var { requireAuth } = require('../middleware/auth');
var companiesService = require('../services/companies.service');

var router = express.Router();
router.use(requireAuth);

// GET /api/companies — companies with their departments nested.
router.get('/', async function (req, res, next) {
  try { res.json(await companiesService.list(req.ctx)); } catch (e) { next(e); }
});

router.post('/', async function (req, res, next) {
  try { res.status(201).json(await companiesService.save(req.ctx, null, req.body)); } catch (e) { next(e); }
});

router.put('/:id', async function (req, res, next) {
  try { res.json(await companiesService.save(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

router.delete('/:id', async function (req, res, next) {
  try { res.json(await companiesService.remove(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
