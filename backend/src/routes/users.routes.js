var express = require('express');
var { requireAuth } = require('../middleware/auth');
var usersService = require('../services/users.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['users.list'] -> GET /api/users
router.get('/', async function (req, res, next) {
  try { res.json(await usersService.list(req.ctx)); } catch (e) { next(e); }
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
