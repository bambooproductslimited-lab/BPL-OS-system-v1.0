/*
 * The restaurant Square import brings each menu item's picture
 * (restaurantSquareImport.service.js): the item's own, or a variation's;
 * not downloaded again when unchanged; replaced when it changes in Square;
 * a photo uploaded here, or one taken off here, is left as it is; a picture
 * that can't be downloaded is skipped without stopping the import. A fake
 * Square client stands in for the real API; drawn bytes, not real photos.
 * Test data uses the ZQP company code.
 */
process.env.SQUARE_ACCESS_TOKEN_ZQP = 'fake-token-for-tests';
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var imp = require('../src/services/restaurantSquareImport.service');
var restaurant = require('../src/services/restaurant.service');
var { buildContext } = require('../src/services/context.service');

var kelvin, company;
var downloads = [];
var broken = {};
// "Pictures": a few bytes standing for each image, enough to tell them apart.
function bytes(tag) { return Buffer.from('\xff\xd8\xff zqp ' + tag, 'binary'); }
var catalog;
function setCatalog(o) {
  catalog = [
    { id: 'ZQP-CAT', type: 'CATEGORY', category_data: { name: 'Zqp grills' } },
    { id: 'ZQP-ITEM-1', type: 'ITEM', is_deleted: false, item_data: { name: 'Zqp tilapia', categories: [{ id: 'ZQP-CAT' }], image_ids: o.item1 ? [o.item1] : [],
      variations: [{ id: 'ZQP-VAR-1', is_deleted: false, item_variation_data: { name: 'Regular', price_money: { amount: 9000 } } }] } },
    // Two prices; the picture is on a variation, not the item.
    { id: 'ZQP-ITEM-2', type: 'ITEM', is_deleted: false, item_data: { name: 'Zqp kebab', image_ids: [],
      variations: [
        { id: 'ZQP-VAR-2S', is_deleted: false, item_variation_data: { name: 'Small', price_money: { amount: 3000 } } },
        { id: 'ZQP-VAR-2L', is_deleted: false, item_variation_data: { name: 'Large', price_money: { amount: 5000 }, image_ids: ['ZQP-IMG-K'] } }] } },
    { id: 'ZQP-ITEM-3', type: 'ITEM', is_deleted: false, item_data: { name: 'Zqp water', image_ids: [],
      variations: [{ id: 'ZQP-VAR-3', is_deleted: false, item_variation_data: { name: 'Regular', price_money: { amount: 500 } } }] } }
  ].concat(['ZQP-IMG-A', 'ZQP-IMG-B', 'ZQP-IMG-K'].map(function (id) { return { id: id, type: 'IMAGE', image_data: { url: 'https://items-images.example/' + id + '.jpg', caption: '' } }; }));
}
function fakeClient() {
  return {
    listLocations: async function () { return [{ id: 'ZQP-LOC' }]; },
    listAllCatalogItems: async function () { return catalog; },
    searchOrdersPage: async function () { return { orders: [], cursor: null }; },
    downloadImage: async function (url) {
      downloads.push(url);
      if (broken[url]) throw new Error('Square answered 404 for the picture');
      return { buffer: bytes(url), contentType: 'image/jpeg' };
    }
  };
}
async function item(name) { return (await pool.query('SELECT * FROM restaurant_menu_items WHERE company_id = $1 AND name = $2', [company.id, name])).rows[0]; }
async function photoOf(name) {
  var it = await item(name);
  if (!it.photo_object_key) return null;
  var p = await restaurant.getMenuItemPhoto(it.id);
  if (p.buffer) return p.buffer.toString('binary');
  var chunks = [];
  for await (var c of p.stream) chunks.push(c);
  return Buffer.concat(chunks).toString('binary');
}
async function run() { return imp.startImport(kelvin, company.id, { wait: true }).then(function () { return imp.jobStatus(kelvin, company.id); }); }

