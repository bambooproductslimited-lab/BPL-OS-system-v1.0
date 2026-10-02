// The Integrations page's Square import as a background job: it saves
// customers, the catalogue, orders a page at a time, invoices and payments,
// records its progress as it goes, running it again duplicates nothing, a
// second import can't start while one is running, a job stopped by a restart
// shows as interrupted, and a failure is recorded with its reason. A fake
// Square client stands in for the real API; its records are all "Zq" test
// data, removed afterwards.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var imp = require('../src/services/squareImport.service');
var { buildContext } = require('../src/services/context.service');

var kelvin;
var downloads = [];
var ORDERS = [1, 2, 3, 4, 5].map(function (n) {
  return {
    id: 'ZQSQ-ORDER-' + n, customer_id: n <= 2 ? 'ZQSQ-CUST-' + n : null, created_at: '2021-04-0' + n + 'T10:00:00Z',
    total_money: { amount: n * 1000, currency: 'GHS' },
    line_items: [{ name: 'Zq bamboo tray', quantity: '1', catalog_object_id: 'ZQSQ-VAR-1', base_price_money: { amount: n * 1000 }, total_money: { amount: n * 1000 } }]
  };
});
function fakeClient(opts) {
  opts = opts || {};
  return {
    listAllCustomers: async function () {
      if (opts.hold) await opts.hold;
      return [
        { id: 'ZQSQ-CUST-1', given_name: 'Zq Ama', family_name: 'Owusu', email_address: 'zq.ama@example.com' },
        { id: 'ZQSQ-CUST-2', company_name: 'Zq Crafts Ltd' }
      ];
    },
    listAllCatalogItems: async function () {
      var list = [
        { id: 'ZQSQ-ITEM-1', type: 'ITEM', item_data: { name: 'Zq bamboo tray', image_ids: ['ZQSQ-IMG-1', 'ZQSQ-IMG-2'], variations: [{ id: 'ZQSQ-VAR-1', item_variation_data: { name: 'Regular', sku: 'ZQSQ-TRAY', price_money: { amount: opts.price || 1000 }, image_ids: ['ZQSQ-IMG-3'] } }] } },
        { id: 'ZQSQ-IMG-1', type: 'IMAGE', image_data: { url: 'https://zq.example.com/tray-front.jpg', caption: 'Front' } },
        { id: 'ZQSQ-IMG-2', type: 'IMAGE', image_data: { url: 'https://zq.example.com/tray-side.jpg' } },
        { id: 'ZQSQ-IMG-3', type: 'IMAGE', image_data: { url: 'https://zq.example.com/tray-regular.jpg' } }
      ];
      if (!opts.dropStool) list.push({ id: 'ZQSQ-ITEM-2', type: 'ITEM', item_data: { name: 'Zq bamboo stool', variations: [{ id: 'ZQSQ-VAR-2', item_variation_data: { name: 'Regular', sku: 'ZQSQ-STOOL', price_money: { amount: 5000 } } }] } });
      return list;
    },
    downloadImage: async function (url) {
      downloads.push(url);
      if (opts.onDownload) await opts.onDownload(downloads.length);
      return { buffer: Buffer.from('zq-picture:' + url), contentType: 'image/jpeg' };
    },
    listLocations: async function () { return [{ id: 'ZQSQ-LOC' }]; },
    searchOrdersPage: async function (locs, o) {
      if (opts.fail) throw new Error('Square API error on POST /v2/orders/search: zqsq test outage');
      var at = o.cursor ? Number(o.cursor) : 0;
      return { orders: ORDERS.slice(at, at + 2), cursor: at + 2 < ORDERS.length ? String(at + 2) : null };
    },
    listAllInvoices: async function () {
      return [{ id: 'ZQSQ-INV-1', order_id: 'ZQSQ-ORDER-1', invoice_number: 'ZQ-0001', status: 'PAID' }];
    },
    listAllPayments: async function () {
      return [
        { id: 'ZQSQ-PAY-1', order_id: 'ZQSQ-ORDER-1', status: 'COMPLETED', source_type: 'CASH', created_at: '2021-04-01T10:05:00Z', amount_money: { amount: 1000 } },
        { id: 'ZQSQ-PAY-2', order_id: 'ZQSQ-ORDER-2', status: 'COMPLETED', source_type: 'CARD', created_at: '2021-04-02T10:05:00Z', amount_money: { amount: 2000 } }
      ];
    }
  };
}

