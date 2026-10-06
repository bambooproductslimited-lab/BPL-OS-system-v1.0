/*
 * Old invoices cleared in one go (invoiceCleanup.service.js): recorded as
 * paid, written off with a credit note, or voided — each under the same
 * rules as by hand, one reason for all, and what cannot be done is reported
 * while the rest go through; Bamboo Products' invoices and Poki's rent and
 * utility bills each only on their own side. Customers use the ZIC prefix and are removed
 * afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var invoices = require('../src/services/invoices.service');
var cleanupSvc = require('../src/services/invoiceCleanup.service');

var admin, cust, other;

async function cleanup() {
  var inv = "(SELECT id FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'ZIC%'))";
  await pool.query('DELETE FROM credit_notes WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM receipts WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM payments WHERE invoice_id IN ' + inv);
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN " + inv);
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query('DELETE FROM poki_tenants WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE \'ZIC%\')');
  await pool.query("DELETE FROM customers WHERE name LIKE 'ZIC%'");
  await pool.query("DELETE FROM audit_logs WHERE action = 'invoice.cleanup' AND summary LIKE '%ZIC test%'");
}

test.before(async function () {
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cust = (await pool.query("INSERT INTO customers (name, email) VALUES ('ZIC Traders', 'zic@example.invalid') RETURNING id")).rows[0].id;
  other = (await pool.query("SELECT id FROM companies WHERE code <> 'BPL' LIMIT 1")).rows[0];
});
test.after(async function () { await cleanup(); await pool.end(); });

function invoiceOf(total) {
  return invoices.createManual(admin, { customerId: cust, items: [{ description: 'ZIC goods', qty: 1, unitPrice: total }] });
}
async function row(id) { return (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0]; }

test('recorded as paid: what is left on each, with a receipt, on the date and by the method chosen', async function () {
  var a = await invoiceOf(500), b = await invoiceOf(800);
  await invoices.recordPayment(admin, b.id, { amount: 300, method: 'cash' });
  var r = await cleanupSvc.apply(admin, { invoiceIds: [a.id, b.id], action: 'paid', method: 'mobile_money', date: '2025-09-01', reason: 'ZIC test: paid at the shop, never recorded' });
  assert.equal(r.done, 2);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.totals, [{ currency: 'GHS', amount: 1000 }]);
  assert.equal(r.results[1].amount, 500, 'only what was left on the part-paid one');
  assert.match(r.results[0].made, /\S/, 'a receipt number');
  for (var id of [a.id, b.id]) {
    var i = await row(id);
    assert.equal(i.status, 'paid');
    assert.equal(Number(i.balance_due), 0);
  }
  var pay = (await pool.query("SELECT * FROM payments WHERE invoice_id = $1 AND method = 'mobile_money'", [b.id])).rows[0];
  assert.equal(Number(pay.amount), 500);
  assert.equal(pay.reference, 'Clean-up');
  assert.equal(pay.notes, 'ZIC test: paid at the shop, never recorded');
  assert.equal(new Date(pay.date).toISOString().slice(0, 10) <= '2025-09-01', true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM receipts WHERE invoice_id = $1', [a.id])).rows[0].n, 1);
  var log = (await pool.query("SELECT * FROM audit_logs WHERE action = 'invoice.cleanup' AND summary LIKE '%ZIC test: paid%'")).rows[0];
  assert.match(log.summary, /2 invoice\(s\) recorded as paid \(GHS 1000\.00\)/);
});

test('written off: a credit note for what is left; the invoice keeps its total and owes nothing', async function () {
  var a = await invoiceOf(1200), b = await invoiceOf(7260);
  await invoices.recordPayment(admin, b.id, { amount: 7000, method: 'bank_transfer' });
  var r = await cleanupSvc.apply(admin, { invoiceIds: [a.id, b.id], action: 'write_off', reason: 'ZIC test: over a year old, customer gone' });
  assert.equal(r.done, 2);
  assert.deepEqual(r.totals, [{ currency: 'GHS', amount: 1460 }]);
  assert.match(r.results[0].made, /CN/);
  var ib = await row(b.id);
  assert.equal(ib.status, 'paid');
  assert.equal(Number(ib.grand_total), 7260);
  assert.equal(Number(ib.credit_total), 260);
  assert.equal(Number(ib.amount_paid), 7000, 'the money that came in stays');
  var cn = (await pool.query('SELECT * FROM credit_notes WHERE invoice_id = $1', [a.id])).rows[0];
  assert.equal(Number(cn.amount), 1200);
  assert.equal(Number(cn.refund_amount), 0);
  assert.equal(cn.reason, 'ZIC test: over a year old, customer gone');
  // Done again: nothing is left to write off.
  var again = await cleanupSvc.apply(admin, { invoiceIds: [a.id], action: 'write_off', reason: 'ZIC test again' });
  assert.equal(again.failed, 1);
  assert.match(again.results[0].error, /Nothing is owed/);
});

test('voided: only invoices with no payments; the rest are reported and the others still go through', async function () {
  var a = await invoiceOf(400), part = await invoiceOf(900), paid = await invoiceOf(100);
  await invoices.recordPayment(admin, part.id, { amount: 100, method: 'cash' });
  await invoices.recordPayment(admin, paid.id, { amount: 100, method: 'cash' });
  var r = await cleanupSvc.apply(admin, { invoiceIds: [part.id, a.id, paid.id, a.id], action: 'void', reason: 'ZIC test: entered twice' });
  assert.equal(r.results.length, 3, 'the same invoice twice counts once');
  assert.equal(r.done, 1);
  assert.equal(r.failed, 2);
  assert.match(r.results[0].error, /Write off what is left instead/);
  assert.equal(r.results[1].ok, true);
  assert.match(r.results[2].error, /paid; it cannot be voided/);
  assert.equal((await row(a.id)).status, 'void');
  assert.equal((await row(part.id)).status, 'partially_paid', 'untouched');
  var log = (await pool.query("SELECT summary FROM audit_logs WHERE action = 'invoice.void' AND entity_id = $1", [a.id])).rows[0];
  assert.match(log.summary, /voided — ZIC test: entered twice\./);
});

test('what it needs: a reason, an action, ticks, the right; nothing in the future; only this company\'s invoices', async function () {
  var a = await invoiceOf(50);
  await assert.rejects(cleanupSvc.apply(admin, { invoiceIds: [a.id], action: 'paid', reason: ' ' }), /Reason is required/);
  await assert.rejects(cleanupSvc.apply(admin, { invoiceIds: [a.id], action: 'burn', reason: 'x' }), /not a valid option/);
  await assert.rejects(cleanupSvc.apply(admin, { invoiceIds: [], action: 'void', reason: 'x' }), /Tick at least one/);
  await assert.rejects(cleanupSvc.apply(admin, { invoiceIds: ['nope'], action: 'void', reason: 'x' }), /not valid/);
  await assert.rejects(cleanupSvc.apply(admin, { invoiceIds: [a.id], action: 'paid', date: '2999-01-01', reason: 'x' }), /future/);
  var reader = Object.assign({}, admin, { can: function (p) { return p === 'invoice.read'; } });
  await assert.rejects(cleanupSvc.apply(reader, { invoiceIds: [a.id], action: 'void', reason: 'x' }), /invoice\.manage/);
  if (other) {
    var b = await invoiceOf(60);
    await pool.query('UPDATE invoices SET company_id = $1 WHERE id = $2', [other.id, b.id]);
    var r = await cleanupSvc.apply(admin, { invoiceIds: [b.id], action: 'void', reason: 'ZIC test: other company' });
    assert.equal(r.failed, 1);
    assert.match(r.results[0].error, /not found/);
    assert.equal((await row(b.id)).status, 'unpaid');
  }
  assert.equal((await row(a.id)).status, 'unpaid', 'nothing changed by the refusals');
});

test('rent and utility bills (Poki): the same clean-up, Poki\'s own bills only, by a Poki manager', async function () {
  var poki = require('../src/services/poki.service');
  var pokiId = await poki.pokiCompanyId();
  var tenant = (await pool.query("INSERT INTO customers (name, company_id) VALUES ('ZIC Tenant', $1) RETURNING id", [pokiId])).rows[0].id;
  async function bill(kind, total) {
    return (await pool.query(
      "INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, doc_kind, company_id) " +
      "VALUES ($1,$2,$3,0,0,$3,0,$3,'unpaid','2025-01-05','2025-01-15',$4,$5) RETURNING id", ['ZIC-PKI-' + kind + '-' + Date.now(), tenant, total, kind, pokiId])).rows[0].id;
  }
  var rent = await bill('rent', 2400), water = await bill('utility', 180), wrong = await bill('cam', 90);
  var bplOne = (await invoiceOf(70)).id;
  // A Poki manager: poki.manage, and not Bamboo Products' invoice.manage.
  var manager = Object.assign(Object.create(Object.getPrototypeOf(admin)), admin, { can: function (p) { return p === 'poki.manage' || p === 'poki.read'; } });

  var r = await cleanupSvc.applyPoki(manager, { invoiceIds: [rent, bplOne], action: 'write_off', reason: 'ZIC test: tenant left in 2025' });
  assert.equal(r.done, 1);
  assert.match(r.results[1].error, /not found/, 'a Bamboo Products invoice is not Poki\'s to clean up');
  assert.equal((await row(rent)).status, 'paid');
  assert.equal(Number((await row(rent)).credit_total), 2400);
  assert.equal((await row(bplOne)).status, 'unpaid');

  r = await cleanupSvc.applyPoki(manager, { invoiceIds: [water], action: 'paid', method: 'cash', date: '2025-02-01', reason: 'ZIC test: paid at the office' });
  assert.equal(r.done, 1);
  assert.match(r.results[0].made, /\S/, 'a receipt number');
  assert.equal((await row(water)).status, 'paid');

  r = await cleanupSvc.applyPoki(manager, { invoiceIds: [wrong], action: 'void', reason: 'ZIC test: billed twice' });
  assert.equal(r.done, 1);
  assert.equal((await row(wrong)).status, 'void');
  assert.match((await pool.query("SELECT summary FROM audit_logs WHERE action = 'invoice.void' AND entity_id = $1", [wrong])).rows[0].summary, /— ZIC test: billed twice\./);
  assert.ok((await pool.query("SELECT 1 FROM audit_logs WHERE action = 'invoice.cleanup' AND summary LIKE 'Poki clean-up: 1 invoice(s) voided%ZIC test: billed twice.'")).rows.length);

  // And the other way: Bamboo Products' clean-up does not reach Poki's bills.
  var other = await bill('rent', 500);
  var b = await cleanupSvc.apply(admin, { invoiceIds: [other], action: 'void', reason: 'ZIC test: not mine' });
  assert.match(b.results[0].error, /not found/);
  await assert.rejects(cleanupSvc.applyPoki(Object.assign({}, admin, { can: function () { return false; } }), { invoiceIds: [other], action: 'void', reason: 'x' }), /poki\.manage/);
});
