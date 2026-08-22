var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var config = require('../config');

// Real Meta (Facebook + Instagram) OAuth for the social tracker — one
// Facebook Login flow covers both, since an Instagram professional account
// is only ever reachable through its linked Facebook Page. Unlike TikTok's
// single-account flow, the logged-in user may admin more than one Page, so
// the callback can't finish the connection by itself: it exchanges the code
// for a long-lived user token, stashes it in marketing_oauth_pending, and
// sends the browser to a "choose a Page" step in the frontend. Only after
// that pick does connectPage() store real, usable tokens.
//
// appId is not secret and is embedded directly in the authorize URL handed
// to the frontend; appSecret never leaves this file.

var GRAPH = 'https://graph.facebook.com/v21.0';
var AUTHORIZE_URL = 'https://www.facebook.com/v21.0/dialog/oauth';
// read_insights isn't requested — this app only reads fan_count and posts
// (both covered by pages_read_engagement, whose own permission description
// includes Page insights), never a dedicated Page Insights endpoint. Newer
// Graph API versions appear to have folded standalone Page insight access
// into pages_read_engagement rather than keeping read_insights separate.
var SCOPES = 'pages_show_list,pages_read_engagement,instagram_basic,instagram_manage_insights';
var PENDING_MAX_AGE_MS = 15 * 60 * 1000;

function requireManage(ctx) {
  if (!ctx.can('marketing.manage')) fail('forbidden', 'Your role does not allow this action (marketing.manage).');
}

async function graphGet(pathOrUrl, accessToken) {
  var url = pathOrUrl.indexOf('http') === 0 ? pathOrUrl : GRAPH + pathOrUrl;
  if (accessToken) {
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    url += sep + 'access_token=' + encodeURIComponent(accessToken);
  }
  var res = await fetch(url);
  var data = await res.json();
  if (!res.ok || data.error) fail('invalid', 'Meta API error: ' + (data.error && data.error.message ? data.error.message : res.status));
  return data;
}

// metaOAuth.startAuth — issues a one-time state token and returns the URL
// to send the browser to.
async function startAuth(ctx) {
  requireManage(ctx);
  if (!config.meta.configured) fail('invalid', 'Facebook/Instagram is not configured on the server yet — set META_APP_ID and META_APP_SECRET on Render.');
  var state = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO marketing_oauth_states (state, channel_key) VALUES ($1, $2)', [state, 'meta']);
  var url = AUTHORIZE_URL + '?client_id=' + encodeURIComponent(config.meta.appId) +
    '&redirect_uri=' + encodeURIComponent(config.meta.redirectUri) +
    '&state=' + state +
    '&scope=' + encodeURIComponent(SCOPES) +
    '&response_type=code';
  return { url: url };
}

// metaOAuth.handleCallback — Meta redirects the browser here with ?code&
// ?state. Exchanges the code for a short-lived user token, then that for a
// long-lived one (~60 days), and stashes it under a fresh pending token for
// the frontend's page-picker to pick up. Returns { pendingToken } so the
// route can build the redirect URL — no ctx here, same reasoning as
// tiktokOAuth's handleCallback.
async function handleCallback(code, state) {
  if (!code || !state) fail('invalid', 'Missing code or state.');
  var stateRes = await pool.query('DELETE FROM marketing_oauth_states WHERE state = $1 AND channel_key = $2 RETURNING state', [state, 'meta']);
  if (!stateRes.rows[0]) fail('invalid', 'This authorization link has expired or was already used — try connecting again.');

  var shortLived = await graphGet(
    '/oauth/access_token?client_id=' + encodeURIComponent(config.meta.appId) +
    '&redirect_uri=' + encodeURIComponent(config.meta.redirectUri) +
    '&client_secret=' + encodeURIComponent(config.meta.appSecret) +
    '&code=' + encodeURIComponent(code),
    null
  );

  var longLived = await graphGet(
    '/oauth/access_token?grant_type=fb_exchange_token' +
    '&client_id=' + encodeURIComponent(config.meta.appId) +
    '&client_secret=' + encodeURIComponent(config.meta.appSecret) +
    '&fb_exchange_token=' + encodeURIComponent(shortLived.access_token),
    null
  );

  var pendingToken = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO marketing_oauth_pending (token, channel_key, user_access_token) VALUES ($1, $2, $3)', [pendingToken, 'meta', longLived.access_token]);
  return { pendingToken: pendingToken };
}

async function loadPending(pendingToken) {
  var res = await pool.query('SELECT * FROM marketing_oauth_pending WHERE token = $1 AND channel_key = $2', [pendingToken, 'meta']);
  var row = res.rows[0];
  if (!row || Date.now() - new Date(row.created_at).getTime() > PENDING_MAX_AGE_MS) {
    fail('invalid', 'This connection attempt has expired — try connecting again.');
  }
  return row;
}

async function fetchPages(userAccessToken) {
  var data = await graphGet('/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100', userAccessToken);
  return data.data || [];
}

