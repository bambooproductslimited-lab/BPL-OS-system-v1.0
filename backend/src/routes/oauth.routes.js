var express = require('express');
var { requireAuth } = require('../middleware/auth');
var tiktokOAuthService = require('../services/tiktokOAuth.service');
var metaOAuthService = require('../services/metaOAuth.service');
var youtubeOAuthService = require('../services/youtubeOAuth.service');
var twitchOAuthService = require('../services/twitchOAuth.service');
var config = require('../config');
var { pool } = require('../db/pool');

// OAuth redirect endpoints, mounted at /api/marketing/oauth in app.js (a
// separate mount from marketing.routes.js's /api/marketing, which applies
// requireAuth to its whole router) — each callback below is hit by the
// browser navigating here directly from the platform (not our own frontend
// calling the API with a Bearer token), so it can't sit behind requireAuth.
// Each path must match the Redirect URI saved in that platform's app
// dashboard exactly:
//   TikTok:  https://bamboo-os-backend.onrender.com/api/marketing/oauth/tiktok/callback
//   Meta:    https://bamboo-os-backend.onrender.com/api/marketing/oauth/meta/callback
//   YouTube: https://bamboo-os-backend.onrender.com/api/marketing/oauth/youtube/callback
//   Twitch:  https://bamboo-os-backend.onrender.com/api/marketing/oauth/twitch/callback

var router = express.Router();

// Back to the OS address the person started from (one of CORS_ORIGIN's),
// kept with the sign-in's one-time state — not simply the first address on
// the list, which may be an old one they are not signed in on.
function originOf(req) {
  var o = String(req.get('origin') || '').replace(/\/+$/, '');
  return o && config.corsOrigin.some(function (x) { return x.replace(/\/+$/, '') === o; }) ? o : null;
}
async function remember(req, out) {
  var o = originOf(req);
  var m = /[?&]state=([^&]+)/.exec((out && out.url) || '');
  if (o && m) await pool.query('UPDATE marketing_oauth_states SET return_to = $1 WHERE state = $2', [o, decodeURIComponent(m[1])]);
  return out;
}
// Read before the service uses up the state.
async function targetFor(state) {
  var r = null;
  try { r = state ? (await pool.query('SELECT return_to FROM marketing_oauth_states WHERE state = $1', [String(state)])).rows[0] : null; } catch (e) { r = null; }
  return (r && r.return_to) || config.appUrl || config.corsOrigin[0] || 'https://blueviolet-ant-812811.hostingersite.com';
}

// Back to the tracker, on the company whose account was just connected.
function back(target, companyCode, query) {
  var q = new URLSearchParams(query);
  if (companyCode && companyCode !== 'BPL') q.set('company', companyCode);
  return target + '/socialtracker?' + q.toString();
}

router.post('/tiktok/start', requireAuth, async function (req, res, next) {
  try { res.json(await remember(req, await tiktokOAuthService.startAuth(req.ctx, (req.body || {}).channel))); } catch (e) { next(e); }
});

router.get('/tiktok/callback', async function (req, res) {
  var target = await targetFor(req.query.state);
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    var done = await tiktokOAuthService.handleCallback(req.query.code, req.query.state);
    res.redirect(back(target, done.companyCode, { tiktok: 'connected' }));
  } catch (e) {
    res.redirect(target + '/socialtracker?tiktok=error&message=' + encodeURIComponent(e.message || 'Connection failed.'));
  }
});

router.post('/meta/start', requireAuth, async function (req, res, next) {
  try { res.json(await remember(req, await metaOAuthService.startAuth(req.ctx, (req.body || {}).company))); } catch (e) { next(e); }
});

// Meta's callback can't finish the connection by itself (the user may
// admin more than one Facebook Page) — it hands off to the frontend's
// "choose a Page" step via a pending token instead of connecting outright.
router.get('/meta/callback', async function (req, res) {
  var target = await targetFor(req.query.state);
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    var result = await metaOAuthService.handleCallback(req.query.code, req.query.state);
    res.redirect(back(target, result.companyCode, { meta: 'choose-page', pending: result.pendingToken }));
  } catch (e) {
    res.redirect(target + '/socialtracker?meta=error&message=' + encodeURIComponent(e.message || 'Connection failed.'));
  }
});

router.post('/youtube/start', requireAuth, async function (req, res, next) {
  try { res.json(await remember(req, await youtubeOAuthService.startAuth(req.ctx, (req.body || {}).channel))); } catch (e) { next(e); }
});

router.get('/youtube/callback', async function (req, res) {
  var target = await targetFor(req.query.state);
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    var done = await youtubeOAuthService.handleCallback(req.query.code, req.query.state);
    res.redirect(back(target, done.companyCode, { youtube: 'connected' }));
  } catch (e) {
    res.redirect(target + '/socialtracker?youtube=error&message=' + encodeURIComponent(e.message || 'Connection failed.'));
  }
});

router.post('/twitch/start', requireAuth, async function (req, res, next) {
  try { res.json(await remember(req, await twitchOAuthService.startAuth(req.ctx))); } catch (e) { next(e); }
});

router.get('/twitch/callback', async function (req, res) {
  var target = await targetFor(req.query.state);
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    await twitchOAuthService.handleCallback(req.query.code, req.query.state);
    res.redirect(target + '/socialtracker?twitch=connected');
  } catch (e) {
    res.redirect(target + '/socialtracker?twitch=error&message=' + encodeURIComponent(e.message || 'Connection failed.'));
  }
});

module.exports = router;
