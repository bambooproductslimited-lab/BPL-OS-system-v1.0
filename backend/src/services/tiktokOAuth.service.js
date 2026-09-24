var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var config = require('../config');
var marketingChannels = require('./marketingChannels');

// Real TikTok Login Kit OAuth for the social tracker's "Connect with
// TikTok" button — the only channel with a live sync built so far (see
// module comment in marketing.service.js for why the others are still
// manual-entry). clientKey is not secret and is embedded directly in the
// authorize URL handed to the frontend; clientSecret never leaves this
// file — it's only ever used server-side in the code/refresh-token
// exchanges below.
//
// Per company (marketingChannels.js): each company's TikTok channel ('tiktok'
// for Bamboo Products, 'sbr-tiktok' …) connects to its own account, and its
// tokens are stored under that channel's key.

var AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
var TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
var USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/';
var VIDEO_LIST_URL = 'https://open.tiktokapis.com/v2/video/list/';
// Must exactly match real TikTok Display API scope names, and each one
// must be individually enabled for the app (and, in Sandbox mode, for the
// target user) in the TikTok Developer Portal — an unrecognized or
// unenabled scope makes the whole authorize request fail with a generic
// "we couldn't log in with TikTok" / "correct: scope" error page.
// user.info.stats (not user.info.basic) is what actually grants
// follower_count on the user/info endpoint used by sync() below.
var SCOPES = 'user.info.basic,user.info.stats,video.list';

function requireManage(ctx) {
  if (!ctx.can('marketing.manage')) fail('forbidden', 'Your role does not allow this action (marketing.manage).');
}

// tiktokOAuth.startAuth — issues a one-time state token (CSRF protection
// for the redirect dance) and returns the URL to send the browser to.
async function startAuth(ctx, channelKey) {
  requireManage(ctx);
  if (!config.tiktok.configured) fail('invalid', 'TikTok is not configured on the server yet — set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET on Render.');
  var chan = await marketingChannels.channelFor(channelKey, 'tiktok');
  var state = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO marketing_oauth_states (state, channel_key, company_code) VALUES ($1, $2, $3)', [state, chan.key, chan.company_code]);
  var url = AUTHORIZE_URL + '?client_key=' + encodeURIComponent(config.tiktok.clientKey) +
    '&scope=' + encodeURIComponent(SCOPES) +
    '&response_type=code' +
    '&redirect_uri=' + encodeURIComponent(config.tiktok.redirectUri) +
    '&state=' + state;
  return { url: url };
}

// tiktokOAuth.handleCallback — TikTok redirects the browser here with
// ?code&?state after the user approves. Plain browser navigation, not an
// authenticated API call, so there's no ctx — the one-time state is the
// proof this came from a request we issued (deleted on use, so a replayed
// callback URL fails the second time).
async function handleCallback(code, state) {
  if (!code || !state) fail('invalid', 'Missing code or state.');
  var stateRes = await pool.query(
    "DELETE FROM marketing_oauth_states WHERE state = $1 AND channel_key IN (SELECT key FROM marketing_channels WHERE coalesce(platform, key) = 'tiktok') RETURNING channel_key", [state]);
  if (!stateRes.rows[0]) fail('invalid', 'This authorization link has expired or was already used — try connecting again.');
  var chan = await marketingChannels.channelFor(stateRes.rows[0].channel_key, 'tiktok');

  var body = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    code: code,
    grant_type: 'authorization_code',
    redirect_uri: config.tiktok.redirectUri
  });
  var tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: body.toString()
  });
  var tokenData = await tokenRes.json();
  if (!tokenRes.ok || tokenData.error) fail('invalid', 'TikTok token exchange failed: ' + (tokenData.error_description || tokenData.error || tokenRes.status));

  var expiresAt = new Date(Date.now() + (tokenData.expires_in || 0) * 1000);
  await pool.query(
    'INSERT INTO marketing_oauth_tokens (channel_key, access_token, refresh_token, open_id, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6) ' +
    'ON CONFLICT (channel_key) DO UPDATE SET access_token = $2, refresh_token = $3, open_id = $4, scope = $5, expires_at = $6, updated_at = now()',
    [chan.key, tokenData.access_token, tokenData.refresh_token || '', tokenData.open_id || '', tokenData.scope || '', expiresAt]
  );

  // Bamboo Products' TikTok is also shown on the Integrations screen.
  var settingsRes = await pool.query('SELECT integrations FROM settings WHERE id = 1');
  var list = settingsRes.rows[0].integrations || [];
  var idx = chan.key === 'tiktok' ? list.findIndex(function (x) { return x.id === 'tiktok'; }) : -1;
  if (idx >= 0) {
    list[idx].connected = true;
    list[idx].apiKey = 'Connected via TikTok login' + (tokenData.open_id ? ' (' + String(tokenData.open_id).slice(0, 8) + '…)' : '');
    await pool.query('UPDATE settings SET integrations = $1, updated_at = now() WHERE id = 1', [JSON.stringify(list)]);
  }
  await audit(pool, null, 'marketing.tiktok.connect', 'marketing_channel', chan.key, 'Connected ' + chan.company_name + '\'s TikTok via OAuth.');
  return { channelKey: chan.key, companyCode: chan.company_code };
}

