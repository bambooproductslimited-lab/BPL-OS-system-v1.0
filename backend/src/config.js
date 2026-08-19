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
    apiKey: process.env.ANTHROPIC_API_KEY || '',
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
  }())
};
