// Which companies have a social & campaign tracker, and which channels each
// one tracks (migration 0079). Bamboo Products Limited's set predates the
// others and keeps its plain keys ('facebook', 'tiktok' …); every other
// company's channels are keyed '<code>-<platform>' ('sbr-facebook'), so a
// key names one account of one company everywhere — including the OAuth
// tokens, which are stored per channel key.
//
// Used by bootstrap.js on every deploy (adds what's missing, never removes)
// and by seed.js.

var BPL_CHANNELS = [
  { platform: 'facebook', name: 'Facebook', kind: 'social', integrationKey: 'facebook' },
  { platform: 'instagram', name: 'Instagram', kind: 'social', integrationKey: 'instagram' },
  { platform: 'tiktok', name: 'TikTok', kind: 'social', integrationKey: 'tiktok' },
  { platform: 'whatsapp', name: 'WhatsApp Business', kind: 'social', integrationKey: 'whatsappbusiness' },
  { platform: 'youtube', name: 'YouTube', kind: 'social', integrationKey: 'youtube' },
  { platform: 'twitch', name: 'Twitch', kind: 'social', integrationKey: 'twitch' },
  { platform: 'linkedin', name: 'LinkedIn Page', kind: 'social', integrationKey: 'linkedin' },
  { platform: 'website', name: 'Website', kind: 'web', integrationKey: 'googleanalytics' },
  // ThomasNet is a B2B directory listing, not a platform with a public
  // analytics API — no integration_key to connect; inquiries/leads from it
  // are logged manually like everything else here until that changes.
  { platform: 'thomasnet', name: 'ThomasNet', kind: 'directory', integrationKey: null }
];

// A restaurant's channels: where diners find it, follow it and talk about
// it. Facebook, Instagram, TikTok and YouTube can be connected to their own
// accounts for live numbers; the website to its own Google Analytics
// property; the rest are logged by hand.
var RESTAURANT_CHANNELS = [
  { platform: 'facebook', name: 'Facebook', kind: 'social' },
  { platform: 'instagram', name: 'Instagram', kind: 'social' },
  { platform: 'tiktok', name: 'TikTok', kind: 'social' },
  { platform: 'youtube', name: 'YouTube', kind: 'social' },
  { platform: 'whatsapp', name: 'WhatsApp Business', kind: 'social' },
  { platform: 'website', name: 'Website', kind: 'web' },
  { platform: 'googlebusiness', name: 'Google Business Profile', kind: 'directory' },
  { platform: 'tripadvisor', name: 'TripAdvisor', kind: 'directory' }
];

// In the order the tracker's company switcher shows them. A company is
// found by its code or, failing that, its name: company codes are set by
// hand in Companies & departments (Star Bar Restaurant is 'SB' on the live
// system, 'SBR' in the demo data), so neither can be assumed.
var TRACKED = [
  { code: 'BPL', codes: ['BPL'], channels: BPL_CHANNELS },
  { code: 'SBR', codes: ['SBR', 'SB'], name: /star\s*bar/i, channels: RESTAURANT_CHANNELS },
  { code: 'BGN', codes: ['BGN', 'BG1', 'BG'], name: /bamboo\s*garden/i, channels: RESTAURANT_CHANNELS }
];

// Platforms that connect to an account for live numbers, per company.
var CONNECTABLE = ['facebook', 'instagram', 'tiktok', 'youtube', 'website'];

// Bamboo Products' channels keep their plain keys; everyone else's are
// '<their company code>-<platform>' ('sb-facebook').
function channelKey(code, platform) {
  return code === 'BPL' ? platform : String(code).toLowerCase() + '-' + platform;
}

// The existing companies with a tracker, in switcher order, each with the
// channel set it gets: [{ id, code, name, channels }].
function trackedCompanies(companies) {
  var found = [];
  TRACKED.forEach(function (t) {
    var co = companies.filter(function (c) { return t.codes.indexOf(String(c.code).toUpperCase()) >= 0; })[0] ||
      (t.name && companies.filter(function (c) { return t.name.test(c.name || ''); })[0]);
    if (co && !found.some(function (f) { return f.id === co.id; })) {
      found.push({ id: co.id, code: co.code, name: co.name, channels: t.channels });
    }
  });
  return found;
}

