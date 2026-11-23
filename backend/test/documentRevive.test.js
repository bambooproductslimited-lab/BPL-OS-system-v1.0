// Reviving documents that ran out (quotations, estimates, invoices
// .service.js revive; shares.service reopenLinks): a quotation past its
// valid-until date opens again with a new date — sent if it had gone out —
// and stays open; an estimate gets a new date; an invoice's customer link
// opens again for 30 days, with a new due date if given. The links the
// customer already has work again.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var customers = require('../src/services/customers.service');
var estimates = require('../src/services/estimates.service');
var quotations = require('../src/services/quotations.service');
var invoices = require('../src/services/invoices.service');
var shares = require('../src/services/shares.service');

var boss, staff, cust;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function rejects(p, code) { await assert.rejects(p, function (e) { return e.code === code; }); }
function find(list, id) { return list.find(function (x) { return x.id === id; }); }
// A link the customer got, already run out.
async function oldLink(type, id) {
  var l = await shares.issueLink(type, id, 30, null);
  await pool.query("UPDATE document_shares SET expires_at = now() - interval '3 days' WHERE token = $1", [l.token]);
  return l.token;
}
async function linkOpen(token) {
  try { await shares.getSharedDocument(token); return true; } catch (e) { return false; }
}

async function cleanup() {
  var c = "(SELECT id FROM customers WHERE name LIKE 'Zqrv%')";
  var inv = '(SELECT id FROM invoices WHERE customer_id IN ' + c + ')';
  var q = '(SELECT id FROM quotations WHERE customer_id IN ' + c + ')';
  var es = '(SELECT id FROM estimates WHERE customer_id IN ' + c + ')';
  await pool.query("DELETE FROM document_shares WHERE document_id IN " + inv + " OR document_id IN " + q + " OR document_id IN " + es);
  await pool.query("DELETE FROM document_line_items WHERE (document_type = 'invoice' AND document_id IN " + inv + ") OR (document_type = 'quotation' AND document_id IN " + q + ") OR (document_type = 'estimate' AND document_id IN " + es + ')');
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query('DELETE FROM quotations WHERE id IN ' + q);
  await pool.query('DELETE FROM estimates WHERE id IN ' + es);
  await pool.query("DELETE FROM customers WHERE name LIKE 'Zqrv%'");
}
test.before(async function () {
  await cleanup();
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = await ctxFor('alice.kamau@bplghana.com');
  cust = await customers.create(boss, { name: 'Zqrv Furniture', phone: '0240000777', email: 'zqrv@example.com', category: 'active' });
});
test.after(async function () { await cleanup(); await pool.end(); });

test('a quotation that ran out: revived with a new date, sent again, and it stays open', async function () {
  var es = await estimates.create(boss, { customerId: cust.id, items: [{ description: 'Zqrv chairs', qty: 4, unitPrice: 250 }] });
  var q = await estimates.convertToQuotation(boss, es.id);
  await quotations.setStatus(boss, q.id, 'sent');
  await pool.query('UPDATE quotations SET valid_until = $2 WHERE id = $1', [q.id, day(-5)]);
  var token = await oldLink('quotation', q.id);
  assert.equal(find(await quotations.list(boss), q.id).status, 'expired', 'ran out');
  assert.equal(await linkOpen(token), false);

  await rejects(quotations.revive(staff, q.id, { validUntil: day(30) }), 'forbidden');
  await rejects(quotations.revive(boss, q.id, { validUntil: day(-1) }), 'invalid');
  await rejects(quotations.revive(boss, q.id, {}), 'invalid');
  var back = await quotations.revive(boss, q.id, { validUntil: day(21) });
  assert.equal(back.status, 'sent', 'it had gone out: sent again');
  assert.equal(String(back.validUntil).slice(0, 10), day(21));
  assert.equal(back.reopenedLinks, 1);
  assert.equal(await linkOpen(token), true, 'the customer\'s link works again');
  // Listing again does not expire it again (the old reopen did); the
  // customer opening the link above made it "viewed".
  assert.equal(find(await quotations.list(boss), q.id).status, 'viewed');
  // Not run out: nothing to revive.
  await rejects(quotations.revive(boss, q.id, { validUntil: day(40) }), 'conflict');
  var audit = (await pool.query("SELECT summary FROM audit_logs WHERE action = 'quotation.revive' AND entity_id = $1", [q.id])).rows[0];
  assert.match(audit.summary, /valid until/);

  // Never sent: a draft again.
  var es2 = await estimates.create(boss, { customerId: cust.id, items: [{ description: 'Zqrv table', qty: 1, unitPrice: 900 }] });
  var q2 = await estimates.convertToQuotation(boss, es2.id);
  await pool.query("UPDATE quotations SET valid_until = $2, status = 'expired' WHERE id = $1", [q2.id, day(-2)]);
  assert.equal((await quotations.revive(boss, q2.id, { validUntil: day(10) })).status, 'draft');
});

