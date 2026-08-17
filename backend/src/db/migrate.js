#!/usr/bin/env node
/*
 * Minimal migration runner. Migrations live in ./migrations as paired SQL files:
 *   0001_name.up.sql
 *   0001_name.down.sql
 * Applied migrations are tracked in the schema_migrations table. This mirrors
 * the spirit of kernel.js's MIGRATIONS array (an ordered, append-only list of
 * schema changes) but as real, individually-reviewable SQL files.
 */
var fs = require('fs');
var path = require('path');
var { pool } = require('./pool');

var MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function loadMigrations() {
  var files = fs.readdirSync(MIGRATIONS_DIR).filter(function (f) { return f.endsWith('.up.sql'); });
  var names = files.map(function (f) { return f.replace(/\.up\.sql$/, ''); }).sort();
  return names.map(function (name) {
    var upPath = path.join(MIGRATIONS_DIR, name + '.up.sql');
    var downPath = path.join(MIGRATIONS_DIR, name + '.down.sql');
    return {
      name: name,
      up: fs.readFileSync(upPath, 'utf8'),
      down: fs.existsSync(downPath) ? fs.readFileSync(downPath, 'utf8') : null
    };
  });
}

async function ensureMigrationsTable() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
    'name text PRIMARY KEY, ' +
    'applied_at timestamptz NOT NULL DEFAULT now()' +
    ')'
  );
}

async function appliedNames() {
  var res = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
  return res.rows.map(function (r) { return r.name; });
}

async function up() {
  await ensureMigrationsTable();
  var migrations = loadMigrations();
  var applied = await appliedNames();
  var appliedSet = {};
  applied.forEach(function (n) { appliedSet[n] = true; });
  var pending = migrations.filter(function (m) { return !appliedSet[m.name]; });
  if (!pending.length) { console.log('Database is up to date (' + applied.length + ' migrations applied).'); return; }
  for (var i = 0; i < pending.length; i++) {
    var m = pending[i];
    var client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.up);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
      await client.query('COMMIT');
      console.log('Applied ' + m.name);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Failed to apply ' + m.name + ':', err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

async function down() {
  await ensureMigrationsTable();
  var migrations = loadMigrations();
  var byName = {};
  migrations.forEach(function (m) { byName[m.name] = m; });
  var applied = await appliedNames();
  if (!applied.length) { console.log('No migrations to roll back.'); return; }
  var last = applied[applied.length - 1];
  var m = byName[last];
  if (!m || !m.down) { throw new Error('No down migration available for ' + last); }
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(m.down);
    await client.query('DELETE FROM schema_migrations WHERE name = $1', [last]);
    await client.query('COMMIT');
    console.log('Rolled back ' + last);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to roll back ' + last + ':', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function status() {
  await ensureMigrationsTable();
  var migrations = loadMigrations();
  var applied = await appliedNames();
  var appliedSet = {};
  applied.forEach(function (n) { appliedSet[n] = true; });
  migrations.forEach(function (m) {
    console.log((appliedSet[m.name] ? '[x] ' : '[ ] ') + m.name);
  });
}

var cmd = process.argv[2] || 'up';
var fn = { up: up, down: down, status: status }[cmd];
if (!fn) { console.error('Usage: node migrate.js <up|down|status>'); process.exit(1); }

fn().then(function () { pool.end(); }).catch(function (err) { console.error(err); pool.end(); process.exit(1); });
