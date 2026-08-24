var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var config = require('../config');

// Real Twitch OAuth for the social tracker's "Connect with Twitch"
// button. Single-account flow like TikTok's — one Twitch account, one
// channel, no page-picker step. Twitch issues a real refresh_token, same
// pattern as youtubeOAuth.service.js.
//
// Every Helix API call needs a Client-Id header alongside the Bearer
// token — a Twitch-specific requirement not shared by the other
// platforms integrated here.
//
// clientId is not secret and is embedded directly in the authorize URL
// handed to the frontend; clientSecret never leaves this file — used only
// in the code/refresh-token exchanges below.

var AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
var TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
var API = 'https://api.twitch.tv/helix';
// moderator:read:followers is required for the follower-count endpoint —
// a broadcaster reading their own channel's followers satisfies it, no
// separate moderator role needed.
var SCOPES = 'moderator:read:followers';

function requireManage(ctx) {
  if (!ctx.can('marketing.manage')) fail('forbidden', 'Your role does not allow this action (marketing.manage).');
}

async function helixGet(path, accessToken) {
  var res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + accessToken, 'Client-Id': config.twitch.clientId } });
  var data = await res.json();
  if (!res.ok) fail('invalid', 'Twitch API error: ' + (data.message || res.status));
  return data;
}

// twitchOAuth.startAuth — issues a one-time state token and returns the
// URL to send the browser to.
async function startAuth(ctx) {
  requireManage(ctx);
  if (!config.twitch.configured) fail('invalid', 'Twitch is not configured on the server yet — set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET on Render.');
  var state = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO marketing_oauth_states (state, channel_key) VALUES ($1, $2)', [state, 'twitch']);
  var url = AUTHORIZE_URL + '?client_id=' + encodeURIComponent(config.twitch.clientId) +
    '&redirect_uri=' + encodeURIComponent(config.twitch.redirectUri) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent(SCOPES) +
    '&state=' + state;
  return { url: url };
}

// twitchOAuth.handleCallback — Twitch redirects the browser here with
// ?code&?state. No ctx — plain browser navigation, same reasoning as
// tiktokOAuth's handleCallback.
async function handleCallback(code, state) {
  if (!code || !state) fail('invalid', 'Missing code or state.');
  var stateRes = await pool.query('DELETE FROM marketing_oauth_states WHERE state = $1 AND channel_key = $2 RETURNING state', [state, 'twitch']);
  if (!stateRes.rows[0]) fail('invalid', 'This authorization link has expired or was already used — try connecting again.');

  var body = new URLSearchParams({
    code: code,
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    redirect_uri: config.twitch.redirectUri,
    grant_type: 'authorization_code'
  });
  var tokenRes = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  var tokenData = await tokenRes.json();
  if (!tokenRes.ok || tokenData.error) fail('invalid', 'Twitch token exchange failed: ' + (tokenData.message || tokenData.error || tokenRes.status));

  var userData = await helixGet('/users', tokenData.access_token);
  var user = userData.data && userData.data[0];
  if (!user) fail('invalid', 'Could not find a Twitch channel for this account.');

  var expiresAt = new Date(Date.now() + (tokenData.expires_in || 0) * 1000);
  await pool.query(
    'INSERT INTO marketing_oauth_tokens (channel_key, access_token, refresh_token, open_id, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6) ' +
    'ON CONFLICT (channel_key) DO UPDATE SET access_token = $2, refresh_token = $3, open_id = $4, scope = $5, expires_at = $6, updated_at = now()',
    ['twitch', tokenData.access_token, tokenData.refresh_token || '', user.id, (tokenData.scope || []).join(' '), expiresAt]
  );

  var settingsRes = await pool.query('SELECT integrations FROM settings WHERE id = 1');
  var list = settingsRes.rows[0].integrations || [];
  var idx = list.findIndex(function (x) { return x.id === 'twitch'; });
  if (idx >= 0) {
    list[idx].connected = true;
    list[idx].apiKey = 'Connected via Twitch login (' + user.display_name + ')';
    await pool.query('UPDATE settings SET integrations = $1, updated_at = now() WHERE id = 1', [JSON.stringify(list)]);
  }
  await audit(pool, null, 'marketing.twitch.connect', 'marketing_channel', 'twitch', 'Connected Twitch channel "' + user.display_name + '" via Twitch login.');
}

