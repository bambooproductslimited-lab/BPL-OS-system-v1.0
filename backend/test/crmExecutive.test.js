/*
 * The Sales & CRM overview's figures for the CEO or a sales manager
 * (crmExecutive.service.js): sales and cash against the period before, what
 * is owed by age, quotations and the win rate, the team, best and quiet
 * customers, what sells, and reply times. The period figures use the first
 * quarter of 2019, which no other test touches; what is owed now is checked
 * as a change from before these invoices existed. Customers use the ZEX
 * prefix and are removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var executive = require('../src/services/crmExecutive.service');

var admin, adminEmp, a, b, quietOne;
var Q1 = { from: '2019-01-01', to: '2019-03-31' };

function daysAgo(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }

async function cleanup() {
  var cust = "(SELECT id FROM customers WHERE name LIKE 'ZEX%')";
  var inv = '(SELECT id FROM invoices WHERE customer_id IN ' + cust + ')';
  await pool.query('DELETE FROM payments WHERE invoice_id IN ' + inv);
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN " + inv);
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query('DELETE FROM quotations WHERE customer_id IN ' + cust);
  await pool.query("DELETE FROM crm_conversations WHERE external_thread_id LIKE 'zex-%'");
  await pool.query("DELETE FROM customers WHERE name LIKE 'ZEX%'");
}

var n = 0;
async function invoice(customer, issued, total, paid, line, opts) {
  opts = opts || {};
  n++;
  var i = (await pool.query(
    "INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, doc_kind) " +
    "VALUES ($1,$2,$3,0,0,$3,0,$3,'unpaid',$4,$5,'sale') RETURNING id", ['ZEX-' + n + '-' + Date.now(), customer, total, issued, opts.due || issued])).rows[0];
  if (line) await pool.query("INSERT INTO document_line_items (document_type, document_id, description, qty, unit_price) VALUES ('invoice',$1,$2,$3,$4)", [i.id, line[0], line[1], line[2]]);
  if (paid) {
    await pool.query("INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, received_by) VALUES ($1,$2,$3,$4,'GHS','cash',$5)", [i.id, customer, opts.paidOn || issued, paid, adminEmp]);
    await pool.query('UPDATE invoices SET amount_paid = $1 WHERE id = $2', [paid, i.id]);
  }
  return i.id;
}

test.before(async function () {
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  adminEmp = admin.employee.id;
  a = (await pool.query("INSERT INTO customers (name, account_manager_id) VALUES ('ZEX Builders', $1) RETURNING id", [adminEmp])).rows[0].id;
  b = (await pool.query("INSERT INTO customers (name) VALUES ('ZEX Hotel') RETURNING id")).rows[0].id;
  quietOne = (await pool.query("INSERT INTO customers (name) VALUES ('ZEX Old Friend') RETURNING id")).rows[0].id;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('sales, cash, customers, quotations and the funnel, against the period before', async function () {
  var owedBefore = (await executive.summary(admin, Q1)).receivables;
  // Q4 2018: one sale to ZEX Hotel, so it is a returning buyer in Q1.
  await invoice(b, '2018-11-10', 500, 500, ['ZEX cups', 50, 10]);
  // Q1 2019: two to ZEX Builders (new), one to ZEX Hotel (returning).
  await invoice(a, '2019-01-15', 3000, 3000, ['ZEX flooring', 10, 300]);
  await invoice(a, '2019-02-20', 2000, 500, ['ZEX flooring', 5, 400], { due: daysAgo(45), paidOn: '2019-03-01' });
  await invoice(b, '2019-03-05', 1000, 0, ['ZEX cups', 100, 10], { due: daysAgo(400) });
  var q = "INSERT INTO quotations (quote_no, customer_id, grand_total, status, created_by, sent_at, valid_until) VALUES ($1,$2,$3,$4,$5,$6,$7)";
  await pool.query(q, ['ZEX-Q1', a, 4000, 'accepted', adminEmp, '2019-01-05', '2019-02-05']);
  await pool.query(q, ['ZEX-Q2', b, 1500, 'rejected', adminEmp, '2019-02-01', '2019-03-01']);
  await pool.query(q, ['ZEX-Q3', b, 800, 'sent', adminEmp, '2019-03-10', '2019-03-20']); // lapsed: counts as lost

  var r = await executive.summary(admin, Q1);
  assert.deepEqual(r.previous, { from: '2018-10-03', to: '2018-12-31' });
  assert.equal(r.now.sales, 6000);
  assert.equal(r.now.cash, 3500, 'payments dated in the period');
  assert.equal(r.now.invoices, 3);
  assert.equal(r.now.averageInvoice, 2000);
  assert.equal(r.now.buyers, 2);
  assert.equal(r.now.newBuyers, 1);
  assert.equal(r.now.returningBuyers, 1);
  assert.equal(r.before.sales, 500);
  assert.equal(r.before.cash, 500);
  assert.equal(r.now.quotesSent, 3);
  assert.equal(r.now.quotesWon, 1);
  assert.equal(r.now.winRate, 33, 'won 1 of 3 decided (one rejected, one lapsed)');
  // Leads (crm_leads) belong to test/crm.test.js, which checks them there.

  // Twelve months to the end of the period.
  assert.equal(r.trend.length, 12);
  assert.equal(r.trend[11].month, '2019-03');
  assert.deepEqual(r.trend.find(function (m) { return m.month === '2019-02'; }), { month: '2019-02', sales: 2000, cash: 0 });
  assert.equal(r.trend.find(function (m) { return m.month === '2019-03'; }).cash, 500);

  // Best customers and what sells.
  assert.deepEqual(r.customers.top.map(function (c) { return [c.name, c.sales, c.share]; }), [['ZEX Builders', 5000, 83], ['ZEX Hotel', 1000, 17]]);
  assert.equal(r.customers.top[0].owes, 1500);
  assert.equal(r.customers.topFiveShare, 100);
  assert.deepEqual(r.products.map(function (p) { return [p.name, p.qty, p.amount]; }), [['ZEX flooring', 15, 5000], ['ZEX cups', 100, 1000]]);

  // What is owed now, by age: 1,500 at 31–60 days, 1,000 over a year.
  var add = function (k) { return r.receivables.aging.find(function (x) { return x.key === k; }).amount - owedBefore.aging.find(function (x) { return x.key === k; }).amount; };
  assert.equal(Math.round(add('d60')), 1500);
  assert.equal(Math.round(add('older')), 1000);
  assert.equal(Math.round(r.receivables.overdue - owedBefore.overdue), 2500);

  // The team: the rep who looks after ZEX Builders has its sales.
  var mine = r.team.find(function (t) { return t.repId === adminEmp; });
  assert.equal(mine.sales, 5000);
  assert.equal(mine.cash, 3500);
  assert.equal(mine.share, 83);
});

test('good customers who have stopped buying', async function () {
  await invoice(quietOne, daysAgo(400), 9000, 9000);
  await invoice(quietOne, daysAgo(200), 7000, 7000);
  var r = await executive.summary(admin, Q1);
  var q = r.customers.quiet.find(function (c) { return c.name === 'ZEX Old Friend'; });
  assert.ok(q, 'listed');
  assert.equal(q.invoices, 2);
  assert.equal(q.lifetime, 16000);
  assert.equal(q.lastBought, daysAgo(200));
  await invoice(quietOne, daysAgo(10), 100, 100);
  r = await executive.summary(admin, Q1);
  assert.ok(!r.customers.quiet.some(function (c) { return c.name === 'ZEX Old Friend'; }), 'bought again: no longer quiet');
});

test('how fast customers get an answer', async function () {
  var conv = (await pool.query("INSERT INTO crm_conversations (channel, external_thread_id, customer_id, status, last_direction, last_message_at) VALUES ('whatsapp', 'zex-1', $1, 'closed', 'out', '2019-02-10T13:00:00Z') RETURNING id", [a])).rows[0].id;
  var m = "INSERT INTO crm_messages (conversation_id, direction, sent_at) VALUES ($1, $2, $3)";
  await pool.query(m, [conv, 'in', '2019-02-10T10:00:00Z']);
  await pool.query(m, [conv, 'out', '2019-02-10T10:30:00Z']); // 30 min
  await pool.query(m, [conv, 'in', '2019-02-10T11:00:00Z']);
  await pool.query(m, [conv, 'in', '2019-02-10T11:05:00Z']); // same run: not asked again
  await pool.query(m, [conv, 'out', '2019-02-10T13:00:00Z']); // 120 min
  await pool.query(m, [conv, 'in', '2019-03-30T09:00:00Z']); // never answered
  var r = await executive.summary(admin, Q1);
  assert.equal(r.service.asked, 3);
  assert.equal(r.service.answered, 2);
  assert.equal(r.service.medianMinutes, 75);
  assert.equal(r.service.withinHour, 33, 'one of the three in an hour');
  assert.deepEqual(r.service.channels.map(function (c) { return [c.channel, c.asked]; }), [['whatsapp', 3]]);
  assert.equal(r.team.find(function (t) { return t.repId === adminEmp; }).replyMedianMinutes, 75);
});

test('who may see it, and a sensible period', async function () {
  var noCrm = Object.assign({}, admin, { can: function () { return false; } });
  await assert.rejects(executive.summary(noCrm, Q1), /crm\.read/);
  await assert.rejects(executive.summary(admin, { from: '2019-03-01', to: '2019-01-01' }), /ends before it starts/);
  var r = await executive.summary(admin, {});
  assert.match(r.period.from, /^\d{4}-(01|04|07|10)-01$/, 'this quarter by default');
});
