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
// Set up with MNOTIFY_API_KEY on the server (config.js) and a sender ID: the
// name texts come from, chosen in Company settings → Text messages, else the
// server's MNOTIFY_SENDER_ID. Until there are both nothing is sent, and the
// screens say so rather than failing.
//
// mNotify sends only from a sender ID approved on the account. A name it
// doesn't know (or hasn't approved yet) makes every text fail — sign-in
// codes included — so the same screen can ask mNotify about the sender ID,
// ask it to approve one, or switch to one already approved, without a
// redeploy. The last thing mNotify said about it is kept (sms_sender_check,
// migration 0207), and a refusal while sending is noted there too.

var TIMEOUT_MS = 15000;
var MAX_LENGTH = 612; // four texts' worth; a reminder is one or two

// Automatic texts the OS may send on its own. Each one spends credit, so
// they are off until someone turns them on in Company settings — except
// the texts to the people working on marketing requests, asked for on.
var MESSAGING_DEFAULTS = {
  autoPaymentReminders: false, // customers and tenants: 3 days before, on the day, 7 and 30 days after
  autoBookingNotices: false,   // tenants: 30 and 7 days before a booking ends
  staffAlertsBySms: false,     // staff: the morning alert as a text too
  requestTeamBySms: true,      // staff: put on a marketing request's team (mkRequests.service.js)
  routineRemindersBySms: true  // staff: a routine's heads-up and "needed tomorrow" reminders (mkRoutines.service.js)
};
// However many are due, no more than this many automatic texts a day: a
// mistake (a bad import, a wrong due date on 300 bills) can't empty the
// account in one morning.
var AUTO_DAILY_LIMIT = 150;

// The sender ID chosen in Company settings and mNotify's last word on it,
// read from the database before each text and each look at the screen (and
// at start-up, server.js), so configured() can stay synchronous.
var chosen = { senderId: null, check: null };

async function loadSender() {
  var r = (await pool.query('SELECT sms_sender_id, sms_sender_check FROM settings WHERE id = 1')).rows[0] || {};
  chosen = { senderId: r.sms_sender_id || null, check: r.sms_sender_check || null };
  return senderId();
}
function senderId() { return chosen.senderId || config.sms.senderId || ''; }

function configured() { return !!(config.sms.apiKey && senderId()); }

// mNotify: up to 11 characters, and not only numbers (it refuses those).
function cleanSender(name) {
  var n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) fail('invalid', 'Type the sender ID: the name texts come from.');
  if (n.length > 11) fail('invalid', 'A sender ID is at most 11 characters — "' + n + '" is ' + n.length + '.');
  if (!/^[A-Za-z0-9 ]+$/.test(n)) fail('invalid', 'A sender ID can only have letters, numbers and spaces.');
  if (!/[A-Za-z]/.test(n)) fail('invalid', 'A sender ID needs at least one letter: mNotify doesn\'t send from numbers alone.');
  return n;
}

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

var FIX_SENDER = 'An administrator can check it and ask mNotify to approve it in Company settings → Text messages, or switch to a sender ID already approved on the account.';

// mNotify refused the sender ID (1006 invalid, 1011 numbers only, 1012 not
// registered).
function senderRefused(r) {
  var j = r.json || {};
  var code = String(j.code || '');
  return code === '1006' || code === '1011' || code === '1012' || /sender/i.test(String(j.message || j.error || ''));
}

