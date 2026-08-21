var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// Social & campaign tracker (Metricool-style): channels, campaigns, a
// content calendar of posts with their engagement numbers, and periodic
// follower/traffic snapshots per channel for growth trend charts.
//
// Everything here is manually logged. A channel's `connected` flag (read
// off settings.integrations, see referenceData.js's defaultIntegrations())
// only means credentials are stored and ready — actually pulling live
// numbers from Meta/TikTok/etc.'s APIs is a separate backend build per
// platform once real developer app approval exists for it, exactly like
// this app's other integrations (Square, Slack, QuickBooks) work today.

function requireRead(ctx) {
  if (!ctx.can('marketing.read')) fail('forbidden', 'Your role does not allow this action (marketing.read).');
}
function requireManage(ctx) {
  if (!ctx.can('marketing.manage')) fail('forbidden', 'Your role does not allow this action (marketing.manage).');
}

function rowToChannel(r, integrationsById) {
  var integration = r.integration_key ? integrationsById[r.integration_key] : null;
  return {
    id: r.id, key: r.key, name: r.name, kind: r.kind, handle: r.handle, notes: r.notes,
    integrationKey: r.integration_key,
    connected: !!(integration && integration.connected)
  };
}

async function integrationsById() {
  var res = await pool.query('SELECT integrations FROM settings WHERE id = 1');
  var list = (res.rows[0] && res.rows[0].integrations) || [];
  var byId = {};
  list.forEach(function (i) { byId[i.id] = i; });
  return byId;
}

// kernel.js-style handler: marketing.channels.list
async function listChannels(ctx) {
  requireRead(ctx);
  var res = await pool.query('SELECT * FROM marketing_channels ORDER BY name');
  var byId = await integrationsById();
  return res.rows.map(function (r) { return rowToChannel(r, byId); });
}

// marketing.channels.update — handle/notes only; the fixed channel set
// (which platforms exist) isn't user-editable in this version.
async function updateChannel(ctx, id, p) {
  requireManage(ctx);
  var res = await pool.query(
    'UPDATE marketing_channels SET handle = $1, notes = $2 WHERE id = $3 RETURNING *',
    [(p.handle || '').trim().slice(0, 160), (p.notes || '').trim().slice(0, 500), id]
  );
  if (!res.rows[0]) fail('notfound', 'Channel not found.');
  var byId = await integrationsById();
  await audit(pool, ctx, 'marketing.channel.update', 'marketing_channel', id, 'Updated ' + res.rows[0].name + '.');
  return rowToChannel(res.rows[0], byId);
}

function rowToChannelStat(r) {
  return { id: r.id, channelId: r.channel_id, capturedOn: r.captured_on, followers: r.followers };
}

// marketing.channelStats.list — follower/reach history for one channel, for
// a growth trend chart.
async function listChannelStats(ctx, channelId) {
  requireRead(ctx);
  var res = await pool.query(
    'SELECT * FROM marketing_channel_stats WHERE channel_id = $1 ORDER BY captured_on', [channelId]
  );
  return res.rows.map(rowToChannelStat);
}

// marketing.channelStats.log — one snapshot per channel per day; logging
// again for the same day overwrites that day's figure rather than erroring,
// so correcting a mis-typed count doesn't need a delete first.
async function logChannelStat(ctx, channelId, p) {
  requireManage(ctx);
  var capturedOn = V.date(p.capturedOn, 'Date');
  var followers = Math.max(0, Math.round(Number(p.followers) || 0));
  var chanRes = await pool.query('SELECT id, name FROM marketing_channels WHERE id = $1', [channelId]);
  if (!chanRes.rows[0]) fail('notfound', 'Channel not found.');

  var res = await pool.query(
    'INSERT INTO marketing_channel_stats (channel_id, captured_on, followers, created_by) VALUES ($1,$2,$3,$4) ' +
    'ON CONFLICT (channel_id, captured_on) DO UPDATE SET followers = $3 RETURNING *',
    [channelId, capturedOn, followers, ctx.employee.id]
  );
  await audit(pool, ctx, 'marketing.stat.log', 'marketing_channel', channelId, 'Logged ' + followers + ' followers for ' + chanRes.rows[0].name + ' on ' + capturedOn + '.');
  return rowToChannelStat(res.rows[0]);
}

