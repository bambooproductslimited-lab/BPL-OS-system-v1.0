var express = require('express');
var { requireAuth } = require('../middleware/auth');
var rolesService = require('../services/roles.service');

var router = express.Router();

// kernel.js: handlers['roles.permissionCatalogue'] -> GET /api/roles/permissions
// The one kernel method exempt from auth (api.call()'s needsAuth check
// explicitly excludes it) — a static catalogue of permission definitions,
// not per-user data, so no requireAuth here.
router.get('/permissions', async function (req, res, next) {
  try { res.json(await rolesService.permissionCatalogue()); } catch (e) { next(e); }
});

// kernel.js: handlers['roles.list'] -> GET /api/roles
router.get('/', requireAuth, async function (req, res, next) {
  try { res.json(await rolesService.list(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['roles.setPermission'] -> POST /api/roles/:roleId/permissions
router.post('/:roleId/permissions', requireAuth, async function (req, res, next) {
  try { res.json(await rolesService.setPermission(req.ctx, req.params.roleId, req.body.permission, !!req.body.on)); } catch (e) { next(e); }
});

module.exports = router;