// The test database holds no Square rows of its own, so everything with
// source 'square' here came from this test.
async function cleanup() {
  await pool.query("DELETE FROM receipts WHERE payment_id IN (SELECT id FROM payments WHERE source = 'square')");
  await pool.query("DELETE FROM payments WHERE source = 'square'");
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN (SELECT id FROM invoices WHERE source = 'square')");
  await pool.query("DELETE FROM invoices WHERE source = 'square'");
  var keys = (await pool.query("SELECT photo_key FROM catalog_item_photos WHERE item_id IN (SELECT id FROM catalog_items WHERE source = 'square')")).rows;
  for (var k of keys) await require('../src/lib/fileStore').del(k.photo_key);
  await pool.query("DELETE FROM catalog_item_variations WHERE item_id IN (SELECT id FROM catalog_items WHERE source = 'square')");
  await pool.query("DELETE FROM catalog_items WHERE source = 'square'");
  await pool.query("DELETE FROM catalog_categories WHERE source = 'square'");
  await pool.query("DELETE FROM customers WHERE source = 'square'");
  await pool.query('DELETE FROM square_import_jobs');
}
test.before(async function () {
  await cleanup();
  kelvin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
});
test.after(async function () { imp.setClientFactoryForTests(null); imp.setBeatForTests(null); await cleanup(); await pool.end(); });
async function count(sql) { return (await pool.query(sql)).rows[0].n; }

test('runs in the background, records its progress, and running it again duplicates nothing', async function () {
  imp.setClientFactoryForTests(function () { return fakeClient(); });
  var started = await imp.startImport(kelvin, { wait: true });
  assert.ok(started.id);
  var job = await imp.jobStatus(kelvin);
  assert.equal(job.id, started.id);
  assert.equal(job.status, 'done');
  assert.equal(job.phase, 'done');
  assert.deepEqual(job.customers, { imported: 2, skipped: 0 });
  assert.equal(job.catalogItems.imported, 2);
  assert.deepEqual(job.photos, { imported: 3, skipped: 0 });
  assert.equal(job.invoices.imported, 5);
  assert.equal(job.payments.imported, 2);
  assert.equal(job.pagesDone, 3);
  assert.equal(job.errorCount, 0);
  assert.ok(job.finishedAt);
  assert.ok((await pool.query("SELECT 1 FROM audit_logs WHERE action = 'square.import' AND entity_id = $1", [job.id])).rows[0]);

  assert.equal(await count("SELECT count(*)::int AS n FROM invoices WHERE source = 'square'"), 5);
  assert.equal(await count("SELECT count(*)::int AS n FROM invoices WHERE source = 'square' AND invoice_no = 'SQ-ZQ-0001'"), 1);
  var paid = (await pool.query("SELECT amount_paid::float AS paid, balance_due::float AS due FROM invoices WHERE external_id = 'ZQSQ-ORDER-2'")).rows[0];
  assert.deepEqual(paid, { paid: 20, due: 0 });

  await imp.startImport(kelvin, { wait: true });
  job = await imp.jobStatus(kelvin);
  assert.equal(job.status, 'done');
  assert.equal(await count("SELECT count(*)::int AS n FROM invoices WHERE source = 'square'"), 5);
  assert.equal(await count("SELECT count(*)::int AS n FROM payments WHERE source = 'square'"), 2);
  assert.equal(await count("SELECT count(*)::int AS n FROM customers WHERE source = 'square' AND external_id LIKE 'ZQSQ-%'"), 2);
});

test('one import at a time; a stopped job shows as interrupted; failures are recorded', async function () {
  imp.setClientFactoryForTests(function () { return fakeClient(); });
  var running = (await pool.query('INSERT INTO square_import_jobs DEFAULT VALUES RETURNING id')).rows[0];
  await assert.rejects(imp.startImport(kelvin, {}), /already running/);
  await pool.query("UPDATE square_import_jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [running.id]);
  assert.equal((await imp.jobStatus(kelvin)).status, 'interrupted');

  imp.setClientFactoryForTests(function () { return fakeClient({ fail: true }); });
  await imp.startImport(kelvin, { wait: true });
  var stopped = (await pool.query('SELECT status, message FROM square_import_jobs WHERE id = $1', [running.id])).rows[0];
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.message, /restarted/);
  var job = await imp.jobStatus(kelvin);
  assert.equal(job.status, 'failed');
  assert.match(job.message, /zqsq test outage/);
  assert.equal(job.customers.imported, 2); // how far it got is kept
  assert.ok(job.finishedAt);
});

test('only settings.manage can start or watch an import, and the real API needs its token', async function () {
  var alice = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'alice.kamau@bplghana.com'")).rows[0].id);
  await assert.rejects(imp.startImport(alice, {}), /settings.manage/);
  await assert.rejects(imp.jobStatus(alice), /settings.manage/);
  imp.setClientFactoryForTests(null);
  var before = await count('SELECT count(*)::int AS n FROM square_import_jobs');
  await assert.rejects(imp.startImport(kelvin, {}), /Square is not configured/);
  assert.equal(await count('SELECT count(*)::int AS n FROM square_import_jobs'), before);
});

