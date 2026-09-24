/*
 * A social & campaign tracker per company (migration 0079,
 * marketingChannels.js): Bamboo Products Limited, Star Bar Restaurant and
 * Bamboo Garden each have their own channels, campaigns, posts, follower
 * history and inbox, and each company's TikTok and Facebook/Instagram
 * connect to that company's own account.
 *
 * TikTok's and Meta's servers are stood in for by swapping fetch for the
 * length of the test that needs them — nothing leaves the machine.
 * Campaigns, posts and inbox items use the Z9M prefix and are removed
 * afterwards, as are any connections made here.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var svc = require('../src/services/marketing.service');
var tiktok = require('../src/services/tiktokOAuth.service');
var meta = require('../src/services/metaOAuth.service');
var { buildContext } = require('../src/services/context.service');

var admin, reader, nobody;
var saved = {};

async function cleanup() {
  await pool.query("DELETE FROM marketing_inbox_items WHERE body LIKE 'Z9M%'");
  await pool.query("DELETE FROM marketing_posts WHERE title LIKE 'Z9M%'");
  await pool.query("DELETE FROM marketing_campaigns WHERE name LIKE 'Z9M%'");
  await pool.query("DELETE FROM marketing_channel_stats WHERE channel_id IN (SELECT id FROM marketing_channels WHERE key LIKE 'sbr-%' OR key LIKE 'bgn-%')");
  await pool.query("DELETE FROM marketing_posts WHERE channel_id IN (SELECT id FROM marketing_channels WHERE key LIKE 'sbr-%' OR key LIKE 'bgn-%')");
  await pool.query("DELETE FROM marketing_oauth_tokens WHERE channel_key LIKE 'sbr-%' OR channel_key LIKE 'bgn-%'");
  await pool.query("DELETE FROM marketing_oauth_states WHERE company_code IN ('SBR', 'BGN')");
  await pool.query("DELETE FROM marketing_oauth_pending WHERE company_code IN ('SBR', 'BGN')");
}

test.before(async function () {
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  reader = Object.assign({}, admin, { can: function (p) { return p === 'marketing.read'; } });
  nobody = Object.assign({}, admin, { can: function () { return false; } });
  saved.tiktok = Object.assign({}, config.tiktok);
  saved.meta = Object.assign({}, config.meta);
});
test.after(async function () {
  await cleanup();
  Object.assign(config.tiktok, saved.tiktok);
  Object.assign(config.meta, saved.meta);
  await pool.end();
});

function byPlatform(list) {
  var out = {};
  list.forEach(function (c) { out[c.platform] = c; });
  return out;
}

test('the companies with a tracker, each with its own set of channels', async function () {
  var companies = await svc.listCompanies(reader);
  assert.deepEqual(companies.map(function (c) { return c.code; }), ['BPL', 'SBR', 'BGN']);
  assert.equal(companies[1].name, 'Star Bar Restaurant');
  await assert.rejects(svc.listCompanies(nobody), /marketing\.read/);

  var bpl = await svc.listChannels(reader, {});
  var sbr = await svc.listChannels(reader, { company: 'SBR' });
  var bgn = await svc.listChannels(reader, { company: 'bgn' });
  assert.ok(bpl.every(function (c) { return c.companyCode === 'BPL'; }), 'no company means Bamboo Products, as before');
  assert.ok(bpl.some(function (c) { return c.key === 'thomasnet'; }));
  assert.deepEqual(sbr.map(function (c) { return c.platform; }).sort(),
    ['facebook', 'googlebusiness', 'instagram', 'tiktok', 'tripadvisor', 'website', 'whatsapp', 'youtube']);
  assert.ok(sbr.every(function (c) { return /^sbr-/.test(c.key) && c.companyCode === 'SBR'; }));
  assert.ok(bgn.every(function (c) { return /^bgn-/.test(c.key); }));
  var s = byPlatform(sbr);
  assert.equal(s.tiktok.connectable, true);
  assert.equal(s.tripadvisor.connectable, false);
  assert.equal(s.facebook.connected, false);
  await assert.rejects(svc.listChannels(reader, { company: 'PKI' }), /no social tracker/);
  await assert.rejects(svc.listChannels(reader, { company: 'XYZ' }), /no social tracker/);
});

test('campaigns, posts, follower history and inbox stay within their company', async function () {
  var sbr = byPlatform(await svc.listChannels(admin, { company: 'SBR' }));
  var bpl = byPlatform(await svc.listChannels(admin, {}));

  var camp = await svc.createCampaign(admin, { name: 'Z9M Friday Jazz Night', status: 'active', company: 'SBR' });
  assert.ok((await svc.listCampaigns(reader, 'SBR')).some(function (c) { return c.id === camp.id; }));
  assert.ok(!(await svc.listCampaigns(reader, 'BPL')).some(function (c) { return c.id === camp.id; }), 'not in Bamboo Products\' list');

  var post = await svc.createPost(admin, {
    channelId: sbr.instagram.id, campaignId: camp.id, title: 'Z9M Jollof special', status: 'published',
    publishedAt: new Date().toISOString(), likes: 120, comments: 14, shares: 9, reach: 3100
  });
  assert.equal(post.channelKey, 'sbr-instagram');
  await assert.rejects(svc.createPost(admin, { channelId: bpl.facebook.id, campaignId: camp.id, title: 'Z9M wrong', status: 'planned' }), /another company/);
  await assert.rejects(svc.updatePost(admin, post.id, { campaignId: (await svc.createCampaign(admin, { name: 'Z9M BPL push', company: 'BPL' })).id, title: 'Z9M Jollof special', status: 'published' }), /another company/);

  assert.ok((await svc.listPosts(reader, { company: 'SBR' })).some(function (p) { return p.id === post.id; }));
  assert.ok(!(await svc.listPosts(reader, {})).some(function (p) { return p.id === post.id; }));
  assert.ok(!(await svc.listPosts(reader, { company: 'BGN' })).some(function (p) { return p.id === post.id; }));

  await svc.logChannelStat(admin, sbr.instagram.id, { capturedOn: new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10), followers: 800 });
  await svc.logChannelStat(admin, sbr.instagram.id, { capturedOn: new Date().toISOString().slice(0, 10), followers: 950 });

  await svc.createInboxItem(admin, { channelId: sbr.instagram.id, kind: 'comment', body: 'Z9M Do you open on Sunday?' });
  assert.equal((await svc.listInboxItems(reader, { company: 'SBR' })).filter(function (i) { return /^Z9M/.test(i.body); }).length, 1);
  assert.equal((await svc.listInboxItems(reader, {})).filter(function (i) { return /^Z9M/.test(i.body); }).length, 0);

  var dash = await svc.dashboard(reader, 'SBR');
  assert.equal(dash.company.name, 'Star Bar Restaurant');
  var ig = dash.channels.filter(function (c) { return c.key === 'sbr-instagram'; })[0];
  assert.equal(ig.totals.posts, 1);
  assert.equal(ig.totals.likes, 120);
  assert.equal(ig.followers, 950);
  assert.equal(ig.followerChange, 150);
  assert.equal(ig.openInboxCount, 1);
  assert.ok(dash.campaigns.some(function (c) { return c.name === 'Z9M Friday Jazz Night' && c.totals.posts === 1; }));
  var bplDash = await svc.dashboard(reader, 'BPL');
  assert.ok(!bplDash.channels.some(function (c) { return /^sbr-/.test(c.key); }));

  // Charts: channels logged by hand count, not just connected ones.
  var from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  var to = new Date().toISOString().slice(0, 10);
  var m = await svc.dashboardMetrics(reader, from, to, 'SBR');
  var f = m.metrics.followers.byChannel.filter(function (x) { return x.channelKey === 'sbr-instagram'; })[0];
  assert.equal(f.value, 950);
  assert.equal(m.metrics.posts.byChannel.filter(function (x) { return x.channelKey === 'sbr-instagram'; })[0].value, 1);
  var bplM = await svc.dashboardMetrics(reader, from, to, 'BPL');
  assert.ok(!bplM.metrics.followers.byChannel.some(function (x) { return /^sbr-/.test(x.channelKey); }));
});

function fakeFetch(routes) {
  var real = global.fetch;
  var calls = [];
  global.fetch = async function (url, opts) {
    var u = String(url);
    calls.push(u);
    for (var i = 0; i < routes.length; i++) {
      if (u.indexOf(routes[i][0]) >= 0) {
        var body = routes[i][1](u, opts);
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return real(url, opts);
  };
  return { calls: calls, restore: function () { global.fetch = real; } };
}

test('TikTok: each company connects its own account; tokens are stored on its own channel', async function () {
  Object.assign(config.tiktok, { clientKey: 'ck', clientSecret: 'cs', redirectUri: 'https://os.example/api/marketing/oauth/tiktok/callback' });
  if (!('configured' in config.tiktok) || !config.tiktok.configured) config.tiktok.configured = true;

  await assert.rejects(tiktok.startAuth(admin, 'sbr-facebook'), /tiktok channel was not found/, 'the channel must be a TikTok one');
  var start = await tiktok.startAuth(admin, 'sbr-tiktok');
  var state = new URL(start.url).searchParams.get('state');
  var row = (await pool.query('SELECT channel_key, company_code FROM marketing_oauth_states WHERE state = $1', [state])).rows[0];
  assert.deepEqual(row, { channel_key: 'sbr-tiktok', company_code: 'SBR' });

  var bplBefore = (await pool.query("SELECT access_token FROM marketing_oauth_tokens WHERE channel_key = 'tiktok'")).rows[0] || null;
  var f = fakeFetch([['open.tiktokapis.com/v2/oauth/token', function () { return { access_token: 'sbr-at', refresh_token: 'sbr-rt', open_id: 'sbr-open', expires_in: 86400, scope: 'user.info.basic' }; }]]);
  try {
    var done = await tiktok.handleCallback('code-1', state);
    assert.deepEqual(done, { channelKey: 'sbr-tiktok', companyCode: 'SBR' });
  } finally { f.restore(); }
  var tok = (await pool.query("SELECT access_token, open_id FROM marketing_oauth_tokens WHERE channel_key = 'sbr-tiktok'")).rows[0];
  assert.deepEqual(tok, { access_token: 'sbr-at', open_id: 'sbr-open' });
  var bplAfter = (await pool.query("SELECT access_token FROM marketing_oauth_tokens WHERE channel_key = 'tiktok'")).rows[0] || null;
  assert.deepEqual(bplAfter, bplBefore, 'Bamboo Products\' TikTok untouched');

  var sbr = byPlatform(await svc.listChannels(reader, { company: 'SBR' }));
  assert.equal(sbr.tiktok.connected, true);
  assert.equal(byPlatform(await svc.listChannels(reader, { company: 'BGN' })).tiktok.connected, false);

  // Syncing Star Bar's TikTok reads with Star Bar's token and fills Star Bar's channel.
  f = fakeFetch([
    ['open.tiktokapis.com/v2/user/info', function () { return { data: { user: { follower_count: 4321 } }, error: { code: 'ok' } }; }],
    ['open.tiktokapis.com/v2/video/list', function () { return { data: { videos: [{ id: 'v1', title: 'Z9M Grill night', create_time: Math.floor(Date.now() / 1000), like_count: 50, comment_count: 4, share_count: 2, view_count: 900 }], has_more: false }, error: { code: 'ok' } }; }]
  ]);
  try {
    var r = await tiktok.sync(admin, 'sbr-tiktok');
    assert.equal(r.followers, 4321);
  } finally { f.restore(); }
  var dash = await svc.dashboard(reader, 'SBR');
  assert.equal(dash.channels.filter(function (c) { return c.key === 'sbr-tiktok'; })[0].followers, 4321);

  var out = await svc.disconnectChannel(admin, sbr.tiktok.id);
  assert.equal(out.disconnected, true);
  assert.equal(byPlatform(await svc.listChannels(reader, { company: 'SBR' })).tiktok.connected, false);
  await assert.rejects(svc.disconnectChannel(reader, sbr.tiktok.id), /marketing\.manage/);
});

test('Facebook/Instagram: the Page chosen goes on that company\'s Facebook and Instagram', async function () {
  Object.assign(config.meta, { appId: 'app', appSecret: 'secret', redirectUri: 'https://os.example/api/marketing/oauth/meta/callback' });
  if (!config.meta.configured) config.meta.configured = true;

  var start = await meta.startAuth(admin, 'BGN');
  var state = new URL(start.url).searchParams.get('state');
  var f = fakeFetch([
    ['/oauth/access_token', function () { return { access_token: 'long-lived-user' }; }],
    ['/me/accounts', function () { return { data: [{ id: 'page-bgn', name: 'Bamboo Garden Accra', access_token: 'page-tok', instagram_business_account: { id: 'ig-bgn', username: 'bamboogarden' } }] }; }]
  ]);
  try {
    var cb = await meta.handleCallback('code-2', state);
    assert.equal(cb.companyCode, 'BGN');
    var pages = await meta.listPages(admin, cb.pendingToken);
    assert.equal(pages[0].instagramUsername, 'bamboogarden');
    var connected = await meta.connectPage(admin, cb.pendingToken, 'page-bgn');
    assert.equal(connected.instagramConnected, true);
    assert.equal(connected.companyCode, 'BGN');
  } finally { f.restore(); }
  var toks = (await pool.query("SELECT channel_key, open_id FROM marketing_oauth_tokens WHERE channel_key IN ('bgn-facebook', 'bgn-instagram') ORDER BY channel_key")).rows;
  assert.deepEqual(toks, [{ channel_key: 'bgn-facebook', open_id: 'page-bgn' }, { channel_key: 'bgn-instagram', open_id: 'ig-bgn' }]);
  var bgn = byPlatform(await svc.listChannels(reader, { company: 'BGN' }));
  assert.equal(bgn.facebook.connected && bgn.instagram.connected, true);
  var settings = (await pool.query('SELECT integrations FROM settings WHERE id = 1')).rows[0].integrations;
  var fb = settings.filter(function (i) { return i.id === 'facebook'; })[0];
  assert.ok(!fb || !/Bamboo Garden/.test(fb.apiKey || ''), 'Bamboo Products\' Integrations screen is not changed');
  await assert.rejects(meta.startAuth(admin, 'PKI'), /not found/);
});

test('recommendations: about the chosen company only', async function () {
  var key = config.ai.apiKey;
  config.ai.apiKey = '';
  try {
    var r = await svc.recommendations(reader, 'SBR');
    assert.equal(r.basedOn.company, 'Star Bar Restaurant');
    assert.ok(r.basedOn.channels.every(function (c) { return ['Facebook', 'Instagram', 'TikTok', 'YouTube', 'WhatsApp Business', 'Website', 'Google Business Profile', 'TripAdvisor'].indexOf(c.name) >= 0; }));
    assert.ok(r.basedOn.topPerformingPosts.every(function (p) { return p.channel !== 'LinkedIn Page'; }));
  } finally { config.ai.apiKey = key; }
});

test('restaurants are found by whatever code they were given, or by name', function () {
  var channels = require('../src/services/marketingChannels');
  var found = channels.trackedCompanies([
    { id: 'a', code: 'PKI', name: 'Poki' },
    { id: 'b', code: 'BG1', name: 'Bamboo Garden' },
    { id: 'c', code: 'SB', name: 'Star Bar Restaurant' },
    { id: 'd', code: 'BPL', name: 'Bamboo Products Limited' }
  ]);
  assert.deepEqual(found.map(function (f) { return f.code; }), ['BPL', 'SB', 'BG1']);
  var byName = channels.trackedCompanies([{ id: 'e', code: 'STAR', name: 'Star Bar' }]);
  assert.equal(byName[0].code, 'STAR');
  assert.equal(channels.channelKey('SB', 'facebook'), 'sb-facebook');
  assert.equal(channels.channelKey('BPL', 'facebook'), 'facebook');
});
