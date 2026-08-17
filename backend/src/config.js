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
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12)
};
