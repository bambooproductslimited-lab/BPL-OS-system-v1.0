var express = require('express');
var { requireAuth } = require('../middleware/auth');
var tiktokOAuthService = require('../services/tiktokOAuth.service');
var metaOAuthService = require('../services/metaOAuth.service');
var config = require('../config');

// OAuth redirect endpoints, mounted at /api/marketing/oauth in app.js (a
// separate mount from marketing.routes.js's /api/marketing, which applies
// requireAuth to its whole router) — each callback below is hit by the
// browser navigating here directly from the platform (not our own frontend
// calling the API with a Bearer token), so it can't sit behind requireAuth.
// Each path must match the Redirect URI saved in that platform's app
// dashboard exactly:
//   TikTok: https://bamboo-os-backend.onrender.com/api/marketing/oauth/tiktok/callback
//   Meta:   https://bamboo-os-backend.onrender.com/api/marketing/oauth/meta/callback

var router = express.Router();

router.post('/tiktok/start', requireAuth, async function (req, res, next) {
  try { res.json(await tiktokOAuthService.startAuth(req.ctx)); } catch (e) { next(e); }
});

router.get('/tiktok/callback', async function (req, res) {
  var target = config.corsOrigin[0] || 'https://blueviolet-ant-812811.hostingersite.com';
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    await tiktokOAuthService.handleCallback(req.query.code, req.query.state);
    res.redirect(target + '/socialtracker?tiktok=connected');
  } catch (e) {
    res.redirect(target + '/socialtracker?tiktok=error&message=' + encodeURIComponent(e.message || 'Connection failed.'));
  }
});

router.post('/meta/start', requireAuth, async function (req, res, next) {
  try { res.json(await metaOAuthService.startAuth(req.ctx)); } catch (e) { next(e); }
});

// Meta's callback can't finish the connection by itself (the user may
// admin more than one Facebook Page) — it hands off to the frontend's
// "choose a Page" step via a pending token instead of connecting outright.
router.get('/meta/callback', async function (req, res) {
  var target = config.corsOrigin[0] || 'https://blueviolet-ant-812811.hostingersite.com';
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    var result = await metaOAuthService.handleCallback(req.query.code, req.query.state);
    res.redirect(target + '/socialtracker?meta=choose-page&pending=' + encodeURIComponent(result.pendingToken));
  } catch (e) {
    res.redirect(target + '/socialtracker?meta=error&message=' + encodeURIComponent(e.message || 'Connection failed.'));
  }
});

module.exports = router;
