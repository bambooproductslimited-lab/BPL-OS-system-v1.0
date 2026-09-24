var nodemailer = require('nodemailer');
var config = require('../config');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { pool } = require('../db/pool');

// Outgoing email over SMTP, through a mailbox the company already has
// (config.js → mail). Used for two-step sign-in codes. Set up with SMTP_HOST,
// SMTP_USER and SMTP_PASS on the server (SMTP_PORT, SMTP_SECURE and MAIL_FROM
// optional); until then nothing is sent and the screens say so.

var transporter = null;
var transporterKey = null;
var testTransport = null;

function configured() { return !!(testTransport || config.mail.configured); }

// One connection setup per set of settings, made when first needed.
function transport() {
  if (testTransport) return testTransport;
  var key = [config.mail.host, config.mail.port, config.mail.secure, config.mail.user].join('|');
  if (!transporter || transporterKey !== key) {
    transporter = nodemailer.createTransport({
      host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
      auth: { user: config.mail.user, pass: config.mail.pass },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
      // Plain text and HTML we write ourselves: no attachments, files or URLs.
      disableFileAccess: true, disableUrlAccess: true
    });
    transporterKey = key;
  }
  return transporter;
}

// The mail server's refusal in words someone can act on — never the password.
function explain(err) {
  var code = err && (err.code || '');
  var said = String((err && (err.response || err.message)) || '');
  if (code === 'EAUTH' || /auth|credentials|535|534/i.test(said)) return 'The mail server didn\'t accept the sign-in. Check SMTP_USER and SMTP_PASS on the server (for Gmail, use an app password).';
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ECONNREFUSED' || code === 'EDNS') return 'Couldn\'t reach the mail server ' + config.mail.host + ':' + config.mail.port + '. Check SMTP_HOST and SMTP_PORT.';
  if (code === 'EENVELOPE') return 'The mail server refused the address: ' + said.replace(config.mail.pass || '\u0000', '•••').slice(0, 200);
  return 'The email wasn\'t sent: ' + said.replace(config.mail.pass || '\u0000', '•••').slice(0, 200);
}

// Sends one email. Throws a plain-language error when it can't be sent.
async function send(opts) {
  if (!configured()) fail('unavailable', 'Email isn\'t set up yet. An administrator adds SMTP_HOST, SMTP_USER and SMTP_PASS on the server (see Company settings → Email).');
  var to = String(opts.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to)) fail('invalid', 'There is no email address to send to.');
  try {
    var info = await transport().sendMail({
      from: config.mail.from || config.mail.user,
      to: to,
      subject: String(opts.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200),
      text: opts.text,
      html: opts.html
    });
    return { messageId: info && info.messageId };
  } catch (e) {
    console.error('Email not sent:', e && e.code, e && e.message);
    fail('unavailable', explain(e));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

// A short message with one big code in it (sign-in and set-up codes).
function codeEmail(code, intro, after) {
  var text = intro + '\n\n    ' + code + '\n\n' + after + '\n\n— Bamboo OS, Bamboo Products Limited';
  var html = '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#201e1d;max-width:480px">' +
    '<p style="color:#3f7d3b;font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 12px">Bamboo OS</p>' +
    '<p style="margin:0 0 16px">' + escapeHtml(intro) + '</p>' +
    '<p style="font-size:30px;font-weight:700;letter-spacing:.2em;margin:0 0 16px;font-family:ui-monospace,Menlo,Consolas,monospace">' + escapeHtml(code) + '</p>' +
    '<p style="margin:0 0 16px;color:#6b6966;font-size:13px">' + escapeHtml(after) + '</p>' +
    '<p style="margin:0;color:#6b6966;font-size:12px">Bamboo Products Limited</p></div>';
  return { text: text, html: html };
}

// ---- Company settings → Email ----------------------------------------------------

function requireManage(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
}

async function status(ctx) {
  requireManage(ctx);
  return {
    configured: configured(),
    host: config.mail.host || null, port: config.mail.host ? config.mail.port : null,
    from: config.mail.from || null
  };
}

// A test email to the person asking, so they can see it arrives.
async function sendTest(ctx) {
  requireManage(ctx);
  var to = ctx.user.email;
  await send({
    to: to, subject: 'Bamboo OS test email',
    text: 'This is a test from Bamboo OS. Email is working: two-step sign-in codes can now be sent by email.\n\n— Bamboo OS',
    html: '<p style="font-family:system-ui,sans-serif">This is a test from Bamboo OS. Email is working: two-step sign-in codes can now be sent by email.</p>'
  });
  await audit(pool, ctx, 'mail.test', 'mail', to, 'Sent a test email to ' + to + '.');
  return { sent: true, to: to };
}

// For the tests: send through this instead of SMTP (null to go back).
function setTransportForTests(t) { testTransport = t; }

module.exports = { configured: configured, send: send, codeEmail: codeEmail, status: status, sendTest: sendTest, setTransportForTests: setTransportForTests };
