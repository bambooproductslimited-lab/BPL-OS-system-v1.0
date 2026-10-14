/*
 * A restaurant's message inbox, in its Guest CRM: guests' WhatsApp messages
 * to the restaurant's own number, and Messenger and Instagram direct
 * messages to its own Page and account. Staff read and answer them in the
 * OS, and each chat is put with the guest it is from (by phone number for
 * WhatsApp), next to their orders and feedback.
 *
 * Where messages come from — the same pieces as Bamboo Products' CRM inbox,
 * pointed at the restaurant:
 *   - WhatsApp: the restaurant's number, connected here with Meta's Embedded
 *     Signup (company_whatsapp). Meta sends every number's messages to the
 *     one webhook (whatsapp.service.js), which hands those sent to a
 *     restaurant's number to takeWhatsapp(). With the number kept in the
 *     WhatsApp Business app, replies typed on the phone and the past chats
 *     come too.
 *   - Facebook and Instagram: the restaurant's Page and account connected on
 *     the Social tracker. crmMeta.service.js reads them every few minutes
 *     (syncAll) and takes their webhook deliveries, with a target saying
 *     whose they are (metaTarget).
 * Restaurant messages never go into the sales CRM (crm_conversations): they
 * are guests, not leads, and restaurant staff answer them.
 *
 * Who: restaurant.read sees a restaurant's inbox; restaurant.manage answers,
 * closes chats and puts them with guests; connecting the WhatsApp number
 * takes restaurant.manage or settings.manage. Staff of the restaurant
 * (restaurant.read or .manage, in one of its departments) are told when a
 * guest writes and is waiting for an answer.
 */
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var config = require('../config');

var GRAPH = 'https://graph.facebook.com/v21.0';
var CHANNELS = ['whatsapp', 'facebook', 'instagram'];
var NAMES = { whatsapp: 'WhatsApp', facebook: 'Messenger', instagram: 'Instagram' };
var REPLY_HOURS = 24;   // Meta allows a free reply this long after the guest's last message
var OLD_DAYS = 7;       // past chats that ended longer ago are filed as closed
var MAX_BODY = 4096;

var fetcher = null; // tests replace Meta
function setFetchForTests(fn) { fetcher = fn; }

