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
function setFetchForTests(fn) { fetcher = fn || function (url, opts) { return fetch(url, opts); }; }

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
    var url = '/' + a.pageId + '/conversations?platform=' + PLATFORM[channel] + '&limit=25&fields=' +
      encodeURIComponent('id,updated_time,participants,messages.limit(50){id,message,from,to,created_time,attachments{name,mime_type}}');
    for (var n = 0; n < MAX_PAGES && url; n++) {
      var page = await graph(url, n ? null : a.token);
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

module.exports = { canSend: canSend, sync: sync, syncChannel: syncChannel, sendMessage: sendMessage, status: status, setFetchForTests: setFetchForTests };
