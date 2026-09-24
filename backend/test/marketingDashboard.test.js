// The marketing dashboard report (GET /api/reports/marketing): the
// customer pipeline, the quotation funnel with what is still waiting for
// an answer, and the leads to follow up with their open quotations.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var reports = require('../src/services/reports.service');
var { buildContext } = require('../src/services/context.service');

var ctx, customerId, quoteId;

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  customerId = (await pool.query("INSERT INTO customers (name, category) VALUES ('K4D Test Lead Ltd', 'lead') RETURNING id")).rows[0].id;
  var emp = (await pool.query('SELECT employee_id FROM users WHERE id = $1', [ctx.user.id])).rows[0];
  quoteId = (await pool.query(
    "INSERT INTO quotations (quote_no, customer_id, grand_total, status, created_by, valid_until) VALUES ('K4D-Q-1', $1, 1500, 'sent', $2, current_date + 3) RETURNING id",
    [customerId, emp.employee_id]
  )).rows[0].id;
});
test.after(async function () {
  await pool.query('DELETE FROM quotations WHERE id = $1', [quoteId]);
  await pool.query('DELETE FROM customers WHERE id = $1', [customerId]);
  await pool.end();
});

test('a sent quotation is waiting, and shows on its lead', async function () {
  var d = await reports.marketingDashboard(ctx);
  assert.ok(d.funnel.waiting >= 1);
  var q = d.waitingQuotes.find(function (x) { return x.quoteNo === 'K4D-Q-1'; });
  assert.ok(q, 'listed as waiting');
  assert.equal(q.customerName, 'K4D Test Lead Ltd');
  assert.match(q.validUntil, /^\d{4}-\d{2}-\d{2}$/);
  var lead = d.leads.find(function (l) { return l.id === customerId; });
  assert.equal(lead.openQuotes, 1);
  assert.equal(lead.hasManager, false);
  assert.match(lead.lastQuoteAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(d.pipeline.find(function (p) { return p.category === 'lead'; }).count >= 1);
});

test('it needs customer.read', async function () {
  var nobody = Object.assign({}, ctx, { can: function () { return false; } });
  await assert.rejects(reports.marketingDashboard(nobody), /customer\.read/);
});
