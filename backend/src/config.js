require('dotenv').config();

function required(name, fallback) {
  var v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error('Missing required environment variable: ' + name);
  }
  return v;
}

// The test suite seeds its own data, and seed.js TRUNCATEs every table to do
// it. Pointing that at the development database would wipe whatever the
// developer was working on, so under NODE_ENV=test every connection is
// redirected to a sibling database with a _test suffix — created once by
// hand, since the app role deliberately has no CREATEDB right. This is what
// makes `npm test` repeatable: the suite is reseeded from scratch before
// every run, so run 2 starts from exactly the same state as run 1.
//
// Applies to DATABASE_URL and the discrete PG* vars alike, and only ever
// when NODE_ENV is exactly 'test' — production is 'production'.
var IS_TEST = process.env.NODE_ENV === 'test';

function testDatabaseUrl(url) {
  if (!url) return url;
  // Rewrite only the path segment; a database name can appear in the
  // password or host otherwise and a blind replace would corrupt it.
  return url.replace(/^(.*:\/\/[^/]+\/)([^/?#]+)(.*)$/, function (_, head, name, tail) {
    return head + (/_test$/.test(name) ? name : name + '_test') + tail;
  });
}

function testDatabaseName(name) {
  return /_test$/.test(name) ? name : name + '_test';
}

module.exports = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isTest: IS_TEST,
  databaseUrl: IS_TEST ? testDatabaseUrl(process.env.DATABASE_URL || null) : (process.env.DATABASE_URL || null),
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
    database: IS_TEST ? testDatabaseName(process.env.PGDATABASE || 'bamboo_os') : (process.env.PGDATABASE || 'bamboo_os')
  },
  jwt: {
    // No insecure fallback here on purpose — a security review flagged that
    // a previous "dev-only-insecure-secret-change-me" default let the app
    // start (and silently sign forgeable session tokens for any user) even
    // in production if this env var was ever left unset. In test/development
    // a fixed fallback is fine (nothing real is at stake), but production
    // must refuse to boot rather than run with a secret anyone who's read
    // this source file already knows.
    secret: (process.env.NODE_ENV === 'production') ? required('JWT_SECRET') : required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
    expiresIn: process.env.JWT_EXPIRES_IN || '8h'
  },
  // HMAC key for kiosk.service.js's PIN hashing — see migration 0025's
  // comment for why a keyed hash rather than bcrypt. Never stored in the
  // database; a DB dump alone can't be used to reverse a PIN without it.
  // Same fail-fast-in-production reasoning as JWT_SECRET above.
  // Web Push signing keys. Optional: when unset, push.service.js generates
  // a pair on first use and keeps it in the database, so this needs no
  // setup. Set both to manage the pair yourself — and never change them on
  // a live deployment without expecting every subscribed device to go
  // quiet until it re-subscribes.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || null,
  kioskPinPepper: (process.env.NODE_ENV === 'production') ? required('KIOSK_PIN_PEPPER') : required('KIOSK_PIN_PEPPER', 'dev-only-insecure-pepper-change-me'),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map(function (s) { return s.trim(); }),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  // Where this backend is reached from outside — the Claude connector's
  // sign-in addresses are built from it (src/mcp/). Render sets
  // RENDER_EXTERNAL_URL itself; PUBLIC_URL overrides it (e.g. a custom domain).
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + (process.env.PORT || 4000))).trim().replace(/\/+$/, ''),
  ai: {
    // .trim() guards against a trailing newline/space from copy-pasting the
    // key into Render's environment UI — Anthropic rejects the key outright
    // (invalid x-api-key) rather than trimming it for you.
    apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
    model: (process.env.ANTHROPIC_MODEL || '').trim() || 'claude-opus-5',
    // How hard the model thinks before answering — see src/ai/claude.js.
    effort: (process.env.ANTHROPIC_EFFORT || '').trim() || 'medium',
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
  // Text messages through mNotify (services/sms.service.js), paid for with
  // the company's mNotify SMS credit. The API key is from the mNotify
  // dashboard (API → API keys); the sender ID is the name texts come from,
  // up to 11 characters, and must already be approved by mNotify.
  sms: (function () {
    var apiKey = (process.env.MNOTIFY_API_KEY || '').trim();
    var senderId = (process.env.MNOTIFY_SENDER_ID || '').trim();
    return {
      provider: 'mnotify',
      apiKey: apiKey,
      senderId: senderId,
      baseUrl: (process.env.MNOTIFY_BASE_URL || 'https://api.mnotify.com').replace(/\/+$/, ''),
      get configured() { return !!(this.apiKey && this.senderId); }
    };
  }()),
  // Outgoing email over SMTP (services/mail.service.js) — two-step sign-in
  // codes by email. Any mailbox the company already has works: Hostinger
  // email (smtp.hostinger.com, port 465), Google Workspace or Gmail with an
  // app password (smtp.gmail.com, 465), and so on. MAIL_FROM is the address
  // the codes come from; it defaults to SMTP_USER.
  mail: (function () {
    var host = (process.env.SMTP_HOST || '').trim();
    var user = (process.env.SMTP_USER || '').trim();
    var pass = process.env.SMTP_PASS || '';
    var port = Number(process.env.SMTP_PORT || 465);
    return {
      host: host,
      port: port,
      // 465 is TLS from the first byte; 587 upgrades with STARTTLS.
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      user: user,
      pass: pass,
      from: (process.env.MAIL_FROM || '').trim() || (user ? 'Bamboo OS <' + user + '>' : ''),
      get configured() { return !!(this.host && this.user && this.pass); }
    };
  }()),
  // Google Drive (services/googleDrive.service.js) — "Import from Google
  // Drive" on Products & inventory reads the Finish Inventory sheets
  // straight from Drive. Server to server with a Google Cloud service
  // account, like the Website analytics below: the sheets (or their folder)
  // are shared with the service account's email as Viewer. Easiest is
  // GOOGLE_SERVICE_ACCOUNT_JSON — the whole JSON key file pasted in; the
  // email and key can also be given separately, and the Website analytics
  // service account is used if neither is set.
  googleDrive: (function () {
    var fromJson = {};
    var raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
    if (raw) {
      try { fromJson = JSON.parse(raw); } catch (e) { fromJson = { invalid: true }; }
    }
    var email = (fromJson.client_email || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GA4_SERVICE_ACCOUNT_EMAIL || '').trim();
    var key = (fromJson.private_key || process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || process.env.GA4_SERVICE_ACCOUNT_PRIVATE_KEY || '').trim().replace(/\\n/g, '\n');
    return {
      serviceAccountEmail: email,
      privateKey: key,
      jsonInvalid: !!fromJson.invalid,
      tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      apiBase: (process.env.GOOGLE_DRIVE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, ''),
      get configured() { return !!(this.serviceAccountEmail && this.privateKey); }
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
      configured: !!(propertyId && serviceAccountEmail && privateKey),
      // Each company's own website (social tracker, per company): Bamboo
      // Products' is GA4_PROPERTY_ID; any other company's is
      // GA4_PROPERTY_ID_<its company code> (GA4_PROPERTY_ID_SB …) — read
      // with the same service account, which needs Viewer access on each.
      forCompanyCode: function (code) {
        var id = code === 'BPL' ? this.propertyId : (process.env['GA4_PROPERTY_ID_' + code] || '').trim();
        return { propertyId: id, configured: !!(id && this.serviceAccountEmail && this.privateKey) };
      }
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
  }()),
  // Restaurant module, Phase 4: each restaurant's Square data, keyed by the
  // business's companies.code column (SQUARE_ACCESS_TOKEN_SBR,
  // SQUARE_ACCESS_TOKEN_BGN, ...) so a future third restaurant needs only a
  // new env var, no code change — same "scoped by company_id" pattern the
  // rest of the restaurant module already uses.
  //
  // Two real-world shapes both need to work here: a restaurant with its own
  // separate Square merchant account (its own token is enough — nothing
  // else to filter, since everything the token can see belongs to that one
  // restaurant), and — as turned out to be the actual case for Star Bar
  // Restaurant / Bamboo Garden — two restaurants that are just two
  // *locations* under one shared Square merchant account. For the latter,
  // SQUARE_ACCESS_TOKEN_SBR and SQUARE_ACCESS_TOKEN_BGN can be set to the
  // same token, with SQUARE_LOCATION_ID_<code> added to say which Square
  // location that company's import should be restricted to — the importer
  // uses it both to scope orders/search's location_ids and to filter which
  // catalog items count as that restaurant's menu (see
  // restaurantSquareImport.service.js's itemPresentAtLocation).
  restaurantSquare: (function () {
    var baseUrl = process.env.SQUARE_API_BASE_URL || 'https://connect.squareup.com';
    return {
      forCompanyCode: function (code) {
        var accessToken = (process.env['SQUARE_ACCESS_TOKEN_' + code] || '').trim();
        var locationId = (process.env['SQUARE_LOCATION_ID_' + code] || '').trim();
        return { accessToken: accessToken, baseUrl: baseUrl, configured: !!accessToken, locationId: locationId || null };
      }
    };
  }()),
  // TimeStation (time & attendance) employee sync — services/timestation.service.js.
  // A single API key authenticates as HTTP Basic Auth username with no
  // password (per TimeStation's own API v1.2 docs). One-way pull only: we
  // never write anything back to TimeStation.
  timestation: (function () {
    var apiKey = (process.env.TIMESTATION_API_KEY || '').trim();
    return {
      apiKey: apiKey,
      baseUrl: process.env.TIMESTATION_API_BASE_URL || 'https://api.mytimestation.com/v1.2',
      configured: !!apiKey
    };
  }())
};
