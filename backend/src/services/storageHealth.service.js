var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var storage = require('../lib/storage');

// Is the file storage working — the photos on the till, the shops and in
// the OS, documents, receipts? Every picture is read through this server
// from Cloudflare R2 (lib/storage.js), or from the database where R2 was
// never set up (lib/fileStore.js 'db:' keys). When R2 refuses, every
// picture breaks at once while everything else works; this says why, in
// plain words, with what to do (Render → Environment, or Cloudflare).
// One of the photos kept in R2 is looked at (not downloaded), so a key
// that works but a bucket without the photos shows too.
// Checked at most once a minute unless asked (force).

var CACHE_MS = 60000;
var cache = null;

var COUNT_SQL =
  "SELECT count(*) FILTER (WHERE k NOT LIKE 'db:%')::int AS r2, count(*) FILTER (WHERE k LIKE 'db:%')::int AS db FROM (" +
  ' SELECT photo_object_key AS k FROM restaurant_menu_items WHERE photo_object_key IS NOT NULL' +
  ' UNION ALL SELECT photo_key FROM catalog_item_photos' +
  ' UNION ALL SELECT photo_key FROM products WHERE photo_key IS NOT NULL' +
  ' UNION ALL SELECT photo_key FROM employees WHERE photo_key IS NOT NULL) x';
var SAMPLE_SQL =
  "SELECT k FROM (SELECT photo_object_key AS k, updated_at AS at FROM restaurant_menu_items WHERE photo_object_key IS NOT NULL AND photo_object_key NOT LIKE 'db:%'" +
  " UNION ALL SELECT photo_key, created_at FROM catalog_item_photos WHERE photo_key NOT LIKE 'db:%') x ORDER BY at DESC NULLS LAST LIMIT 1";

var REFUSED = ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied', 'Unauthorized', 'Forbidden', 'InvalidToken', 'ExpiredToken', 'InvalidArgument', 'HTTP 401', 'HTTP 403'];
var UNREACHABLE = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'TimeoutError', 'NetworkingError', 'RequestTimeout'];

// The state, with what it means and what to do (English, for the server's
// log and the public check; the OS shows its own words for each state).
var WORDS = {
  ok: ['Cloudflare R2 answers and the photos are there.', ''],
  database: ['Files are kept in the database (Cloudflare R2 is not set up). Photos work; big files over 15 MB cannot be kept.', ''],
  'missing-settings': ['The R2 settings are missing on the server, but photos are kept in Cloudflare R2, so none of them can be shown.',
    'Put R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET back in Render → bamboo-os-backend → Environment, and save.'],
  refused: ['Cloudflare refused the server\'s R2 key: it was deleted, has expired or was changed.',
    'In Cloudflare → R2 → Manage API tokens, create a token with Object Read & Write on the bucket and no end date; put its Access Key ID and Secret Access Key in Render as R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, and save.'],
  'no-bucket': ['The bucket named in R2_BUCKET does not exist (renamed or deleted).',
    'In Render, set R2_BUCKET to the bucket\'s exact name as Cloudflare → R2 lists it.'],
  'not-in-bucket': ['Cloudflare R2 answers, but the photos are not in this bucket: R2_BUCKET or R2_ACCOUNT_ID points at another bucket or account.',
    'In Render, set R2_ACCOUNT_ID and R2_BUCKET back to the account and bucket the photos were saved in.'],
  unreachable: ['The server cannot reach Cloudflare R2: R2_ACCOUNT_ID may be wrong, or Cloudflare is having trouble.',
    'Check R2_ACCOUNT_ID in Render against Cloudflare → R2 (Account ID), and Cloudflare\'s status page.'],
  error: ['Cloudflare R2 answered with an error.', 'Look at the server log in Render for the line starting [file storage].']
};

function stateOf(r, counts) {
  if (r.ok) return 'ok';
  if (r.code === 'NotConfigured') return counts.r2 > 0 ? 'missing-settings' : 'database';
  if (REFUSED.indexOf(r.code) >= 0) return 'refused';
  if (r.code === 'NoSuchBucket') return 'no-bucket';
  if (r.code === 'NoSuchKey') return 'not-in-bucket';
  if (UNREACHABLE.indexOf(r.code) >= 0) return 'unreachable';
  return 'error';
}

async function status(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.out;
  var counts = (await pool.query(COUNT_SQL)).rows[0];
  var sample = storage.configured || counts.r2 ? (await pool.query(SAMPLE_SQL)).rows[0] : null;
  var r = await storage.check(sample ? sample.k : null);
  var state = stateOf(r, counts);
  var out = { state: state, ok: state === 'ok' || state === 'database', code: r.code || '', step: r.step || '', photos: { r2: counts.r2, database: counts.db },
    why: WORDS[state][0], fix: WORDS[state][1], checkedAt: new Date().toISOString() };
  cache = { at: Date.now(), out: out };
  return out;
}

// GET /api/settings/storage-check — checked now, for whoever looks after
// the settings (Integrations → Services).
async function checkNow(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  return status(true);
}
// GET /api/health/storage — anyone: the state and what to do, no numbers.
async function publicStatus() {
  var s = await status(false);
  return { storage: s.state, ok: s.ok, code: s.code, why: s.why, fix: s.fix, checkedAt: s.checkedAt };
}
// When the server starts: one line in the log, so a broken storage shows
// in Render's log straight away.
async function logAtStart() {
  try {
    var s = await status(true);
    console.log('[file storage] ' + (s.ok ? 'OK: ' : 'NOT WORKING (' + s.state + (s.code ? ', ' + s.code : '') + '): ') + s.why + (s.fix ? ' What to do: ' + s.fix : ''));
  } catch (e) { console.error('[file storage] could not be checked:', e.message); }
}
function forgetForTests() { cache = null; }

module.exports = { status: status, checkNow: checkNow, publicStatus: publicStatus, logAtStart: logAtStart, stateOf: stateOf, WORDS: WORDS, forgetForTests: forgetForTests };
