var { Pool, types } = require('pg');
var config = require('../config');

// node-pg parses `date` columns into JS Date objects by default, which then
// serialize to JSON as full UTC-midnight timestamps ("2026-09-01T00:00:00.000Z")
// instead of the plain "YYYY-MM-DD" strings the prototype's kernel.js worked
// with everywhere. Keep dates as the raw string Postgres already sends.
types.setTypeParser(types.builtins.DATE, function (val) { return val; });

var pool = new Pool(
  config.databaseUrl
    ? { connectionString: config.databaseUrl, ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined }
    : config.pg
);

pool.on('error', function (err) {
  // Idle client errors (e.g. connection dropped) — log and let the pool recover.
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = {
  pool: pool,
  query: function (text, params) { return pool.query(text, params); },
  // Run a callback inside a transaction; commits on success, rolls back on throw.
  // client.afterCommit collects work that must only happen once the
  // transaction is really committed (a phone pop-up, utils/notify.js); it
  // runs after COMMIT and is dropped on ROLLBACK.
  withTransaction: async function (fn) {
    var client = await pool.connect();
    try {
      await client.query('BEGIN');
      client.afterCommit = [];
      var result = await fn(client);
      await client.query('COMMIT');
      var jobs = client.afterCommit;
      client.afterCommit = null;
      jobs.forEach(function (job) { try { job(); } catch (e) { console.error('After-commit job failed:', e.message); } });
      return result;
    } catch (err) {
      client.afterCommit = null;
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.afterCommit = null;
      client.release();
    }
  }
};
