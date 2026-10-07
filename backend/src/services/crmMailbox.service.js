var crypto = require('crypto');
var nodemailer = require('nodemailer');
var MailComposer = require('nodemailer/lib/mail-composer');
var config = require('../config');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var secretBox = require('../utils/secretBox');

// The sales mailbox the CRM inbox reads (crmEmail.service.js, over IMAP) and
// replies from (SMTP), connected on Integrations → Email inbox: Gmail or
// Google Workspace with an app password, Hostinger email, or any other
// mailbox. The password is kept sealed in crm_mailbox and never shown
// again. Before connecting, the OS signs in both ways (reading and sending)
// and finds the sent-mail folder, so a wrong password or server is said
// there and then, not discovered later.
//
// Until a mailbox is connected here, the server's own settings are used as
// before (config.js → crmImap for reading, → mail for sending).

var PURPOSE = 'crm-mailbox';
var PROVIDERS = {
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465, sent: '[Gmail]/Sent Mail' },
  hostinger: { imapHost: 'imap.hostinger.com', imapPort: 993, smtpHost: 'smtp.hostinger.com', smtpPort: 465, sent: '' }
};

function need(ctx) { if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).'); }
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
function port(v, fallback, label) {
  var n = v === undefined || v === null || v === '' ? fallback : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail('invalid', label + ' must be a port number, such as 993 or 465.');
  return n;
}
function host(v, label) {
  var h = str(v, 120).toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) fail('invalid', label + ' must be a server name, such as imap.example.com.');
  return h;
}

// The mailbox in use: the one connected here, else the server's settings.
// { source: 'os' | 'render', configured, address, pass, provider, imap, smtp, inbox, sent, fromName }
async function settings() {
  var r = (await pool.query('SELECT m.*, e.first_name, e.last_name FROM crm_mailbox m LEFT JOIN employees e ON e.id = m.connected_by WHERE m.id = 1')).rows[0];
  if (r) {
    var pass = secretBox.open(PURPOSE, r.password_enc);
    return {
      source: 'os', configured: !!pass, broken: !pass, provider: r.provider, address: r.address, pass: pass || '',
      imap: { host: r.imap_host, port: r.imap_port, secure: r.imap_port === 993 },
      smtp: { host: r.smtp_host, port: r.smtp_port, secure: r.smtp_port === 465 },
      inbox: r.inbox_folder, sent: r.sent_folder, fromName: r.from_name,
      connectedAt: r.connected_at, connectedByName: r.first_name ? r.first_name + ' ' + r.last_name : null
    };
  }
  var c = config.crmImap;
  return {
    source: 'render', configured: c.configured, provider: null, address: c.user, pass: c.pass,
    imap: { host: c.host, port: c.port, secure: c.secure }, smtp: null, inbox: c.inbox, sent: c.sent, fromName: ''
  };
}

// ── signing in both ways ─────────────────────────────────────────────
var probeForTests = null;
function setProbeForTests(fn) { probeForTests = fn; }

