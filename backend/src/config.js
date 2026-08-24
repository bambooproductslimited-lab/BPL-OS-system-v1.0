require('dotenv').config();

function required(name, fallback) {
  var v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error('Missing required environment variable: ' + name);
  }
  return v;
}

module.exports = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || null,
  // Managed Postgres (Render, Railway, Neon, Supabase, ...) requires TLS and
  // typically presents a cert `pg` won't validate against a default CA
  // bundle; PGSSLMODE=require opts in without pinning a specific CA, fine
  // for these providers' own infra. Leave unset for a local/self-hosted DB.
  pgSsl: process.env.PGSSLMODE === 'require',
  pg: {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'bamboo',
    password: process.env.PGPASSWORD || 'bamboo',
    database: process.env.PGDATABASE || 'bamboo_os'
  },
  jwt: {
    secret: required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
    expiresIn: process.env.JWT_EXPIRES_IN || '8h'
  },
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map(function (s) { return s.trim(); }),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  ai: {
    // .trim() guards against a trailing newline/space from copy-pasting the
    // key into Render's environment UI — Anthropic rejects the key outright
    // (invalid x-api-key) rather than trimming it for you.
    apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
  },
  // Cloudflare R2 (S3-compatible) storage for real Documents uploads — see
  // src/lib/storage.js. All four must be set or uploads are refused with a
  // clear "not configured" error instead of a confusing SDK crash.
  r2: (function () {
    var accountId = process.env.R2_ACCOUNT_ID || '';
    var accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
    var secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
    var bucket = process.env.R2_BUCKET || '';
    return {
      accountId: accountId, accessKeyId: accessKeyId, secretAccessKey: secretAccessKey, bucket: bucket,
      configured: !!(accountId && accessKeyId && secretAccessKey && bucket)
    };
  }()),
  // TikTok Login Kit + Content Posting API (see services/tiktokOAuth.service.js).
  // clientKey is not secret (it's sent to the browser as part of the
  // authorize URL, same as any OAuth client id); clientSecret never leaves
  // the server — it's only used server-side in the authorization-code and
  // refresh-token exchanges.
  tiktok: (function () {
    var clientKey = (process.env.TIKTOK_CLIENT_KEY || '').trim();
    var clientSecret = (process.env.TIKTOK_CLIENT_SECRET || '').trim();
    return {
      clientKey: clientKey,
      clientSecret: clientSecret,
      redirectUri: process.env.TIKTOK_REDIRECT_URI || 'https://bamboo-os-backend.onrender.com/api/marketing/oauth/tiktok/callback',
      configured: !!(clientKey && clientSecret)
    };
  }()),
  // Meta (Facebook + Instagram) Login — one app/one OAuth flow covers both,
  // since an Instagram professional account is only ever reachable via its
  // linked Facebook Page. appId is not secret (sent to the browser as part
  // of the authorize URL); appSecret never leaves the server — only used in
  // the code/long-lived-token exchanges in services/metaOAuth.service.js.
  meta: (function () {
    var appId = (process.env.META_APP_ID || '').trim();
    var appSecret = (process.env.META_APP_SECRET || '').trim();
    return {
      appId: appId,
      appSecret: appSecret,
      redirectUri: process.env.META_REDIRECT_URI || 'https://bamboo-os-backend.onrender.com/api/marketing/oauth/meta/callback',
      configured: !!(appId && appSecret)
    };
  }()),
  // YouTube (Google OAuth) — clientId is not secret; clientSecret never
  // leaves the server, used only in services/youtubeOAuth.service.js's
  // code/refresh-token exchanges.
  youtube: (function () {
    var clientId = (process.env.YOUTUBE_CLIENT_ID || '').trim();
    var clientSecret = (process.env.YOUTUBE_CLIENT_SECRET || '').trim();
    return {
      clientId: clientId,
      clientSecret: clientSecret,
      redirectUri: process.env.YOUTUBE_REDIRECT_URI || 'https://bamboo-os-backend.onrender.com/api/marketing/oauth/youtube/callback',
      configured: !!(clientId && clientSecret)
    };
  }()),
  // Twitch — clientId is not secret; clientSecret never leaves the server,
  // used only in services/twitchOAuth.service.js's code/refresh-token
  // exchanges.
  twitch: (function () {
    var clientId = (process.env.TWITCH_CLIENT_ID || '').trim();
    var clientSecret = (process.env.TWITCH_CLIENT_SECRET || '').trim();
    return {
      clientId: clientId,
      clientSecret: clientSecret,
      redirectUri: process.env.TWITCH_REDIRECT_URI || 'https://bamboo-os-backend.onrender.com/api/marketing/oauth/twitch/callback',
      configured: !!(clientId && clientSecret)
    };
  }())
};