async function cleanup() {
  if (!company) return;
  var keys = (await pool.query('SELECT photo_object_key FROM restaurant_menu_items WHERE company_id = $1 AND photo_object_key IS NOT NULL', [company.id])).rows;
  var fileStore = require('../src/lib/fileStore');
  for (var k of keys) await fileStore.del(k.photo_object_key);
  await pool.query('DELETE FROM restaurant_menu_item_variations WHERE menu_item_id IN (SELECT id FROM restaurant_menu_items WHERE company_id = $1)', [company.id]);
  await pool.query('DELETE FROM restaurant_menu_items WHERE company_id = $1', [company.id]);
  await pool.query('DELETE FROM restaurant_import_jobs WHERE company_id = $1', [company.id]);
  await pool.query("DELETE FROM employees WHERE code = 'ZQP-SQIMPORT'");
  await pool.query('DELETE FROM departments WHERE company_id = $1', [company.id]);
  await pool.query('DELETE FROM companies WHERE id = $1', [company.id]);
}
test.before(async function () {
  await pool.query("DELETE FROM companies WHERE code = 'ZQP'");
  kelvin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQP', 'Zqp Grill') RETURNING *")).rows[0];
  await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQPK', 'Zqp Kitchen', $1)", [company.id]);
  imp.setClientFactoryForTests(function () { return fakeClient(); });
});
test.after(async function () { imp.setClientFactoryForTests(null); await cleanup(); await pool.end(); });

test('each menu item gets its Square picture — the item\'s own, or a variation\'s — and the job counts them', async function () {
  setCatalog({ item1: 'ZQP-IMG-A' });
  var job = await run();
  assert.equal(job.status, 'done');
  assert.deepEqual(job.photos, { imported: 2, skipped: 0 });
  assert.match(await photoOf('Zqp tilapia'), /ZQP-IMG-A/);
  assert.match(await photoOf('Zqp kebab'), /ZQP-IMG-K/, 'from the Large variation');
  assert.equal(await photoOf('Zqp water'), null, 'no picture in Square, none here');
  assert.equal((await item('Zqp tilapia')).photo_square_image_id, 'ZQP-IMG-A');
  var listed = (await restaurant.listMenuItems(kelvin, company.id)).find(function (m) { return m.name === 'Zqp tilapia'; });
  assert.ok(listed.photoUrl, 'the menu shows it');
});

test('unchanged pictures are not downloaded again; a changed one replaces the old', async function () {
  downloads = [];
  var job = await run();
  assert.deepEqual([job.photos.imported, downloads.length], [0, 0]);
  var oldKey = (await item('Zqp tilapia')).photo_object_key;
  setCatalog({ item1: 'ZQP-IMG-B' });
  job = await run();
  assert.equal(job.photos.imported, 1);
  assert.match(await photoOf('Zqp tilapia'), /ZQP-IMG-B/);
  assert.notEqual((await item('Zqp tilapia')).photo_object_key, oldKey);
  var gone = await require('../src/lib/fileStore').get(oldKey).catch(function () { return null; });
  assert.equal(gone, null, 'the old picture is deleted, not left behind');
});

test('a photo uploaded here is never replaced; one taken off stays off until the picture changes', async function () {
  var tilapia = await item('Zqp tilapia');
  await restaurant.setMenuItemPhoto(kelvin, tilapia.id, { originalname: 'our-tilapia.jpg', buffer: bytes('OURS'), mimetype: 'image/jpeg', size: 20 });
  setCatalog({ item1: 'ZQP-IMG-A' });
  var job = await run();
  assert.equal(job.photos.imported, 0);
  assert.match(await photoOf('Zqp tilapia'), /OURS/);

  var kebab = await item('Zqp kebab');
  await restaurant.removeMenuItemPhoto(kelvin, kebab.id);
  job = await run();
  assert.equal(await photoOf('Zqp kebab'), null, 'not brought back');
});

test('a picture that cannot be downloaded is skipped, the rest of the import carries on', async function () {
  await pool.query("UPDATE restaurant_menu_items SET photo_object_key = NULL, photo_square_image_id = NULL WHERE company_id = $1 AND name = 'Zqp kebab'", [company.id]);
  broken['https://items-images.example/ZQP-IMG-K.jpg'] = true;
  var job = await run();
  assert.equal(job.status, 'done');
  assert.deepEqual(job.photos, { imported: 0, skipped: 1 });
  assert.match(job.errors.find(function (e) { return e.type === 'menuPhoto'; }).message, /Zqp kebab.*404/);
  delete broken['https://items-images.example/ZQP-IMG-K.jpg'];
  job = await run();
  assert.equal(job.photos.imported, 1, 'tried again next time');
});
