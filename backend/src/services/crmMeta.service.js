/*
 * Facebook Page and Instagram messages for the CRM inbox
 * (crmInbox.service.js).
 *
 * Uses the Page connected on the Social tracker (metaOAuth.service.js): its
 * Page access token reads the Page's Messenger conversations and its
 * Instagram account's direct messages, and sends replies. Reading and
 * sending messages need the pages_messaging and instagram_manage_messages
 * permissions, so a Page connected before the CRM must be connected again
 * once (Integrations → Facebook → Connect).
 *
 * sync() runs from jobs/crm.js every few minutes: it asks for the
 * conversations updated since the last run (newest first) and hands each to
 * crmInbox.ingest(), which keeps every message once.
 */
var { pool } = require('../db/pool');
var inbox = require('./crmInbox.service');

var GRAPH = 'https://graph.facebook.com/v21.0';
var MAX_PAGES = 10;
var PLATFORM = { facebook: 'messenger', instagram: 'instagram' };
var NEEDS = { facebook: 'pages_messaging', instagram: 'instagram_manage_messages' };

var fetcher = function (url, opts) { return fetch(url, opts); };
var retryMs = 1500;
function setFetchForTests(fn) { fetcher = fn || function (url, opts) { return fetch(url, opts); }; retryMs = fn ? 0 : 1500; }

// The Page token, the Page id, and (for Instagram) the account id.
async function access(channel) {
  var fb = (await pool.query("SELECT access_token, open_id, scope FROM marketing_oauth_tokens WHERE channel_key = 'facebook'")).rows[0];
  if (!fb || !fb.access_token) return null;
  var own = fb.open_id;
  if (channel === 'instagram') {
    var ig = (await pool.query("SELECT open_id, scope FROM marketing_oauth_tokens WHERE channel_key = 'instagram'")).rows[0];
    if (!ig) return null;
    own = ig.open_id;
  }
  return { token: fb.access_token, pageId: fb.open_id, ownId: own, scope: String(fb.scope || '') };
}

async function canSend(channel) {
  var a = await access(channel);
  return !!(a && a.scope.indexOf(NEEDS[channel]) >= 0);
}

async function graph(url, token, opts) {
  var u = (url.indexOf('http') === 0 ? url : GRAPH + url);
  if (token) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
  var res = await fetcher(u, opts);
  var data = await res.json();
  if (!res.ok || data.error) {
    var e = new Error('Meta: ' + (data.error && data.error.message ? data.error.message : 'answered ' + res.status));
    e.metaCode = data.error && data.error.code;
    throw e;
  }
  return data;
}

// Meta sometimes gives up on a big ask — "Timeout", "Please reduce the
// amount of data you're asking for", "Service temporarily unavailable" —
// usually for an Instagram account with many chats. Asked again for less.
function slow(e) {
  return [1, 2, -2].indexOf(e.metaCode) >= 0 || /timeout|timed out|temporarily unavailable|unexpected error|reduce the amount of data/i.test(e.message || '');
}
// While the app has only standard access, Meta searches the whole
// Instagram inbox for the chats of people with a role on the app, and on a
// busy account gives up on anything more than one chat a page — one at a
// time works, though Meta still stumbles now and then (asked again shortly).
var SIZES = [[25, 50], [10, 20], [5, 10], [1, 10]]; // conversations a page, messages each
function listUrl(a, channel, size) {
  return '/' + a.pageId + '/conversations?platform=' + PLATFORM[channel] + '&limit=' + size[0] + '&fields=' +
    encodeURIComponent('id,updated_time,participants,messages.limit(' + size[1] + '){id,message,from,to,created_time,attachments{name,mime_type}}');
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function patient(fn) {
  for (var i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (!slow(e) || i >= 2) throw e; await sleep(retryMs * (i + 1)); }
  }
}
async function firstPage(a, channel) {
  for (var i = 0; ; i++) {
    var size = SIZES[i];
    try { return await (i === SIZES.length - 1 ? patient(function () { return graph(listUrl(a, channel, size), a.token); }) : graph(listUrl(a, channel, size), a.token)); }
    catch (e) { if (!slow(e) || i === SIZES.length - 1) throw e; }
  }
}

// Messages: Meta wants the app subscribed to the Page (pages_manage_metadata)
// — done when the Page is connected, and from the check if it is not.
var SUB_FIELDS = 'messages,messaging_postbacks';
async function subscribePage(pageId, token) {
  return graph('/' + encodeURIComponent(pageId) + '/subscribed_apps?subscribed_fields=' + SUB_FIELDS, token, { method: 'POST' });
}