// Refreshes the stored access token if it's expired (or about to be),
// using the stored refresh token. Returns a valid access token either way.
async function getValidAccessToken(channelKey) {
  var res = await pool.query('SELECT * FROM marketing_oauth_tokens WHERE channel_key = $1', [channelKey]);
  var row = res.rows[0];
  if (!row) fail('invalid', 'TikTok is not connected yet — connect it from the tracker\'s Channels tab first.');
  if (new Date(row.expires_at).getTime() > Date.now() + 60000) return row.access_token;

  var body = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token
  });
  var refreshRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: body.toString()
  });
  var data = await refreshRes.json();
  if (!refreshRes.ok || data.error) fail('invalid', 'Your TikTok session expired and could not be refreshed — connect it again from the tracker\'s Channels tab.');
  var expiresAt = new Date(Date.now() + (data.expires_in || 0) * 1000);
  await pool.query(
    'UPDATE marketing_oauth_tokens SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = now() WHERE channel_key = $4',
    [data.access_token, data.refresh_token || row.refresh_token, expiresAt, channelKey]
  );
  return data.access_token;
}

// tiktokOAuth.sync — pulls the connected account's current follower count
// (logged as today's channel_stats snapshot) and its recent videos (with
// their current view/like/comment counts) into the content calendar.
// Videos are matched by TikTok's own video id, so a repeat sync updates
// the same rows instead of duplicating them; posts logged manually
// (source='manual') are never touched by this.
async function sync(ctx, channelKey) {
  requireManage(ctx);
  var chan = await marketingChannels.channelFor(channelKey, 'tiktok');
  var accessToken = await getValidAccessToken(chan.key);

  var channelId = chan.id;

  var userRes = await fetch(USER_INFO_URL + '?fields=open_id,display_name,follower_count', {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  var userData = await userRes.json();
  if (!userRes.ok) fail('invalid', 'Could not read your TikTok account info.');
  var followerCount = userData.data && userData.data.user ? userData.data.user.follower_count : null;
  if (followerCount !== null && followerCount !== undefined) {
    var today = new Date().toISOString().slice(0, 10);
    await pool.query(
      'INSERT INTO marketing_channel_stats (channel_id, captured_on, followers, created_by) VALUES ($1,$2,$3,$4) ' +
      'ON CONFLICT (channel_id, captured_on) DO UPDATE SET followers = $3',
      [channelId, today, followerCount, ctx.employee.id]
    );
  }

  // Follower count is already saved above at this point — fetching/
  // inserting videos is a separate, independently-failable step, so a
  // problem here (bad scope, TikTok outage, unexpected response shape)
  // must not turn an otherwise-successful follower sync into a 500.
  var videoCount = 0;
  var videoError = null;
  try {
    var cursor = 0;
    var hasMore = true;
    var pagesFetched = 0;
    // TikTok returns at most 20 videos per call; page through with the
    // cursor it hands back until has_more is false. Capped at 50 pages
    // (1000 videos) as a sanity limit against an API bug looping forever.
    while (hasMore && pagesFetched < 50) {
      var videoRes = await fetch(VIDEO_LIST_URL + '?fields=id,title,video_description,create_time,share_url,view_count,like_count,comment_count,share_count', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_count: 20, cursor: cursor })
      });
      var videoData = await videoRes.json();
      if (!videoRes.ok || (videoData.error && videoData.error.code && videoData.error.code !== 'ok')) {
        throw new Error((videoData.error && (videoData.error.message || videoData.error.code)) || ('HTTP ' + videoRes.status));
      }
      var videos = (videoData.data && videoData.data.videos) || [];

      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        var publishedAt = v.create_time ? new Date(v.create_time * 1000) : null;
        await pool.query(
          'INSERT INTO marketing_posts (channel_id, external_id, title, caption, media_url, published_at, status, likes, comments, shares, reach, source, created_by) ' +
          "VALUES ($1,$2,$3,$4,$5,$6,'published',$7,$8,$9,$10,'synced',$11) " +
          // idx_marketing_posts_channel_external is a partial unique index
          // (WHERE external_id IS NOT NULL) — Postgres only matches a
          // partial index as the ON CONFLICT arbiter if that same predicate
          // is restated here; naming just the columns isn't enough.
          'ON CONFLICT (channel_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET title = $3, caption = $4, media_url = $5, likes = $7, comments = $8, shares = $9, reach = $10, updated_at = now()',
          [channelId, v.id, (v.title || v.video_description || 'TikTok video').slice(0, 160), (v.video_description || '').slice(0, 2000), v.share_url || '',
            publishedAt, v.like_count || 0, v.comment_count || 0, v.share_count || 0, v.view_count || 0, ctx.employee.id]
        );
      }
      videoCount += videos.length;
      pagesFetched++;
      hasMore = !!(videoData.data && videoData.data.has_more);
      cursor = (videoData.data && videoData.data.cursor) || cursor;
    }
  } catch (err) {
    videoError = err.message;
    console.error('TikTok video sync failed:', err);
  }

  await audit(pool, ctx, 'marketing.tiktok.sync', 'marketing_channel', channelId, 'Synced ' + videoCount + ' TikTok video(s).');
  return { synced: videoCount, followers: followerCount, videoError: videoError };
}

module.exports = { startAuth: startAuth, handleCallback: handleCallback, sync: sync };
