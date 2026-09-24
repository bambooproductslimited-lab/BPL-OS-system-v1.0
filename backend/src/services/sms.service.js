var config = require('../config');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { internationalNumber } = require('../utils/phone');

// Text messages through mNotify, on the company's own SMS credit (migration
// 0077). Used for sign-in codes, payment reminders, booking notices and, if
// turned on, staff alerts. Every text is logged in sms_messages — sent or
// failed — so the Company settings screen can show what went out and what
// it cost.
//
// Set up with two env vars on the server: MNOTIFY_API_KEY and
// MNOTIFY_SENDER_ID (config.js). Until both are set nothing is sent, and the
// screens say so rather than failing.

var TIMEOUT_MS = 15000;
var MAX_LENGTH = 612; // four texts' worth; a reminder is one or two

// Automatic texts the OS may send on its own. All off until someone turns
// them on in Company settings — each one spends credit.
var MESSAGING_DEFAULTS = {
  autoPaymentReminders: false, // customers and tenants: 3 days before, on the day, 7 and 30 days after
  autoBookingNotices: false,   // tenants: 30 and 7 days before a booking ends
  staffAlertsBySms: false      // staff: the morning alert as a text too
};
// However many are due, no more than this many automatic texts a day: a
// mistake (a bad import, a wrong due date on 300 bills) can't empty the
// account in one morning.
var AUTO_DAILY_LIMIT = 150;

function configured() { return !!config.sms.configured; }

// mNotify's own examples use Ghana numbers in the local form, 0244123456;
// anything else goes in international form.
function smsNumber(phone) {
  var intl = internationalNumber(phone);
  if (!intl) return null;
  return intl.length === 12 && intl.indexOf('233') === 0 ? '0' + intl.slice(3) : intl;
}

// One request to mNotify. The API key rides in the query string, as mNotify
// requires, so the URL is never logged or put in an error message.
async function call(method, path, body) {
  var url = config.sms.baseUrl + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(config.sms.apiKey);
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  try {
    var res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    var text = await res.text();
    var json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON — treated as a failure below */ }
    return { httpStatus: res.status, json: json };
  } catch (e) {
    return { httpStatus: 0, json: null, networkError: e && e.name === 'AbortError' ? 'mNotify did not answer in time.' : 'Could not reach mNotify.' };
  } finally {
    clearTimeout(timer);
  }
}

// mNotify's answer, in words someone at Bamboo can act on.
function explain(r) {
  if (r.networkError) return r.networkError + ' Try again in a minute.';
  var j = r.json || {};
  var code = String(j.code || '');
  var said = String(j.message || j.error || '').trim();
  if (code === '1003' || /balance|credit|insufficient/i.test(said)) return 'Not enough SMS credit on the mNotify account. Top up on mNotify and try again.';
  if (code === '1004' || r.httpStatus === 401 || /api key|apikey|unauthori[sz]ed/i.test(said)) return 'mNotify didn\'t accept the API key. Check MNOTIFY_API_KEY on the server.';
  if (code === '1006' || code === '1011' || code === '1012' || /sender/i.test(said)) return 'mNotify didn\'t accept the sender ID "' + config.sms.senderId + '". It must be approved in the mNotify dashboard first (up to 11 characters).';
  if (code === '1005' || /invalid.*(phone|number|recipient)/i.test(said)) return 'mNotify says the phone number isn\'t valid.';
  return said ? 'mNotify said: ' + said : 'mNotify didn\'t send it (' + (r.httpStatus || 'no answer') + ').';
}

function succeeded(r) {
  var j = r.json;
  if (!j || r.httpStatus >= 400) return false;
  var ok = j.status === 'success' || String(j.code) === '2000';
  if (!ok) return false;
  // Accepted overall but the number itself refused.
  var s = j.summary;
  if (s && Array.isArray(s.numbers_sent) && !s.numbers_sent.length && Number(s.total_rejected) > 0) return false;
  return true;
}

