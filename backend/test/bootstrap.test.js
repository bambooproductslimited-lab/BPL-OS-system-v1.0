// Deploys run bootstrap.js every time (render.yaml). It makes the first
// administrator from ADMIN_* and nothing more: once an administrator exists,
// a different ADMIN_EMAIL (or none at all) must not add another one.
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');
var { execFile } = require('node:child_process');
var { pool } = require('../src/db/pool');

var EMAIL = 'zqb.second.admin@example.com';
function bootstrap(env) {
  var clean = Object.assign({}, process.env, { NODE_ENV: 'test' });
  ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_FIRST_NAME', 'ADMIN_LAST_NAME'].forEach(function (k) { delete clean[k]; });
  return new Promise(function (resolve) {
    execFile(process.execPath, [path.join(__dirname, '../src/db/bootstrap.js')], { env: Object.assign(clean, env) }, function (err, stdout, stderr) {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}
test.after(async function () { await pool.end(); });

test('an existing administrator stops bootstrap making another', async function () {
  var r = await bootstrap({ ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: 'zqbpassword1', ADMIN_FIRST_NAME: 'Zqb', ADMIN_LAST_NAME: 'Admin' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /An administrator already exists/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [EMAIL])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM employees WHERE email = $1', [EMAIL])).rows[0].n, 0);
});

test('with an administrator, deploys no longer need ADMIN_* at all', async function () {
  var r = await bootstrap({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Bootstrap complete/);
});
