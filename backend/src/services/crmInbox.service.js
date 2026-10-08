/*
 * The CRM inbox: every conversation with a customer, from every channel, in
 * one place, each on the customer's profile.
 *
 * Messages come in through ingest(), whatever the channel — the WhatsApp
 * webhook, the email sync, Facebook and Instagram, a WhatsApp chat export,
 * or a call or visit logged by hand. ingest() keeps the conversation and its
 * messages (a message seen twice is kept once), recognises who wrote by
 * their phone number, email address or social account (customer_identities)
 * and, when nobody has that number or address yet, makes them a customer
 * profile (category "lead", source "crm"), so every person who writes to the
 * company is in the CRM without anyone typing them in. The profile's rep is
 * told when a customer writes again.
 *
 * Who is not made a profile: the company's own staff, and automatic mail
 * (no-reply addresses, mailing lists) — their conversations are kept but
 * left unlinked.
 *
 * Replies written in the OS go out on the same channel (WhatsApp, email,
 * Facebook or Instagram) and are kept on the conversation with who wrote
 * them.
 */
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { internationalNumber } = require('../utils/phone');

var CHANNELS = ['whatsapp', 'email', 'instagram', 'facebook', 'sms', 'call', 'visit', 'other'];
var MANUAL_CHANNELS = ['call', 'visit', 'sms', 'other'];
var KINDS = ['phone', 'email', 'instagram', 'facebook', 'other'];
var MAX_BODY = 20000;
var CHANNEL_NAME = { whatsapp: 'WhatsApp', email: 'email', instagram: 'Instagram', facebook: 'Facebook', sms: 'SMS', call: 'a call', visit: 'a visit', other: 'a message' };

function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function me(ctx) { return ctx && ctx.employee ? ctx.employee.id : null; }
function str(v, max) { v = v == null ? '' : String(v).trim(); return max ? v.slice(0, max) : v; }
function preview(body) { return str(body).replace(/\s+/g, ' ').slice(0, 160); }

// The company whose customers the CRM holds: the one in the CRM settings,
// else Bamboo Products Limited.
async function crmCompanyId(db) {
  var r = (await (db || pool).query(
    "SELECT COALESCE((SELECT company_id FROM crm_settings WHERE id = 1), (SELECT id FROM companies WHERE code = 'BPL' LIMIT 1)) AS id")).rows[0];
  return r ? r.id : null;
}

// ── identities ───────────────────────────────────────────────────────
function isEmail(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim()); }
function phoneLabel(digits) {
  if (/^233\d{9}$/.test(digits)) return '+233 ' + digits.slice(3, 5) + ' ' + digits.slice(5, 8) + ' ' + digits.slice(8);
  return '+' + digits;
}
// { kind, value, label } with value in the form identities are kept in, or
// null when it can't be one (a phone that isn't a number, a broken email).
function normIdentity(h) {
  if (!h || KINDS.indexOf(h.kind) < 0) return null;
  var raw = str(h.value, 300);
  if (!raw) return null;
  if (h.kind === 'phone') {
    var d = internationalNumber(raw);
    return d ? { kind: 'phone', value: d, label: str(h.label, 120) || phoneLabel(d) } : null;
  }
  if (h.kind === 'email') return isEmail(raw) ? { kind: 'email', value: raw.toLowerCase(), label: str(h.label, 200) || raw } : null;
  return { kind: h.kind, value: raw, label: str(h.label, 120) || raw };
}

async function findCustomerByIdentities(db, ids) {
  for (var i = 0; i < ids.length; i++) {
    var r = (await db.query(
      "SELECT c.id FROM customer_identities ci JOIN customers c ON c.id = ci.customer_id WHERE ci.kind = $1 AND ci.value = $2 ORDER BY c.status = 'active' DESC LIMIT 1",
      [ids[i].kind, ids[i].value])).rows[0];
    if (r) return r.id;
  }
  return null;
}
async function addIdentities(db, customerId, ids) {
  for (var i = 0; i < ids.length; i++) {
    await db.query('INSERT INTO customer_identities (customer_id, kind, value, label) VALUES ($1,$2,$3,$4) ON CONFLICT (kind, value) DO NOTHING',
      [customerId, ids[i].kind, ids[i].value, ids[i].label]);
  }
}

