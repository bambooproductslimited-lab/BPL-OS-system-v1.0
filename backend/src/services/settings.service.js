var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { withLiveConfigState } = require('./envConfiguredIntegrations');
var config = require('../config');

// A stored integration secret must never travel back to a browser. It was
// riding along on settings.get, which only needs employee.read — so every
// employee could read any connected integration's key, while the properly
// gated integrations list sat next to it requiring settings.manage. Nothing
// leaks today only because no key has been set through this path yet.
//
// The Integrations screen shows this field in a disabled input as
// `apiKey || MASK`, so it never needed the real value: dropping it shows
// the mask, which is what that field was always meant to look like.
// hasApiKey carries the one bit the UI legitimately needs.
function redactIntegrations(list) {
  return (Array.isArray(list) ? list : []).map(function (i) {
    var copy = Object.assign({}, i);
    copy.hasApiKey = !!(i && i.apiKey);
    delete copy.apiKey;
    return copy;
  });
}

function rowToSettings(r) {
  return {
    companyName: r.company_name, shortName: r.short_name, country: r.country, currency: r.currency,
    timezone: r.timezone, fiscalYearStart: r.fiscal_year_start, workWeek: r.work_week,
    standardHours: r.standard_hours, lateAfter: r.late_after ? r.late_after.slice(0, 5) : null,
    plants: r.plants, leaveApprovalChain: r.leave_approval_chain, updatedAt: r.updated_at,
    commercial: r.commercial, integrations: redactIntegrations(r.integrations)
  };
}

// kernel.js: handlers['settings.get']
async function get(ctx) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var res = await pool.query('SELECT * FROM settings WHERE id = 1');
  var out = rowToSettings(res.rows[0]);
  // The grace in force today (attendance.service.js, migration 0074).
  var grace = await pool.query('SELECT minutes FROM late_grace WHERE effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1');
  out.lateGraceMinutes = grace.rows[0] ? Number(grace.rows[0].minutes) : 10;
  // How the grace has changed, newest first, and what the settings page
  // links to elsewhere (counts only).
  out.lateGraceHistory = (await pool.query(
    "SELECT g.effective_from, g.minutes, e.first_name || ' ' || e.last_name AS set_by FROM late_grace g LEFT JOIN employees e ON e.id = g.set_by ORDER BY g.effective_from DESC LIMIT 6"
  )).rows.map(function (r) { return { from: r.effective_from, minutes: Number(r.minutes), setBy: r.set_by || null }; });
  out.structure = (await pool.query(
    "SELECT (SELECT count(*) FROM companies)::int AS companies, (SELECT count(*) FROM departments)::int AS departments, " +
    "(SELECT count(*) FROM leave_types WHERE active)::int AS leave_types, (SELECT count(*) FROM holidays WHERE date >= CURRENT_DATE)::int AS holidays_ahead, " +
    "(SELECT count(*) FROM employees WHERE status <> 'terminated')::int AS employees"
  )).rows[0];
  var roles = (await pool.query('SELECT key, name FROM roles WHERE key = ANY($1::text[])', [out.leaveApprovalChain || []])).rows;
  out.leaveApprovalNames = (out.leaveApprovalChain || []).map(function (k) { var r = roles.find(function (x) { return x.key === k; }); return r ? r.name : k; });
  return out;
}

// The latest changes to company settings, integrations, text messages and
// email, from the audit log.
async function changes(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var res = await pool.query(
    "SELECT at, actor_name, action, summary FROM audit_logs WHERE split_part(action, '.', 1) IN ('settings', 'integration', 'sms', 'mail', 'commercial') " +
    "AND action NOT IN ('sms.send', 'mail.send', 'sms.test', 'mail.test') ORDER BY at DESC LIMIT 20");
  return res.rows.map(function (r) { return { at: r.at, actorName: r.actor_name, action: r.action, summary: r.summary }; });
}

var TEXT_FIELDS = { companyName: 'company_name', shortName: 'short_name', country: 'country', currency: 'currency', timezone: 'timezone', workWeek: 'work_week', lateAfter: 'late_after' };

