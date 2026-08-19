var express = require('express');
var { requireAuth } = require('../middleware/auth');
var usersService = require('../services/users.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['users.list'] -> GET /api/users
router.get('/', async function (req, res, next) {
  try { res.json(await usersService.list(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['users.availableEmployees'] -> GET /api/users/available-employees
router.get('/available-employees', async function (req, res, next) {
  try { res.json(await usersService.availableEmployees(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['users.create'] -> POST /api/users
router.post('/', async function (req, res, next) {
  try { res.json(await usersService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['users.setPassword'] -> POST /api/users/:id/password
router.post('/:id/password', async function (req, res, next) {
  try { res.json(await usersService.setPassword(req.ctx, req.params.id, req.body.password)); } catch (e) { next(e); }
});

// kernel.js: handlers['users.setRole'] -> POST /api/users/:id/role
router.post('/:id/role', async function (req, res, next) {
  try { res.json(await usersService.setRole(req.ctx, req.params.id, req.body.roleId)); } catch (e) { next(e); }
});

// kernel.js: handlers['users.setStatus'] -> POST /api/users/:id/status
router.post('/:id/status', async function (req, res, next) {
  try { res.json(await usersService.setStatus(req.ctx, req.params.id, req.body.status)); } catch (e) { next(e); }
});

module.exports = router;