async function realProbe(s) {
  var { ImapFlow } = require('imapflow');
  var client = new ImapFlow({ host: s.imap.host, port: s.imap.port, secure: s.imap.secure, auth: { user: s.address, pass: s.pass }, logger: false, socketTimeout: 30000 });
  var sentFolder = '';
  try {
    await client.connect();
  } catch (e) { e.stage = 'imap'; throw e; }
  try {
    var folders = await client.list();
    var sent = folders.find(function (f) { return f.specialUse === '\\Sent'; }) || folders.find(function (f) { return /^(inbox\.)?sent( (mail|items|messages))?$/i.test(f.path); });
    sentFolder = sent ? sent.path : '';
  } finally {
    try { await client.logout(); } catch (e) { /* already gone */ }
  }
  var t = nodemailer.createTransport({ host: s.smtp.host, port: s.smtp.port, secure: s.smtp.secure, auth: { user: s.address, pass: s.pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
  try { await t.verify(); } catch (e) { e.stage = 'smtp'; throw e; } finally { t.close(); }
  return { sentFolder: sentFolder };
}

// What went wrong, in words someone can act on — never the password.
function explain(err, s) {
  var said = String((err && (err.response || err.responseText || err.message)) || '').replace(s.pass || '\u0000', '•••');
  var code = String((err && err.code) || '');
  var reading = err && err.stage === 'imap';
  var where = reading ? s.imap.host + ':' + s.imap.port : s.smtp.host + ':' + s.smtp.port;
  if ((err && err.authenticationFailed) || code === 'EAUTH' || /AUTHENTICATIONFAILED|invalid credentials|authentication failed|username and password not accepted|535|534/i.test(said)) {
    return s.provider === 'gmail'
      ? 'Gmail didn\'t accept the password. Use an app password, not the normal one: Google account → Security → 2-Step Verification → App passwords.'
      : 'The mailbox didn\'t accept the email address and password. Check them in your email provider (for Hostinger: hPanel → Emails).';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ESOCKET|ECONNECTION|EDNS/.test(code + ' ' + said)) {
    return 'Couldn\'t reach the mail server ' + where + (reading ? ' (reading)' : ' (sending)') + '. Check the server name and port.';
  }
  return (reading ? 'Reading the mailbox failed: ' : 'Sending from the mailbox failed: ') + said.slice(0, 200);
}

// The settings asked for, checked, with the password to try.
async function wanted(p) {
  p = p || {};
  var provider = V.oneOf(p.provider || 'other', ['gmail', 'hostinger', 'other'], 'Provider');
  var address = str(p.address, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(address)) fail('invalid', 'Enter the mailbox\'s email address.');
  var pass = String(p.password || '');
  if (!pass) {
    // Changing other settings of the same mailbox: the password already kept.
    var cur = (await pool.query('SELECT address, password_enc FROM crm_mailbox WHERE id = 1')).rows[0];
    if (cur && cur.address === address) pass = secretBox.open(PURPOSE, cur.password_enc) || '';
  }
  if (!pass) fail('invalid', 'Enter the mailbox\'s password' + (provider === 'gmail' ? ' (an app password for Gmail).' : '.'));
  var preset = PROVIDERS[provider];
  var s = {
    source: 'os', provider: provider, address: address, pass: pass,
    imap: preset ? { host: preset.imapHost, port: preset.imapPort } : { host: host(p.imapHost, 'Reading server (IMAP)'), port: port(p.imapPort, 993, 'Reading port') },
    smtp: preset ? { host: preset.smtpHost, port: preset.smtpPort } : { host: host(p.smtpHost, 'Sending server (SMTP)'), port: port(p.smtpPort, 465, 'Sending port') },
    inbox: str(p.inbox, 120) || 'INBOX', sent: str(p.sent, 120), fromName: str(p.fromName, 80) || 'Bamboo Products'
  };
  s.imap.secure = s.imap.port === 993;
  s.smtp.secure = s.smtp.port === 465;
  if (!s.sent && preset) s.sent = preset.sent;
  return s;
}

async function check(s) {
  try {
    return await (probeForTests || realProbe)(s);
  } catch (e) {
    fail('invalid', explain(e, s));
  }
}

async function test(ctx, p) {
  need(ctx);
  var s = await wanted(p);
  var found = await check(s);
  return { ok: true, sentFolder: s.sent || found.sentFolder || '' };
}

async function connect(ctx, p) {
  need(ctx);
  var s = await wanted(p);
  var found = await check(s);
  var sent = s.sent || found.sentFolder || '';
  await pool.query(
    'INSERT INTO crm_mailbox (id, provider, address, password_enc, imap_host, imap_port, smtp_host, smtp_port, inbox_folder, sent_folder, from_name, connected_by, connected_at) ' +
    'VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) ON CONFLICT (id) DO UPDATE SET provider = $1, address = $2, password_enc = $3, imap_host = $4, imap_port = $5, ' +
    'smtp_host = $6, smtp_port = $7, inbox_folder = $8, sent_folder = $9, from_name = $10, connected_by = $11, connected_at = now()',
    [s.provider, s.address, secretBox.seal(PURPOSE, s.pass), s.imap.host, s.imap.port, s.smtp.host, s.smtp.port, s.inbox, sent, s.fromName, ctx.employee ? ctx.employee.id : null]);
  await audit(pool, ctx, 'crm.mailbox.connect', 'crm_mailbox', '1', 'Connected the mailbox ' + s.address + ' to the CRM inbox.');
  return info(ctx);
}

async function disconnect(ctx) {
  need(ctx);
  var r = (await pool.query('DELETE FROM crm_mailbox WHERE id = 1 RETURNING address')).rows[0];
  if (r) await audit(pool, ctx, 'crm.mailbox.disconnect', 'crm_mailbox', '1', 'Disconnected the mailbox ' + r.address + ' from the CRM inbox.');
  return info(ctx);
}

// What Integrations shows: never the password.
async function info(ctx) {
  need(ctx);
  var s = await settings();
  var st = await require('./crmEmail.service').status();
  return {
    source: s.source === 'os' ? 'os' : s.configured ? 'render' : null,
    broken: !!s.broken,
    address: s.address || null, provider: s.provider || null,
    imapHost: s.imap.host, smtpHost: s.smtp ? s.smtp.host : null,
    inbox: s.inbox, sent: s.sent || '', fromName: s.fromName || '',
    connectedAt: s.connectedAt || null, connectedByName: s.connectedByName || null,
    canSend: await canSend(),
    lastOkAt: st.lastOkAt, lastError: st.lastError, items: st.items,
    providers: PROVIDERS
  };
}

// ── sending replies ──────────────────────────────────────────────────
var transportForTests = null, appendForTests = null;
function setTransportForTests(t, append) { transportForTests = t; appendForTests = append || null; }

async function canSend() {
  if (transportForTests) return true;
  var s = await settings();
  if (s.source === 'os') return s.configured;
  return require('./mail.service').configured();
}

// A reply from the mailbox, with a copy put in its sent folder so it shows
// in the mail app too (Gmail keeps one by itself). Through the server's
// email settings when no mailbox is connected here.
async function send(opts) {
  var s = await settings();
  // Signed by the person who wrote it, then the mailbox's name.
  var name = opts.author ? opts.author + ' \u00b7 ' + (s.fromName || 'Bamboo Products') : opts.fromName || s.fromName || 'Bamboo Products';
  if (s.source !== 'os' && !transportForTests) return require('./mail.service').send(Object.assign({}, opts, { fromName: name }));
  if (!transportForTests && !s.configured) fail('unavailable', 'The mailbox needs connecting again on Integrations → Email inbox.');
  var domain = (s.address.split('@')[1] || 'bamboo.local');
  var mail = {
    from: { name: String(name).replace(/[\r\n"<>]+/g, ' ').slice(0, 80), address: s.address },
    to: opts.to, subject: String(opts.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200), text: opts.text,
    inReplyTo: opts.inReplyTo || undefined, references: opts.references || undefined,
    messageId: '<' + crypto.randomUUID() + '@' + domain + '>', date: new Date()
  };
  var t = transportForTests || nodemailer.createTransport({ host: s.smtp.host, port: s.smtp.port, secure: s.smtp.secure, auth: { user: s.address, pass: s.pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000, disableFileAccess: true, disableUrlAccess: true });
  try {
    await t.sendMail(mail);
  } catch (e) {
    e.stage = 'smtp';
    fail('unavailable', explain(e, s));
  } finally {
    if (!transportForTests) t.close();
  }
  if (s.sent && s.provider !== 'gmail') {
    try {
      var raw = await new MailComposer(mail).compile().build();
      if (appendForTests) await appendForTests(s.sent, raw);
      else {
        var { ImapFlow } = require('imapflow');
        var c = new ImapFlow({ host: s.imap.host, port: s.imap.port, secure: s.imap.secure, auth: { user: s.address, pass: s.pass }, logger: false, socketTimeout: 30000 });
        await c.connect();
        try { await c.append(s.sent, raw, ['\\Seen']); } finally { try { await c.logout(); } catch (e) { /* gone */ } }
      }
    } catch (e) {
      console.error('[crm mailbox] reply sent, but not copied to ' + s.sent + ':', e.message);
    }
  }
  return { messageId: mail.messageId };
}

module.exports = {
  settings: settings, info: info, test: test, connect: connect, disconnect: disconnect, canSend: canSend, send: send,
  setProbeForTests: setProbeForTests, setTransportForTests: setTransportForTests, PROVIDERS: PROVIDERS
};