var LABELS = { companyName: 'company name', shortName: 'short name', country: 'country', currency: 'default currency', timezone: 'time zone', workWeek: 'work week', lateAfter: 'counted late after', fiscalYearStart: 'fiscal year start', standardHours: 'standard hours' };

// kernel.js: handlers['settings.save']
// Only what is sent changes; the audit log says what changed, from what to
// what. The default currency must be one of the enabled ones, and can't be
// taken off the list while it is the default.
async function save(ctx, p) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var row = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
  var before = rowToSettings(row);

  var sets = [], values = [], changed = [];
  function set(col, v, key, shownBefore, shownAfter) {
    values.push(v);
    sets.push(col + ' = $' + values.length);
    if (String(shownBefore === null || shownBefore === undefined ? '' : shownBefore) !== String(shownAfter)) changed.push(LABELS[key] + ' ' + (shownBefore || '—') + ' → ' + shownAfter);
  }
  Object.keys(TEXT_FIELDS).forEach(function (k) {
    if (p[k] === undefined) return;
    var v = V.text(p[k], LABELS[k] || k, 60);
    if (k === 'lateAfter') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail('invalid', 'Counted late after must be a time like 07:10.');
    }
    if (k === 'currency') v = v.toUpperCase();
    set(TEXT_FIELDS[k], v, k, before[k], v);
  });
  if (p.fiscalYearStart !== undefined) {
    var fy = String(p.fiscalYearStart || '').trim();
    if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(fy)) fail('invalid', 'The fiscal year start must be a month and day like 01-01.');
    set('fiscal_year_start', fy, 'fiscalYearStart', before.fiscalYearStart, fy);
  }
  if (p.standardHours !== undefined) {
    var hours = Number(p.standardHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 12) fail('invalid', 'Standard hours must be from 1 to 12.');
    set('standard_hours', hours, 'standardHours', before.standardHours, hours);
  }

  // Multi-currency: the enabled-currency list every quotation/estimate/
  // invoice currency picker (and documents.js's resolveCurrency()) draws
  // from. It lives in the commercial jsonb blob, not a plain column.
  var commercial = row.commercial || {};
  var currencies = commercial.currencies || ['GHS'];
  if (p.currencies !== undefined) {
    var codes = (Array.isArray(p.currencies) ? p.currencies : []).map(function (c) { return String(c || '').trim().toUpperCase(); });
    codes.forEach(function (c) { if (!/^[A-Z]{3}$/.test(c)) fail('invalid', 'A currency code is three letters, like GHS or USD.'); });
    var unique = codes.filter(function (c, i) { return codes.indexOf(c) === i; });
    if (!unique.length) fail('invalid', 'Keep at least one currency enabled.');
    var added = unique.filter(function (c) { return currencies.indexOf(c) < 0; });
    var removed = currencies.filter(function (c) { return unique.indexOf(c) < 0; });
    if (added.length) changed.push('added currency ' + added.join(', '));
    if (removed.length) changed.push('removed currency ' + removed.join(', '));
    currencies = unique;
  }
  var defaultCurrency = p.currency !== undefined ? String(p.currency).trim().toUpperCase() : before.currency;
  if (currencies.indexOf(defaultCurrency) < 0) {
    fail('invalid', p.currencies !== undefined && p.currency === undefined
      ? defaultCurrency + ' is the default currency. Choose another default before removing it.'
      : 'The default currency must be one of the enabled currencies.');
  }

  if (sets.length) await pool.query('UPDATE settings SET ' + sets.join(', ') + ', updated_at = now() WHERE id = 1', values);
  if (p.currencies !== undefined) {
    // Only the currencies: writing back the whole copy read above could put
    // the document number counters back (see commercialSettings.service.js).
    await pool.query('UPDATE settings SET commercial = commercial || $1::jsonb, updated_at = now() WHERE id = 1', [JSON.stringify({ currencies: currencies })]);
  }

  // Minutes after a shift start that still count as on time. Takes effect
  // from today; days before keep the grace they were judged by.
  if (p.lateGraceMinutes !== undefined && p.lateGraceMinutes !== null && p.lateGraceMinutes !== '') {
    var minutes = Number(p.lateGraceMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) fail('invalid', 'Minutes before someone is late must be a whole number from 0 to 240.');
    var current = await pool.query('SELECT minutes FROM late_grace WHERE effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1');
    if (!current.rows[0] || Number(current.rows[0].minutes) !== minutes) {
      await pool.query(
        'INSERT INTO late_grace (effective_from, minutes, set_by) VALUES (CURRENT_DATE, $1, $2) ' +
        'ON CONFLICT (effective_from) DO UPDATE SET minutes = EXCLUDED.minutes, set_by = EXCLUDED.set_by, set_at = now()',
        [minutes, ctx.employee ? ctx.employee.id : null]
      );
      await audit(pool, ctx, 'settings.lateGrace', 'settings', 'company', 'Late after ' + minutes + ' minutes past the shift start, from today.');
    }
  }

  if (changed.length) {
    var said = changed.join('; ');
    await audit(pool, ctx, 'settings.save', 'settings', 'company', said.charAt(0).toUpperCase() + said.slice(1) + '.');
  }
  return get(ctx);
}