// metaOAuth.listPages — for the frontend's "choose a Page" step. Never
// returns page access tokens to the browser, only what's needed to pick.
async function listPages(ctx, pendingToken) {
  requireManage(ctx);
  var pending = await loadPending(pendingToken);
  var pages = await fetchPages(pending.user_access_token);
  return pages.map(function (p) {
    return { id: p.id, name: p.name, hasInstagram: !!p.instagram_business_account, instagramUsername: p.instagram_business_account ? p.instagram_business_account.username : null };
  });
}

// metaOAuth.connectPage — finalizes the connection for the chosen Page.
// Re-fetches the page list server-side (rather than trusting anything the
// browser sent beyond the id) so the stored access token always comes
// straight from Meta.
async function connectPage(ctx, pendingToken, pageId) {
  requireManage(ctx);
  var pending = await loadPending(pendingToken);
  var pages = await fetchPages(pending.user_access_token);
  var page = pages.find(function (p) { return p.id === pageId; });
  if (!page) fail('notfound', 'That Page was not found among the ones this account manages.');

  // Page access tokens derived from a long-lived user token do not expire
  // on their own (Meta only invalidates them if the user removes the app
  // or loses admin rights on the Page) — expires_at is set far out as a
  // soft marker, not because Meta issues a real expiry here.
  var expiresAt = new Date(Date.now() + 365 * 86400000);

  var chanRes = await pool.query("SELECT id, key FROM marketing_channels WHERE key IN ('facebook','instagram')");
  var channelIdByKey = {};
  chanRes.rows.forEach(function (r) { channelIdByKey[r.key] = r.id; });

  await pool.query(
    'INSERT INTO marketing_oauth_tokens (channel_key, access_token, refresh_token, open_id, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6) ' +
    'ON CONFLICT (channel_key) DO UPDATE SET access_token = $2, open_id = $4, scope = $5, expires_at = $6, updated_at = now()',
    ['facebook', page.access_token, '', page.id, SCOPES, expiresAt]
  );
  var instagramConnected = false;
  if (page.instagram_business_account) {
    await pool.query(
      'INSERT INTO marketing_oauth_tokens (channel_key, access_token, refresh_token, open_id, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6) ' +
      'ON CONFLICT (channel_key) DO UPDATE SET access_token = $2, open_id = $4, scope = $5, expires_at = $6, updated_at = now()',
      ['instagram', page.access_token, '', page.instagram_business_account.id, SCOPES, expiresAt]
    );
    instagramConnected = true;
  }

  var settingsRes = await pool.query('SELECT integrations FROM settings WHERE id = 1');
  var list = settingsRes.rows[0].integrations || [];
  ['facebook', 'instagram'].forEach(function (id) {
    if (id === 'instagram' && !instagramConnected) return;
    var idx = list.findIndex(function (x) { return x.id === id; });
    if (idx >= 0) {
      list[idx].connected = true;
      list[idx].apiKey = 'Connected via Facebook login (Page: ' + page.name + ')';
    }
  });
  await pool.query('UPDATE settings SET integrations = $1, updated_at = now() WHERE id = 1', [JSON.stringify(list)]);

  await pool.query('DELETE FROM marketing_oauth_pending WHERE token = $1', [pendingToken]);
  await audit(pool, ctx, 'marketing.meta.connect', 'marketing_channel', page.id, 'Connected Facebook Page "' + page.name + '"' + (instagramConnected ? ' and its linked Instagram account' : '') + ' via Meta login.');

  return { pageName: page.name, facebookConnected: true, instagramConnected: instagramConnected };
}

async function getToken(channelKey) {
  var res = await pool.query('SELECT * FROM marketing_oauth_tokens WHERE channel_key = $1', [channelKey]);
  if (!res.rows[0]) fail('invalid', (channelKey === 'facebook' ? 'Facebook' : 'Instagram') + ' is not connected yet — connect it from Integrations first.');
  return res.rows[0];
}

async function followPaging(firstUrl, accessToken, maxPages) {
  var items = [];
  var url = firstUrl;
  var token = accessToken;
  var pages = 0;
  while (url && pages < maxPages) {
    var data = await graphGet(url, token);
    items = items.concat(data.data || []);
    url = data.paging && data.paging.next;
    token = null; // next-page URLs Meta hands back already carry their own access_token
    pages++;
  }
  return items;
}

