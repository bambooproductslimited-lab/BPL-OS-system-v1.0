/*
 * Integration test for the social & campaign tracker (marketing.service.js):
 * channels (with their connected status read off settings.integrations),
 * campaigns, the content-calendar posts, follower-stat logging, and the
 * dashboard aggregation. Requires `npm run migrate && npm run seed` first,
 * same as the other test files.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');

var server;
var base;

test.before(function (t, done) {
  server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); });
});
test.after(function () { server.close(); });

async function login(email) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  return (await res.json()).token;
}
function authed(token) { return { Authorization: 'Bearer ' + token }; }
function jsonAuthed(token) { return Object.assign({ 'Content-Type': 'application/json' }, authed(token)); }

test('marketing.channels/campaigns/posts: permission-gated, seeded channels present, dashboard totals + follower delta', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com'); // plain employee — no marketing.read

  var denied = await fetch(base + '/api/marketing/channels', { headers: authed(alice) });
  assert.equal(denied.status, 403);

  var channels = await (await fetch(base + '/api/marketing/channels', { headers: authed(admin) })).json();
  var byKey = {};
  channels.forEach(function (c) { byKey[c.key] = c; });
  assert.ok(byKey.facebook);
  assert.ok(byKey.instagram);
  assert.ok(byKey.tiktok);
  assert.ok(byKey.whatsapp);
  assert.ok(byKey.website);
  assert.ok(byKey.thomasnet);
  // ThomasNet has no API to connect to — no integration_key at all.
  assert.equal(byKey.thomasnet.integrationKey, null);
  assert.equal(byKey.thomasnet.connected, false);
  assert.equal(byKey.facebook.connected, false);

  // Connecting Facebook's integration (Integrations screen's own endpoint)
  // should flip the channel's connected flag without anything marketing-
  // specific involved.
  var connectRes = await fetch(base + '/api/settings/integrations/facebook/connect', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ apiKey: 'test-key' })
  });
  assert.equal(connectRes.status, 200);
  var channelsAfter = await (await fetch(base + '/api/marketing/channels', { headers: authed(admin) })).json();
  assert.equal(channelsAfter.find(function (c) { return c.key === 'facebook'; }).connected, true);

  // Campaign create is denied without marketing.manage, allowed with it.
  var campDenied = await fetch(base + '/api/marketing/campaigns', {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ name: 'x' })
  });
  assert.equal(campDenied.status, 403);

  var campRes = await fetch(base + '/api/marketing/campaigns', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ name: 'Test Campaign', status: 'active' })
  });
  assert.equal(campRes.status, 201);
  var campaign = await campRes.json();
  assert.equal(campaign.status, 'active');

  var facebookId = byKey.facebook.id;

  // Log two follower snapshots (out of date order, and dated safely after
  // the seed's own demo snapshots so these are always the two most recent)
  // and confirm the dashboard picks the most recent by date, not by
  // insertion order, and computes the delta against the one before it.
  await fetch(base + '/api/marketing/channels/' + facebookId + '/stats', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ capturedOn: '2027-06-10', followers: 1000 })
  });
  await fetch(base + '/api/marketing/channels/' + facebookId + '/stats', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ capturedOn: '2027-07-10', followers: 1250 })
  });

  // Facebook already carries seeded demo posts, so compare totals as a
  // delta from a baseline taken just before adding this test's own post,
  // rather than assuming the channel starts at zero.
  var dashBefore = await (await fetch(base + '/api/marketing/dashboard', { headers: authed(admin) })).json();
  var fbBefore = dashBefore.channels.find(function (c) { return c.key === 'facebook'; }).totals;

  var postRes = await fetch(base + '/api/marketing/posts', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({
      channelId: facebookId, campaignId: campaign.id, title: 'Launch post', status: 'published',
      publishedAt: '2026-02-01T10:00:00Z', likes: 100, comments: 10, shares: 5, reach: 2000, clicks: 40, leads: 3
    })
  });
  assert.equal(postRes.status, 201);
  var post = await postRes.json();
  assert.equal(post.channelName, 'Facebook');
  assert.equal(post.campaignName, 'Test Campaign');

  // A second, still-planned post shouldn't count toward published totals.
  await fetch(base + '/api/marketing/posts', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ channelId: facebookId, title: 'Draft post', status: 'planned', likes: 999 })
  });

  var dash = await (await fetch(base + '/api/marketing/dashboard', { headers: authed(admin) })).json();
  var fbSummary = dash.channels.find(function (c) { return c.key === 'facebook'; });
  assert.equal(fbSummary.totals.posts, fbBefore.posts + 1);
  assert.equal(fbSummary.totals.likes, fbBefore.likes + 100);
  assert.equal(fbSummary.followers, 1250);
  assert.equal(fbSummary.followerChange, 250);

  var campSummary = dash.campaigns.find(function (c) { return c.id === campaign.id; });
  assert.equal(campSummary.totals.posts, 1);
  assert.equal(campSummary.totals.leads, 3);

  // Filtering the content calendar by campaign only returns that campaign's post.
  var filtered = await (await fetch(base + '/api/marketing/posts?campaignId=' + campaign.id, { headers: authed(admin) })).json();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, post.id);

  // Editing a post updates its metrics.
  var updateRes = await fetch(base + '/api/marketing/posts/' + post.id, {
    method: 'PATCH', headers: jsonAuthed(admin),
    body: JSON.stringify({ channelId: facebookId, title: 'Launch post', status: 'published', likes: 150 })
  });
  assert.equal(updateRes.status, 200);
  assert.equal((await updateRes.json()).likes, 150);

  // Deleting requires marketing.manage.
  var delDenied = await fetch(base + '/api/marketing/posts/' + post.id, { method: 'DELETE', headers: authed(alice) });
  assert.equal(delDenied.status, 403);
  var delRes = await fetch(base + '/api/marketing/posts/' + post.id, { method: 'DELETE', headers: authed(admin) });
  assert.equal(delRes.status, 200);
});