// How each integration is connected: 'oauth' (a Connect button that signs
// in to the platform), 'server' (set up with keys in the server's
// settings on Render, nothing to type here), or 'planned' (listed so it
// can be asked for, but nothing in the OS uses it yet — a key pasted for
// it would sit unused, so none is asked for).
var HOW = {
  facebook: 'oauth', instagram: 'oauth', tiktok: 'oauth', youtube: 'oauth', twitch: 'oauth',
  whatsappbusiness: 'server', googleanalytics: 'server', squareup: 'server', timestation: 'server',
  slack: 'planned', quickbooks: 'planned', linkedin: 'planned'
};
// Whether the platform's app keys are on the server, which a Connect
// button needs before it can work.
function oauthReady(id) {
  if (id === 'facebook' || id === 'instagram') return config.meta.configured;
  if (config[id] && typeof config[id].configured === 'boolean') return config[id].configured;
  return true;
}

// kernel.js: handlers['integrations.list']
// Each with how it connects, whether its Connect button can work, and the
// latest connect / disconnect from the audit log.
async function listIntegrations(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var res = await pool.query('SELECT integrations FROM settings WHERE id = 1');
  var list = redactIntegrations(withLiveConfigState(res.rows[0].integrations || []));
  var last = (await pool.query(
    "SELECT DISTINCT ON (entity_id) entity_id, at, actor_name, action FROM audit_logs WHERE entity = 'integration' ORDER BY entity_id, at DESC")).rows;
  return list.map(function (i) {
    var l = last.find(function (x) { return x.entity_id === i.id; });
    return Object.assign(i, {
      how: HOW[i.id] || 'planned', ready: HOW[i.id] === 'oauth' ? oauthReady(i.id) : true,
      lastChange: l ? { at: l.at, actorName: l.actor_name, action: l.action } : null
    });
  });
}

