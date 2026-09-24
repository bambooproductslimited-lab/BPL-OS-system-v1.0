// The marketing dashboard report (GET /api/reports/marketing): the
// customer pipeline, the quotation funnel with what is still waiting for
// an answer, and the leads to follow up with their open quotations.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var reports = require('../src/services/reports.service');
var { buildContext } = require('../src/services/context.service');

var ctx, customerId, quoteId, pokiCustomerId, sbr, guestId, empId;

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  customerId = (await pool.query("INSERT INTO customers (name, category) VALUES ('K4D Test Lead Ltd', 'lead') RETURNING id")).rows[0].id;
  var emp = (await pool.query('SELECT employee_id FROM users WHERE id = $1', [ctx.user.id])).rows[0];
  quoteId = (await pool.query(
    "INSERT INTO quotations (quote_no, customer_id, grand_total, status, created_by, valid_until) VALUES ('K4D-Q-1', $1, 1500, 'sent', $2, current_date + 3) RETURNING id",
    [customerId, emp.employee_id]
  )).rows[0].id;
  empId = emp.employee_id;
  var poki = (await pool.query("SELECT id FROM companies WHERE code = 'PKI'")).rows[0];
  pokiCustomerId = (await pool.query("INSERT INTO customers (name, category, company_id) VALUES ('K4D Poki Prospect', 'prospect', $1) RETURNING id", [poki.id])).rows[0].id;
  sbr = (await pool.query("SELECT id, code FROM companies WHERE code = 'SBR'")).rows[0];
  guestId = (await pool.query("INSERT INTO restaurant_guests (company_id, name, phone) VALUES ($1, 'K4D Regular Guest', '0200000000') RETURNING id", [sbr.id])).rows[0].id;
  // Two visits 40 and 50 days ago (a regular who stopped coming) and a
  // counter sale today with a dish on it.
  await pool.query(
    "INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, guest_id, created_at) VALUES " +
    "($1, 'K4D-R-1', $2, 120, 120, $3, now() - interval '40 days'), ($1, 'K4D-R-2', $2, 80, 80, $3, now() - interval '50 days'), " +
    "($1, 'K4D-R-3', $2, 60, 60, NULL, now())", [sbr.id, empId, guestId]
  );
  var today = (await pool.query("SELECT id FROM restaurant_orders WHERE order_no = 'K4D-R-3'")).rows[0].id;
  await pool.query("INSERT INTO restaurant_order_items (order_id, name, qty, unit_price, line_total) VALUES ($1, 'K4D Jollof special', 2, 30, 60)", [today]);
});
test.after(async function () {
  await pool.query('DELETE FROM quotations WHERE id = $1', [quoteId]);
  await pool.query('DELETE FROM customers WHERE id = ANY($1::uuid[])', [[customerId, pokiCustomerId]]);
  await pool.query("DELETE FROM restaurant_orders WHERE order_no LIKE 'K4D-R-%'");
  await pool.query('DELETE FROM restaurant_guests WHERE id = $1', [guestId]);
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

test('each company sees only its own customers', async function () {
  var bpl = await reports.marketingDashboard(ctx);
  assert.equal(bpl.company.code, 'BPL');
  assert.equal(bpl.kind, 'trade');
  assert.ok(!bpl.leads.some(function (l) { return l.id === pokiCustomerId; }), 'Poki prospect not on Bamboo Products');
  var poki = await reports.marketingDashboard(ctx, 'pki');
  assert.equal(poki.company.code, 'PKI');
  assert.ok(poki.leads.some(function (l) { return l.id === pokiCustomerId; }));
  assert.ok(!poki.leads.some(function (l) { return l.id === customerId; }));
  await assert.rejects(reports.marketingDashboard(ctx, 'NOPE'), /no marketing dashboard/);
});

test('the switcher lists Bamboo Products first, then the restaurants', async function () {
  var list = await reports.marketingCompanies(ctx);
  assert.equal(list[0].code, 'BPL');
  assert.deepEqual(list.slice(1, 3).map(function (c) { return c.code; }), ['SBR', 'BGN']);
  assert.equal(list[1].kind, 'restaurant');
  assert.ok(list.some(function (c) { return c.code === 'PKI' && c.kind === 'trade'; }));
});

test('a restaurant gets its guests, regulars who stopped coming and best sellers', async function () {
  var d = await reports.marketingDashboard(ctx, sbr.code);
  assert.equal(d.kind, 'restaurant');
  assert.ok(d.sales.orders >= 1);
  assert.ok(d.lapsed.some(function (g) { return g.name === 'K4D Regular Guest' && g.orders === 2 && g.total === 200; }));
  assert.ok(d.bestSellers.some(function (b) { return b.name === 'K4D Jollof special' && b.qty === 2; }));
  assert.equal(d.weekdays.length, 7);
  assert.ok(d.guests.returning >= 1);
});

test('restaurants need restaurant.read', async function () {
  var noRestaurant = Object.assign({}, ctx, { can: function (p) { return p === 'customer.read'; } });
  var list = await reports.marketingCompanies(noRestaurant);
  assert.ok(!list.some(function (c) { return c.kind === 'restaurant'; }));
  await assert.rejects(reports.marketingDashboard(noRestaurant, sbr.code), /no marketing dashboard/);
});
