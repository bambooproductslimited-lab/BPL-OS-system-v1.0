// The restaurant Square import as a background job: pages of orders are
// saved as they arrive, the job records its progress, a later import only
// fetches orders from the last one saved, a full re-import fetches all
// again without duplicating anything, a second import can't start while
// one is running, a job stopped by a restart shows as interrupted, and a
// failure is recorded with its reason. A fake Square client stands in for
// the real API. Test data uses the ZQI company code.
process.env.SQUARE_ACCESS_TOKEN_ZQI = 'fake-token-for-tests';
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var imp = require('../src/services/restaurantSquareImport.service');
var { buildContext } = require('../src/services/context.service');

var kelvin, company, seen = [];
var ORDERS = [1, 2, 3, 4, 5].map(function (n) {
  return {
    id: 'ZQI-ORDER-' + n, state: 'COMPLETED', created_at: '2021-03-0' + n + 'T10:00:00Z', total_money: { amount: n * 1000, currency: 'GHS' },
    line_items: [{ name: 'Zqi jollof', quantity: '1', catalog_object_id: 'ZQI-VAR-1', base_price_money: { amount: n * 1000 }, total_money: { amount: n * 1000 } }],
    tenders: [{ type: 'CASH' }]
  };
});
function fakeClient(opts) {
  opts = opts || {};
  return {
    listLocations: async function () { return [{ id: 'ZQI-LOC' }]; },
    listAllCatalogItems: async function () {
      return [{ id: 'ZQI-ITEM-1', type: 'ITEM', is_deleted: false, item_data: { name: 'Zqi jollof', variations: [{ id: 'ZQI-VAR-1', is_deleted: false, item_variation_data: { name: 'Regular', price_money: { amount: 1000 } } }] } }];
    },
    searchOrdersPage: async function (locs, o) {
      if (opts.fail) throw new Error('Square API error on POST /v2/orders/search: zqi test outage');
      seen.push(o.since ? new Date(o.since).toISOString() : null);
      var list = ORDERS.filter(function (x) { return !o.since || new Date(x.created_at) >= new Date(o.since); });
      var at = o.cursor ? Number(o.cursor) : 0;
      return { orders: list.slice(at, at + 2), cursor: at + 2 < list.length ? String(at + 2) : null };
    }
  };
}
async function cleanup() {
  if (!company) return;
  await pool.query('DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = $1)', [company.id]);
  await pool.query('DELETE FROM restaurant_orders WHERE company_id = $1', [company.id]);
  await pool.query('DELETE FROM restaurant_menu_item_variations WHERE menu_item_id IN (SELECT id FROM restaurant_menu_items WHERE company_id = $1)', [company.id]);
  await pool.query('DELETE FROM restaurant_menu_items WHERE company_id = $1', [company.id]);
  await pool.query('DELETE FROM restaurant_import_jobs WHERE company_id = $1', [company.id]);
  await pool.query("DELETE FROM employees WHERE code = 'ZQI-SQIMPORT'");
  await pool.query('DELETE FROM departments WHERE company_id = $1', [company.id]);
  await pool.query('DELETE FROM companies WHERE id = $1', [company.id]);
}
test.before(async function () {
  await pool.query("DELETE FROM companies WHERE code = 'ZQI'");
  kelvin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQI', 'Zqi Chop Bar') RETURNING *")).rows[0];
  await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQIK', 'Zqi Kitchen', $1)", [company.id]);
});
test.after(async function () { imp.setClientFactoryForTests(null); await cleanup(); await pool.end(); });
async function savedOrders() { return (await pool.query('SELECT count(*)::int AS n FROM restaurant_orders WHERE company_id = $1', [company.id])).rows[0].n; }

test('runs page by page, then only fetches from the last saved order, and a full re-import duplicates nothing', async function () {
  imp.setClientFactoryForTests(function () { return fakeClient(); });
  var started = await imp.startImport(kelvin, company.id, { wait: true });
  assert.ok(started.id);
  var job = await imp.jobStatus(kelvin, company.id);
  assert.equal(job.status, 'done');
  assert.equal(job.orders.imported, 5);
  assert.equal(job.pagesDone, 3);
  assert.equal(job.menuItems.imported, 1);
  assert.equal(new Date(job.lastOrderAt).toISOString(), '2021-03-05T10:00:00.000Z');
  assert.equal(job.ordersSince, null);
  assert.equal(await savedOrders(), 5);
  var perOrder = (await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'restaurant.square_import.order' AND summary LIKE '%ZQI-ORDER%'")).rows[0].n;
  assert.equal(perOrder, 0);
  assert.ok((await pool.query("SELECT 1 FROM audit_logs WHERE action = 'restaurant.square_import' AND entity_id = $1", [job.id])).rows[0]);

  // Next import: from a day before the last saved order.
  seen.length = 0;
  await imp.startImport(kelvin, company.id, { wait: true });
  job = await imp.jobStatus(kelvin, company.id);
  assert.equal(seen[0], '2021-03-04T10:00:00.000Z');
  assert.equal(job.orders.imported, 2);
  assert.equal(await savedOrders(), 5);

  seen.length = 0;
  await imp.startImport(kelvin, company.id, { full: true, wait: true });
  job = await imp.jobStatus(kelvin, company.id);
  assert.equal(seen[0], null);
  assert.equal(job.fullImport, true);
  assert.equal(job.orders.imported, 5);
  assert.equal(await savedOrders(), 5);
});

test('one import at a time; a stopped job shows as interrupted; failures are recorded', async function () {
  imp.setClientFactoryForTests(function () { return fakeClient(); });
  var running = (await pool.query("INSERT INTO restaurant_import_jobs (company_id) VALUES ($1) RETURNING id", [company.id])).rows[0];
  await assert.rejects(imp.startImport(kelvin, company.id, {}), /already running/);
  await pool.query("UPDATE restaurant_import_jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [running.id]);
  assert.equal((await imp.jobStatus(kelvin, company.id)).status, 'interrupted');

  imp.setClientFactoryForTests(function () { return fakeClient({ fail: true }); });
  await imp.startImport(kelvin, company.id, { wait: true });
  assert.equal((await pool.query('SELECT status FROM restaurant_import_jobs WHERE id = $1', [running.id])).rows[0].status, 'failed');
  var job = await imp.jobStatus(kelvin, company.id);
  assert.equal(job.status, 'failed');
  assert.match(job.message, /zqi test outage/);
});

test('checks happen before anything starts', async function () {
  var alice = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'alice.kamau@bplghana.com'")).rows[0].id);
  await assert.rejects(imp.startImport(alice, company.id, {}), /restaurant.manage/);
  await assert.rejects(imp.startImport(kelvin, '00000000-0000-0000-0000-000000000000', {}), /not found/i);
});