test('running the import again keeps the catalogue: photos added here, stock and links stay; Square pictures come once', async function () {
  imp.setClientFactoryForTests(function () { return fakeClient(); });
  await imp.startImport(kelvin, { wait: true });
  var tray = (await pool.query("SELECT * FROM catalog_items WHERE external_id = 'ZQSQ-ITEM-1'")).rows[0];
  var photos = (await pool.query('SELECT * FROM catalog_item_photos WHERE item_id = $1 ORDER BY position', [tray.id])).rows;
  assert.deepEqual(photos.map(function (p) { return p.square_image_id; }), ['ZQSQ-IMG-1', 'ZQSQ-IMG-2', 'ZQSQ-IMG-3'], 'Square\'s first picture is the cover');
  assert.equal(photos[0].caption, 'Front');
  var trayVar = (await pool.query("SELECT id FROM catalog_item_variations WHERE external_id = 'ZQSQ-VAR-1'")).rows[0];
  assert.equal(photos[2].variation_id, trayVar.id, 'a variation\'s picture is tagged to it');

  // What Bamboo OS adds to the item: a photo of its own, stock, a cost price.
  var fileStore = require('../src/lib/fileStore');
  var ownKey = await fileStore.put('catalog-zq-own.jpg', Buffer.from('zq own photo'), 'image/jpeg');
  await pool.query('INSERT INTO catalog_item_photos (item_id, photo_key, position) VALUES ($1, $2, 3)', [tray.id, ownKey]);
  await pool.query('UPDATE catalog_item_variations SET stock_qty = 7, cost_price = 4 WHERE id = $1', [trayVar.id]);
  var before = downloads.length;

  // Square changes the price and drops the stool.
  imp.setClientFactoryForTests(function () { return fakeClient({ price: 1500, dropStool: true }); });
  await imp.startImport(kelvin, { wait: true });
  var job = await imp.jobStatus(kelvin);
  assert.equal(job.status, 'done');
  assert.deepEqual(job.photos, { imported: 0, skipped: 0 });
  assert.equal(downloads.length, before, 'no picture downloaded twice');
  var tray2 = (await pool.query("SELECT * FROM catalog_items WHERE external_id = 'ZQSQ-ITEM-1'")).rows[0];
  assert.equal(tray2.id, tray.id, 'the same item, updated in place');
  var v2 = (await pool.query('SELECT * FROM catalog_item_variations WHERE id = $1', [trayVar.id])).rows[0];
  assert.equal(Number(v2.unit_price), 15, 'the new price from Square');
  assert.equal(Number(v2.stock_qty), 7, 'stock kept');
  assert.equal(Number(v2.cost_price), 4, 'cost price kept');
  var after = (await pool.query('SELECT photo_key, square_image_id FROM catalog_item_photos WHERE item_id = $1 ORDER BY position', [tray.id])).rows;
  assert.equal(after.length, 4, 'the photo added here is kept, Square\'s are not added again');
  assert.ok(after.some(function (p) { return p.photo_key === ownKey; }));
  var stool = (await pool.query("SELECT active FROM catalog_items WHERE external_id = 'ZQSQ-ITEM-2'")).rows[0];
  assert.equal(stool.active, false, 'an item no longer in Square is made inactive, not deleted');

  // Back in Square: active again.
  imp.setClientFactoryForTests(function () { return fakeClient(); });
  await imp.startImport(kelvin, { wait: true });
  assert.equal((await pool.query("SELECT active FROM catalog_items WHERE external_id = 'ZQSQ-ITEM-2'")).rows[0].active, true);
});

test('a long step keeps saving its progress, and a second import is refused while one really runs', async function () {
  // Pictures downloading slowly: progress is saved between them, so the job
  // never looks stopped (it used to save only every 100 items).
  imp.setBeatForTests(0);
  await pool.query("DELETE FROM catalog_item_photos WHERE item_id IN (SELECT id FROM catalog_items WHERE external_id = 'ZQSQ-ITEM-1')");
  var seen = [];
  imp.setClientFactoryForTests(function () {
    return fakeClient({ onDownload: async function (n) {
      var j = (await pool.query('SELECT phase, photos_imported FROM square_import_jobs ORDER BY started_at DESC LIMIT 1')).rows[0];
      seen.push([n, j.phase, j.photos_imported]);
    } });
  });
  await imp.startImport(kelvin, { wait: true });
  assert.deepEqual(seen.map(function (x) { return x[1]; }), ['catalog', 'catalog', 'catalog']);
  assert.equal(seen[2][2], 2, 'the two pictures already in were saved before the third was fetched');
  imp.setBeatForTests(null);

  // A job running on this server is running, however old its last save.
  var release;
  var hold = new Promise(function (r) { release = r; });
  imp.setClientFactoryForTests(function () { return fakeClient({ hold: hold }); });
  var started = await imp.startImport(kelvin, {});
  await pool.query("UPDATE square_import_jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [started.id]);
  assert.equal((await imp.jobStatus(kelvin)).status, 'running', 'not mistaken for a restart');
  await assert.rejects(imp.startImport(kelvin, {}), /already running/);
  release();
  for (var i = 0; i < 100 && (await imp.jobStatus(kelvin)).status === 'running'; i++) await new Promise(function (r) { setTimeout(r, 50); });
  assert.equal((await imp.jobStatus(kelvin)).status, 'done');
});