function rowToCampaign(r) {
  return {
    id: r.id, name: r.name, description: r.description, startDate: r.start_date, endDate: r.end_date,
    status: r.status, createdAt: r.created_at
  };
}

// kernel.js-style handler: marketing.campaigns.list
async function listCampaigns(ctx) {
  requireRead(ctx);
  var res = await pool.query('SELECT * FROM marketing_campaigns ORDER BY created_at DESC');
  return res.rows.map(rowToCampaign);
}

// marketing.campaigns.create
async function createCampaign(ctx, p) {
  requireManage(ctx);
  var name = V.text(p.name, 'Campaign name', 120);
  var status = V.oneOf(p.status || 'planned', ['planned', 'active', 'completed'], 'Status');
  var res = await pool.query(
    "INSERT INTO marketing_campaigns (name, description, start_date, end_date, status, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [name, (p.description || '').trim().slice(0, 500), p.startDate || null, p.endDate || null, status, ctx.employee.id]
  );
  await audit(pool, ctx, 'marketing.campaign.create', 'marketing_campaign', res.rows[0].id, 'Created campaign ' + name + '.');
  return rowToCampaign(res.rows[0]);
}

// marketing.campaigns.update
async function updateCampaign(ctx, id, p) {
  requireManage(ctx);
  var name = V.text(p.name, 'Campaign name', 120);
  var status = V.oneOf(p.status || 'planned', ['planned', 'active', 'completed'], 'Status');
  var res = await pool.query(
    'UPDATE marketing_campaigns SET name = $1, description = $2, start_date = $3, end_date = $4, status = $5 WHERE id = $6 RETURNING *',
    [name, (p.description || '').trim().slice(0, 500), p.startDate || null, p.endDate || null, status, id]
  );
  if (!res.rows[0]) fail('notfound', 'Campaign not found.');
  await audit(pool, ctx, 'marketing.campaign.update', 'marketing_campaign', id, 'Updated campaign ' + name + '.');
  return rowToCampaign(res.rows[0]);
}

function rowToPost(r) {
  return {
    id: r.id, channelId: r.channel_id, channelName: r.channel_name, channelKey: r.channel_key,
    campaignId: r.campaign_id, campaignName: r.campaign_name,
    title: r.title, caption: r.caption, mediaUrl: r.media_url,
    scheduledAt: r.scheduled_at, publishedAt: r.published_at, status: r.status,
    likes: r.likes, comments: r.comments, shares: r.shares, reach: r.reach,
    impressions: r.impressions, clicks: r.clicks, leads: r.leads,
    createdAt: r.created_at
  };
}

var POST_SELECT =
  'SELECT p.*, c.name AS channel_name, c.key AS channel_key, camp.name AS campaign_name ' +
  'FROM marketing_posts p JOIN marketing_channels c ON c.id = p.channel_id ' +
  'LEFT JOIN marketing_campaigns camp ON camp.id = p.campaign_id ';

// kernel.js-style handler: marketing.posts.list — optional channelId/
// campaignId/status filters for the content-calendar and campaign views.
async function listPosts(ctx, filters) {
  requireRead(ctx);
  filters = filters || {};
  var clauses = [];
  var params = [];
  if (filters.channelId) { params.push(filters.channelId); clauses.push('p.channel_id = $' + params.length); }
  if (filters.campaignId) { params.push(filters.campaignId); clauses.push('p.campaign_id = $' + params.length); }
  if (filters.status) { params.push(filters.status); clauses.push('p.status = $' + params.length); }
  var where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  var res = await pool.query(POST_SELECT + where + ' ORDER BY COALESCE(p.published_at, p.scheduled_at, p.created_at) DESC', params);
  return res.rows.map(rowToPost);
}

