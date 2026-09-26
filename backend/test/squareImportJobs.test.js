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
      return [
        { id: 'ZQSQ-CUST-1', given_name: 'Zq Ama', family_name: 'Owusu', email_address: 'zq.ama@example.com' },
        { id: 'ZQSQ-CUST-2', company_name: 'Zq Crafts Ltd' }
      ];
    },
    listAllCatalogItems: async function () {
      return [{ id: 'ZQSQ-ITEM-1', type: 'ITEM', item_data: { name: 'Zq bamboo tray', variations: [{ id: 'ZQSQ-VAR-1', item_variation_data: { name: 'Regular', sku: 'ZQSQ-TRAY', price_money: { amount: 1000 } } }] } }];
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
test.after(async function () { imp.setClientFactoryForTests(null); await cleanup(); await pool.end(); });
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
  assert.equal(job.catalogItems.imported, 1);
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
