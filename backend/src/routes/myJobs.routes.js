var express = require('express');
var fileStore = require('../lib/fileStore');
var access = require('../services/myJobsAccess.service');
var mwo = require('../services/maintenanceWorkOrders.service');

// My Jobs signed in with a kiosk code (myJobsAccess.service.js) — mounted at
// /api/myjobs in app.js, beside the kiosk, outside requireAuth: its own
// sign-in (Authorization: Bearer <My Jobs token>), reaching only the
// person's own jobs through the maintenance service, with no permissions.

var router = express.Router();

function bearer(req) {
  var h = String(req.headers.authorization || '');
  return h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : '';
}
function open(fn) {
  return async function (req, res, next) {
    try { res.json(await fn(req)); } catch (e) { next(e); }
  };
}
function signedIn(fn) {
  return async function (req, res, next) {
    try { var ctx = await access.contextOf(bearer(req)); res.json(await fn(ctx, req)); } catch (e) { next(e); }
  };
}
function photo(find) {
  return async function (req, res, next) {
    try { var ctx = await access.contextOf(bearer(req)); var f = await find(ctx, req); await fileStore.send(res, f.key, f.name, req.query.inline === '1'); } catch (e) { next(e); }
  };
}

// Signing in: the team code (once per phone), then the kiosk code.
router.post('/team', open(function (req) { return access.checkTeam((req.body || {}).team, req.ip); }));
router.post('/sign-in', open(function (req) { return access.signIn((req.body || {}).team, (req.body || {}).pin, req.ip, req.get('user-agent')); }));
router.post('/sign-out', open(function (req) { return access.signOut(bearer(req)); }));

// The person's own jobs and routines.
router.get('/mine', signedIn(function (ctx) { return mwo.mine(ctx); }));
router.get('/jobs/:id', signedIn(function (ctx, req) { return mwo.get(ctx, req.params.id); }));
router.post('/jobs/:id/status', signedIn(function (ctx, req) { return mwo.setStatus(ctx, req.params.id, req.body); }));
router.post('/routines/:id/done', signedIn(function (ctx, req) { return mwo.routineDone(ctx, req.params.id, req.body); }));
router.get('/jobs/:id/photos/:n', photo(function (ctx, req) { return mwo.photoOf(ctx, req.params.id, req.params.n); }));
router.get('/routines/log/:id/photos/:n', photo(function (ctx, req) { return mwo.routinePhotoOf(ctx, req.params.id, req.params.n); }));

module.exports = router;
