/*
 * Photos lost when the Square import used to delete and re-create its
 * catalogue items: found (database storage and R2), matched to the item by
 * name, shown, and put back by a person. A file still in use anywhere is
 * never offered. Items use the "Zq" prefix and are removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var catalog = require('../src/services/catalog.service');
var recovery = require('../src/services/catalogPhotoRecovery.service');

var kelvin, alice;
async function cleanup() {
  await pool.query("DELETE FROM stored_files WHERE id::text IN (SELECT substr(photo_key, 4) FROM catalog_item_photos WHERE item_id IN (SELECT id FROM catalog_items WHERE name LIKE 'Zq %'))");
  await pool.query("DELETE FROM catalog_items WHERE name LIKE 'Zq %'");
  await pool.query("DELETE FROM stored_files WHERE data = convert_to('zq lost tray photo', 'UTF8')");
  await pool.query("DELETE FROM audit_logs WHERE action = 'catalog.photo.add' AND summary LIKE '%Zq %'");
}
async function item(name) {
  return (await pool.query("INSERT INTO catalog_items (name, description, tax_rate_id, active, external_id, source) VALUES ($1, '', 'tx_zero', true, $2, 'square') RETURNING id", [name, 'ZQ-' + name])).rows[0].id;
}
test.before(async function () {
  await cleanup();
  kelvin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  alice = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'alice.kamau@bplghana.com'")).rows[0].id);
});
test.after(async function () { recovery.setR2ForTests(null); await cleanup(); await pool.end(); });

test('a photo lost with a re-created Square item is found, matched by name, and put back', async function () {
  // A photo added in the OS, then the old import deletes the item and makes it again.
  var old = await item('Zq Bamboo Tray');
  await catalog.addPhotos(kelvin, old, [{ buffer: Buffer.from('zq lost tray photo'), mimetype: 'image/jpeg' }]);
  var key = (await pool.query('SELECT photo_key FROM catalog_item_photos WHERE item_id = $1', [old])).rows[0].photo_key;
  await pool.query('DELETE FROM catalog_items WHERE id = $1', [old]);
  await pool.query("UPDATE catalog_items SET external_id = NULL WHERE external_id = 'ZQ-Zq Bamboo Tray'");
  var again = await item('Zq Bamboo Tray');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_item_photos WHERE item_id = $1', [again])).rows[0].n, 0, 'the photo is gone from the item');

  var lost = (await recovery.list(kelvin)).filter(function (l) { return /Zq Bamboo Tray/.test(l.itemName); });
  assert.equal(lost.length, 1);
  assert.equal(lost[0].ref, key, 'the file is still there');
  assert.deepEqual(lost[0].matches.map(function (m) { return m.id; }), [again], 'matched to the item of the same name');

  assert.equal(await recovery.preview(kelvin, key), key);
  // Someone's profile photo, or any file in use, is never shown or attached.
  var other = (await pool.query("INSERT INTO stored_files (content_type, size, data) VALUES ('image/jpeg', 3, 'abc') RETURNING id")).rows[0].id;
  await assert.rejects(recovery.preview(kelvin, 'db:' + other), /not one of the lost ones/);
  await assert.rejects(recovery.restore(kelvin, { photos: [{ ref: 'db:' + other, itemId: again }] }), /no longer a lost one/);
  await pool.query('DELETE FROM stored_files WHERE id = $1', [other]);
  await assert.rejects(recovery.list(alice), /catalog\.manage/);

  var r = await recovery.restore(kelvin, { photos: [{ ref: key, itemId: again }] });
  assert.equal(r.restored, 1);
  var back = (await pool.query('SELECT photo_key, position FROM catalog_item_photos WHERE item_id = $1', [again])).rows;
  assert.deepEqual(back, [{ photo_key: key, position: 0 }]);
  assert.equal((await recovery.list(kelvin)).filter(function (l) { return l.ref === key; }).length, 0, 'not offered again');
});

test('in R2: lost catalogue files are found by the item name in their key; files in use are not', async function () {
  var lamp = await item('Zq Pole Lamp');
  var inUse = 'documents/11111111-1111-1111-1111-111111111111-catalog-zq-pole-lamp.jpg';
  await pool.query('INSERT INTO catalog_item_photos (item_id, photo_key) VALUES ($1, $2)', [lamp, inUse]);
  recovery.setR2ForTests(async function (prefix) {
    assert.equal(prefix, 'documents/');
    return [
      { key: 'documents/22222222-2222-2222-2222-222222222222-catalog-zq-pole-lamp.jpg', lastModified: new Date('2026-09-20T10:00:00Z') },
      { key: inUse, lastModified: new Date('2026-09-20T10:00:00Z') },
      { key: 'documents/33333333-3333-3333-3333-333333333333-contract.pdf', lastModified: new Date() }
    ];
  });
  var lost = (await recovery.list(kelvin)).filter(function (l) { return /^documents\//.test(l.ref); });
  assert.deepEqual(lost.map(function (l) { return l.ref; }), ['documents/22222222-2222-2222-2222-222222222222-catalog-zq-pole-lamp.jpg']);
  assert.equal(lost[0].matches[0].id, lamp);
  recovery.setR2ForTests(null);
});
