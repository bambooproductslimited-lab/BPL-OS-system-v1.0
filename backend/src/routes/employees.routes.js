var express = require('express');
var { requireAuth } = require('../middleware/auth');
var employeesService = require('../services/employees.service');

var router = express.Router();
router.use(requireAuth);

// kernel.js: handlers['employees.list'] -> GET /api/employees?q=&departmentId=&includeTerminated=
router.get('/', async function (req, res, next) {
  try {
    res.json(await employeesService.list(req.ctx, {
      q: req.query.q, departmentId: req.query.departmentId, includeTerminated: req.query.includeTerminated === 'true'
    }));
  } catch (e) { next(e); }
});

// kernel.js: handlers['employees.create'] -> POST /api/employees
router.post('/', async function (req, res, next) {
  try { res.status(201).json(await employeesService.create(req.ctx, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['employees.purgeTerminated'] -> POST /api/employees/purge-terminated
router.post('/purge-terminated', async function (req, res, next) {
  try { res.json(await employeesService.purgeTerminated(req.ctx)); } catch (e) { next(e); }
});

// kernel.js: handlers['employees.get'] -> GET /api/employees/:id
router.get('/:id', async function (req, res, next) {
  try { res.json(await employeesService.get(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['employees.profile'] -> GET /api/employees/:id/profile
router.get('/:id/profile', async function (req, res, next) {
  try { res.json(await employeesService.profile(req.ctx, req.params.id)); } catch (e) { next(e); }
});

// kernel.js: handlers['employees.update'] -> PATCH /api/employees/:id
router.patch('/:id', async function (req, res, next) {
  try { res.json(await employeesService.update(req.ctx, req.params.id, req.body)); } catch (e) { next(e); }
});

// kernel.js: handlers['employees.terminate'] -> POST /api/employees/:id/terminate
router.post('/:id/terminate', async function (req, res, next) {
  try { res.json(await employeesService.terminate(req.ctx, req.params.id, req.body.reason)); } catch (e) { next(e); }
});

module.exports = router;
