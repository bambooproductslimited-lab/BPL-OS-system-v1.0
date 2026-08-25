var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var config = require('../config');

// Real Google Analytics (GA4 Data API) sync for the social tracker's
// Website channel. Unlike every OAuth-based platform in this app, there's
// no per-user consent redirect here — a GA4 property is read server-to-
// server via a Google Cloud service account (granted Viewer access on the
// property in GA4 Admin > Property Access Management), authenticated by
// signing a short-lived JWT with the service account's private key and
// exchanging it for an access token. This is the standard "server auth"
// flow Google documents for service accounts; see config.js's `website`
// block for where the three credentials come from.
//
// There's no real "followers" concept for a website, so the channel's
// growth-trend snapshot (marketing_channel_stats.followers) is repurposed
// as a 30-day active-users figure — a reasonable audience-size proxy that,
// like every other platform's follower count here, is a cumulative
// snapshot taken at sync time, not a per-day delta.

var TOKEN_URL = 'https://oauth2.googleapis.com/token';
var SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// getAccessToken — signs a JWT asserting the service account's identity
// and scope, then exchanges it for a short-lived (1 hour) access token.
// No refresh token involved; a fresh one is requested on every sync since
// this is only ever called from an explicit "Sync now" click, not a
// background job.
async function getAccessToken() {
  var now = Math.floor(Date.now() / 1000);
  var header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claims = base64url(JSON.stringify({
    iss: config.website.serviceAccountEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600
  }));
  var signingInput = header + '.' + claims;
  var signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(config.website.privateKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  var jwt = signingInput + '.' + signature;

  var body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt });
  var res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  var data = await res.json();
  if (!res.ok || data.error) fail('invalid', 'Google Analytics auth failed: ' + (data.error_description || data.error || res.status) + ' — check GA4_SERVICE_ACCOUNT_EMAIL/GA4_SERVICE_ACCOUNT_PRIVATE_KEY and that the service account has Viewer access on the GA4 property.');
  return data.access_token;
}

async function runReport(accessToken, body) {
  var res = await fetch('https://analyticsdata.googleapis.com/v1beta/properties/' + config.website.propertyId + ':runReport', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify(body)
  });
  var data = await res.json();
  if (!res.ok || data.error) fail('invalid', 'GA4 Data API error: ' + (data.error && data.error.message ? data.error.message : res.status));
  return data;
}

function requireManage(ctx) {
  if (!ctx.can('marketing.manage')) fail('forbidden', 'Your role does not allow this action (marketing.manage).');
}

// googleAnalytics.sync — logs the trailing-30-day active-users figure as
// today's channel_stats snapshot, and upserts the top 10 pages by
// pageviews into the content calendar as synced "posts" (matched by page
// path, so a repeat sync updates the same rows instead of duplicating
// them) — mirroring how the seed data already models a landing page as a
// Website channel post.
async function sync(ctx) {
  requireManage(ctx);
  if (!config.website.configured) fail('invalid', 'Website analytics is not configured on the server yet — set GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_EMAIL and GA4_SERVICE_ACCOUNT_PRIVATE_KEY on Render.');

  var chanRes = await pool.query("SELECT id FROM marketing_channels WHERE key = 'website'");
  if (!chanRes.rows[0]) fail('notfound', 'Website channel not found.');
  var channelId = chanRes.rows[0].id;

  var accessToken = await getAccessToken();
  var dateRange = { startDate: '30daysAgo', endDate: 'today' };

  var totals = await runReport(accessToken, { dateRanges: [dateRange], metrics: [{ name: 'activeUsers' }] });
  var activeUsers = totals.rows && totals.rows[0] ? Number(totals.rows[0].metricValues[0].value) : 0;
  var today = new Date().toISOString().slice(0, 10);
  await pool.query(
    'INSERT INTO marketing_channel_stats (channel_id, captured_on, followers, created_by) VALUES ($1,$2,$3,$4) ' +
    'ON CONFLICT (channel_id, captured_on) DO UPDATE SET followers = $3',
    [channelId, today, activeUsers, ctx.employee.id]
  );

  var pages = await runReport(accessToken, {
    dateRanges: [dateRange],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 10
  });
  var rows = pages.rows || [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var pagePath = r.dimensionValues[0].value;
    var pageTitle = r.dimensionValues[1].value || pagePath;
    var views = Number(r.metricValues[0].value || 0);
    var users = Number(r.metricValues[1].value || 0);
    await pool.query(
      'INSERT INTO marketing_posts (channel_id, external_id, title, caption, media_url, status, clicks, reach, source, created_by) ' +
      "VALUES ($1,$2,$3,$4,$5,'published',$6,$7,'synced',$8) " +
      'ON CONFLICT (channel_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET title = $3, caption = $4, media_url = $5, clicks = $6, reach = $7, updated_at = now()',
      [channelId, pagePath, pageTitle.slice(0, 160), pagePath.slice(0, 2000), 'https://www.bplghana.com' + pagePath, views, users, ctx.employee.id]
    );
  }

  await audit(pool, ctx, 'marketing.website.sync', 'marketing_channel', channelId, 'Synced ' + rows.length + ' website page(s).');
  return { synced: rows.length, followers: activeUsers };
}

module.exports = { sync: sync };