var POST_STATUSES = ['planned', 'scheduled', 'published', 'failed'];

function metricFields(p) {
  return {
    likes: Math.max(0, Math.round(Number(p.likes) || 0)),
    comments: Math.max(0, Math.round(Number(p.comments) || 0)),
    shares: Math.max(0, Math.round(Number(p.shares) || 0)),
    reach: Math.max(0, Math.round(Number(p.reach) || 0)),
    impressions: Math.max(0, Math.round(Number(p.impressions) || 0)),
    clicks: Math.max(0, Math.round(Number(p.clicks) || 0)),
    leads: Math.max(0, Math.round(Number(p.leads) || 0))
  };
}

// marketing.posts.create
async function createPost(ctx, p) {
  requireManage(ctx);
  var title = V.text(p.title, 'Title', 160);
  var status = V.oneOf(p.status || 'planned', POST_STATUSES, 'Status');
  var chanRes = await pool.query('SELECT id FROM marketing_channels WHERE id = $1', [p.channelId]);
  if (!chanRes.rows[0]) fail('invalid', 'Choose a channel.');
  if (p.campaignId) {
    var campRes = await pool.query('SELECT id FROM marketing_campaigns WHERE id = $1', [p.campaignId]);
    if (!campRes.rows[0]) fail('invalid', 'Unknown campaign.');
  }
  var m = metricFields(p);

  var newId = await withTransaction(async function (client) {
    var res = await client.query(
      'INSERT INTO marketing_posts (channel_id, campaign_id, title, caption, media_url, scheduled_at, published_at, status, ' +
      'likes, comments, shares, reach, impressions, clicks, leads, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id',
      [p.channelId, p.campaignId || null, title, (p.caption || '').trim().slice(0, 2000), (p.mediaUrl || '').trim().slice(0, 500),
        p.scheduledAt || null, p.publishedAt || null, status,
        m.likes, m.comments, m.shares, m.reach, m.impressions, m.clicks, m.leads, ctx.employee.id]
    );
    await audit(client, ctx, 'marketing.post.create', 'marketing_post', res.rows[0].id, 'Added post "' + title + '".');
    return res.rows[0].id;
  });

  var final = await pool.query(POST_SELECT + ' WHERE p.id = $1', [newId]);
  return rowToPost(final.rows[0]);
}

// marketing.posts.update — same fields as create, plus this is where a
// planned/scheduled post is marked published and its real metrics logged.
async function updatePost(ctx, id, p) {
  requireManage(ctx);
  var title = V.text(p.title, 'Title', 160);
  var status = V.oneOf(p.status || 'planned', POST_STATUSES, 'Status');
  if (p.campaignId) {
    var campRes = await pool.query('SELECT id FROM marketing_campaigns WHERE id = $1', [p.campaignId]);
    if (!campRes.rows[0]) fail('invalid', 'Unknown campaign.');
  }
  var m = metricFields(p);

  var res = await pool.query(
    'UPDATE marketing_posts SET campaign_id = $1, title = $2, caption = $3, media_url = $4, scheduled_at = $5, published_at = $6, status = $7, ' +
    'likes = $8, comments = $9, shares = $10, reach = $11, impressions = $12, clicks = $13, leads = $14, updated_at = now() ' +
    'WHERE id = $15 RETURNING id',
    [p.campaignId || null, title, (p.caption || '').trim().slice(0, 2000), (p.mediaUrl || '').trim().slice(0, 500),
      p.scheduledAt || null, p.publishedAt || null, status,
      m.likes, m.comments, m.shares, m.reach, m.impressions, m.clicks, m.leads, id]
  );
  if (!res.rows[0]) fail('notfound', 'Post not found.');
  await audit(pool, ctx, 'marketing.post.update', 'marketing_post', id, 'Updated post "' + title + '".');
  var final = await pool.query(POST_SELECT + ' WHERE p.id = $1', [id]);
  return rowToPost(final.rows[0]);
}

