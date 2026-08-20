var express = require('express');
var { requireAuth } = require('../middleware/auth');
var toolRoomService = require('../services/toolRoom.service');

var router = express.Router();
router.use(requireAuth);

router.get('/', async function (req, res, next) {
  try { res.json(await toolRoomService.list(req.ctx)); } catch (e) { next(e); }
});

router.post('/', async function (req, res, next) {
  try { res.status(201).json(await toolRoomService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

router.put('/:id', async function (req, res, next) {
  try { res.json(await toolRoomService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

router.post('/:id/checkout', async function (req, res, next) {
  try { res.json(await toolRoomService.setCheckout(req.ctx, req.params.id, req.body.employeeId)); } catch (e) { next(e); }
});

module.exports = router;
