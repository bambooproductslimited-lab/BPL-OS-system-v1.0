var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var config = require('../config');

// Real YouTube (Google) OAuth for the social tracker's "Connect with
// YouTube" button. Single-account flow like TikTok's — a Google account
// has exactly one associated YouTube channel, so there's no page-picker
// step like Meta's. Google issues a real refresh_token (unlike Meta's
// long-lived-token model), so this follows TikTok's getValidAccessToken
// refresh pattern almost exactly.
//
// clientId is not secret and is embedded directly in the authorize URL
// handed to the frontend; clientSecret never leaves this file — used only
// in the code/refresh-token exchanges below.

var AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
var TOKEN_URL = 'https://oauth2.googleapis.com/token';
var CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';
var PLAYLIST_ITEMS_URL = 'https://www.googleapis.com/youtube/v3/playlistItems';
var VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
var SCOPES = 'https://www.googleapis.com/auth/youtube.readonly';

function requireManage(ctx) {
  if (!ctx.can('marketing.manage')) fail('forbidden', 'Your role does not allow this action (marketing.manage).');
}

// youtubeOAuth.startAuth — issues a one-time state token and returns the
// URL to send the browser to. access_type=offline + prompt=consent force
// Google to hand back a refresh_token (it otherwise only does this on a
// user's very first consent for the app).
async function startAuth(ctx) {
  requireManage(ctx);
  if (!config.youtube.configured) fail('invalid', 'YouTube is not configured on the server yet — set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET on Render.');
  var state = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO marketing_oauth_states (state, channel_key) VALUES ($1, $2)', [state, 'youtube']);
  var url = AUTHORIZE_URL + '?client_id=' + encodeURIComponent(config.youtube.clientId) +
    '&redirect_uri=' + encodeURIComponent(config.youtube.redirectUri) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent(SCOPES) +
    '&access_type=offline' +
    '&prompt=consent' +
    '&state=' + state;
  return { url: url };
}

