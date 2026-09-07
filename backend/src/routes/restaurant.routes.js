var express = require('express');
var { requireAuth } = require('../middleware/auth');
var restaurantService = require('../services/restaurant.service');
var restaurantPosService = require('../services/restaurantPos.service');

var router = express.Router();
router.use(requireAuth);

router.get('/menu-items', async function (req, res, next) {
  try { res.json(await restaurantService.listMenuItems(req.ctx, req.query.companyId)); } catch (e) { next(e); }
});
router.post('/menu-items', async function (req, res, next) {
  try { res.status(201).json(await restaurantService.createMenuItem(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/menu-items/:id', async function (req, res, next) {
  try { res.json(await restaurantService.updateMenuItem(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/menu-items/:id/active', async function (req, res, next) {
  try { res.json(await restaurantService.setMenuItemActive(req.ctx, req.params.id, req.body.active)); } catch (e) { next(e); }
});
router.delete('/menu-items/:id', async function (req, res, next) {
  try { res.json(await restaurantService.removeMenuItem(req.ctx, req.params.id)); } catch (e) { next(e); }
});

router.get('/supplies', async function (req, res, next) {
  try { res.json(await restaurantService.listSupplies(req.ctx, req.query.companyId)); } catch (e) { next(e); }
});
router.post('/supplies', async function (req, res, next) {
  try { res.status(201).json(await restaurantService.createSupply(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/supplies/:id', async function (req, res, next) {
  try { res.json(await restaurantService.updateSupply(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/supplies/:id/stock', async function (req, res, next) {
  try { res.json(await restaurantService.adjustSupplyStock(req.ctx, req.params.id, req.body.delta, req.body.note)); } catch (e) { next(e); }
});
router.delete('/supplies/:id', async function (req, res, next) {
  try { res.json(await restaurantService.removeSupply(req.ctx, req.params.id)); } catch (e) { next(e); }
});

router.get('/ingredients', async function (req, res, next) {
  try { res.json(await restaurantService.listIngredients(req.ctx, req.query.companyId)); } catch (e) { next(e); }
});
router.post('/ingredients', async function (req, res, next) {
  try { res.status(201).json(await restaurantService.createIngredient(req.ctx, req.body)); } catch (e) { next(e); }
});
router.put('/ingredients/:id', async function (req, res, next) {
  try { res.json(await restaurantService.updateIngredient(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/ingredients/:id/stock', async function (req, res, next) {
  try { res.json(await restaurantService.adjustIngredientStock(req.ctx, req.params.id, req.body.delta, req.body.note)); } catch (e) { next(e); }
});
router.delete('/ingredients/:id', async function (req, res, next) {
  try { res.json(await restaurantService.removeIngredient(req.ctx, req.params.id)); } catch (e) { next(e); }
});

router.get('/orders', async function (req, res, next) {
  try { res.json(await restaurantPosService.listOrders(req.ctx, req.query.companyId)); } catch (e) { next(e); }
});
router.post('/orders/:id/void', async function (req, res, next) {
  try { res.json(await restaurantPosService.voidOrder(req.ctx, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