// Adds any tracked company's missing channels (for companies that exist),
// and fills in company/platform on channels made before migration 0079.
// A company counts as having a platform's channel whatever its key, so a
// company code changed later doesn't bring a second set. Never removes or
// renames anything.
async function ensureChannels(client, opts) {
  var log = opts && opts.log;
  var companies = (await client.query('SELECT id, code, name FROM companies')).rows;
  var bpl = companies.filter(function (c) { return c.code === 'BPL'; })[0];
  if (bpl) {
    await client.query('UPDATE marketing_channels SET company_id = $1 WHERE company_id IS NULL', [bpl.id]);
    await client.query('UPDATE marketing_campaigns SET company_id = $1 WHERE company_id IS NULL', [bpl.id]);
  }
  await client.query('UPDATE marketing_channels SET platform = key WHERE platform IS NULL');
  var existing = {};
  (await client.query('SELECT key, company_id, platform FROM marketing_channels')).rows.forEach(function (r) {
    existing[r.key] = true;
    existing[r.company_id + '|' + r.platform] = true;
  });
  var added = 0;
  var tracked = trackedCompanies(companies);
  for (var i = 0; i < tracked.length; i++) {
    var t = tracked[i];
    for (var j = 0; j < t.channels.length; j++) {
      var c = t.channels[j];
      var key = channelKey(t.code, c.platform);
      if (existing[key] || existing[t.id + '|' + c.platform]) continue;
      if (log) log('Adding marketing channel: ' + t.code + ' ' + c.name);
      await client.query(
        'INSERT INTO marketing_channels (key, name, kind, integration_key, platform, company_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING',
        [key, c.name, c.kind, c.integrationKey || null, c.platform, t.id]
      );
      added++;
    }
  }
  return added;
}

// A channel by its key, checked to be on the platform a sync or connect is
// for: { id, key, name, platform, handle, company_code, company_name }.
// Callers default the key to Bamboo Products' ('facebook' …), so requests
// made before there were other companies still work.
async function channelFor(key, platform) {
  var { pool } = require('../db/pool');
  var { fail } = require('../utils/errors');
  var k = String(key || platform);
  var r = (await pool.query(
    'SELECT ch.id, ch.key, ch.name, ch.platform, ch.handle, co.code AS company_code, co.name AS company_name ' +
    'FROM marketing_channels ch LEFT JOIN companies co ON co.id = ch.company_id WHERE ch.key = $1', [k]
  )).rows[0];
  if (!r || (r.platform || r.key) !== platform) fail('notfound', 'That ' + platform + ' channel was not found.');
  r.company_code = r.company_code || 'BPL';
  return r;
}

// A company's channel on a platform, whatever its key (Meta connects a
// company's Facebook Page and its Instagram together).
async function channelForCompany(code, platform) {
  var { pool } = require('../db/pool');
  var { fail } = require('../utils/errors');
  var r = (await pool.query(
    'SELECT ch.key FROM marketing_channels ch JOIN companies co ON co.id = ch.company_id WHERE upper(co.code) = upper($1) AND ch.platform = $2 ORDER BY ch.created_at LIMIT 1',
    [String(code || 'BPL'), platform]
  )).rows[0];
  if (!r) fail('notfound', 'That ' + platform + ' channel was not found.');
  return channelFor(r.key, platform);
}

module.exports = {
  channelFor: channelFor, channelForCompany: channelForCompany, trackedCompanies: trackedCompanies,
  BPL_CHANNELS: BPL_CHANNELS, RESTAURANT_CHANNELS: RESTAURANT_CHANNELS, TRACKED: TRACKED, CONNECTABLE: CONNECTABLE,
  channelKey: channelKey, ensureChannels: ensureChannels
};
