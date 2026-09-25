// Integrations: each says how it connects (a Connect button, the server's
// settings, or not built yet), whether its Connect button can work, and
// the latest connect / disconnect; the server services list says only
// whether each is ready and which settings it needs, never a value.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var settings = require('../src/services/settings.service');
var { buildContext } = require('../src/services/context.service');

var kelvin, alice;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
test.before(async function () { kelvin = await ctxFor('kelvin.duho@bplghana.com'); alice = await ctxFor('alice.kamau@bplghana.com'); });
test.after(async function () { await pool.end(); });

test('integrations say how they connect and what happened last', async function () {
  var list = await settings.listIntegrations(kelvin);
  var by = Object.fromEntries(list.map(function (i) { return [i.id, i]; }));
  assert.equal(by.slack.how, 'planned');
  assert.equal(by.facebook.how, 'oauth');
  assert.equal(typeof by.facebook.ready, 'boolean');
  assert.equal(by.timestation.how, 'server');
  assert.equal(by.timestation.connected, false);
  assert.ok(list.every(function (i) { return i.apiKey === undefined; }));
  await settings.disconnect(kelvin, 'slack');
  by = Object.fromEntries((await settings.listIntegrations(kelvin)).map(function (i) { return [i.id, i]; }));
  assert.equal(by.slack.lastChange.action, 'integration.disconnect');
  await assert.rejects(settings.listIntegrations(alice), /settings.manage/);
});

test('server services: ready or not, and the names of the settings only', async function () {
  var list = settings.services(kelvin);
  assert.ok(list.length >= 10);
  list.forEach(function (sv) {
    assert.deepEqual(Object.keys(sv).sort(), ['env', 'essential', 'id', 'name', 'page', 'powers', 'ready']);
    assert.equal(typeof sv.ready, 'boolean');
    sv.env.forEach(function (name) { assert.match(name, /^[A-Z0-9_]+$/); });
  });
  assert.throws(function () { settings.services(alice); }, /settings.manage/);
});