// Sends one text. Throws a plain-language error when it can't be sent, after
// logging the attempt. opts: { to, message, purpose, refId, sentBy,
// logMessage (what to keep in the log instead — sign-in codes are masked) }.
async function send(opts) {
  if (!configured()) fail('unavailable', 'Text messages aren\'t set up yet. An administrator adds MNOTIFY_API_KEY and MNOTIFY_SENDER_ID on the server (see Company settings → Text messages).');
  var number = smsNumber(opts.to);
  if (!number) fail('invalid', opts.to ? 'The phone number ' + opts.to + ' isn\'t one a text can go to.' : 'There is no phone number to text.');
  var message = String(opts.message || '').trim();
  if (!message) fail('invalid', 'The message is empty.');
  if (message.length > MAX_LENGTH) message = message.slice(0, MAX_LENGTH - 1) + '…';

  var r = await call('POST', '/api/sms/quick', {
    recipient: [number], sender: config.sms.senderId, message: message, is_schedule: false, schedule_date: ''
  });
  var ok = succeeded(r);
  var summary = (r.json && r.json.summary) || {};
  var error = ok ? null : explain(r);
  var row = (await pool.query(
    'INSERT INTO sms_messages (to_phone, message, purpose, ref_id, status, error, provider_ref, credits_used, sent_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [number, opts.logMessage || message, opts.purpose || 'other', opts.refId || null, ok ? 'sent' : 'failed', error,
      summary._id ? String(summary._id) : null, summary.credit_used !== undefined && !isNaN(Number(summary.credit_used)) ? Number(summary.credit_used) : null,
      opts.sentBy || null]
  )).rows[0];
  if (!ok) fail('unavailable', error);
  return {
    id: row.id, to: number,
    creditLeft: summary.credit_left !== undefined && !isNaN(Number(summary.credit_left)) ? Number(summary.credit_left) : null
  };
}

async function balance() {
  if (!configured()) return null;
  var r = await call('GET', '/api/balance/sms');
  if (!r.json || r.httpStatus >= 400 || (r.json.status && r.json.status !== 'success')) fail('unavailable', explain(r));
  return { balance: Number(r.json.balance) || 0, bonus: Number(r.json.bonus) || 0 };
}

// ---- settings ----------------------------------------------------------------

async function messaging() {
  var r = (await pool.query('SELECT messaging FROM settings WHERE id = 1')).rows[0];
  return Object.assign({}, MESSAGING_DEFAULTS, (r && r.messaging) || {});
}

// Automatic texts sent today (to hold to AUTO_DAILY_LIMIT).
async function autoSentToday() {
  return (await pool.query(
    "SELECT count(*)::int AS n FROM sms_messages WHERE purpose LIKE 'auto_%' AND created_at >= date_trunc('day', now())"
  )).rows[0].n;
}

function requireManage(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
}

// Company settings → Text messages.
async function status(ctx) {
  requireManage(ctx);
  var out = {
    provider: 'mNotify', configured: configured(), senderId: config.sms.senderId || null,
    settings: await messaging(), dailyLimit: AUTO_DAILY_LIMIT, balance: null, balanceError: null
  };
  if (out.configured) {
    try { out.balance = await balance(); } catch (e) { out.balanceError = e.message; }
  }
  var month = (await pool.query(
    "SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed, " +
    "COALESCE(sum(credits_used) FILTER (WHERE status = 'sent'), 0)::float AS credits " +
    "FROM sms_messages WHERE created_at >= date_trunc('month', now())"
  )).rows[0];
  out.thisMonth = month;
  out.recent = (await pool.query(
    'SELECT s.id, s.to_phone, s.message, s.purpose, s.status, s.error, s.created_at, e.first_name, e.last_name ' +
    'FROM sms_messages s LEFT JOIN employees e ON e.id = s.sent_by ORDER BY s.created_at DESC LIMIT 30'
  )).rows.map(function (r) {
    return {
      id: r.id, to: r.to_phone, message: r.message, purpose: r.purpose, status: r.status, error: r.error, at: r.created_at,
      by: r.first_name ? r.first_name + ' ' + r.last_name : null
    };
  });
  return out;
}

async function saveSettings(ctx, p) {
  requireManage(ctx);
  var current = await messaging();
  var next = {};
  Object.keys(MESSAGING_DEFAULTS).forEach(function (k) {
    next[k] = p && p[k] !== undefined ? !!p[k] : current[k];
  });
  await pool.query('UPDATE settings SET messaging = $1, updated_at = now() WHERE id = 1', [JSON.stringify(next)]);
  var on = Object.keys(next).filter(function (k) { return next[k]; });
  await audit(pool, ctx, 'settings.messaging', 'settings', 'company', 'Automatic texts: ' + (on.length ? on.join(', ') : 'all off') + '.');
  return status(ctx);
}

async function sendTest(ctx, phone) {
  requireManage(ctx);
  var sent = await send({
    to: phone, purpose: 'test', sentBy: ctx.employee ? ctx.employee.id : null,
    message: 'Test from Bamboo OS: text messages are working.'
  });
  await audit(pool, ctx, 'sms.test', 'sms', sent.id, 'Sent a test text to ' + sent.to + '.');
  return { sent: true, to: sent.to, creditLeft: sent.creditLeft };
}

module.exports = {
  configured: configured, send: send, balance: balance, smsNumber: smsNumber, messaging: messaging, autoSentToday: autoSentToday,
  status: status, saveSettings: saveSettings, sendTest: sendTest, AUTO_DAILY_LIMIT: AUTO_DAILY_LIMIT
};
