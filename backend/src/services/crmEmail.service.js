/*
 * The sales mailbox in the CRM inbox: customers' emails, read over IMAP
 * (config.js → crmImap; Gmail with an app password, or Hostinger), land on
 * their profiles as conversations, one per email thread.
 *
 * sync() runs from jobs/crm.js every few minutes. Each folder (the inbox,
 * and the sent folder when set, so replies written in the mail app are kept
 * too) is read from the last message seen; the first run goes back 30 days.
 * Mail no person sent — newsletters, mailing lists, automatic notices — and
 * mail between the company's own staff is left out. Only the new part of
 * each email is kept, not the quoted conversation below it.
 */
var { simpleParser } = require('mailparser');
var config = require('../config');
var { pool } = require('../db/pool');
var inbox = require('./crmInbox.service');

var FIRST_DAYS = 30;
var MAX_PER_RUN = 300;

// How messages are fetched: ImapFlow against the real mailbox; tests hand in
// a fake with the same listNew().
var mailbox = null;
function setMailboxForTests(m) { mailbox = m; }

function realMailbox() {
  var { ImapFlow } = require('imapflow');
  var client = null;
  return {
    open: async function () {
      client = new ImapFlow({ host: config.crmImap.host, port: config.crmImap.port, secure: config.crmImap.secure,
        auth: { user: config.crmImap.user, pass: config.crmImap.pass }, logger: false, socketTimeout: 60000 });
      await client.connect();
    },
    // The messages after `cursor` ({ v: uidValidity, uid }) in the folder.
    listNew: async function (folder, cursor) {
      var lock = await client.getMailboxLock(folder);
      try {
        var v = String(client.mailbox.uidValidity);
        var uids;
        if (!cursor || cursor.v !== v) uids = await client.search({ since: new Date(Date.now() - FIRST_DAYS * 86400000) }, { uid: true });
        else uids = await client.search({ uid: (Number(cursor.uid) + 1) + ':*' }, { uid: true });
        uids = (uids || []).filter(function (u) { return !cursor || cursor.v !== v || u > Number(cursor.uid); }).sort(function (a, b) { return a - b; }).slice(0, MAX_PER_RUN);
        var out = [];
        if (uids.length) {
          for await (var msg of client.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) out.push({ uid: msg.uid, source: msg.source });
        }
        return { v: v, messages: out.sort(function (a, b) { return a.uid - b.uid; }) };
      } finally { lock.release(); }
    },
    close: async function () { if (client) { try { await client.logout(); } catch (e) { /* already gone */ } } }
  };
}

// Only the new words, not the earlier emails quoted under them.
function newPart(text) {
  var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^On .{4,200}wrote:\s*$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^_{5,}$/.test(l) ||
      (/^From:\s.+/.test(l) && out.join('').trim()) || /^Le .{4,200}a écrit\s?:\s*$/.test(l)) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function automated(parsed, address) {
  var h = parsed.headers;
  // mailparser files List-Unsubscribe, List-Id … under 'list'.
  if (h.has('list') || h.get('list-unsubscribe') || h.get('list-id')) return true;
  if (/^(bulk|list|junk)$/i.test(String(h.get('precedence') || ''))) return true;
  var auto = String(h.get('auto-submitted') || '');
  if (auto && auto.toLowerCase() !== 'no') return true;
  return inbox.isAutomatedEmail(address);
}

// One email into the CRM; false when it isn't a conversation with a customer.
async function take(parsed, fromSentFolder) {
  var me = config.crmImap.user.toLowerCase();
  var from = parsed.from && parsed.from.value && parsed.from.value[0];
  var fromAddr = from && from.address ? from.address.toLowerCase() : '';
  var outgoing = fromSentFolder || fromAddr === me;
  var toList = ((parsed.to && parsed.to.value) || []).concat((parsed.cc && parsed.cc.value) || []);
  var other = outgoing ? toList.find(function (t) { return t.address && t.address.toLowerCase() !== me; }) : from;
  if (!other || !other.address) return false;
  var addr = other.address.toLowerCase();
  if (!outgoing && automated(parsed, addr)) return false;
  var refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : String(parsed.references).split(/\s+/)) : [];
  var root = refs[0] || parsed.inReplyTo || parsed.messageId;
  if (!root) return false;
  var body = newPart(parsed.text || (parsed.html ? String(parsed.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ') : ''));
  await inbox.ingest({
    channel: 'email', threadId: 'mail:' + root, subject: parsed.subject || '',
    contact: { name: other.name || '', handles: [{ kind: 'email', value: addr, label: addr }] },
    messages: [{
      externalId: parsed.messageId || null, direction: outgoing ? 'out' : 'in', author: outgoing ? (from && from.name) || me : other.name || addr,
      body: body, sentAt: parsed.date || new Date(),
      attachments: (parsed.attachments || []).filter(function (a) { return a.contentDisposition !== 'inline'; }).map(function (a) { return { name: a.filename || 'attachment', type: a.contentType || '' }; })
    }]
  });
  return true;
}

async function state(key) { return (await pool.query('SELECT * FROM crm_channel_state WHERE key = $1', [key])).rows[0] || null; }
async function saveState(key, cursor, error, items) {
  await pool.query(
    'INSERT INTO crm_channel_state (key, cursor, last_run_at, last_ok_at, last_error, items) VALUES ($1,$2,now(),CASE WHEN $3::text IS NULL THEN now() END,$3,$4) ' +
    'ON CONFLICT (key) DO UPDATE SET cursor = COALESCE($2, crm_channel_state.cursor), last_run_at = now(), ' +
    'last_ok_at = CASE WHEN $3::text IS NULL THEN now() ELSE crm_channel_state.last_ok_at END, last_error = $3, items = crm_channel_state.items + $4',
    [key, cursor, error, items || 0]);
}

async function sync() {
  if (!mailbox && !config.crmImap.configured) return { skipped: 'not set up' };
  var box = mailbox || realMailbox();
  var folders = [[config.crmImap.inbox, false]];
  if (config.crmImap.sent) folders.push([config.crmImap.sent, true]);
  var result = { kept: 0, skipped: 0 };
  try {
    await box.open();
    for (var f of folders) {
      var key = 'email:' + f[0];
      var st = await state(key);
      var cursor = st && st.cursor ? JSON.parse(st.cursor) : null;
      var got = await box.listNew(f[0], cursor);
      var last = cursor && cursor.v === got.v ? Number(cursor.uid) : 0;
      var kept = 0;
      for (var m of got.messages) {
        try {
          var parsed = await simpleParser(m.source);
          if (await take(parsed, f[1])) kept++; else result.skipped++;
        } catch (e) { console.error('[crm email] message ' + m.uid + ' not read:', e.message); }
        last = Math.max(last, m.uid);
      }
      await saveState(key, JSON.stringify({ v: got.v, uid: last }), null, kept);
      result.kept += kept;
    }
  } catch (e) {
    await saveState('email:' + config.crmImap.inbox, null, String(e.message || e).slice(0, 300), 0);
    result.error = e.message;
  } finally {
    await box.close();
  }
  return result;
}

async function status() {
  var st = await state('email:' + config.crmImap.inbox);
  return { configured: config.crmImap.configured, mailbox: config.crmImap.user || null, host: config.crmImap.host,
    lastOkAt: st ? st.last_ok_at : null, lastError: st ? st.last_error : null, items: st ? st.items : 0 };
}

module.exports = { sync: sync, status: status, newPart: newPart, setMailboxForTests: setMailboxForTests };