// Phones typed on customers before the CRM kept identities, and any added
// since by other screens: each becomes the customer's phone identity (unless
// another customer already has that number — the duplicate scan shows those).
async function backfillIdentities() {
  var rows = (await pool.query(
    "SELECT c.id, c.phone, c.email FROM customers c WHERE c.status = 'active' AND (c.phone <> '' OR c.email <> '') " +
    "AND NOT EXISTS (SELECT 1 FROM customer_identities ci WHERE ci.customer_id = c.id AND ci.kind IN ('phone', 'email'))")).rows;
  var added = 0;
  for (var r of rows) {
    var ids = [];
    String(r.phone || '').split(/[\/,;]| or /).forEach(function (p) { var n = normIdentity({ kind: 'phone', value: p }); if (n) ids.push(n); });
    var e = normIdentity({ kind: 'email', value: r.email });
    if (e) ids.push(e);
    if (!ids.length) continue;
    await addIdentities(pool, r.id, ids);
    added += ids.length;
  }
  return added;
}

// Our own people, and mail no person sent, never become customer profiles.
var AUTOMATED_EMAIL = /(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|newsletter|news|info-noreply)([._+-]|@)/i;
function isAutomatedEmail(addr) { return AUTOMATED_EMAIL.test(String(addr || '')); }
async function isStaff(db, ids) {
  var emails = ids.filter(function (i) { return i.kind === 'email'; }).map(function (i) { return i.value; });
  var phones = ids.filter(function (i) { return i.kind === 'phone'; }).map(function (i) { return i.value; });
  if (emails.length) {
    var e = (await db.query('SELECT 1 FROM employees WHERE lower(email) = ANY($1) UNION ALL SELECT 1 FROM users WHERE lower(email) = ANY($1) LIMIT 1', [emails])).rows[0];
    if (e) return true;
  }
  if (phones.length) {
    var staffPhones = (await db.query("SELECT phone FROM employees WHERE phone <> '' AND status = 'active'")).rows;
    for (var s of staffPhones) { if (phones.indexOf(internationalNumber(s.phone)) >= 0) return true; }
  }
  return false;
}

