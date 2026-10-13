// The finance dashboard's lighter facts for its banner: for a trade company
// how fast clients pay, how much of what was invoiced has come in, the
// biggest payment this month, the top payer and the days since money last
// came in; for a restaurant the busiest hour, the best seller and the best
// day. Other test files run alongside, so the figures that add up across
// the company are checked as lower bounds.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var reports = require('../src/services/reports.service');
var { buildContext } = require('../src/services/context.service');

var ctx, empId, cust, invs = [], sbr, orders = [];

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  empId = (await pool.query('SELECT employee_id FROM users WHERE id = $1', [ctx.user.id])).rows[0].employee_id;
  sbr = (await pool.query("SELECT id, code FROM companies WHERE code = 'SBR'")).rows[0];
  cust = (await pool.query("INSERT INTO customers (name, category) VALUES ('FXF Bamboo Buyer', 'active') RETURNING id")).rows[0].id;
  // Two invoices paid in full today: one issued 10 days ago (GHS 9,999 —
  // the biggest payment this month), one issued 4 days ago (GHS 500).
  for (var x of [[9999, 10, 'FXF-1'], [500, 4, 'FXF-2']]) {
    var id = (await pool.query(
      "INSERT INTO invoices (invoice_no, customer_id, grand_total, amount_paid, balance_due, status, currency, issued_at, due_date, paid_at) " +
      "VALUES ($3, $1, $2, $2, 0, 'paid', 'GHS', current_date - $4::int, current_date + 20, current_date) RETURNING id", [cust, x[0], x[2], x[1]])).rows[0].id;
    invs.push(id);
    await pool.query("INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, received_by) VALUES ($1, $2, current_date, $3, 'GHS', 'mobile_money', $4)", [id, cust, x[0], empId]);
  }
  // A restaurant's till: a best seller and a busy hour this month.
  var o = (await pool.query(
    "INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, status, payment_method, created_at) " +
    "VALUES ($1, 'FXF-R-1', $2, 999, 999, 'completed', 'cash', date_trunc('day', now()) + interval '13 hours') RETURNING id", [sbr.id, empId])).rows[0].id;
  orders.push(o);
  await pool.query("INSERT INTO restaurant_order_items (order_id, name, qty, unit_price, line_total) VALUES ($1, 'FXF Jollof special', 99, 10.09, 999)", [o]);
});
test.after(async function () {
  await pool.query('DELETE FROM payments WHERE invoice_id = ANY($1)', [invs]);
  await pool.query('DELETE FROM invoices WHERE id = ANY($1)', [invs]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust]);
  await pool.query('DELETE FROM restaurant_order_items WHERE order_id = ANY($1)', [orders]);
  await pool.query('DELETE FROM restaurant_orders WHERE id = ANY($1)', [orders]);
  await pool.end();
});

test('a trade company: how fast clients pay, the biggest payment, the top payer', async function () {
  var d = await reports.financeDashboard(ctx, { company: 'BPL' });
  var f = d.fun;
  assert.ok(f, 'the fun facts come with the dashboard');
  assert.equal(typeof f.daysToPay, 'number');
  assert.ok(f.paidInvoices >= 2);
  assert.ok(f.biggestPayment && f.biggestPayment.amount >= 9999, 'the biggest payment this month');
  assert.ok(f.paymentsThisMonth >= 2);
  assert.ok(f.payersThisMonth >= 1);
  assert.equal(f.daysSinceLastPayment, 0, 'money came in today');
  assert.ok(f.collectedShare !== null && f.collectedShare > 0 && f.collectedShare <= 1);
  assert.ok(f.paid90 >= 10499);
  assert.ok(f.topPayerThisYear && f.topPayerThisYear.amount >= 10499);
  assert.ok(f.bestMonth && f.bestMonth.amount >= 10499, 'this month is at least as good as our two payments');
});

test('a restaurant: the busiest hour, the best seller and the best day', async function () {
  var d = await reports.financeDashboard(ctx, { company: sbr.code });
  var f = d.fun;
  assert.ok(f.bestSeller && f.bestSeller.qty >= 99, 'the best seller this month');
  assert.equal(f.bestSeller.name, 'FXF Jollof special');
  assert.ok(f.busiestHour && typeof f.busiestHour.hour === 'number');
  assert.ok(f.bestDay && f.bestDay.sales >= 999);
});
