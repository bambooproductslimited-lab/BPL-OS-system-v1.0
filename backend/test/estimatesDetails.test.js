// Estimates: the list says who each is for and how to reach them, who made
// it and which quotation came from it. Only a draft/finalized/archived move
// is allowed by hand; "converted" comes from making the quotation, and an
// archived estimate must be brought back before it can become one.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var estimates = require('../src/services/estimates.service');
var { buildContext } = require('../src/services/context.service');

var boss, cust;
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = await customers.create(boss, { name: 'Zqe Shelving Co', phone: '0240000401', email: 'zqe@example.com', category: 'prospect' });
});
test.after(async function () {
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM estimates WHERE customer_id = $1) OR document_id IN (SELECT id FROM quotations WHERE customer_id = $1)", [cust.id]);
  await pool.query('DELETE FROM quotations WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM estimates WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
  await pool.end();
});

test('estimate list carries contact, maker and the quotation made from it', async function () {
  var es = await estimates.create(boss, { customerId: cust.id, items: [{ description: 'Zqe shelf', qty: 4, unitPrice: 250 }] });
  var row = (await estimates.list(boss)).find(function (x) { return x.id === es.id; });
  assert.equal(row.customerPhone, '0240000401');
  assert.equal(row.customerEmail, 'zqe@example.com');
  assert.equal(row.customerCategory, 'prospect');
  assert.ok(row.createdByName.length > 0);
  assert.equal(row.quotation, null);

  var q = await estimates.convertToQuotation(boss, es.id);
  row = (await estimates.list(boss)).find(function (x) { return x.id === es.id; });
  assert.equal(row.status, 'converted');
  assert.deepEqual(row.quotation, { id: q.id, quoteNo: q.quoteNo, status: 'draft' });
});

test('status moves: converted only by making a quotation; archived must come back first', async function () {
  var es = await estimates.create(boss, { customerId: cust.id, items: [{ description: 'Zqe rack', qty: 1, unitPrice: 900 }] });
  await assert.rejects(estimates.setStatus(boss, es.id, 'converted'), /Status/);
  assert.equal((await estimates.setStatus(boss, es.id, 'finalized')).status, 'finalized');
  assert.equal((await estimates.setStatus(boss, es.id, 'archived')).status, 'archived');
  await assert.rejects(estimates.convertToQuotation(boss, es.id), /Bring this estimate back/);
  assert.equal((await estimates.setStatus(boss, es.id, 'draft')).status, 'draft');
  await estimates.convertToQuotation(boss, es.id);
  await assert.rejects(estimates.setStatus(boss, es.id, 'draft'), /already been made into a quotation/);
});