// marketing.posts.delete
async function deletePost(ctx, id) {
  requireManage(ctx);
  var res = await pool.query('DELETE FROM marketing_posts WHERE id = $1 RETURNING title', [id]);
  if (!res.rows[0]) fail('notfound', 'Post not found.');
  await audit(pool, ctx, 'marketing.post.delete', 'marketing_post', id, 'Deleted post "' + res.rows[0].title + '".');
  return { ok: true };
}

// marketing.dashboard — per-channel totals (posts, engagement, latest
// follower count + change since the previous snapshot) and campaign
// rollups, for the tracker's Overview tab.
async function dashboard(ctx) {
  requireRead(ctx);
  var channels = await listChannels(ctx);

  var totalsRes = await pool.query(
    'SELECT channel_id, count(*) AS posts, sum(likes) AS likes, sum(comments) AS comments, sum(shares) AS shares, ' +
    'sum(reach) AS reach, sum(clicks) AS clicks, sum(leads) AS leads ' +
    "FROM marketing_posts WHERE status = 'published' GROUP BY channel_id"
  );
  var totalsByChannel = {};
  totalsRes.rows.forEach(function (r) {
    totalsByChannel[r.channel_id] = {
      posts: Number(r.posts), likes: Number(r.likes), comments: Number(r.comments), shares: Number(r.shares),
      reach: Number(r.reach), clicks: Number(r.clicks), leads: Number(r.leads)
    };
  });

  var statsRes = await pool.query(
    'SELECT channel_id, captured_on, followers, ' +
    'ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY captured_on DESC) AS rn ' +
    'FROM marketing_channel_stats'
  );
  var latestByChannel = {};
  var prevByChannel = {};
  statsRes.rows.forEach(function (r) {
    if (Number(r.rn) === 1) latestByChannel[r.channel_id] = { followers: r.followers, capturedOn: r.captured_on };
    else if (Number(r.rn) === 2) prevByChannel[r.channel_id] = r.followers;
  });

  var channelSummaries = channels.map(function (c) {
    var totals = totalsByChannel[c.id] || { posts: 0, likes: 0, comments: 0, shares: 0, reach: 0, clicks: 0, leads: 0 };
    var latest = latestByChannel[c.id];
    return Object.assign({}, c, {
      totals: totals,
      followers: latest ? latest.followers : null,
      followersAsOf: latest ? latest.capturedOn : null,
      followerChange: latest && prevByChannel[c.id] !== undefined ? latest.followers - prevByChannel[c.id] : null
    });
  });

  var campaigns = await listCampaigns(ctx);
  var campaignTotalsRes = await pool.query(
    'SELECT campaign_id, count(*) AS posts, sum(likes) AS likes, sum(comments) AS comments, sum(shares) AS shares, ' +
    'sum(reach) AS reach, sum(clicks) AS clicks, sum(leads) AS leads ' +
    "FROM marketing_posts WHERE campaign_id IS NOT NULL AND status = 'published' GROUP BY campaign_id"
  );
  var campaignTotalsById = {};
  campaignTotalsRes.rows.forEach(function (r) {
    campaignTotalsById[r.campaign_id] = {
      posts: Number(r.posts), likes: Number(r.likes), comments: Number(r.comments), shares: Number(r.shares),
      reach: Number(r.reach), clicks: Number(r.clicks), leads: Number(r.leads)
    };
  });
  var campaignSummaries = campaigns.map(function (c) {
    return Object.assign({}, c, { totals: campaignTotalsById[c.id] || { posts: 0, likes: 0, comments: 0, shares: 0, reach: 0, clicks: 0, leads: 0 } });
  });

  return { channels: channelSummaries, campaigns: campaignSummaries };
}

module.exports = {
  listChannels: listChannels, updateChannel: updateChannel,
  listChannelStats: listChannelStats, logChannelStat: logChannelStat,
  listCampaigns: listCampaigns, createCampaign: createCampaign, updateCampaign: updateCampaign,
  listPosts: listPosts, createPost: createPost, updatePost: updatePost, deletePost: deletePost,
  dashboard: dashboard
};
