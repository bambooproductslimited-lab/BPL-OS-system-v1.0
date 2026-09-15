#!/usr/bin/env node
/*
 * Puts the test database into a known state before the suite runs. Wired to
 * `npm test` through the `pretest` hook, so there is nothing extra to
 * remember.
 *
 * Why this exists: the suite was only trustworthy on a database nobody had
 * run it against before. Tests create employees, pay runs, catalogue items
 * and menu photos and mostly do not clean up, so each run left the next one
 * a slightly different world. Measured on one afternoon: 2 failures on a
 * freshly seeded database, 17 on the second run against that same database,
 * 28 on the long-lived development one — the same code and the same tests
 * every time. A suite that fails differently depending on how often it has
 * been run is a suite people stop reading.
 *
 * The fix is to reseed from scratch every run. seed.js already TRUNCATEs
 * every table, so this just points it somewhere safe: config.js redirects
 * NODE_ENV=test to a <database>_test sibling, which this script migrates and
 * reseeds. The development database is never touched.
 *
 * Run with: npm test  (or directly: NODE_ENV=test node src/db/prepareTestDb.js)
 */
var { execFileSync } = require('child_process');
var path = require('path');
var { Client } = require('pg');
var config = require('../config');

if (!config.isTest) {
  console.error('prepareTestDb.js only runs under NODE_ENV=test — refusing, so it can never reseed a real database.');
  process.exit(1);
}

function databaseName() {
  if (config.databaseUrl) {
    var m = /^.*:\/\/[^/]+\/([^/?#]+)/.exec(config.databaseUrl);
    return m ? m[1] : '(unknown)';
  }
  return config.pg.database;
}

async function main() {
  var name = databaseName();
  var client = new Client(
    config.databaseUrl
      ? { connectionString: config.databaseUrl, ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined }
      : config.pg);

  try {
    await client.connect();
    await client.end();
  } catch (e) {
    if (e.code === '3D000') {
      // The app role has no CREATEDB right on purpose, so this is a one-off
      // manual step rather than something to paper over.
      console.error('\nThe test database "' + name + '" does not exist.\n');
      console.error('Create it once, then re-run the tests:\n');
      console.error('    createdb -O ' + (config.pg.user || 'bamboo') + ' ' + name + '\n');
      console.error('(or, if your Postgres needs it: sudo -u postgres createdb -O ' +
                    (config.pg.user || 'bamboo') + ' ' + name + ')\n');
      process.exit(1);
    }
    throw e;
  }

  var env = Object.assign({}, process.env, { NODE_ENV: 'test' });
  var run = function (script) {
    execFileSync(process.execPath, [path.join(__dirname, script)], { env: env, stdio: 'pipe' });
  };

  process.stdout.write('preparing ' + name + ': migrating... ');
  run('migrate.js');
  process.stdout.write('seeding... ');
  run('seed.js');
  console.log('ready.');
}

main().catch(function (e) {
  console.error('\nCould not prepare the test database: ' + e.message);
  process.exit(1);
});