test('an estimate past its date: a new date, its link open again; one made into a quotation is revived there', async function () {
  var es = await estimates.create(boss, { customerId: cust.id, items: [{ description: 'Zqrv shelves', qty: 2, unitPrice: 300 }] });
  await pool.query('UPDATE estimates SET valid_until = $2 WHERE id = $1', [es.id, day(-10)]);
  var token = await oldLink('estimate', es.id);
  var back = await estimates.revive(boss, es.id, { validUntil: day(14) });
  assert.equal(String(back.validUntil).slice(0, 10), day(14));
  assert.equal(back.reopenedLinks, 1);
  assert.equal(await linkOpen(token), true);
  await rejects(estimates.revive(staff, es.id, { validUntil: day(14) }), 'forbidden');

  await estimates.convertToQuotation(boss, es.id);
  await assert.rejects(estimates.revive(boss, es.id, { validUntil: day(14) }), function (e) { return e.code === 'conflict' && /revive that quotation/.test(e.message); });
});

test('an invoice: its customer link opens again for 30 days, with a new due date if given', async function () {
  var inv = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqrv cabinet', qty: 1, unitPrice: 1500 }] });
  await pool.query('UPDATE invoices SET due_date = $2 WHERE id = $1', [inv.id, day(-20)]);
  // No link yet, no new due date: nothing to revive.
  await rejects(invoices.revive(boss, inv.id, {}), 'invalid');
  var token = await oldLink('invoice', inv.id);
  var row = find(await invoices.list(boss), inv.id);
  assert.equal(row.linkExpired, true, 'the list says its link ran out');
  assert.equal(row.overdue, true);

  await rejects(invoices.revive(boss, inv.id, { dueDate: day(-1) }), 'invalid');
  var back = await invoices.revive(boss, inv.id, { dueDate: day(14) });
  assert.equal(String(back.dueDate).slice(0, 10), day(14));
  assert.equal(back.reopenedLinks, 1);
  assert.equal(back.linkExpired, false);
  assert.ok(new Date(back.linkExpiresAt) > new Date(Date.now() + 29 * 86400000), 'for 30 days');
  assert.equal(await linkOpen(token), true);
  row = find(await invoices.list(boss), inv.id);
  assert.equal(row.overdue, false);
  assert.equal(row.linkExpired, false);

  // Only the link: the due date stays.
  await pool.query("UPDATE document_shares SET expires_at = now() - interval '1 day' WHERE token = $1", [token]);
  assert.equal(String((await invoices.revive(boss, inv.id, {})).dueDate).slice(0, 10), day(14));
  assert.equal(await linkOpen(token), true);

  await rejects(invoices.revive(staff, inv.id, {}), 'forbidden');
  await invoices.voidInvoice(boss, inv.id, 'Zqrv test');
  await rejects(invoices.revive(boss, inv.id, {}), 'conflict');
});