async function saveState(key, patch) {
  await pool.query(
    'INSERT INTO crm_channel_state (key, cursor, last_run_at, last_ok_at, last_error, items) VALUES ($1,$2,now(),$3,$4,$5) ' +
    'ON CONFLICT (key) DO UPDATE SET cursor = COALESCE($2, crm_channel_state.cursor), last_run_at = now(), ' +
    'last_ok_at = COALESCE($3, crm_channel_state.last_ok_at), last_error = $4, items = crm_channel_state.items + $5',
    [key, patch.cursor || null, patch.ok ? new Date() : null, patch.error || null, patch.items || 0]);
}

// One channel: the conversations updated since last time, each with its
// recent messages.
async function syncChannel(channel) {
  var a = await access(channel);
  if (!a) return { skipped: 'not connected' };
  if (a.scope.indexOf(NEEDS[channel]) < 0) return { skipped: 'needs reconnecting for messages' };
  var state = (await pool.query('SELECT cursor FROM crm_channel_state WHERE key = $1', [channel])).rows[0];
  var since = state && state.cursor ? new Date(state.cursor) : new Date(Date.now() - 30 * 86400000);
  var newest = since, conversations = 0, messages = 0;
  try {
    // The next pages (Meta's paging links) keep the size the first one got.
    var url = true;
    for (var n = 0; n < MAX_PAGES && url; n++) {
      var page = n ? await patient(function () { return graph(url, null); }) : await firstPage(a, channel);
      var done = false;
      for (var c of page.data || []) {
        var updated = new Date(c.updated_time);
        if (updated <= since) { done = true; break; }
        if (updated > newest) newest = updated;
        var them = ((c.participants && c.participants.data) || []).find(function (p) { return p.id !== a.ownId && p.id !== a.pageId; });
        if (!them) continue;
        var name = them.name || (them.username ? '@' + them.username : '');
        var msgs = ((c.messages && c.messages.data) || []).map(function (m) {
          var out = m.from && (m.from.id === a.ownId || m.from.id === a.pageId);
          return {
            externalId: m.id, direction: out ? 'out' : 'in', author: m.from ? (m.from.name || (m.from.username ? '@' + m.from.username : '')) : '',
            body: m.message || '', sentAt: m.created_time,
            attachments: ((m.attachments && m.attachments.data) || []).map(function (x) { return { name: x.name || 'attachment', type: x.mime_type || '' }; })
          };
        });
        var r = await inbox.ingest({
          channel: channel, threadId: c.id,
          contact: { name: name, handles: [{ kind: channel, value: them.id, label: them.username ? '@' + them.username : name }] },
          messages: msgs
        });
        conversations++;
        messages += r.added;
      }
      url = !done && page.paging && page.paging.next ? page.paging.next : null;
    }
    await saveState(channel, { cursor: newest.toISOString(), ok: true, items: messages });
    return { conversations: conversations, messages: messages };
  } catch (e) {
    await saveState(channel, { error: e.message });
    return { error: e.message };
  }
}

async function sync() {
  return { facebook: await syncChannel('facebook'), instagram: await syncChannel('instagram') };
}

// A reply, within the 24 hours Meta allows after the customer's last message.
async function sendMessage(conv, body) {
  var a = await access(conv.channel);
  if (!a) throw new Error(conv.channel + ' isn\'t connected.');
  try {
    var r = await graph('/' + a.pageId + '/messages', a.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: conv.contact_key }, messaging_type: 'RESPONSE', message: { text: body } })
    });
    return { externalId: r.message_id || null };
  } catch (e) {
    var { fail } = require('../utils/errors');
    if (e.metaCode === 10 || /outside of allowed window|24 hours/i.test(e.message)) {
      fail('invalid', 'Meta only allows a reply within 24 hours of the customer\'s last message. Reach them another way, or wait for them to write again.');
    }
    fail('unavailable', e.message);
  }
}

async function status() {
  var out = {};
  for (var ch of ['facebook', 'instagram']) {
    var a = await access(ch);
    var st = (await pool.query('SELECT * FROM crm_channel_state WHERE key = $1', [ch])).rows[0];
    out[ch] = { connected: !!a, messages: !!(a && a.scope.indexOf(NEEDS[ch]) >= 0), lastOkAt: st ? st.last_ok_at : null, lastError: st ? st.last_error : null, items: st ? st.items : 0 };
  }
  return out;
}

