var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Texts and emails to a restaurant's guests (migration 0175), from the
// till's back office (Guests → Campaigns): a message to an audience —
// everyone, regulars, guests who have not come back, new guests, loyalty
// members, birthdays this month — sent now or at a set time; and the
// automatic ones the restaurant turns on (till settings campaigns): "we
// miss you" once a guest has not come back for a while, "happy birthday"
// on the day, "thank you for coming" after a first visit.
//
// Never to a guest who said no (at the till, or with the link every message
// carries); only to those who said yes when the restaurant says so; at most
// one a guest every few days, a limited number a day, and only in the hours
// the restaurant allows. Texts go through mNotify (sms.service), emails
// through the OS's mail (mail.service); without them set up a message is
// kept as skipped, saying why. Each one sent, failed or skipped is kept, and
// a campaign shows how many guests came back in the 14 days after it.

var KINDS = ['manual', 'lapsed', 'birthday', 'welcome'];
var AUDIENCES = ['all', 'regulars', 'lapsed', 'new', 'loyalty', 'birthday', 'spenders'];
var CAME_BACK_DAYS = 14;
var MAX_AUDIENCE = 5000;

function sms() { return require('./sms.service'); }
function mail() { return require('./mail.service'); }
function online() { return require('./restaurantOnline.service'); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function clean(v, max) { return String(v == null ? '' : v).replace(/[ \t]+/g, ' ').trim().slice(0, max); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
function hhmm(d) { return d.toISOString().slice(11, 16); } // Ghana keeps UTC

// Each guest with what is known of their visits: sales on the till (by the
// guest picked, or their phone number), points, last messaged.
var GUESTS =
  'WITH v AS (SELECT g.id, count(o.id)::int AS visits, max(o.created_at) AS last_at, min(o.created_at) AS first_at, ' +
  "   coalesce(sum(o.total) FILTER (WHERE o.created_at > now() - interval '90 days'), 0) AS spent90, count(o.id) FILTER (WHERE o.created_at > now() - interval '90 days')::int AS visits90 " +
  '  FROM restaurant_guests g LEFT JOIN restaurant_orders o ON o.company_id = g.company_id AND o.status = \'completed\' ' +
  "   AND (o.guest_id = g.id OR (g.phone_key <> '' AND o.guest_id IS NULL AND o.customer_phone <> '' AND restaurant_phone_key(o.customer_phone) = g.phone_key)) " +
  '  WHERE g.company_id = $1 GROUP BY g.id) ' +
  'SELECT g.id, g.name, g.phone, g.phone_key, g.email, g.birthday, g.marketing, g.unsubscribe_token, v.visits, v.visits90, v.spent90, v.last_at, v.first_at, ' +
  '  coalesce((SELECT sum(points) FROM restaurant_loyalty_entries l WHERE l.guest_id = g.id), 0)::int AS points, ' +
  '  (SELECT max(created_at) FROM restaurant_campaign_sends s WHERE s.guest_id = g.id AND s.status = \'sent\') AS messaged_at ' +
  'FROM restaurant_guests g JOIN v ON v.id = g.id WHERE g.company_id = $1 ';

// Who an audience is: { kind, days, visits, points, amount } — the guests in it.
function audienceOf(a) {
  a = a || {};
  var kind = AUDIENCES.indexOf(a.kind) >= 0 ? a.kind : 'all';
  var out = { kind: kind };
  if (kind === 'regulars') out.visits = Math.max(2, Math.min(50, Math.round(Number(a.visits) || 3)));
  if (kind === 'lapsed') out.days = Math.max(7, Math.min(730, Math.round(Number(a.days) || 30)));
  if (kind === 'new') out.days = Math.max(1, Math.min(90, Math.round(Number(a.days) || 30)));
  if (kind === 'loyalty') out.points = Math.max(1, Math.round(Number(a.points) || 1));
  if (kind === 'spenders') out.amount = Math.max(1, round2(a.amount || 500));
  return out;
}
function inAudience(g, a, now) {
  var day = 86400000;
  if (a.kind === 'regulars') return g.visits90 >= a.visits;
  if (a.kind === 'lapsed') return g.visits > 0 && g.last_at && now - new Date(g.last_at).getTime() > a.days * day;
  if (a.kind === 'new') return g.visits > 0 && g.first_at && now - new Date(g.first_at).getTime() <= a.days * day;
  if (a.kind === 'loyalty') return g.points >= a.points;
  if (a.kind === 'birthday') return !!g.birthday && new Date(g.birthday).getUTCMonth() === new Date(now).getUTCMonth();
  if (a.kind === 'spenders') return Number(g.spent90) >= a.amount;
  return true;
}
// Whether a message may go to a guest, by which way, and why not.
function reach(g, channel, settings, now) {
  if (g.marketing === 'no') return { why: 'said no' };
  if (settings.campaigns.onlyAgreed && g.marketing !== 'yes') return { why: 'not agreed' };
  var gap = settings.campaigns.perGuestDays;
  if (gap > 0 && g.messaged_at && now - new Date(g.messaged_at).getTime() < gap * 86400000) return { why: 'messaged lately' };
  var byText = !!g.phone_key && g.phone_key.length >= 10;
  var byMail = mail().isEmail(g.email);
  var ways = channel === 'sms' ? (byText ? ['sms'] : []) : channel === 'email' ? (byMail ? ['email'] : []) : (byText ? ['sms'] : byMail ? ['email'] : []);
  if (!ways.length) return { why: channel === 'email' ? 'no email' : channel === 'sms' ? 'no phone' : 'no phone or email' };
  return { ways: ways };
}

async function guestsOf(companyId) { return (await pool.query(GUESTS + 'ORDER BY g.name LIMIT ' + (MAX_AUDIENCE * 4), [companyId])).rows; }

// The words for one guest; the way to stop them at the end.
function render(message, g, co, link) {
  return String(message || '')
    .replace(/\{name\}/g, firstName(g.name) || 'there')
    .replace(/\{restaurant\}/g, co.name)
    .replace(/\{points\}/g, String(g.points || 0));
}
function stopLine(link, channel) { return channel === 'email' ? 'To stop these emails: ' + link : 'Stop: ' + link; }
async function unsubscribeLink(db, g, co) {
  var token = g.unsubscribe_token;
  if (!token) {
    token = crypto.randomBytes(9).toString('base64url');
    await db.query('UPDATE restaurant_guests SET unsubscribe_token = $2 WHERE id = $1 AND unsubscribe_token IS NULL', [g.id, token]);
    token = (await db.query('SELECT unsubscribe_token FROM restaurant_guests WHERE id = $1', [g.id])).rows[0].unsubscribe_token;
  }
  return online().siteUrlFor(co.code) + '/u/' + token;
}

// One message to one guest: sent, failed or skipped (not set up), kept.
async function deliver(c, g, co, way, settings) {
  var link = await unsubscribeLink(pool, g, co);
  var words = render(c.message, g, co);
  var status = 'sent', error = '', to = way === 'sms' ? g.phone : g.email;
  try {
    if (way === 'sms') {
      if (!sms().configured()) { status = 'skipped'; error = 'Texts are not set up on the server (mNotify).'; }
      else await sms().send({ to: g.phone, message: words + ' ' + stopLine(link, 'sms'), purpose: 'marketing', refId: c.id });
    } else {
      if (!mail().configured()) { status = 'skipped'; error = 'Email is not set up on the server.'; }
      else {
        var esc = mail().escapeHtml;
        await mail().send({ to: g.email, subject: c.subject || co.name, fromName: co.name, text: words + '\n\n' + stopLine(link, 'email'),
          html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">' + esc(words).replace(/\n/g, '<br>') +
            '<p style="margin-top:28px;font-size:12px;color:#6b7280">' + esc(co.name) + ' · <a href="' + esc(link) + '">Stop these emails</a></p></div>' });
      }
    }
  } catch (e) { status = 'failed'; error = String(e.message || e).slice(0, 300); }
  await pool.query('INSERT INTO restaurant_campaign_sends (campaign_id, company_id, guest_id, channel, to_addr, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [c.id, c.company_id, g.id, way, String(to || '').slice(0, 120), status, error]);
  return status;
}

async function sentToday(companyId) {
  return (await pool.query("SELECT count(*)::int AS n FROM restaurant_campaign_sends WHERE company_id = $1 AND status = 'sent' AND created_at >= date_trunc('day', now())", [companyId])).rows[0].n;
}
function inHours(settings, now) {
  var t = hhmm(new Date(now));
  return t >= settings.campaigns.from && t < settings.campaigns.to;
}

// Sends a campaign that is due: to its audience as it is now, within the
// day's limit; what is left (the limit reached, or out of hours) waits for
// the next round.
async function sendCampaign(c) {
  var settings = await access.settingsOf(c.company_id);
  var now = Date.now();
  if (!inHours(settings, now)) return { waiting: 'hours' };
  var co = (await pool.query('SELECT code, name FROM companies WHERE id = $1', [c.company_id])).rows[0];
  await pool.query("UPDATE restaurant_campaigns SET status = 'sending', started_at = coalesce(started_at, now()), updated_at = now() WHERE id = $1", [c.id]);
  var done = new Set((await pool.query('SELECT guest_id FROM restaurant_campaign_sends WHERE campaign_id = $1', [c.id])).rows.map(function (r) { return r.guest_id; }));
  var a = audienceOf(c.audience);
  var left = Math.max(0, settings.campaigns.dailyMax - await sentToday(c.company_id));
  var guests = (await guestsOf(c.company_id)).filter(function (g) { return !done.has(g.id) && inAudience(g, a, now); });
  var waiting = false;
  for (var i = 0; i < guests.length; i++) {
    var r = reach(guests[i], c.channel, settings, now);
    if (!r.ways) continue;
    if (left <= 0) { waiting = true; break; }
    var st = await deliver(c, guests[i], co, r.ways[0], settings);
    if (st === 'sent') left -= 1;
  }
  var counts = await countsOf(c.id);
  await pool.query('UPDATE restaurant_campaigns SET status = $2, finished_at = CASE WHEN $2 = \'sent\' THEN now() ELSE finished_at END, counts = $3, updated_at = now() WHERE id = $1',
    [c.id, waiting ? 'sending' : 'sent', JSON.stringify(counts)]);
  if (!waiting) {
    await activity.log(pool, { companyId: c.company_id, employeeId: c.created_by, app: 'settings', action: 'settings.campaign_sent',
      summary: 'The campaign "' + c.name + '" went out: ' + counts.sent + ' sent' + (counts.failed ? ', ' + counts.failed + ' failed' : '') + (counts.skipped ? ', ' + counts.skipped + ' not sent' : '') + '.',
      refType: 'campaign', refId: c.id });
  }
  return { waiting: waiting ? 'limit' : null, counts: counts };
}
async function countsOf(id) {
  var r = (await pool.query("SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'skipped')::int AS skipped, " +
    "count(*) FILTER (WHERE status = 'sent' AND channel = 'sms')::int AS sms, count(*) FILTER (WHERE status = 'sent' AND channel = 'email')::int AS email FROM restaurant_campaign_sends WHERE campaign_id = $1", [id])).rows[0];
  return r;
}

// The automatic ones, for one restaurant: whoever is due today.
async function autoRow(companyId, kind, settings) {
  var x = settings.campaigns[kind];
  var names = { lapsed: 'We miss you', birthday: 'Happy birthday', welcome: 'Thank you for coming' };
  var row = (await pool.query(
    "INSERT INTO restaurant_campaigns (company_id, kind, name, channel, message, status) VALUES ($1,$2,$3,$4,$5,'auto') " +
    'ON CONFLICT (company_id, kind) WHERE kind <> \'manual\' DO UPDATE SET channel = EXCLUDED.channel, message = EXCLUDED.message, updated_at = now() RETURNING *',
    [companyId, kind, names[kind], x.channel, x.message])).rows[0];
  return row;
}
async function runAuto(companyId) {
  var settings = await access.settingsOf(companyId);
  var cs = settings.campaigns;
  if (!cs.lapsed.on && !cs.birthday.on && !cs.welcome.on) return 0;
  var now = Date.now();
  if (!inHours(settings, now)) return 0;
  var co = (await pool.query('SELECT code, name FROM companies WHERE id = $1', [companyId])).rows[0];
  var left = Math.max(0, cs.dailyMax - await sentToday(companyId));
  var guests = await guestsOf(companyId);
  var sent = 0, day = 86400000;
  var lastOf = {};
  (await pool.query("SELECT s.guest_id, c.kind, max(s.created_at) AS at FROM restaurant_campaign_sends s JOIN restaurant_campaigns c ON c.id = s.campaign_id " +
    "WHERE s.company_id = $1 AND c.kind <> 'manual' AND s.status <> 'failed' GROUP BY 1, 2", [companyId])).rows.forEach(function (r) { lastOf[r.guest_id + ':' + r.kind] = new Date(r.at).getTime(); });
  var today = new Date(now);
  for (var k = 0; k < 3; k++) {
    var kind = ['birthday', 'welcome', 'lapsed'][k];
    if (!cs[kind].on) continue;
    var c = await autoRow(companyId, kind, settings);
    for (var i = 0; i < guests.length && left > 0; i++) {
      var g = guests[i];
      var last = lastOf[g.id + ':' + kind] || 0;
      var due = false;
      if (kind === 'birthday') {
        var b = g.birthday ? new Date(g.birthday) : null;
        due = !!b && b.getUTCMonth() === today.getUTCMonth() && b.getUTCDate() === today.getUTCDate() && (!last || new Date(last).getUTCFullYear() !== today.getUTCFullYear());
      } else if (kind === 'welcome') {
        due = g.visits === 1 && g.first_at && now - new Date(g.first_at).getTime() > 12 * 3600000 && now - new Date(g.first_at).getTime() < 4 * day && !last;
      } else {
        due = g.visits > 0 && g.last_at && now - new Date(g.last_at).getTime() > cs.lapsed.days * day && last < new Date(g.last_at).getTime();
      }
      if (!due) continue;
      var r = reach(g, cs[kind].channel, settings, now);
      if (!r.ways) continue;
      var st = await deliver(c, g, co, r.ways[0], settings);
      lastOf[g.id + ':' + kind] = now;
      if (st === 'sent') { left -= 1; sent += 1; g.messaged_at = new Date(now); }
    }
    await pool.query('UPDATE restaurant_campaigns SET counts = $2, updated_at = now() WHERE id = $1', [c.id, JSON.stringify(await countsOf(c.id))]);
  }
  return sent;
}

// The job (jobs/campaigns.js): campaigns that are due, and the automatic ones.
async function runDue() {
  var due = (await pool.query("SELECT * FROM restaurant_campaigns WHERE (status = 'scheduled' AND send_at <= now()) OR status = 'sending' ORDER BY send_at")).rows;
  for (var i = 0; i < due.length; i++) {
    try { await sendCampaign(due[i]); } catch (e) { console.error('Campaign not sent:', e.message); }
  }
  var companies = (await pool.query("SELECT company_id FROM restaurant_till_settings WHERE settings -> 'campaigns' IS NOT NULL")).rows;
  var total = 0;
  for (var j = 0; j < companies.length; j++) {
    try { total += await runAuto(companies[j].company_id); } catch (e) { console.error('Automatic messages not sent:', e.message); }
  }
  return { campaigns: due.length, automatic: total };
}

// ── the back office (a manager) ──

function campaignOut(c, results) {
  return {
    id: c.id, kind: c.kind, name: c.name, channel: c.channel, audience: c.audience || {}, subject: c.subject, message: c.message, status: c.status,
    sendAt: c.send_at, startedAt: c.started_at, finishedAt: c.finished_at, counts: c.counts || {}, createdAt: c.created_at,
    by: c.first_name ? c.first_name + ' ' + c.last_name : null, results: results || null
  };
}
// Guests who came back within 14 days of being messaged, and what they spent.
async function resultsOf(c) {
  var r = (await pool.query(
    'SELECT count(DISTINCT s.guest_id)::int AS guests, coalesce(sum(o.total), 0) AS spent, count(o.id)::int AS orders FROM restaurant_campaign_sends s ' +
    'JOIN restaurant_guests g ON g.id = s.guest_id JOIN restaurant_orders o ON o.company_id = s.company_id AND o.status = \'completed\' ' +
    "  AND (o.guest_id = g.id OR (g.phone_key <> '' AND o.guest_id IS NULL AND restaurant_phone_key(o.customer_phone) = g.phone_key)) " +
    "  AND o.created_at > s.created_at AND o.created_at < s.created_at + interval '" + CAME_BACK_DAYS + " days' " +
    "WHERE s.campaign_id = $1 AND s.status = 'sent'", [c.id])).rows[0];
  return { guests: r.guests, orders: r.orders, spent: round2(r.spent) };
}

function cleanCampaign(p) {
  p = p || {};
  var name = clean(p.name, 60);
  if (name.length < 2) fail('invalid', 'Give the campaign a name, for you.');
  var channel = ['sms', 'email', 'both'].indexOf(p.channel) >= 0 ? p.channel : fail('invalid', 'By text, by email or both?');
  var message = String(p.message || '').trim().slice(0, 480);
  if (message.length < 10) fail('invalid', 'Write the message.');
  var subject = clean(p.subject, 120);
  return { name: name, channel: channel, message: message, subject: subject, audience: audienceOf(p.audience) };
}

// POST /api/pos/settings/campaigns { managerPin, action, … } — list
// (default), preview, save, send (now or at), cancel.
async function tab(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  var settings = await access.settingsOf(company);
  var action = p.action || 'list';
  if (action === 'preview') return preview(company, settings, p);
  if (action === 'save' || action === 'send') {
    var c = cleanCampaign(p.campaign);
    var row;
    if (p.id) {
      row = (await pool.query("UPDATE restaurant_campaigns SET name = $3, channel = $4, message = $5, subject = $6, audience = $7, updated_at = now() WHERE id = $1 AND company_id = $2 AND kind = 'manual' AND status IN ('draft', 'scheduled') RETURNING *",
        [p.id, company, c.name, c.channel, c.message, c.subject, JSON.stringify(c.audience)])).rows[0];
      if (!row) fail('conflict', 'That campaign has gone out already: it cannot be changed.');
    } else {
      row = (await pool.query("INSERT INTO restaurant_campaigns (company_id, name, channel, message, subject, audience, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [company, c.name, c.channel, c.message, c.subject, JSON.stringify(c.audience), m.manager.id])).rows[0];
    }
    if (action === 'send') {
      var at = p.sendAt ? new Date(p.sendAt) : new Date();
      if (isNaN(at.getTime())) fail('invalid', 'When should it go?');
      if (at.getTime() > Date.now() + 90 * 86400000) fail('invalid', 'Within the next 90 days.');
      if (at.getTime() < Date.now() - 60000) at = new Date();
      await pool.query("UPDATE restaurant_campaigns SET status = 'scheduled', send_at = $2, updated_at = now() WHERE id = $1", [row.id, at]);
      await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'settings', action: 'settings.campaign',
        summary: 'Campaign "' + c.name + '" ' + (at.getTime() <= Date.now() + 60000 ? 'sent' : 'set for ' + at.toISOString().slice(0, 16).replace('T', ' ')) + ' (' + c.channel + ').', refType: 'campaign', refId: row.id });
      // Now: it starts at once, in the background.
      if (at.getTime() <= Date.now() + 60000 && !require('../config').isTest) setImmediate(function () { runDue().catch(function (e) { console.error('Campaign:', e.message); }); });
    }
  }
  if (action === 'cancel') {
    var x = (await pool.query("UPDATE restaurant_campaigns SET status = 'cancelled', updated_at = now() WHERE id = $1 AND company_id = $2 AND status IN ('draft', 'scheduled', 'sending') RETURNING id", [p.id, company])).rows[0];
    if (!x) fail('conflict', 'That campaign has gone out already.');
  }
  return list(company, settings);
}
async function list(company, settings) {
  var rows = (await pool.query(
    'SELECT c.*, e.first_name, e.last_name FROM restaurant_campaigns c LEFT JOIN employees e ON e.id = c.created_by WHERE c.company_id = $1 ORDER BY (c.kind = \'manual\'), c.created_at DESC LIMIT 60', [company])).rows;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var c = rows[i];
    out.push(campaignOut(c, c.status === 'sent' || c.status === 'sending' || c.status === 'auto' ? await resultsOf(c) : null));
  }
  var g = (await pool.query(
    "SELECT count(*)::int AS guests, count(*) FILTER (WHERE phone_key <> '' AND length(phone_key) >= 10)::int AS phones, count(*) FILTER (WHERE email ~* '^[^@ ]+@[^@ ]+\\.[^@ ]+$')::int AS emails, " +
    "count(*) FILTER (WHERE marketing = 'yes')::int AS agreed, count(*) FILTER (WHERE marketing = 'no')::int AS said_no FROM restaurant_guests WHERE company_id = $1", [company])).rows[0];
  return {
    campaigns: out, guests: g, settings: settings.campaigns, smsOn: sms().configured(), emailOn: mail().configured(),
    sentToday: await sentToday(company)
  };
}
// How many an audience reaches, by which way, who is left out and why, and the message for one of them.
async function preview(company, settings, p) {
  var c = cleanCampaign(Object.assign({ name: 'Preview', message: 'Preview message.', channel: 'sms' }, p.campaign || {}));
  var now = Date.now();
  var a = audienceOf(c.audience);
  var all = (await guestsOf(company)).filter(function (g) { return inAudience(g, a, now); });
  var by = { sms: 0, email: 0 }, out = {};
  var sample = null;
  all.forEach(function (g) {
    var r = reach(g, c.channel, settings, now);
    if (r.ways) { by[r.ways[0]] += 1; if (!sample) sample = g; }
    else out[r.why] = (out[r.why] || 0) + 1;
  });
  var co = (await pool.query('SELECT code, name FROM companies WHERE id = $1', [company])).rows[0];
  var words = sample ? render(c.message, sample, co) : render(c.message, { name: 'Ama', points: 120 }, co);
  var smsText = words + ' Stop: ' + online().siteUrlFor(co.code) + '/u/xxxxxxxxxxxx';
  var segments = Math.ceil(smsText.length / (/[^\x00-\x7F]/.test(smsText) ? 67 : 153)) || 1;
  return {
    audience: a, matching: all.length, reach: by.sms + by.email, bySms: by.sms, byEmail: by.email, left: out,
    sample: { name: sample ? firstName(sample.name) : 'Ama', text: words, smsText: smsText, segments: smsText.length <= 160 ? 1 : segments },
    smsOn: sms().configured(), emailOn: mail().configured(), dailyMax: settings.campaigns.dailyMax, sentToday: await sentToday(company)
  };
}

// GET /api/pos/online/unsubscribe/:token — the link in every message: no more.
async function unsubscribe(token, confirm) {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(token || ''))) fail('notfound', 'This link is not right.');
  var g = (await pool.query('SELECT g.id, g.name, g.marketing, c.name AS company_name, c.code FROM restaurant_guests g JOIN companies c ON c.id = g.company_id WHERE g.unsubscribe_token = $1', [token])).rows[0];
  if (!g) fail('notfound', 'This link is not right, or no longer works.');
  if (confirm && g.marketing !== 'no') {
    await pool.query("UPDATE restaurant_guests SET marketing = 'no', marketing_at = now() WHERE id = $1", [g.id]);
    g.marketing = 'no';
  }
  return { restaurant: { code: g.code, name: g.company_name }, name: firstName(g.name), stopped: g.marketing === 'no' };
}

module.exports = {
  KINDS: KINDS, AUDIENCES: AUDIENCES, audienceOf: audienceOf, inAudience: inAudience, reach: reach, render: render,
  sendCampaign: sendCampaign, runAuto: runAuto, runDue: runDue, tab: tab, preview: preview, unsubscribe: unsubscribe, resultsOf: resultsOf
};