// mNotify's answer, in words someone at Bamboo can act on.
function explain(r, sender) {
  if (r.networkError) return r.networkError + ' Try again in a minute.';
  var j = r.json || {};
  var code = String(j.code || '');
  var said = String(j.message || j.error || '').trim();
  sender = sender || senderId();
  if (code === '1003' || /balance|credit|insufficient/i.test(said)) return 'Not enough SMS credit on the mNotify account. Top up on mNotify and try again.';
  if (code === '1004' || r.httpStatus === 401 || /api key|apikey|unauthori[sz]ed/i.test(said)) return 'mNotify didn\'t accept the API key. Check MNOTIFY_API_KEY on the server.';
  if (code === '1011') return 'mNotify doesn\'t send from a sender ID of numbers only ("' + sender + '"). ' + FIX_SENDER;
  if (senderRefused(r)) return 'mNotify didn\'t accept the sender ID "' + sender + '": it isn\'t approved on the mNotify account yet. ' + FIX_SENDER;
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

// Staff who never get texts from the OS (employees.sms_opt_out, migration
// 0208): the CEO, say. Nothing goes to their phone — alerts, reminders, a
// request's team, a booking or receipt — except a sign-in code they asked
// for themselves, or a test sent to that number on purpose. Matched on the
// number, so every way a text is sent is covered, now and later.
var ALWAYS_SENT = ['two_step', 'portal_code', 'test'];
async function quietStaffAt(number) {
  var rows = (await pool.query("SELECT id, first_name, last_name, phone FROM employees WHERE sms_opt_out AND coalesce(phone, '') <> ''")).rows;
  for (var i = 0; i < rows.length; i++) {
    var nums = String(rows[i].phone).split(/[\/,;]/).map(smsNumber).filter(Boolean);
    if (nums.indexOf(number) >= 0) return rows[i];
  }
  return null;
}

// Sends one text. Throws a plain-language error when it can't be sent, after
// logging the attempt. opts: { to, message, purpose, refId, sentBy,
// logMessage (what to keep in the log instead — sign-in codes are masked) }.
async function send(opts) {
  await loadSender();
  if (!configured()) fail('unavailable', config.sms.apiKey
    ? 'Text messages have no sender ID yet. An administrator chooses one in Company settings → Text messages.'
    : 'Text messages aren\'t set up yet. An administrator adds MNOTIFY_API_KEY on the server (see Company settings → Text messages).');
  var number = smsNumber(opts.to);
  if (!number) fail('invalid', opts.to ? 'The phone number ' + opts.to + ' isn\'t one a text can go to.' : 'There is no phone number to text.');
  var message = String(opts.message || '').trim();
  if (!message) fail('invalid', 'The message is empty.');
  if (message.length > MAX_LENGTH) message = message.slice(0, MAX_LENGTH - 1) + '…';
  if (ALWAYS_SENT.indexOf(opts.purpose) < 0) {
    var quiet = await quietStaffAt(number);
    if (quiet) {
      // Kept in the log, so "why didn't they get it?" has an answer.
      var skipped = (await pool.query(
        "INSERT INTO sms_messages (to_phone, message, purpose, ref_id, status, error, sent_by) VALUES ($1,$2,$3,$4,'skipped',$5,$6) RETURNING id",
        [number, opts.logMessage || message, opts.purpose || 'other', opts.refId || null,
          'Not sent: ' + quiet.first_name + ' ' + quiet.last_name + ' doesn\'t get texts from the OS (Company settings → Text messages).', opts.sentBy || null]
      )).rows[0];
      return { id: skipped.id, to: number, skipped: true, creditLeft: null };
    }
  }

  var sender = senderId();
  var r = await call('POST', '/api/sms/quick', {
    recipient: [number], sender: sender, message: message, is_schedule: false, schedule_date: ''
  });
  var ok = succeeded(r);
  var summary = (r.json && r.json.summary) || {};
  var error = ok ? null : explain(r, sender);
  // What sending says about the sender ID, for the settings screen: refused,
  // or (the first time after a change) clearly working.
  if (!ok && senderRefused(r)) await noteCheck(sender, 'refused', String((r.json || {}).message || ''));
  else if (ok && !(chosen.check && chosen.check.name === sender && chosen.check.state === 'approved')) await noteCheck(sender, 'approved', '');
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

// ---- the sender ID -------------------------------------------------------------

async function noteCheck(name, state, said) {
  var check = { name: name, state: state, said: said ? String(said).slice(0, 300) : null, at: new Date().toISOString() };
  await pool.query('UPDATE settings SET sms_sender_check = $1 WHERE id = 1', [JSON.stringify(check)]);
  chosen.check = check;
  return check;
}

// mNotify's answer about a sender ID, as one of: approved, pending,
// rejected, not_registered, unknown.
function senderState(r) {
  var j = r.json || {};
  var code = String(j.code || '');
  var said = String(j.message || j.error || '').trim();
  var st = String((j.summary && (j.summary.status || j.summary.sender_status)) || j.sender_status || '').toLowerCase();
  if (r.networkError) return { state: 'unknown', said: r.networkError };
  if (code === '1004' || r.httpStatus === 401) return { state: 'unknown', said: explain(r) };
  if (/^(active|approved|verified|live)$/.test(st)) return { state: 'approved', said: said };
  if (/pend|review|process|submit|await/.test(st)) return { state: 'pending', said: said };
  if (/reject|declin|denied|block|inactive|suspend|disabled/.test(st)) return { state: 'rejected', said: said };
  if (r.httpStatus === 404 || /not\s*(found|exist|regist)|no\s*sender|unregistered|doesn.?t exist|does not exist/i.test(said)) return { state: 'not_registered', said: said };
  return { state: 'unknown', said: said || 'mNotify gave no answer (' + (r.httpStatus || 'no answer') + ').' };
}

// "Check with mNotify": where the sender ID stands on the account.
async function checkSender(ctx, p) {
  requireManage(ctx);
  if (!config.sms.apiKey) fail('unavailable', 'Add MNOTIFY_API_KEY on the server first: the check is made with the account\'s key.');
  await loadSender();
  var name = p && p.name ? cleanSender(p.name) : senderId();
  if (!name) fail('invalid', 'Choose a sender ID first.');
  var r = await call('POST', '/api/senderid/status', { sender_name: name });
  var s = senderState(r);
  await noteCheck(name, s.state, s.said);
  return status(ctx);
}

// "Ask mNotify to approve it": registers the sender ID on the account with
// what it is for; mNotify reviews it (usually within a working day).
async function registerSender(ctx, p) {
  requireManage(ctx);
  if (!config.sms.apiKey) fail('unavailable', 'Add MNOTIFY_API_KEY on the server first: the request is made with the account\'s key.');
  await loadSender();
  var name = p && p.name ? cleanSender(p.name) : senderId();
  if (!name) fail('invalid', 'Choose a sender ID first.');
  var purpose = String((p && p.purpose) || '').trim().replace(/\s+/g, ' ');
  if (purpose.length < 15) fail('invalid', 'Say what the texts are for, in a sentence: mNotify reads it before approving the sender ID.');
  if (purpose.length > 300) purpose = purpose.slice(0, 300);
  var r = await call('POST', '/api/senderid/register', { sender_name: name, purpose: purpose });
  var j = r.json || {};
  var said = String(j.message || j.error || '').trim();
  var accepted = !r.networkError && r.httpStatus < 400 && (j.status === 'success' || String(j.code) === '2000');
  if (!accepted && !/already/i.test(said)) {
    fail('unavailable', r.networkError ? r.networkError + ' Try again in a minute.'
      : String(j.code) === '1004' || r.httpStatus === 401 ? explain(r) : 'mNotify didn\'t take the request for "' + name + '"' + (said ? ': ' + said : '.'));
  }
  var s = senderState(r);
  await noteCheck(name, s.state === 'unknown' ? 'pending' : s.state, said);
  await audit(pool, ctx, 'sms.sender_register', 'settings', 'company', 'Asked mNotify to approve the sender ID "' + name + '": ' + purpose);
  return status(ctx);
}

// The sender ID texts come from; null goes back to the server's
// MNOTIFY_SENDER_ID. Checked with mNotify straight away when it can be.
async function saveSender(ctx, p) {
  requireManage(ctx);
  var raw = p ? p.senderId : null;
  var name = raw === null || raw === undefined || String(raw).trim() === '' ? null : cleanSender(raw);
  var before = (await loadSender()) || null;
  await pool.query('UPDATE settings SET sms_sender_id = $1, updated_at = now() WHERE id = 1', [name]);
  chosen.senderId = name;
  var now = senderId();
  await audit(pool, ctx, 'sms.sender', 'settings', 'company', 'Texts now come from "' + (now || '—') + '"' + (before && before !== now ? ' (was "' + before + '")' : '') + (name ? '.' : ', the server\'s sender ID.'));
  if (config.sms.apiKey && now) {
    try { return await checkSender(ctx, { name: now }); } catch (e) { /* the screen shows it unchecked */ }
  }
  return status(ctx);
}

function suggestedPurpose(company) {
  return 'Sign-in codes for staff, and payment reminders, booking and order updates for the customers of ' + company + '.';
}

// Company settings → Text messages.
async function status(ctx) {
  requireManage(ctx);
  await loadSender();
  var sender = senderId();
  var company = ((await pool.query('SELECT company_name FROM settings WHERE id = 1')).rows[0] || {}).company_name || 'Bamboo Products Limited';
  var out = {
    provider: 'mNotify', configured: configured(), apiKeySet: !!config.sms.apiKey,
    senderId: sender || null, senderSource: chosen.senderId ? 'settings' : config.sms.senderId ? 'server' : null,
    serverSenderId: config.sms.senderId || null,
    senderCheck: chosen.check && chosen.check.name === sender ? chosen.check : null,
    suggestedPurpose: suggestedPurpose(company),
    staff: await quietStaff(),
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

// Company settings → Text messages: who never gets texts, and everyone with
// a phone who could be added.
async function quietStaff() {
  return (await pool.query(
    "SELECT id, first_name, last_name, sms_opt_out FROM employees WHERE status = 'active' AND coalesce(phone, '') <> '' ORDER BY first_name, last_name")).rows
    .map(function (e) { return { id: e.id, name: e.first_name + ' ' + e.last_name, quiet: !!e.sms_opt_out }; });
}

async function setQuietStaff(ctx, p) {
  requireManage(ctx);
  p = p || {};
  var e = (await pool.query('SELECT id, first_name, last_name, sms_opt_out FROM employees WHERE id = $1', [p.employeeId])).rows[0];
  if (!e) fail('notfound', 'Staff member not found.');
  var quiet = p.quiet !== false;
  if (!!e.sms_opt_out !== quiet) {
    await pool.query('UPDATE employees SET sms_opt_out = $2 WHERE id = $1', [e.id, quiet]);
    await audit(pool, ctx, 'sms.quiet_staff', 'employee', e.id, quiet
      ? e.first_name + ' ' + e.last_name + ' no longer gets texts from the OS (sign-in codes they ask for still come).'
      : e.first_name + ' ' + e.last_name + ' gets texts from the OS again.');
  }
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
  status: status, saveSettings: saveSettings, sendTest: sendTest, AUTO_DAILY_LIMIT: AUTO_DAILY_LIMIT,
  loadSender: loadSender, senderId: senderId, saveSender: saveSender, checkSender: checkSender, registerSender: registerSender,
  setQuietStaff: setQuietStaff
};
