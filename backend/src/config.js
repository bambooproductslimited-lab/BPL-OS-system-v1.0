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
  // HMAC key for kiosk.service.js's PIN hashing — see migration 0025's
  // comment for why a keyed hash rather than bcrypt. Never stored in the
  // database; a DB dump alone can't be used to reverse a PIN without it.
  kioskPinPepper: required('KIOSK_PIN_PEPPER', 'dev-only-insecure-pepper-change-me'),
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
  }()),
  // WhatsApp Business Cloud API — unlike the other social platforms this
  // isn't a per-user OAuth redirect: a WhatsApp Business phone number and
  // its permanent access token are set up once in Meta Business Suite (as a
  // product under the same Meta app used for Facebook Login) and configured
  // here as server env vars, not a "Connect" button click. verifyToken is a
  // string *we* invent and paste into Meta's webhook config screen so
  // handleWebhookVerify can confirm the handshake request really came from
  // that config, not a secret Meta issues.
  whatsapp: (function () {
    var phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
    var businessAccountId = (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
    var accessToken = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
    var verifyToken = (process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
    return {
      phoneNumberId: phoneNumberId,
      businessAccountId: businessAccountId,
      accessToken: accessToken,
      verifyToken: verifyToken,
      configured: !!(phoneNumberId && accessToken && verifyToken)
    };
  }()),
  // Website analytics (GA4 Data API) — a service account granted Viewer
  // access on the GA4 property, authenticated server-to-server via a
  // signed JWT (see services/googleAnalytics.service.js), not a per-user
  // OAuth redirect either. privateKey commonly arrives from a hosting
  // panel's env var UI with literal "\n" sequences instead of real
  // newlines (copy-pasting a multi-line PEM into a single-line field) —
  // normalized back to real newlines here so crypto.createSign() accepts it.
  website: (function () {
    var propertyId = (process.env.GA4_PROPERTY_ID || '').trim();
    var serviceAccountEmail = (process.env.GA4_SERVICE_ACCOUNT_EMAIL || '').trim();
    var privateKey = (process.env.GA4_SERVICE_ACCOUNT_PRIVATE_KEY || '').trim().replace(/\\n/g, '\n');
    return {
      propertyId: propertyId,
      serviceAccountEmail: serviceAccountEmail,
      privateKey: privateKey,
      configured: !!(propertyId && serviceAccountEmail && privateKey)
    };
  }()),
  // Square (POS/payments platform) — a one-time historical data import only
  // (services/squareImport.service.js), not a live sync. A single Production
  // Access Token for the seller's own account is enough: no OAuth
  // app/client-secret dance, since we're not acting on behalf of other
  // Square sellers.
  square: (function () {
    var accessToken = (process.env.SQUARE_ACCESS_TOKEN || '').trim();
    return {
      accessToken: accessToken,
      baseUrl: process.env.SQUARE_API_BASE_URL || 'https://connect.squareup.com',
      configured: !!accessToken
    };
  }())
};
