// Deleting a letting offer (pokiEstimates.service.js remove, DELETE
// /api/poki/estimates/:id): the offer and its lines go; an offer that became
// a booking stays. Records are named ZQPD and removed afterwards.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var poki = require('../src/services/poki.service');
var offers = require('../src/services/pokiEstimates.service');
var { buildContext } = require('../src/services/context.service');

var MARK = 'ZQPD';
var boss;

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
});
test.after(async function () {
  var est = "(SELECT e.id FROM estimates e JOIN customers c ON c.id = e.customer_id WHERE c.name LIKE '" + MARK + "%')";
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'estimate' AND document_id IN " + est);
  await pool.query('DELETE FROM estimates WHERE id IN ' + est);
  await pool.query("DELETE FROM poki_units WHERE code LIKE $1", [MARK + '%']);
  await pool.query("DELETE FROM poki_tenants WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE $1)", [MARK + '%']);
  await pool.query("DELETE FROM customers WHERE name LIKE $1", [MARK + '%']);
  await pool.query("DELETE FROM poki_properties WHERE code LIKE $1", [MARK + '%']);
  await pool.end();
});

test('a letting offer is deleted with its lines; one that became a booking is kept', async function () {
  var prop = await poki.createProperty(boss, { name: MARK + ' Court', code: MARK + '1' });
  var unit = await poki.createUnit(boss, { propertyId: prop.id, code: MARK + '-A', baseRent: 1500 });
  var tenant = await poki.createTenant(boss, { name: MARK + ' Prospect', phone: '0240000091' });
  var draft = await offers.lettingDraft(boss, { unitId: unit.id, rentPeriods: 6, depositMonths: 1 });
  var offer = await offers.create(boss, { docKind: 'letting', tenantId: tenant.id, unitId: unit.id, items: draft.items, clientNotes: draft.clientNotes, validUntil: draft.validUntil });
  var lines = function () { return pool.query("SELECT count(*)::int AS n FROM document_line_items WHERE document_type = 'estimate' AND document_id = $1", [offer.id]).then(function (r) { return r.rows[0].n; }); };
  assert.ok(await lines() > 0, 'the offer has its lines');

  assert.equal(await offers.remove(boss, offer.id), true);
  assert.equal((await pool.query('SELECT 1 FROM estimates WHERE id = $1', [offer.id])).rows.length, 0, 'the offer is gone');
  assert.equal(await lines(), 0, 'and so are its lines');
  assert.match((await pool.query("SELECT summary FROM audit_logs WHERE action = 'poki.estimate.delete' AND entity_id = $1", [offer.id])).rows[0].summary, /^Deleted estimate /);

  var kept = await offers.create(boss, { docKind: 'letting', tenantId: tenant.id, unitId: unit.id, items: draft.items, clientNotes: draft.clientNotes, validUntil: draft.validUntil });
  await pool.query("UPDATE estimates SET status = 'converted' WHERE id = $1", [kept.id]);
  await assert.rejects(offers.remove(boss, kept.id), /Cannot delete an offer that has become booking/);
  await assert.rejects(offers.remove(Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function () { return false; } }), kept.id), /poki\.manage/);
});