// Refreshes the stored access token if it's expired (or about to be),
// using the stored refresh token. Returns a valid access token either way.
async function getValidAccessToken(channelKey) {
  var res = await pool.query('SELECT * FROM marketing_oauth_tokens WHERE channel_key = $1', [channelKey]);
  var row = res.rows[0];
  if (!row) fail('invalid', 'Twitch is not connected yet — connect it from Integrations first.');
  if (new Date(row.expires_at).getTime() > Date.now() + 60000) return row.access_token;

  var body = new URLSearchParams({
    refresh_token: row.refresh_token,
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    grant_type: 'refresh_token'
  });
  var refreshRes = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  var data = await refreshRes.json();
  if (!refreshRes.ok || data.error) fail('invalid', 'Your Twitch session expired and could not be refreshed — reconnect it from Integrations.');
  var expiresAt = new Date(Date.now() + (data.expires_in || 0) * 1000);
  await pool.query(
    'UPDATE marketing_oauth_tokens SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = now() WHERE channel_key = $4',
    [data.access_token, data.refresh_token || row.refresh_token, expiresAt, channelKey]
  );
  return data.access_token;
}

// twitchOAuth.sync — pulls the connected channel's current follower count
// (logged as today's channel_stats snapshot) and its recent VODs (with
// current view counts — Twitch VODs have no like/comment concept) into
// the content calendar. Videos are matched by Twitch's own video id, so a
// repeat sync updates the same rows instead of duplicating them.
async function sync(ctx) {
  requireManage(ctx);
  var accessToken = await getValidAccessToken('twitch');

  var chanRes = await pool.query("SELECT id FROM marketing_channels WHERE key = 'twitch'");
  if (!chanRes.rows[0]) fail('notfound', 'Twitch channel not found.');
  var channelId = chanRes.rows[0].id;
  var broadcasterId = (await pool.query('SELECT open_id FROM marketing_oauth_tokens WHERE channel_key = $1', ['twitch'])).rows[0].open_id;

  var followerCount = null, videoCount = 0;
  try {
    var followersData = await helixGet('/channels/followers?broadcaster_id=' + broadcasterId, accessToken);
    followerCount = followersData.total !== undefined ? followersData.total : null;
    if (followerCount !== null) {
      var today = new Date().toISOString().slice(0, 10);
      await pool.query(
        'INSERT INTO marketing_channel_stats (channel_id, captured_on, followers, created_by) VALUES ($1,$2,$3,$4) ' +
        'ON CONFLICT (channel_id, captured_on) DO UPDATE SET followers = $3',
        [channelId, today, followerCount, ctx.employee.id]
      );
    }
  } catch (err) {
    console.error('Twitch follower sync failed:', err);
  }

  var videosData = await helixGet('/videos?user_id=' + broadcasterId + '&first=25', accessToken);
  var videos = videosData.data || [];
  for (var i = 0; i < videos.length; i++) {
    var v = videos[i];
    await pool.query(
      'INSERT INTO marketing_posts (channel_id, external_id, title, caption, media_url, published_at, status, likes, comments, shares, reach, source, created_by) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,'published',0,0,0,$7,'synced',$8) " +
      'ON CONFLICT (channel_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET title = $3, caption = $4, media_url = $5, reach = $7, updated_at = now()',
      [channelId, v.id, (v.title || 'Twitch video').slice(0, 160), (v.description || '').slice(0, 2000), v.url || '',
        v.created_at ? new Date(v.created_at) : null, Number(v.view_count || 0), ctx.employee.id]
    );
  }
  videoCount = videos.length;

  await audit(pool, ctx, 'marketing.twitch.sync', 'marketing_channel', channelId, 'Synced ' + videoCount + ' Twitch video(s).');
  return { synced: videoCount, followers: followerCount };
}

module.exports = { startAuth: startAuth, handleCallback: handleCallback, sync: sync };
