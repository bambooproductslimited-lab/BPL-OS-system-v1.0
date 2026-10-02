var express = require('express');
var { requireAuth } = require('../middleware/auth');
var feeds = require('../services/attendanceFeeds.service');

// Attendance feeds (attendanceFeeds.service.js).
//   manage — /api/attendance-feeds, signed in with settings.manage
//            (the Integrations page);
//   read   — /api/feeds/attendance, the outside system with the feed's
//            read-only key (Authorization: Bearer bfk_…); nothing else.
function wrap(fn) { return function (req, res, next) { Promise.resolve(fn(req, res)).then(function (out) { res.json(out); }).catch(next); }; }

var manage = express.Router();
manage.use(requireAuth);
manage.get('/', wrap(function (req) { return feeds.list(req.ctx); }));
manage.post('/', wrap(function (req) { return feeds.create(req.ctx, req.body || {}); }));
manage.put('/:id', wrap(function (req) { return feeds.update(req.ctx, req.params.id, req.body || {}); }));
manage.delete('/:id', wrap(function (req) { return feeds.remove(req.ctx, req.params.id); }));
manage.post('/:id/secret', wrap(function (req) { return feeds.rotateSecret(req.ctx, req.params.id); }));
manage.post('/:id/read-key', wrap(function (req) { return feeds.rotateReadKey(req.ctx, req.params.id); }));
manage.delete('/:id/read-key', wrap(function (req) { return feeds.removeReadKey(req.ctx, req.params.id); }));
manage.post('/:id/test', wrap(function (req) { return feeds.sendTest(req.ctx, req.params.id); }));
manage.post('/:id/resend', wrap(function (req) { return feeds.resend(req.ctx, req.params.id, req.body || {}); }));
manage.get('/:id/deliveries', wrap(function (req) { return feeds.deliveries(req.ctx, req.params.id); }));

var read = express.Router();
read.use(function (req, res, next) { res.set('Cache-Control', 'no-store'); next(); });
read.get('/changes', wrap(function (req) { return feeds.changesFor(req.get('authorization'), req.query, req.get('origin')); }));
read.get('/records', wrap(function (req) { return feeds.recordsFor(req.get('authorization'), req.query, req.get('origin')); }));
read.get('/staff', wrap(function (req) { return feeds.staffFor(req.get('authorization'), req.get('origin')); }));
read.get('/days', wrap(function (req) { return feeds.daysFor(req.get('authorization'), req.query, req.get('origin')); }));

// Browsers: only a website some feed allows may read (its key still has to
// match that feed — feedForKey). Mounted before the app's own CORS rule.
async function browsers(req, res, next) {
  var origin = req.get('origin');
  if (!origin) return next();
  try {
    if ((await feeds.allowedOrigins()).has(origin)) {
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '600' });
    }
  } catch (e) { return next(e); }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

module.exports = { manage: manage, read: read, browsers: browsers };