// youtubeOAuth.handleCallback — Google redirects the browser here with
// ?code&?state. No ctx — plain browser navigation, same reasoning as
// tiktokOAuth's handleCallback.
async function handleCallback(code, state) {
  if (!code || !state) fail('invalid', 'Missing code or state.');
  var stateRes = await pool.query('DELETE FROM marketing_oauth_states WHERE state = $1 AND channel_key = $2 RETURNING state', [state, 'youtube']);
  if (!stateRes.rows[0]) fail('invalid', 'This authorization link has expired or was already used — try connecting again.');

  var body = new URLSearchParams({
    code: code,
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    redirect_uri: config.youtube.redirectUri,
    grant_type: 'authorization_code'
  });
  var tokenRes = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  var tokenData = await tokenRes.json();
  if (!tokenRes.ok || tokenData.error) fail('invalid', 'YouTube token exchange failed: ' + (tokenData.error_description || tokenData.error || tokenRes.status));
  if (!tokenData.refresh_token) fail('invalid', 'Google did not return a refresh token — if you previously connected and revoked YouTube, remove Bamboo OS from your Google account\'s connected apps first, then try connecting again.');

  var chanRes = await fetch(CHANNELS_URL + '?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + tokenData.access_token } });
  var chanData = await chanRes.json();
  var channel = chanData.items && chanData.items[0];
  if (!channel) fail('invalid', 'Could not find a YouTube channel for this Google account.');

  var expiresAt = new Date(Date.now() + (tokenData.expires_in || 0) * 1000);
  await pool.query(
    'INSERT INTO marketing_oauth_tokens (channel_key, access_token, refresh_token, open_id, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6) ' +
    'ON CONFLICT (channel_key) DO UPDATE SET access_token = $2, refresh_token = $3, open_id = $4, scope = $5, expires_at = $6, updated_at = now()',
    ['youtube', tokenData.access_token, tokenData.refresh_token, channel.id, tokenData.scope || SCOPES, expiresAt]
  );

  var settingsRes = await pool.query('SELECT integrations FROM settings WHERE id = 1');
  var list = settingsRes.rows[0].integrations || [];
  var idx = list.findIndex(function (x) { return x.id === 'youtube'; });
  if (idx >= 0) {
    list[idx].connected = true;
    list[idx].apiKey = 'Connected via Google login (' + channel.snippet.title + ')';
    await pool.query('UPDATE settings SET integrations = $1, updated_at = now() WHERE id = 1', [JSON.stringify(list)]);
  }
  await audit(pool, null, 'marketing.youtube.connect', 'marketing_channel', 'youtube', 'Connected YouTube channel "' + channel.snippet.title + '" via Google login.');
}

// Refreshes the stored access token if it's expired (or about to be),
// using the stored refresh token. Returns a valid access token either way.
async function getValidAccessToken(channelKey) {
  var res = await pool.query('SELECT * FROM marketing_oauth_tokens WHERE channel_key = $1', [channelKey]);
  var row = res.rows[0];
  if (!row) fail('invalid', 'YouTube is not connected yet — connect it from Integrations first.');
  if (new Date(row.expires_at).getTime() > Date.now() + 60000) return row.access_token;

  var body = new URLSearchParams({
    refresh_token: row.refresh_token,
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    grant_type: 'refresh_token'
  });
  var refreshRes = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  var data = await refreshRes.json();
  if (!refreshRes.ok || data.error) fail('invalid', 'Your YouTube session expired and could not be refreshed — reconnect it from Integrations.');
  var expiresAt = new Date(Date.now() + (data.expires_in || 0) * 1000);
  await pool.query(
    'UPDATE marketing_oauth_tokens SET access_token = $1, expires_at = $2, updated_at = now() WHERE channel_key = $3',
    [data.access_token, expiresAt, channelKey]
  );
  return data.access_token;
}

// youtubeOAuth.sync — pulls the connected channel's current subscriber
// count (logged as today's channel_stats snapshot) and its recent videos
// (with current view/like/comment counts) into the content calendar.
// Videos are matched by YouTube's own video id, so a repeat sync updates
// the same rows instead of duplicating them.
async function sync(ctx) {
  requireManage(ctx);
  var accessToken = await getValidAccessToken('youtube');
  var authHeader = { Authorization: 'Bearer ' + accessToken };

  var chanRes = await pool.query("SELECT id FROM marketing_channels WHERE key = 'youtube'");
  if (!chanRes.rows[0]) fail('notfound', 'YouTube channel not found.');
  var channelId = chanRes.rows[0].id;

  var ytRes = await fetch(CHANNELS_URL + '?part=statistics,contentDetails&mine=true', { headers: authHeader });
  var ytData = await ytRes.json();
  if (!ytRes.ok) fail('invalid', 'Could not read your YouTube channel info.');
  var yt = ytData.items && ytData.items[0];
  var subscriberCount = yt && yt.statistics && !yt.statistics.hiddenSubscriberCount ? Number(yt.statistics.subscriberCount) : null;
  if (subscriberCount !== null) {
    var today = new Date().toISOString().slice(0, 10);
    await pool.query(
      'INSERT INTO marketing_channel_stats (channel_id, captured_on, followers, created_by) VALUES ($1,$2,$3,$4) ' +
      'ON CONFLICT (channel_id, captured_on) DO UPDATE SET followers = $3',
      [channelId, today, subscriberCount, ctx.employee.id]
    );
  }

  var videoCount = 0;
  var uploadsPlaylistId = yt && yt.contentDetails && yt.contentDetails.relatedPlaylists && yt.contentDetails.relatedPlaylists.uploads;
  if (uploadsPlaylistId) {
    var itemsRes = await fetch(PLAYLIST_ITEMS_URL + '?part=contentDetails&playlistId=' + uploadsPlaylistId + '&maxResults=25', { headers: authHeader });
    var itemsData = await itemsRes.json();
    var videoIds = ((itemsData.items) || []).map(function (i) { return i.contentDetails.videoId; }).filter(Boolean);
    if (videoIds.length) {
      var videosRes = await fetch(VIDEOS_URL + '?part=snippet,statistics&id=' + videoIds.join(','), { headers: authHeader });
      var videosData = await videosRes.json();
      var videos = videosData.items || [];
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        await pool.query(
          'INSERT INTO marketing_posts (channel_id, external_id, title, caption, media_url, published_at, status, likes, comments, shares, reach, source, created_by) ' +
          "VALUES ($1,$2,$3,$4,$5,$6,'published',$7,$8,0,$9,'synced',$10) " +
          'ON CONFLICT (channel_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET title = $3, caption = $4, media_url = $5, likes = $7, comments = $8, reach = $9, updated_at = now()',
          [channelId, v.id, (v.snippet.title || 'YouTube video').slice(0, 160), (v.snippet.description || '').slice(0, 2000), 'https://www.youtube.com/watch?v=' + v.id,
            v.snippet.publishedAt ? new Date(v.snippet.publishedAt) : null, Number(v.statistics.likeCount || 0), Number(v.statistics.commentCount || 0), Number(v.statistics.viewCount || 0), ctx.employee.id]
        );
      }
      videoCount = videos.length;
    }
  }

  await audit(pool, ctx, 'marketing.youtube.sync', 'marketing_channel', channelId, 'Synced ' + videoCount + ' YouTube video(s).');
  return { synced: videoCount, followers: subscriberCount };
}

module.exports = { startAuth: startAuth, handleCallback: handleCallback, sync: sync };