// The services the OS uses that are set up only in the server's settings
// (Render → Environment): whether each is ready, what it powers and which
// settings it needs. Only yes/no and the names of the settings — never a
// value.
function services(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var list = [
    { id: 'ai', name: 'Claude (Anthropic)', powers: 'The AI Assistant and marketing suggestions.', ready: !!config.ai.apiKey, env: ['ANTHROPIC_API_KEY'], page: '/assistant', essential: false },
    { id: 'sms', name: 'mNotify', powers: 'Text messages: payment reminders, booking notices, sign-in codes.', ready: !!config.sms.configured, env: ['MNOTIFY_API_KEY', 'MNOTIFY_SENDER_ID'], page: '/settings', essential: true },
    { id: 'mail', name: 'Email (SMTP)', powers: 'Sign-in codes by email.', ready: !!config.mail.configured, env: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'], page: '/settings', essential: false },
    { id: 'storage', name: 'Cloudflare R2', powers: 'File storage for documents, photos and receipts. Without it, files up to 15 MB are kept in the database.', ready: !!config.r2.configured, env: ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'], page: '/documents', essential: true },
    { id: 'drive', name: 'Google Drive', powers: 'Importing documents from Google Drive.', ready: !!config.googleDrive.configured && !config.googleDrive.jsonInvalid, env: ['GOOGLE_SERVICE_ACCOUNT_JSON'], page: '/documents', essential: false },
    { id: 'timestation', name: 'TimeStation', powers: 'Importing employees and clock-ins from TimeStation.', ready: !!config.timestation.configured, env: ['TIMESTATION_API_KEY'], page: '/attendance', essential: false },
    { id: 'square', name: 'Square', powers: 'Importing customers, catalogue, invoices and payments from Square.', ready: !!config.square.configured, env: ['SQUARE_ACCESS_TOKEN'], page: '/integrations', essential: false },
    { id: 'whatsapp', name: 'WhatsApp Business', powers: 'The WhatsApp channel on the Social & campaign tracker.', ready: !!config.whatsapp.configured, env: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_VERIFY_TOKEN'], page: '/socialtracker', essential: false },
    { id: 'ga4', name: 'Google Analytics', powers: 'Website visits on the Social & campaign tracker.', ready: !!config.website.configured, env: ['GA4_PROPERTY_ID', 'GA4_SERVICE_ACCOUNT_EMAIL', 'GA4_SERVICE_ACCOUNT_PRIVATE_KEY'], page: '/socialtracker', essential: false },
    { id: 'meta', name: 'Meta app', powers: 'The Connect buttons for Facebook and Instagram.', ready: !!config.meta.configured, env: ['META_APP_ID', 'META_APP_SECRET'], page: '/integrations', essential: false },
    { id: 'tiktok', name: 'TikTok app', powers: 'The Connect button for TikTok.', ready: !!config.tiktok.configured, env: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'], page: '/integrations', essential: false },
    { id: 'youtube', name: 'YouTube app', powers: 'The Connect button for YouTube.', ready: !!config.youtube.configured, env: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'], page: '/integrations', essential: false },
    { id: 'twitch', name: 'Twitch app', powers: 'The Connect button for Twitch.', ready: !!config.twitch.configured, env: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'], page: '/integrations', essential: false }
  ];
  return list;
}

async function findIntegration(id) {
  var res = await pool.query('SELECT integrations FROM settings WHERE id = 1');
  var list = res.rows[0].integrations || [];
  var i = list.findIndex(function (x) { return x.id === id; });
  return { list: list, index: i };
}

// kernel.js: handlers['integrations.connect']
async function connect(ctx, id, apiKey) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var found = await findIntegration(id);
  if (found.index < 0) fail('notfound', 'Integration not found.');
  found.list[found.index].apiKey = V.text(apiKey, 'API key', 200);
  found.list[found.index].connected = true;
  await pool.query('UPDATE settings SET integrations = $1, updated_at = now() WHERE id = 1', [JSON.stringify(found.list)]);
  await audit(pool, ctx, 'integration.connect', 'integration', id, 'Connected ' + found.list[found.index].name + '.');
  return redactIntegrations([found.list[found.index]])[0];
}

// kernel.js: handlers['integrations.disconnect']
async function disconnect(ctx, id) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var found = await findIntegration(id);
  if (found.index < 0) fail('notfound', 'Integration not found.');
  found.list[found.index].connected = false;
  found.list[found.index].apiKey = '';
  await pool.query('UPDATE settings SET integrations = $1, updated_at = now() WHERE id = 1', [JSON.stringify(found.list)]);
  // TikTok/Facebook/Instagram/YouTube/Twitch's real OAuth tokens live in
  // a dedicated table (see tiktokOAuth.service.js / metaOAuth.service.js
  // / youtubeOAuth.service.js / twitchOAuth.service.js), not the generic
  // apiKey field above — clear those out too so a "disconnected" channel
  // can't still sync.
  if (id === 'tiktok' || id === 'facebook' || id === 'instagram' || id === 'youtube' || id === 'twitch') {
    await pool.query('DELETE FROM marketing_oauth_tokens WHERE channel_key = $1', [id]);
  }
  await audit(pool, ctx, 'integration.disconnect', 'integration', id, 'Disconnected ' + found.list[found.index].name + '.');
  return found.list[found.index];
}

module.exports = { get: get, save: save, changes: changes, services: services, listIntegrations: listIntegrations, connect: connect, disconnect: disconnect };