// ── the setup check ──────────────────────────────────────────────────
// Integrations → Facebook & Instagram messages: asks Meta, step by step,
// whether the CRM inbox can read the Page's Messenger chats and the
// Instagram account's direct messages, and says which step is not right.
// Each step: { key, state: ok | warn | bad | wait | info | skip, data, error, fix }
// (fix: 'connect' — the Facebook Connect button; 'sync' — read now).
var NEED_FB = ['pages_messaging', 'pages_show_list'];
var NEED_IG = ['instagram_manage_messages', 'instagram_basic', 'pages_manage_metadata'];
function mayCheck(ctx) {
  var { fail } = require('../utils/errors');
  if (!ctx.can('settings.manage') && !ctx.can('marketing.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
}
async function check(ctx) {
  mayCheck(ctx);
  var config = require('../config');
  var steps = [];
  function add(key, state, data, error, fix) { steps.push({ key: key, state: state, data: data || {}, error: error || null, fix: fix || null }); }
  var appToken = config.meta.appId + '|' + config.meta.appSecret;

  if (!config.meta.appId || !config.meta.appSecret) add('app', 'bad', { missing: [!config.meta.appId && 'META_APP_ID', !config.meta.appSecret && 'META_APP_SECRET'].filter(Boolean) });
  else {
    try { var app = await graph('/' + encodeURIComponent(config.meta.appId) + '?fields=id,name', appToken); add('app', 'ok', { name: app.name || '' }); }
    catch (e) { add('app', 'bad', {}, e.message); }
  }

  var fb = await access('facebook');
  var pageInfo = null, scopes = null, lacking = [];
  if (!fb) {
    add('page', 'bad', {}, null, 'connect');
    ['token', 'messenger', 'instagram'].forEach(function (k) { add(k, 'skip'); });
  } else {
    try {
      pageInfo = await graph('/' + fb.pageId + '?fields=' + encodeURIComponent('name,instagram_business_account{id,username}'), fb.token);
      var subscribed = null;
      try {
        var subs = (await graph('/' + fb.pageId + '/subscribed_apps', fb.token)).data || [];
        subscribed = subs.some(function (x) { return String(x.id) === String(config.meta.appId); });
      } catch (e) { subscribed = null; }
      add('page', subscribed === false ? 'warn' : 'ok', { name: pageInfo.name || '', instagram: pageInfo.instagram_business_account ? pageInfo.instagram_business_account.username || '' : null, subscribed: subscribed },
        null, subscribed === false ? 'subscribe' : null);
    } catch (e) { add('page', 'bad', {}, e.message, 'connect'); }

    if (!config.meta.appId || !config.meta.appSecret) add('token', 'skip');
    else {
      try {
        var d = (await graph('/debug_token?input_token=' + encodeURIComponent(fb.token), appToken)).data || {};
        scopes = d.scopes || [];
        var want = NEED_FB.concat(pageInfo && pageInfo.instagram_business_account ? NEED_IG : []);
        lacking = want.filter(function (x) { return scopes.indexOf(x) < 0; });
        add('token', !d.is_valid || lacking.length ? 'bad' : 'ok', { valid: !!d.is_valid, lacking: lacking, configId: !!config.meta.pagesConfigId }, null, !d.is_valid || lacking.length ? 'connect' : null);
      } catch (e) { add('token', 'bad', {}, e.message, 'connect'); }
    }

    try {
      var mc = await graph('/' + fb.pageId + '/conversations?platform=messenger&limit=5&fields=id,updated_time', fb.token);
      add('messenger', 'ok', { seen: (mc.data || []).length, latest: mc.data && mc.data[0] ? mc.data[0].updated_time : null });
    } catch (e) {
      var fbLacks = lacking.filter(function (x) { return NEED_FB.indexOf(x) >= 0; });
      add('messenger', !fbLacks.length && slow(e) ? 'warn' : 'bad', { becauseToken: fbLacks.length > 0, tokenLacks: fbLacks, slow: !fbLacks.length && slow(e) }, e.message);
    }

    var igLinked = pageInfo && pageInfo.instagram_business_account;
    var igRow = await access('instagram');
    if (!igLinked) add('instagram', pageInfo ? 'bad' : 'skip', { noAccount: !!pageInfo });
    else if (!igRow || String(igRow.ownId) !== String(igLinked.id)) add('instagram', 'warn', { notSaved: true, username: igLinked.username || '' }, null, 'connect');
    else {
      try {
        var ic, one = false;
        try { ic = await graph('/' + fb.pageId + '/conversations?platform=instagram&limit=5&fields=id,updated_time', fb.token); }
        catch (e0) {
          if (!slow(e0) || lacking.some(function (x) { return NEED_IG.indexOf(x) >= 0; })) throw e0;
          one = true;
          ic = await patient(function () { return graph('/' + fb.pageId + '/conversations?platform=instagram&limit=1&fields=id,updated_time', fb.token); });
        }
        add('instagram', 'ok', { username: igLinked.username || '', seen: (ic.data || []).length, latest: ic.data && ic.data[0] ? ic.data[0].updated_time : null, oneAtATime: one });
      } catch (e) {
        var igLacks = lacking.filter(function (x) { return NEED_IG.indexOf(x) >= 0; });
        add('instagram', !igLacks.length && slow(e) ? 'warn' : 'bad', { username: igLinked.username || '', becauseToken: igLacks.length > 0, tokenLacks: igLacks, slow: !igLacks.length && slow(e) }, e.message);
      }
    }
  }

  // App Review: Meta does not say through the API whether the app has
  // advanced access; the step explains what each level lets in.
  add('review', 'info', {});

  // What the 3-minute read has brought in, per channel.
  var states = (await pool.query("SELECT key, last_ok_at, last_run_at, last_error, items FROM crm_channel_state WHERE key IN ('facebook', 'instagram')")).rows;
  var lastIn = (await pool.query(
    "SELECT c.channel, max(m.sent_at) FILTER (WHERE m.direction = 'in') AS t, count(*) FILTER (WHERE m.direction = 'in')::int AS n FROM crm_messages m JOIN crm_conversations c ON c.id = m.conversation_id " +
    "WHERE c.channel IN ('facebook', 'instagram') GROUP BY c.channel")).rows;
  var arriving = {};
  ['facebook', 'instagram'].forEach(function (ch) {
    var st = states.find(function (x) { return x.key === ch; }) || null;
    var li = lastIn.find(function (x) { return x.channel === ch; }) || null;
    arriving[ch] = { lastReadAt: st ? st.last_ok_at : null, error: st && st.last_error && (!st.last_ok_at || new Date(st.last_run_at) > new Date(st.last_ok_at)) ? st.last_error : null,
      received: li ? li.n : 0, lastCustomerAt: li ? li.t : null,
      // Connected before the OS asked for messages: the 3-minute read leaves it alone.
      notAsked: !!(fb && fb.scope.indexOf(NEEDS[ch]) < 0) };
  });
  var anyErr = arriving.facebook.error || arriving.instagram.error;
  var anyRead = arriving.facebook.lastReadAt || arriving.instagram.lastReadAt;
  var noneAsked = arriving.facebook.notAsked && arriving.instagram.notAsked;
  add('arriving', anyErr ? 'bad' : anyRead ? 'ok' : 'wait', arriving, null, fb && !noneAsked ? 'sync' : null);

  return { steps: steps, ready: !steps.some(function (x) { return x.state === 'bad'; }), checkedAt: new Date() };
}

// "Read messages now": the 3-minute read at once, then the check again.
async function syncNow(ctx) {
  mayCheck(ctx);
  var r = await sync();
  return Object.assign(await check(ctx), { synced: r });
}

// "Subscribe the app to the Page" (the check's button).
async function subscribe(ctx) {
  mayCheck(ctx);
  var fb = await access('facebook');
  if (!fb) { var { fail } = require('../utils/errors'); fail('invalid', 'Connect the Facebook Page first.'); }
  await subscribePage(fb.pageId, fb.token);
  return check(ctx);
}

// "Bring in older chats": the read normally takes what changed since it
// last ran (30 days the first time); this moves that back, then reads.
// Messages already kept are not kept twice (crmInbox.ingest).
var HISTORY_MONTHS = [3, 6, 12, 24];
async function readOlder(ctx, p) {
  mayCheck(ctx);
  var months = Number(p && p.months);
  if (HISTORY_MONTHS.indexOf(months) < 0) { var { fail } = require('../utils/errors'); fail('invalid', 'Choose 3, 6, 12 or 24 months.'); }
  var since = new Date(); since.setMonth(since.getMonth() - months);
  for (var ch of ['facebook', 'instagram']) {
    await pool.query(
      'INSERT INTO crm_channel_state (key, cursor) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET cursor = LEAST(COALESCE(crm_channel_state.cursor, $2), $2)',
      [ch, since.toISOString()]);
  }
  var r = await sync();
  return Object.assign(await check(ctx), { synced: r, months: months });
}

module.exports = { canSend: canSend, sync: sync, syncChannel: syncChannel, sendMessage: sendMessage, status: status, check: check, syncNow: syncNow, readOlder: readOlder, subscribe: subscribe, subscribePage: subscribePage, setFetchForTests: setFetchForTests };