// metaOAuth.syncFacebook — pulls the connected Page's follower (fan) count
// and its recent posts (with current like/comment counts) into the content
// calendar. Posts are matched by Facebook's own post id, so a repeat sync
// updates the same rows rather than duplicating them.
async function syncFacebook(ctx) {
  requireManage(ctx);
  var token = await getToken('facebook');

  var chanRes = await pool.query("SELECT id FROM marketing_channels WHERE key = 'facebook'");
  if (!chanRes.rows[0]) fail('notfound', 'Facebook channel not found.');
  var channelId = chanRes.rows[0].id;

  var pageError = null, followerCount = null, postCount = 0;
  try {
    var pageInfo = await graphGet('/' + token.open_id + '?fields=fan_count', token.access_token);
    followerCount = pageInfo.fan_count !== undefined ? pageInfo.fan_count : null;
    if (followerCount !== null) {
      var today = new Date().toISOString().slice(0, 10);
      await pool.query(
        'INSERT INTO marketing_channel_stats (channel_id, captured_on, followers, created_by) VALUES ($1,$2,$3,$4) ' +
        'ON CONFLICT (channel_id, captured_on) DO UPDATE SET followers = $3',
        [channelId, today, followerCount, ctx.employee.id]
      );
    }
  } catch (err) {
    pageError = err.message;
    console.error('Facebook follower sync failed:', err);
  }

  try {
    var posts = await followPaging(
      GRAPH + '/' + token.open_id + '/posts?fields=id,message,permalink_url,created_time,likes.summary(true),comments.summary(true),shares&limit=25',
      token.access_token, 10
    );
    for (var i = 0; i < posts.length; i++) {
      var p = posts[i];
      await pool.query(
        'INSERT INTO marketing_posts (channel_id, external_id, title, caption, media_url, published_at, status, likes, comments, shares, reach, source, created_by) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,'published',$7,$8,$9,0,'synced',$10) " +
        'ON CONFLICT (channel_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET title = $3, caption = $4, media_url = $5, likes = $7, comments = $8, shares = $9, updated_at = now()',
        [channelId, p.id, (p.message || 'Facebook post').slice(0, 160), (p.message || '').slice(0, 2000), p.permalink_url || '',
          p.created_time ? new Date(p.created_time) : null, (p.likes && p.likes.summary ? p.likes.summary.total_count : 0),
          (p.comments && p.comments.summary ? p.comments.summary.total_count : 0), (p.shares ? p.shares.count : 0), ctx.employee.id]
      );
    }
    postCount = posts.length;
  } catch (err) {
    pageError = pageError || err.message;
    console.error('Facebook post sync failed:', err);
  }

  await audit(pool, ctx, 'marketing.facebook.sync', 'marketing_channel', channelId, 'Synced ' + postCount + ' Facebook post(s).');
  return { synced: postCount, followers: followerCount, syncError: pageError };
}

// metaOAuth.syncInstagram — same idea as syncFacebook, for the linked
// Instagram Business account's follower count and recent media.
async function syncInstagram(ctx) {
  requireManage(ctx);
  var token = await getToken('instagram');

  var chanRes = await pool.query("SELECT id FROM marketing_channels WHERE key = 'instagram'");
  if (!chanRes.rows[0]) fail('notfound', 'Instagram channel not found.');
  var channelId = chanRes.rows[0].id;

  var igError = null, followerCount = null, mediaCount = 0;
  try {
    var igInfo = await graphGet('/' + token.open_id + '?fields=followers_count', token.access_token);
    followerCount = igInfo.followers_count !== undefined ? igInfo.followers_count : null;
    if (followerCount !== null) {
      var today = new Date().toISOString().slice(0, 10);
      await pool.query(
        'INSERT INTO marketing_channel_stats (channel_id, captured_on, followers, created_by) VALUES ($1,$2,$3,$4) ' +
        'ON CONFLICT (channel_id, captured_on) DO UPDATE SET followers = $3',
        [channelId, today, followerCount, ctx.employee.id]
      );
    }
  } catch (err) {
    igError = err.message;
    console.error('Instagram follower sync failed:', err);
  }

  try {
    var media = await followPaging(
      GRAPH + '/' + token.open_id + '/media?fields=id,caption,media_url,permalink,timestamp,like_count,comments_count&limit=25',
      token.access_token, 10
    );
    for (var i = 0; i < media.length; i++) {
      var m = media[i];
      await pool.query(
        'INSERT INTO marketing_posts (channel_id, external_id, title, caption, media_url, published_at, status, likes, comments, shares, reach, source, created_by) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,'published',$7,$8,0,0,'synced',$9) " +
        'ON CONFLICT (channel_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET title = $3, caption = $4, media_url = $5, likes = $7, comments = $8, updated_at = now()',
        [channelId, m.id, (m.caption || 'Instagram post').slice(0, 160), (m.caption || '').slice(0, 2000), m.permalink || m.media_url || '',
          m.timestamp ? new Date(m.timestamp) : null, m.like_count || 0, m.comments_count || 0, ctx.employee.id]
      );
    }
    mediaCount = media.length;
  } catch (err) {
    igError = igError || err.message;
    console.error('Instagram media sync failed:', err);
  }

  await audit(pool, ctx, 'marketing.instagram.sync', 'marketing_channel', channelId, 'Synced ' + mediaCount + ' Instagram post(s).');
  return { synced: mediaCount, followers: followerCount, syncError: igError };
}

module.exports = {
  startAuth: startAuth, handleCallback: handleCallback, listPages: listPages, connectPage: connectPage,
  syncFacebook: syncFacebook, syncInstagram: syncInstagram
};
