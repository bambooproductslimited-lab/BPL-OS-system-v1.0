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

// Turns off someone's two-step sign-in when they've lost their phone and
// backup codes (user.create, like a password reset).
router.post('/:id/two-step/reset', async function (req, res, next) {
  try { res.json(await require('../services/twoStep.service').adminReset(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['users.setPassword'] -> POST /api/users/:id/password
router.post('/:id/password', async function (req, res, next) {
  try { res.json(await usersService.setPassword(req.ctx, req.params.id, req.body.password)); } catch (e) { next(e); }
});

// New capability -> POST /api/users/:id/email: corrects an account's login
// email after creation (see users.service.js's setEmail for why this
// can't be done by editing the employee record instead). Gated on
// user.create, same as setPassword just below.
router.post('/:id/email', async function (req, res, next) {
  try { res.json(await usersService.setEmail(req.ctx, req.params.id, req.body.email)); } catch (e) { next(e); }
});

// kernel.js: handlers['users.setRole'] -> POST /api/users/:id/role
router.post('/:id/role', async function (req, res, next) {
  try { res.json(await usersService.setRole(req.ctx, req.params.id, req.body.roleId)); } catch (e) { next(e); }
});

// Several roles at once (replaces the account's roles).
router.post('/:id/roles', async function (req, res, next) {
  try { res.json(await usersService.setRoles(req.ctx, req.params.id, req.body.roleIds)); } catch (e) { next(e); }
});
// Clears a lock-out after too many wrong passwords.
router.post('/:id/unlock', async function (req, res, next) {
  try { res.json(await usersService.unlock(req.ctx, req.params.id)); } catch (e) { next(e); }
});
// Sign-ins and changes to this account, from the audit log.
router.get('/:id/activity', async function (req, res, next) {
  try { res.json(await usersService.activity(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['users.setStatus'] -> POST /api/users/:id/status
router.post('/:id/status', async function (req, res, next) {
  try { res.json(await usersService.setStatus(req.ctx, req.params.id, req.body.status)); } catch (e) { next(e); }
});

module.exports = router;