// ── taking messages in ───────────────────────────────────────────────
// input: { channel, threadId, subject?, imported?, companyId?, customerId?,
//          contact: { name, handles: [{ kind, value, label }] },
//          messages: [{ externalId?, direction: 'in'|'out', author?, body, sentAt, attachments?, sentBy? }] }
// opts:  { noProfile } — keep the conversation but don't make a profile.
async function ingest(input, opts) {
  opts = opts || {};
  if (CHANNELS.indexOf(input.channel) < 0) fail('invalid', 'Unknown channel.');
  var threadId = str(input.threadId, 300);
  if (!threadId) fail('invalid', 'The conversation has no id.');
  var handles = ((input.contact && input.contact.handles) || []).map(normIdentity).filter(Boolean);
  var primary = handles[0] || null;
  var contactName = str(input.contact && input.contact.name, 200);
  var msgs = (input.messages || []).filter(function (m) { return m && (str(m.body) || (m.attachments && m.attachments.length)); });

  var notifyRep = null;
  var result = await withTransaction(async function (db) {
    var companyId = input.companyId || await crmCompanyId(db);
    var before = (await db.query('SELECT * FROM crm_conversations WHERE channel = $1 AND external_thread_id = $2', [input.channel, threadId])).rows[0] || null;
    var conv = (await db.query(
      'INSERT INTO crm_conversations (company_id, channel, external_thread_id, subject, contact_name, contact_label, contact_kind, contact_key, imported) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (channel, external_thread_id) DO UPDATE SET ' +
      "contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''), crm_conversations.contact_name), " +
      "subject = CASE WHEN crm_conversations.subject = '' THEN EXCLUDED.subject ELSE crm_conversations.subject END, " +
      "contact_label = CASE WHEN crm_conversations.contact_label = '' THEN EXCLUDED.contact_label ELSE crm_conversations.contact_label END, " +
      "contact_kind = CASE WHEN crm_conversations.contact_kind = '' THEN EXCLUDED.contact_kind ELSE crm_conversations.contact_kind END, " +
      "contact_key = CASE WHEN crm_conversations.contact_key = '' THEN EXCLUDED.contact_key ELSE crm_conversations.contact_key END " +
      'RETURNING *',
      [companyId, input.channel, threadId, str(input.subject, 300), contactName, primary ? primary.label : '', primary ? primary.kind : '', primary ? primary.value : '', !!input.imported])).rows[0];

    var added = 0, addedIn = 0, lastIn = null, lastOut = null;
    for (var m of msgs) {
      var sentAt = m.sentAt ? new Date(m.sentAt) : new Date();
      if (isNaN(sentAt.getTime())) sentAt = new Date();
      var direction = m.direction === 'out' ? 'out' : 'in';
      var body = str(m.body, MAX_BODY);
      var ext = m.externalId ? str(m.externalId, 300) : null;
      var res;
      if (ext) {
        res = await db.query(
          'INSERT INTO crm_messages (conversation_id, external_id, direction, author_name, body, attachments, sent_at, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ' +
          'ON CONFLICT (conversation_id, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id',
          [conv.id, ext, direction, str(m.author, 200), body, JSON.stringify(m.attachments || []), sentAt, m.sentBy || null]);
      } else {
        // No id from the channel (a chat export, a logged call): the same
        // words at the same moment are the same message.
        var seen = (await db.query('SELECT 1 FROM crm_messages WHERE conversation_id = $1 AND sent_at = $2 AND direction = $3 AND body = $4',
          [conv.id, sentAt, direction, body])).rows[0];
        res = seen ? { rows: [] } : await db.query(
          'INSERT INTO crm_messages (conversation_id, direction, author_name, body, attachments, sent_at, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [conv.id, direction, str(m.author, 200), body, JSON.stringify(m.attachments || []), sentAt, m.sentBy || null]);
      }
      if (res.rows[0]) {
        added++;
        if (direction === 'in') { addedIn++; if (!lastIn || sentAt > lastIn) lastIn = sentAt; } else if (!lastOut || sentAt > lastOut) lastOut = sentAt;
      }
    }
    conv = await refreshConversation(db, conv.id, addedIn > 0);

    // Whose conversation it is.
    var customerId = conv.customer_id;
    var created = false;
    if (input.customerId && !customerId) {
      customerId = input.customerId;
      await db.query('UPDATE crm_conversations SET customer_id = $2 WHERE id = $1', [conv.id, customerId]);
    }
    if (!customerId && !opts.noProfile && handles.length) {
      customerId = await findCustomerByIdentities(db, handles);
      var automated = handles.some(function (h) { return h.kind === 'email' && isAutomatedEmail(h.value); });
      var hasInbound = (await db.query("SELECT 1 FROM crm_messages WHERE conversation_id = $1 AND direction = 'in' LIMIT 1", [conv.id])).rows[0];
      if (!customerId && hasInbound && !automated && !(await isStaff(db, handles))) {
        var phone = handles.find(function (h) { return h.kind === 'phone'; });
        var email = handles.find(function (h) { return h.kind === 'email'; });
        var name = contactName || (phone ? phone.label : email ? email.value : primary.label);
        customerId = (await db.query(
          "INSERT INTO customers (name, phone, email, category, source, origin_channel, company_id) VALUES ($1,$2,$3,'lead','crm',$4,$5) RETURNING id",
          [name.slice(0, 200), phone ? phone.label : '', email ? email.value : '', input.channel, companyId])).rows[0].id;
        created = true;
      }
      if (customerId) await db.query('UPDATE crm_conversations SET customer_id = $2 WHERE id = $1', [conv.id, customerId]);
    }
    if (customerId) {
      await addIdentities(db, customerId, handles);
      await stampCustomer(db, customerId);
      if (addedIn && !input.imported) {
        var quietBefore = !before || !before.last_message_at || before.last_direction === 'out' || new Date(before.last_message_at) < new Date(Date.now() - 3600000);
        var cust = (await db.query('SELECT name, account_manager_id FROM customers WHERE id = $1', [customerId])).rows[0];
        if (quietBefore && cust && cust.account_manager_id) notifyRep = { rep: cust.account_manager_id, name: cust.name, conv: conv.id, last: msgs[msgs.length - 1] };
      }
    }
    return { conversationId: conv.id, customerId: customerId, customerCreated: created, added: added };
  });
  if (notifyRep) {
    try {
      await notify(pool, notifyRep.rep, notifyRep.name + ' wrote on ' + CHANNEL_NAME[input.channel],
        preview(notifyRep.last && notifyRep.last.body) || 'A new message.', '/crminbox?c=' + notifyRep.conv);
    } catch (e) { console.error('[crm] could not notify the rep:', e.message); }
  }
  return result;
}

// The conversation's count, last message and whether it waits for a reply,
// from its messages; a closed conversation opens again when the customer
// writes.
async function refreshConversation(db, id, reopen) {
  return (await db.query(
    'UPDATE crm_conversations c SET message_count = s.n, last_message_at = s.at, last_direction = s.dir, last_preview = s.pv' +
    (reopen ? ", status = CASE WHEN c.status = 'closed' THEN 'open' ELSE c.status END" : '') + ' ' +
    'FROM (SELECT count(*)::int AS n, max(sent_at) AS at, ' +
    '  (SELECT direction FROM crm_messages WHERE conversation_id = $1 ORDER BY sent_at DESC, created_at DESC LIMIT 1) AS dir, ' +
    "  COALESCE((SELECT left(regexp_replace(body, '\\s+', ' ', 'g'), 160) FROM crm_messages WHERE conversation_id = $1 ORDER BY sent_at DESC, created_at DESC LIMIT 1), '') AS pv " +
    '  FROM crm_messages WHERE conversation_id = $1) s WHERE c.id = $1 RETURNING c.*', [id])).rows[0];
}

// The customer's last contact, from all their conversations.
async function stampCustomer(db, customerId) {
  await db.query(
    'UPDATE customers c SET last_contact_at = s.last_any, last_inbound_at = s.last_in, last_outbound_at = s.last_out FROM (' +
    "  SELECT max(m.sent_at) AS last_any, max(m.sent_at) FILTER (WHERE m.direction = 'in') AS last_in, max(m.sent_at) FILTER (WHERE m.direction = 'out') AS last_out " +
    '  FROM crm_messages m JOIN crm_conversations cv ON cv.id = m.conversation_id WHERE cv.customer_id = $1) s WHERE c.id = $1', [customerId]);
}

// ── reading ──────────────────────────────────────────────────────────
function like(q) { return '%' + String(q || '').trim().replace(/[\\%_]/g, '\\$&') + '%'; }

function rowToConversation(r) {
  return {
    id: r.id, channel: r.channel, subject: r.subject, status: r.status, imported: r.imported,
    contact: { name: r.contact_name, label: r.contact_label, kind: r.contact_kind, key: r.contact_key },
    customer: r.customer_id ? { id: r.customer_id, name: r.customer_name, repId: r.rep_id || null, repName: r.rep_first ? r.rep_first + ' ' + r.rep_last : null } : null,
    messageCount: r.message_count, lastMessageAt: r.last_message_at, lastDirection: r.last_direction, lastPreview: r.last_preview,
    waiting: r.last_direction === 'in' && r.status === 'open'
  };
}
var CONV_SQL = 'SELECT cv.*, c.name AS customer_name, c.account_manager_id AS rep_id, e.first_name AS rep_first, e.last_name AS rep_last ' +
  'FROM crm_conversations cv LEFT JOIN customers c ON c.id = cv.customer_id LEFT JOIN employees e ON e.id = c.account_manager_id ';

async function listConversations(ctx, q) {
  need(ctx, 'crm.read');
  q = q || {};
  var where = ['true'], args = [];
  function arg(v) { args.push(v); return '$' + args.length; }
  if (q.channel && CHANNELS.indexOf(q.channel) >= 0) where.push('cv.channel = ' + arg(q.channel));
  if (q.status === 'all') { /* every status */ } else where.push('cv.status = ' + arg(['open', 'closed', 'spam'].indexOf(q.status) >= 0 ? q.status : 'open'));
  if (q.waiting === '1' || q.waiting === true) where.push("cv.last_direction = 'in'");
  if (q.unlinked === '1' || q.unlinked === true) where.push('cv.customer_id IS NULL');
  if (q.mine === '1' || q.mine === true) where.push('c.account_manager_id = ' + arg(me(ctx)));
  if (q.customerId) where.push('cv.customer_id = ' + arg(q.customerId));
  if (q.search) {
    var s = arg(like(q.search));
    where.push('(cv.contact_name ILIKE ' + s + ' OR cv.contact_label ILIKE ' + s + ' OR c.name ILIKE ' + s + ' OR cv.last_preview ILIKE ' + s + ' OR cv.subject ILIKE ' + s + ')');
  }
  var limit = Math.min(300, Math.max(1, Number(q.limit) || 100));
  var rows = (await pool.query(CONV_SQL + 'WHERE ' + where.join(' AND ') + ' ORDER BY cv.last_message_at DESC NULLS LAST LIMIT ' + limit, args)).rows;
  var counts = (await pool.query(
    "SELECT channel, count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'open' AND last_direction = 'in')::int AS waiting, " +
    "count(*) FILTER (WHERE status = 'open' AND customer_id IS NULL)::int AS unlinked FROM crm_conversations GROUP BY channel")).rows;
  return { conversations: rows.map(rowToConversation), counts: counts };
}

async function getConversation(ctx, id) {
  need(ctx, 'crm.read');
  var r = (await pool.query(CONV_SQL + 'WHERE cv.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Conversation not found.');
  var messages = (await pool.query(
    "SELECT m.*, e.first_name || ' ' || e.last_name AS sent_by_name FROM crm_messages m LEFT JOIN employees e ON e.id = m.sent_by " +
    'WHERE m.conversation_id = $1 ORDER BY m.sent_at, m.created_at LIMIT 1000', [id])).rows;
  return Object.assign(rowToConversation(r), {
    canReply: await replyChannel(r) !== null,
    messages: messages.map(function (m) {
      return { id: m.id, direction: m.direction, author: m.author_name, body: m.body, attachments: m.attachments || [], sentAt: m.sent_at, sentBy: m.sent_by ? { id: m.sent_by, name: m.sent_by_name } : null };
    })
  });
}

// ── replying ─────────────────────────────────────────────────────────
// How a reply goes out on this conversation's channel, or null when it
// can't from the OS (the channel isn't set up, or it is a logged call).
async function replyChannel(conv) {
  var config = require('../config');
  if (conv.channel === 'whatsapp') return require('./whatsappAccess').configured() ? 'whatsapp' : null;
  if (conv.channel === 'email') return (await require('./crmMailbox.service').canSend()) && isEmail(conv.contact_key || conv.contact_label) ? 'email' : null;
  if (conv.channel === 'facebook' || conv.channel === 'instagram') return (await require('./crmMeta.service').canSend(conv.channel)) ? conv.channel : null;
  return null;
}

var senders = null; // tests replace the channels' send functions
function setSendersForTests(s) { senders = s; }

async function reply(ctx, id, p) {
  need(ctx, 'crm.manage');
  var body = str(p && p.body, 4000);
  if (!body) fail('invalid', 'Write the reply first.');
  var conv = (await pool.query('SELECT * FROM crm_conversations WHERE id = $1', [id])).rows[0];
  if (!conv) fail('notfound', 'Conversation not found.');
  var how = senders ? (senders[conv.channel] ? conv.channel : null) : await replyChannel(conv);
  if (!how) {
    fail('invalid', MANUAL_CHANNELS.indexOf(conv.channel) >= 0
      ? 'This is a logged ' + conv.channel + ': add what was said with "Log a call or visit".'
      : CHANNEL_NAME[conv.channel] + ' isn\'t connected for sending yet, so reply on ' + CHANNEL_NAME[conv.channel] + ' itself.');
  }
  var sent;
  if (senders) sent = await senders[how](conv, body);
  else if (how === 'whatsapp') {
    var w = await require('./whatsapp.service').sendMessage(conv.external_thread_id, body);
    sent = { externalId: w && w.messages && w.messages[0] && w.messages[0].id };
  } else if (how === 'email') {
    var lastIn = (await pool.query("SELECT external_id FROM crm_messages WHERE conversation_id = $1 AND direction = 'in' AND external_id IS NOT NULL ORDER BY sent_at DESC, created_at DESC LIMIT 1", [conv.id])).rows[0];
    var subject = conv.subject ? (/^re:/i.test(conv.subject) ? conv.subject : 'Re: ' + conv.subject) : 'Bamboo Products';
    // The thread's first message, then the one answered: the customer's mail
    // app keeps the reply in the thread, and reading it back from the sent
    // folder lands it on this same conversation.
    var root = /^mail:/.test(conv.external_thread_id || '') ? conv.external_thread_id.slice(5) : null;
    var refs = [root, lastIn && lastIn.external_id].filter(function (x, i, all) { return x && all.indexOf(x) === i; });
    var mailed = await require('./crmMailbox.service').send({
      to: conv.contact_key || conv.contact_label, subject: subject, text: body,
      inReplyTo: lastIn ? lastIn.external_id : undefined, references: refs.length ? refs : undefined,
      author: ctx.employee ? ctx.employee.first_name + ' ' + ctx.employee.last_name : undefined
    });
    sent = { externalId: mailed && mailed.messageId };
  } else {
    sent = await require('./crmMeta.service').sendMessage(conv, body);
  }
  var who = ctx.employee ? ctx.employee.first_name + ' ' + ctx.employee.last_name : '';
  await withTransaction(async function (db) {
    await db.query('INSERT INTO crm_messages (conversation_id, external_id, direction, author_name, body, sent_at, sent_by) VALUES ($1,$2,\'out\',$3,$4,now(),$5)',
      [conv.id, (sent && sent.externalId) || null, who, body, me(ctx)]);
    await refreshConversation(db, conv.id, false);
    if (conv.customer_id) await stampCustomer(db, conv.customer_id);
    await audit(db, ctx, 'crm.reply', 'crm_conversation', conv.id, 'Replied on ' + CHANNEL_NAME[conv.channel] + ' to ' + (conv.contact_name || conv.contact_label) + '.');
  });
  return getConversation(ctx, id);
}

// A call, a visit or a message on a channel the OS can't read, written down
// on the customer's profile.
async function logInteraction(ctx, customerId, p) {
  need(ctx, 'crm.manage');
  var channel = MANUAL_CHANNELS.indexOf(p && p.channel) >= 0 ? p.channel : 'call';
  var body = str(p && p.body, 4000);
  if (!body) fail('invalid', 'Write what was said.');
  var cust = (await pool.query('SELECT id, name FROM customers WHERE id = $1', [customerId])).rows[0];
  if (!cust) fail('notfound', 'Customer not found.');
  var at = p.at ? new Date(p.at) : new Date();
  if (isNaN(at.getTime()) || at > new Date(Date.now() + 60000)) fail('invalid', 'That time isn\'t right.');
  var who = ctx.employee ? ctx.employee.first_name + ' ' + ctx.employee.last_name : '';
  var out = await ingest({
    channel: channel, threadId: 'manual:' + channel + ':' + cust.id, customerId: cust.id,
    contact: { name: cust.name, handles: [] },
    messages: [{ direction: p.direction === 'in' ? 'in' : 'out', author: p.direction === 'in' ? cust.name : who, body: body, sentAt: at, sentBy: me(ctx) }]
  }, { noProfile: true });
  await audit(pool, ctx, 'crm.log', 'customer', cust.id, 'Logged ' + CHANNEL_NAME[channel] + ' with ' + cust.name + '.');
  return out;
}

// Puts a conversation on a customer's profile (an existing one, or a new
// one made from the sender), moving the sender's number or address to that
// customer too, so their next message lands there.
async function linkConversation(ctx, id, p) {
  need(ctx, 'crm.manage');
  var conv = (await pool.query('SELECT * FROM crm_conversations WHERE id = $1', [id])).rows[0];
  if (!conv) fail('notfound', 'Conversation not found.');
  var customerId = p && p.customerId;
  await withTransaction(async function (db) {
    if (!customerId) {
      var name = str(p && p.name, 200) || conv.contact_name || conv.contact_label;
      if (!name) fail('invalid', 'Give the new customer a name.');
      var ident = conv.contact_kind ? { kind: conv.contact_kind, value: conv.contact_key, label: conv.contact_label } : null;
      customerId = (await db.query(
        "INSERT INTO customers (name, phone, email, category, source, origin_channel, company_id) VALUES ($1,$2,$3,'lead','crm',$4,$5) RETURNING id",
        [name, ident && ident.kind === 'phone' ? ident.label : '', ident && ident.kind === 'email' ? ident.value : '', conv.channel, conv.company_id || await crmCompanyId(db)])).rows[0].id;
    } else if (!(await db.query('SELECT 1 FROM customers WHERE id = $1', [customerId])).rows[0]) fail('notfound', 'Customer not found.');
    await db.query('UPDATE crm_conversations SET customer_id = $2 WHERE id = $1', [id, customerId]);
    if (conv.contact_kind && conv.contact_key) {
      await db.query(
        'INSERT INTO customer_identities (customer_id, kind, value, label) VALUES ($1,$2,$3,$4) ON CONFLICT (kind, value) DO UPDATE SET customer_id = EXCLUDED.customer_id',
        [customerId, conv.contact_kind, conv.contact_key, conv.contact_label || conv.contact_key]);
    }
    await stampCustomer(db, customerId);
    if (conv.customer_id && conv.customer_id !== customerId) await stampCustomer(db, conv.customer_id);
    await audit(db, ctx, 'crm.link', 'crm_conversation', id, 'Put the ' + CHANNEL_NAME[conv.channel] + ' conversation with ' + (conv.contact_name || conv.contact_label) + ' on a customer\'s profile.');
  });
  return getConversation(ctx, id);
}

async function setStatus(ctx, id, status) {
  need(ctx, 'crm.manage');
  if (['open', 'closed', 'spam'].indexOf(status) < 0) fail('invalid', 'Unknown status.');
  var r = (await pool.query('UPDATE crm_conversations SET status = $2 WHERE id = $1 RETURNING id', [id, status])).rows[0];
  if (!r) fail('notfound', 'Conversation not found.');
  return getConversation(ctx, id);
}

module.exports = {
  CHANNELS: CHANNELS, crmCompanyId: crmCompanyId, normIdentity: normIdentity, phoneLabel: phoneLabel, isEmail: isEmail, isAutomatedEmail: isAutomatedEmail,
  addIdentities: addIdentities, backfillIdentities: backfillIdentities, stampCustomer: stampCustomer,
  ingest: ingest, listConversations: listConversations, getConversation: getConversation, reply: reply,
  logInteraction: logInteraction, linkConversation: linkConversation, setStatus: setStatus, setSendersForTests: setSendersForTests
};