function str(v, max) { v = v == null ? '' : String(v).trim(); return max ? v.slice(0, max) : v; }
function preview(body) { return str(body).replace(/\s+/g, ' ').slice(0, 160); }
function canRead(ctx) { if (!ctx.can('restaurant.read') && !ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.read).'); }
function canManage(ctx) { if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).'); }
function canConnect(ctx) { if (!ctx.can('restaurant.manage') && !ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).'); }
function me(ctx) { return ctx && ctx.employee ? ctx.employee.id : null; }

// The same form as the database's restaurant_phone_key (233XXXXXXXXX).
function phoneKey(p) {
  var d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.indexOf('00') === 0) return d.slice(2);
  if (d.length === 10 && d[0] === '0') return '233' + d.slice(1);
  if (d.length === 9) return '233' + d;
  return d;
}
function phoneLabel(k) {
  if (/^233\d{9}$/.test(k)) return '+233 ' + k.slice(3, 5) + ' ' + k.slice(5, 8) + ' ' + k.slice(8);
  return k ? '+' + k : '';
}

async function company(companyId) {
  if (!companyId) fail('invalid', 'Choose a restaurant.');
  var c = (await pool.query('SELECT id, code, name FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!c) fail('notfound', 'Restaurant not found.');
  if (c.code === 'BPL') fail('invalid', 'Bamboo Products\' messages are in the CRM inbox.');
  return c;
}

// ── keeping messages ─────────────────────────────────────────────────
// input: { channel, threadId, imported?, contact: { name, handles: [{ kind, value, label }] },
//          messages: [{ externalId, direction, author, body, attachments, sentAt, sentBy }] }
// A message seen twice is kept once. Returns { conversationId, added, addedIn }.
async function ingest(companyId, input) {
  var channel = input.channel;
  if (CHANNELS.indexOf(channel) < 0) fail('invalid', 'Unknown channel.');
  var threadId = str(input.threadId, 300);
  if (!threadId) fail('invalid', 'The chat has no id.');
  var h = ((input.contact && input.contact.handles) || [])[0] || {};
  var key = channel === 'whatsapp' ? phoneKey(h.value) : str(h.value, 200);
  var handle = channel === 'whatsapp' ? phoneLabel(key) : (/^@/.test(h.label || '') ? str(h.label, 200) : '');
  var name = str(input.contact && input.contact.name, 200);
  var imported = !!input.imported;
  var out = { conversationId: null, added: 0, addedIn: 0 };
  var told = null;
  await withTransaction(async function (db) {
    var conv = (await db.query(
      'INSERT INTO restaurant_conversations (company_id, channel, external_thread_id, contact_key, contact_name, contact_handle, imported) VALUES ($1,$2,$3,$4,$5,$6,$7) ' +
      'ON CONFLICT (company_id, channel, external_thread_id) DO UPDATE SET ' +
      "contact_name = CASE WHEN EXCLUDED.contact_name <> '' THEN EXCLUDED.contact_name ELSE restaurant_conversations.contact_name END, " +
      "contact_handle = CASE WHEN EXCLUDED.contact_handle <> '' THEN EXCLUDED.contact_handle ELSE restaurant_conversations.contact_handle END, " +
      "contact_key = CASE WHEN restaurant_conversations.contact_key = '' THEN EXCLUDED.contact_key ELSE restaurant_conversations.contact_key END " +
      'RETURNING *, (xmax = 0) AS fresh',
      [companyId, channel, threadId, key, name || handle, handle, imported])).rows[0];
    out.conversationId = conv.id;
    var wasWaiting = conv.last_direction === 'in' && conv.status === 'open';
    for (var m of input.messages || []) {
      var sentAt = new Date(m.sentAt || Date.now());
      if (isNaN(sentAt.getTime())) sentAt = new Date();
      var r = (await db.query(
        'INSERT INTO restaurant_messages (conversation_id, external_id, direction, author_name, body, attachments, sent_at, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ' +
        'ON CONFLICT (conversation_id, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id',
        [conv.id, m.externalId ? String(m.externalId) : null, m.direction === 'out' ? 'out' : 'in', str(m.author, 200), str(m.body, MAX_BODY),
          JSON.stringify((m.attachments || []).slice(0, 20)), sentAt, m.sentBy || null])).rows[0];
      if (!r) continue;
      out.added++;
      if (m.direction !== 'out') out.addedIn++;
    }
    if (!out.added) return;
    var last = (await db.query('SELECT direction, body, attachments, sent_at FROM restaurant_messages WHERE conversation_id = $1 ORDER BY sent_at DESC, created_at DESC LIMIT 1', [conv.id])).rows[0];
    var live = out.addedIn > 0 && !imported;
    await db.query(
      'UPDATE restaurant_conversations SET message_count = (SELECT count(*) FROM restaurant_messages WHERE conversation_id = $1), ' +
      'last_message_at = $2, last_direction = $3, last_preview = $4, unread = unread + $5, ' +
      "status = CASE WHEN $6 THEN 'open' ELSE status END, imported = imported AND NOT $6 WHERE id = $1",
      [conv.id, last.sent_at, last.direction, preview(last.body) || '[' + ((last.attachments[0] && last.attachments[0].name) || 'attachment') + ']', live ? out.addedIn : 0, live]);
    // Put with the guest who has that number.
    if (!conv.guest_id && channel === 'whatsapp' && key) {
      var g = (await db.query('SELECT id FROM restaurant_guests WHERE company_id = $1 AND phone_key = $2 ORDER BY created_at LIMIT 1', [companyId, key])).rows[0];
      if (g) await db.query('UPDATE restaurant_conversations SET guest_id = $2 WHERE id = $1', [conv.id, g.id]);
    }
    if (live && !wasWaiting && last.direction === 'in') told = { conv: conv, body: last.body };
  });
  if (told) {
    try { await tellStaff(companyId, told.conv, told.body); } catch (e) { console.error('[restaurant inbox] staff not told:', e.message); }
  }
  return out;
}

// The restaurant's own staff who see its guests: told when a guest writes
// and is waiting for an answer (once, not for every message).
async function tellStaff(companyId, conv, body) {
  var c = (await pool.query('SELECT code, name FROM companies WHERE id = $1', [companyId])).rows[0];
  var staff = (await pool.query(
    'SELECT DISTINCT e.id FROM employees e JOIN departments d ON d.id = e.department_id JOIN users u ON u.employee_id = e.id ' +
    'JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id ' +
    "WHERE d.company_id = $1 AND e.status = 'active' AND u.status = 'active' AND rp.permission_key IN ('restaurant.read', 'restaurant.manage')",
    [companyId])).rows;
  var who = conv.contact_name || conv.contact_handle || 'A guest';
  for (var s of staff) {
    await notify(pool, s.id, NAMES[conv.channel] + ' from ' + who + ' (' + c.name + ')', preview(body), '/restaurantcrm?restaurant=' + encodeURIComponent(c.code) + '&view=inbox&open=' + conv.id);
  }
}

// ── WhatsApp ─────────────────────────────────────────────────────────
// The restaurant whose number a delivery was sent to, or null.
async function companyForNumber(phoneNumberId) {
  return (await pool.query(
    'SELECT w.*, c.id, c.code, c.name FROM company_whatsapp w JOIN companies c ON c.id = w.company_id WHERE w.phone_number_id = $1', [String(phoneNumberId)])).rows[0] || null;
}

// One webhook change for a restaurant's number (whatsapp.service.js):
// guests' messages, replies typed on the phone, names saved on the phone,
// and the past chats.
async function takeWhatsapp(co, value) {
  var wa = require('./whatsapp.service');
  var phoneAuthor = co.name + ' (phone)';
  for (var s of value.state_sync || []) {
    if (!s || s.type !== 'contact' || !s.contact) continue;
    var k = phoneKey(s.contact.phone_number);
    var nm = str(s.contact.full_name || s.contact.first_name, 200);
    if (k && nm && s.action !== 'remove') {
      await pool.query("UPDATE restaurant_conversations SET contact_name = $3 WHERE company_id = $1 AND channel = 'whatsapp' AND contact_key = $2", [co.id, k, nm]);
    }
  }
  for (var e of value.message_echoes || []) {
    var to = wa.waNumber(e && e.to);
    if (!to) continue;
    var de = wa.describe(e);
    await ingest(co.id, { channel: 'whatsapp', threadId: to, contact: { name: '', handles: [{ kind: 'phone', value: to }] },
      messages: [{ externalId: e.id, direction: 'out', author: phoneAuthor, body: de.body, attachments: de.attachments, sentAt: wa.when(e.timestamp) }] });
  }
  for (var hh of value.history || []) {
    for (var t of (hh && hh.threads) || []) {
      var them = wa.waNumber(t && t.id);
      if (!them) continue;
      var msgs = (t.messages || []).map(function (m) {
        var d = wa.describe(m);
        var mine = wa.waNumber(m.from) !== them;
        return { externalId: m.id, direction: mine ? 'out' : 'in', author: mine ? phoneAuthor : '', body: d.body, attachments: d.attachments, sentAt: wa.when(m.timestamp) };
      });
      if (!msgs.length) continue;
      var r = await ingest(co.id, { channel: 'whatsapp', threadId: them, imported: true, contact: { name: '', handles: [{ kind: 'phone', value: them }] }, messages: msgs });
      await pool.query("UPDATE restaurant_conversations SET status = 'closed' WHERE id = $1 AND imported AND status = 'open' AND last_message_at < now() - make_interval(days => $2)", [r.conversationId, OLD_DAYS]);
    }
  }
  var names = {};
  (value.contacts || []).forEach(function (c) { names[c.wa_id] = c.profile && c.profile.name; });
  for (var m of value.messages || []) {
    var d = wa.describe(m);
    await ingest(co.id, { channel: 'whatsapp', threadId: m.from, contact: { name: names[m.from] || '', handles: [{ kind: 'phone', value: m.from }] },
      messages: [{ externalId: m.id, direction: 'in', author: names[m.from] || '', body: d.body, attachments: d.attachments, sentAt: wa.when(m.timestamp) }] });
  }
}

async function graph(path, token, opts) {
  var o = Object.assign({ headers: {} }, opts || {});
  if (token) o.headers = Object.assign({ Authorization: 'Bearer ' + token }, o.headers);
  var res = await (fetcher || fetch)(GRAPH + path, o);
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok || data.error) {
    var e = new Error((data.error && (data.error.error_user_msg || data.error.message)) || ('Meta answered ' + res.status));
    e.metaCode = data.error && data.error.code;
    throw e;
  }
  return data;
}

// ── Facebook and Instagram ───────────────────────────────────────────
async function metaKeys(companyId) {
  var rows = (await pool.query("SELECT platform, key FROM marketing_channels WHERE company_id = $1 AND platform IN ('facebook', 'instagram') ORDER BY created_at", [companyId])).rows;
  var keys = { facebook: null, instagram: null };
  rows.forEach(function (r) { if (!keys[r.platform]) keys[r.platform] = r.key; });
  return keys;
}
// Where crmMeta.service.js puts a restaurant's Messenger and Instagram chats.
async function metaTarget(companyId) {
  var c = (await pool.query('SELECT code FROM companies WHERE id = $1', [companyId])).rows[0];
  return {
    keys: await metaKeys(companyId),
    statePrefix: 'restaurant:' + (c ? c.code : companyId),
    ingest: function (input) { return ingest(companyId, input); },
    knownThread: async function (channel, them) {
      var r = (await pool.query('SELECT external_thread_id FROM restaurant_conversations WHERE company_id = $1 AND channel = $2 AND contact_key = $3 ORDER BY created_at DESC LIMIT 1', [companyId, channel, them])).rows[0];
      return r ? r.external_thread_id : null;
    }
  };
}
// The 3-minute read (jobs/crm.js): every restaurant with a Page connected.
async function syncAll(opts) {
  var meta = require('./crmMeta.service');
  var rows = (await pool.query(
    "SELECT DISTINCT ch.company_id FROM marketing_oauth_tokens t JOIN marketing_channels ch ON ch.key = t.channel_key " +
    "JOIN companies co ON co.id = ch.company_id WHERE ch.platform = 'facebook' AND t.channel_key <> 'facebook' AND co.code <> 'BPL'")).rows;
  var out = {};
  for (var r of rows) {
    var target = await metaTarget(r.company_id);
    out[r.company_id] = {};
    for (var ch of ['facebook', 'instagram']) {
      out[r.company_id][ch] = !(opts && opts.force) && await meta.pausedForSlow(ch, target) ? { skipped: 'Meta was slow; tried again later' } : await meta.syncChannel(ch, target);
    }
  }
  return out;
}

// ── the inbox ────────────────────────────────────────────────────────
function within(conv) {
  return !!(conv.last_in_at && Date.now() - new Date(conv.last_in_at).getTime() < REPLY_HOURS * 3600000);
}
function convOut(r) {
  return {
    id: r.id, channel: r.channel, contactName: r.contact_name, contactHandle: r.contact_handle, contactKey: r.channel === 'whatsapp' ? r.contact_key : null,
    guest: r.guest_id ? { id: r.guest_id, name: r.guest_name, phone: r.guest_phone } : null,
    status: r.status, unread: r.unread, waiting: r.status === 'open' && r.last_direction === 'in',
    lastMessageAt: r.last_message_at, lastDirection: r.last_direction, lastPreview: r.last_preview, messageCount: r.message_count,
    imported: r.imported, lastInAt: r.last_in_at, canReply: within(r)
  };
}
var CONV_SELECT = 'SELECT c.*, g.name AS guest_name, g.phone AS guest_phone, ' +
  "(SELECT max(sent_at) FROM restaurant_messages m WHERE m.conversation_id = c.id AND m.direction = 'in') AS last_in_at " +
  'FROM restaurant_conversations c LEFT JOIN restaurant_guests g ON g.id = c.guest_id ';

// GET /api/restaurant-inbox?companyId&status=open|waiting|closed|all&channel&q&guestId
async function list(ctx, q) {
  canRead(ctx);
  q = q || {};
  var co = await company(q.companyId);
  var args = [co.id], where = ['c.company_id = $1'];
  var status = q.status || 'open';
  if (status === 'open') where.push("c.status = 'open'");
  else if (status === 'waiting') where.push("c.status = 'open' AND c.last_direction = 'in'");
  else if (status === 'closed') where.push("c.status = 'closed'");
  if (q.channel && CHANNELS.indexOf(q.channel) >= 0) { args.push(q.channel); where.push('c.channel = $' + args.length); }
  if (q.guestId) { args.push(q.guestId); where.push('c.guest_id = $' + args.length); }
  if (str(q.q)) {
    args.push('%' + str(q.q, 100).toLowerCase() + '%');
    where.push('(lower(c.contact_name) LIKE $' + args.length + ' OR lower(c.contact_handle) LIKE $' + args.length + ' OR lower(c.last_preview) LIKE $' + args.length + ' OR c.contact_key LIKE $' + args.length + ' OR lower(coalesce(g.name, \'\')) LIKE $' + args.length + ')');
  }
  var rows = (await pool.query(CONV_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY c.last_message_at DESC NULLS LAST LIMIT 300', args)).rows;
  var counts = (await pool.query(
    "SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'open' AND last_direction = 'in')::int AS waiting, " +
    "count(*) FILTER (WHERE status = 'closed')::int AS closed, count(*)::int AS all, coalesce(sum(unread), 0)::int AS unread, " +
    "count(*) FILTER (WHERE channel = 'whatsapp')::int AS whatsapp, count(*) FILTER (WHERE channel = 'facebook')::int AS facebook, count(*) FILTER (WHERE channel = 'instagram')::int AS instagram, " +
    "count(*) FILTER (WHERE guest_id IS NULL)::int AS unlinked FROM restaurant_conversations WHERE company_id = $1", [co.id])).rows[0];
  return { company: { id: co.id, code: co.code, name: co.name }, conversations: rows.map(convOut), counts: counts, connections: await connectionsOf(ctx, co) };
}

async function row(id) {
  var r = (await pool.query(CONV_SELECT + 'WHERE c.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Chat not found.');
  return r;
}

// GET /api/restaurant-inbox/:id — the chat (marked read), and the guest's
// orders at a glance.
async function get(ctx, id) {
  canRead(ctx);
  var r = await row(id);
  if (r.unread) await pool.query('UPDATE restaurant_conversations SET unread = 0 WHERE id = $1', [id]);
  r.unread = 0;
  var msgs = (await pool.query(
    "SELECT m.*, e.first_name || ' ' || e.last_name AS sent_by_name FROM restaurant_messages m LEFT JOIN employees e ON e.id = m.sent_by " +
    'WHERE m.conversation_id = $1 ORDER BY m.sent_at DESC, m.created_at DESC LIMIT 300', [id])).rows.reverse();
  var o = convOut(r);
  o.messages = msgs.map(function (m) {
    return { id: m.id, direction: m.direction, author: m.sent_by_name || m.author_name, body: m.body, attachments: m.attachments, sentAt: m.sent_at, fromOs: !!m.sent_by };
  });
  if (r.guest_id) {
    var g = (await pool.query(
      'SELECT (SELECT count(*) FROM restaurant_guest_orders o WHERE o.guest_id = $1)::int + (SELECT count(*) FROM restaurant_orders o WHERE o.guest_id = $1)::int AS orders, ' +
      'greatest((SELECT max(ordered_on) FROM restaurant_guest_orders o WHERE o.guest_id = $1), (SELECT max(created_at)::date FROM restaurant_orders o WHERE o.guest_id = $1)) AS last_order, ' +
      '(SELECT round(avg(rating)::numeric, 1) FROM restaurant_guest_orders o WHERE o.guest_id = $1 AND rating IS NOT NULL) AS rating', [r.guest_id])).rows[0];
    o.guest.orders = g.orders; o.guest.lastOrder = g.last_order; o.guest.rating = g.rating == null ? null : Number(g.rating);
  }
  return o;
}

// POST /api/restaurant-inbox/:id/reply { body } — out on the same channel,
// within the 24 hours Meta allows after the guest's last message.
async function reply(ctx, id, p) {
  canManage(ctx);
  var body = str(p && p.body, MAX_BODY);
  if (!body) fail('invalid', 'Write the reply first.');
  var r = await row(id);
  var co = await company(r.company_id);
  if (!within(r)) fail('invalid', 'Meta only allows a reply within 24 hours of the guest\'s last message. Call them, or wait for them to write again.');
  var externalId = null;
  if (r.channel === 'whatsapp') {
    var w = (await pool.query('SELECT phone_number_id, access_token FROM company_whatsapp WHERE company_id = $1', [co.id])).rows[0];
    if (!w) fail('invalid', co.name + '\'s WhatsApp number isn\'t connected. Connect it in the inbox first.');
    try {
      var sent = await graph('/' + w.phone_number_id + '/messages', w.access_token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: r.contact_key, type: 'text', text: { body: body } }) });
      externalId = sent.messages && sent.messages[0] ? sent.messages[0].id : null;
    } catch (e) {
      if (e.metaCode === 131047) fail('invalid', 'Meta only allows a reply within 24 hours of the guest\'s last message. Call them, or wait for them to write again.');
      fail('unavailable', 'WhatsApp did not send it: ' + e.message);
    }
  } else {
    var keys = await metaKeys(co.id);
    var out = await require('./crmMeta.service').sendMessage({ channel: r.channel, contact_key: r.contact_key }, body, keys);
    externalId = out.externalId;
  }
  var author = ctx.employee ? ((ctx.employee.first_name || ctx.employee.firstName || '') + ' ' + (ctx.employee.last_name || ctx.employee.lastName || '')).trim() : '';
  await ingest(co.id, { channel: r.channel, threadId: r.external_thread_id, contact: { name: '', handles: [] },
    messages: [{ externalId: externalId, direction: 'out', author: author, body: body, sentAt: new Date(), sentBy: me(ctx) }] });
  await audit(pool, ctx, 'restaurant.inbox.reply', 'restaurant_conversation', id, 'Replied on ' + NAMES[r.channel] + ' to ' + (r.contact_name || r.contact_handle) + ' for ' + co.name + '.');
  return get(ctx, id);
}

// POST /api/restaurant-inbox/:id/status { status: open | closed }
async function setStatus(ctx, id, p) {
  canManage(ctx);
  var status = p && p.status;
  if (['open', 'closed'].indexOf(status) < 0) fail('invalid', 'Open or closed?');
  await row(id);
  await pool.query('UPDATE restaurant_conversations SET status = $2, unread = CASE WHEN $2 = \'closed\' THEN 0 ELSE unread END WHERE id = $1', [id, status]);
  return get(ctx, id);
}

// POST /api/restaurant-inbox/:id/guest { guestId } | { create: true, name, phone }
// — put the chat with a guest of the restaurant, or make them one.
async function linkGuest(ctx, id, p) {
  canManage(ctx);
  var r = await row(id);
  var guestId = null;
  if (p && p.guestId) {
    var g = (await pool.query('SELECT id FROM restaurant_guests WHERE id = $1 AND company_id = $2', [p.guestId, r.company_id])).rows[0];
    if (!g) fail('invalid', 'That guest is not this restaurant\'s.');
    guestId = g.id;
  } else if (p && p.create) {
    var name = str(p.name, 100) || r.contact_name || r.contact_handle;
    var phone = str(p.phone, 40) || (r.channel === 'whatsapp' ? r.contact_key : '');
    if (!name) fail('invalid', 'Give the guest a name.');
    guestId = await withTransaction(async function (db) {
      var made = await require('./restaurantCrm.service').findOrCreateGuest(db, r.company_id, { name: name, phone: phone }, 'message');
      return made.id;
    });
  } else if (p && p.guestId === null) {
    guestId = null;
  } else fail('invalid', 'Choose the guest.');
  await pool.query('UPDATE restaurant_conversations SET guest_id = $2 WHERE id = $1', [id, guestId]);
  // The guest's other chats with the same number come along.
  if (guestId && r.channel === 'whatsapp' && r.contact_key) {
    await pool.query("UPDATE restaurant_conversations SET guest_id = $3 WHERE company_id = $1 AND channel = 'whatsapp' AND contact_key = $2 AND guest_id IS NULL", [r.company_id, r.contact_key, guestId]);
  }
  await audit(pool, ctx, 'restaurant.inbox.guest', 'restaurant_conversation', id, guestId ? 'Put a chat with a guest.' : 'Took a chat off its guest.');
  return get(ctx, id);
}

// ── connections ──────────────────────────────────────────────────────
function waRow(w) {
  if (!w) return null;
  return { displayPhone: w.display_phone, verifiedName: w.verified_name, coexistence: w.coexistence, connectedAt: w.connected_at, connectedBy: w.connected_by_name || null, phoneNumberId: w.phone_number_id, lastError: w.last_error };
}
async function connectionsOf(ctx, co) {
  var w = (await pool.query("SELECT w.*, e.first_name || ' ' || e.last_name AS connected_by_name FROM company_whatsapp w LEFT JOIN employees e ON e.id = w.connected_by WHERE w.company_id = $1", [co.id])).rows[0];
  var keys = await metaKeys(co.id);
  var meta = require('./crmMeta.service');
  var out = {
    whatsapp: {
      connection: waRow(w),
      ready: !!(config.meta.appId && config.meta.appSecret && config.meta.waConfigId && config.whatsapp.verifyToken),
      appId: config.meta.appId || null, configId: config.meta.waConfigId || null,
      canConnect: ctx.can('restaurant.manage') || ctx.can('settings.manage')
    }
  };
  for (var ch of ['facebook', 'instagram']) {
    var a = keys.facebook ? await meta.access(ch, keys) : null;
    var st = (await pool.query('SELECT last_ok_at, last_error FROM crm_channel_state WHERE key = $1', ['restaurant:' + co.code + ':' + ch])).rows[0];
    out[ch] = { connected: !!a, messages: !!(a && a.scope.indexOf(meta.NEEDS[ch]) >= 0), lastReadAt: st ? st.last_ok_at : null, lastError: st ? st.last_error : null };
  }
  var lastIn = (await pool.query(
    "SELECT c.channel, max(m.sent_at) AS t FROM restaurant_messages m JOIN restaurant_conversations c ON c.id = m.conversation_id WHERE c.company_id = $1 AND m.direction = 'in' GROUP BY c.channel", [co.id])).rows;
  lastIn.forEach(function (x) { if (out[x.channel]) out[x.channel].lastGuestAt = x.t; });
  out.canTracker = ctx.can('marketing.manage');
  return out;
}

// POST /api/restaurant-inbox/whatsapp { companyId, code, wabaId, phoneNumberId, coexistence }
// — Meta's Embedded Signup done in the browser (as on Integrations).
async function connectWhatsapp(ctx, p) {
  canConnect(ctx);
  var co = await company(p && p.companyId);
  var wc = require('./whatsappConnect.service');
  var su = await wc.signUp(p);
  var bpl = (await pool.query('SELECT phone_number_id FROM whatsapp_connection WHERE id = 1')).rows[0];
  if ((bpl && bpl.phone_number_id === su.phoneId) || (config.whatsapp.phoneNumberId && String(config.whatsapp.phoneNumberId) === su.phoneId)) {
    fail('invalid', 'That is Bamboo Products\' number, used by the CRM inbox. Connect the restaurant\'s own number.');
  }
  var other = (await pool.query('SELECT c.name FROM company_whatsapp w JOIN companies c ON c.id = w.company_id WHERE w.phone_number_id = $1 AND w.company_id <> $2', [su.phoneId, co.id])).rows[0];
  if (other) fail('invalid', 'That number is already connected to ' + other.name + '.');
  await pool.query(
    'INSERT INTO company_whatsapp (company_id, waba_id, phone_number_id, display_phone, verified_name, access_token, coexistence, connected_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ' +
    'ON CONFLICT (company_id) DO UPDATE SET waba_id = EXCLUDED.waba_id, phone_number_id = EXCLUDED.phone_number_id, display_phone = EXCLUDED.display_phone, ' +
    'verified_name = EXCLUDED.verified_name, access_token = EXCLUDED.access_token, coexistence = EXCLUDED.coexistence, connected_by = EXCLUDED.connected_by, ' +
    'connected_at = now(), history_requested_at = NULL, contacts_requested_at = NULL, last_error = NULL',
    [co.id, su.wabaId, su.phoneId, su.num.display_phone_number || '', su.num.verified_name || '', su.token, su.coex, me(ctx)]);
  if (su.coex) {
    var s = await wc.requestSync(su.phoneId, su.token);
    await pool.query('UPDATE company_whatsapp SET contacts_requested_at = $2, history_requested_at = $3, last_error = $4 WHERE company_id = $1', [co.id, s.contacts, s.history, s.error]);
  }
  await audit(pool, ctx, 'restaurant.whatsapp.connect', 'company_whatsapp', su.phoneId,
    'Connected WhatsApp ' + (su.num.display_phone_number || su.phoneId) + ' to ' + co.name + '\'s inbox' + (su.coex ? ' (kept in the WhatsApp Business app)' : '') + '.');
  return list(ctx, { companyId: co.id });
}

// DELETE /api/restaurant-inbox/whatsapp?companyId — the chats stay.
async function disconnectWhatsapp(ctx, companyId) {
  canConnect(ctx);
  var co = await company(companyId);
  var w = (await pool.query('DELETE FROM company_whatsapp WHERE company_id = $1 RETURNING display_phone, phone_number_id', [co.id])).rows[0];
  if (w) await audit(pool, ctx, 'restaurant.whatsapp.disconnect', 'company_whatsapp', w.phone_number_id, 'Disconnected WhatsApp ' + (w.display_phone || w.phone_number_id) + ' from ' + co.name + '\'s inbox.');
  return list(ctx, { companyId: co.id });
}

// POST /api/restaurant-inbox/meta/read { companyId } — read the Page's and
// Instagram's chats now, subscribing the app to the Page first (needed for
// Meta to send new messages as they come).
async function readMetaNow(ctx, p) {
  canConnect(ctx);
  var co = await company(p && p.companyId);
  var meta = require('./crmMeta.service');
  var keys = await metaKeys(co.id);
  var a = keys.facebook ? await meta.access('facebook', keys) : null;
  if (!a) fail('invalid', 'Connect ' + co.name + '\'s Facebook Page on the Social tracker first.');
  var subscribeError = null;
  try { await meta.subscribePage(a.pageId, a.token); } catch (e) { subscribeError = e.message; }
  var target = await metaTarget(co.id);
  var read = { facebook: await meta.syncChannel('facebook', target), instagram: await meta.syncChannel('instagram', target) };
  return Object.assign(await list(ctx, { companyId: co.id }), { read: read, subscribeError: subscribeError });
}

module.exports = {
  list: list, get: get, reply: reply, setStatus: setStatus, linkGuest: linkGuest,
  connectWhatsapp: connectWhatsapp, disconnectWhatsapp: disconnectWhatsapp, readMetaNow: readMetaNow,
  ingest: ingest, takeWhatsapp: takeWhatsapp, companyForNumber: companyForNumber, metaTarget: metaTarget, syncAll: syncAll,
  setFetchForTests: setFetchForTests, phoneKey: phoneKey
};
