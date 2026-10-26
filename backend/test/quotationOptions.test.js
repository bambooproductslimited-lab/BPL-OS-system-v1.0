// Quotation options (migration 0193; Square's estimate packages): two or
// three options, each with its own lines plus the lines in all of them; the
// customer picks one when approving online (or the rep for them), and the
// quotation becomes that option — its totals, its payment schedule, its
// invoice. Fake Zqo data; nothing goes out.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var quotations = require('../src/services/quotations.service');
var invoices = require('../src/services/invoices.service');
var shares = require('../src/services/shares.service');
var documentPdf = require('../src/services/documentPdf.service');
var { buildContext } = require('../src/services/context.service');
var boss, cust, server, base;
var SIG = [[[20, 150], [80, 60], [140, 140], [220, 50], [300, 130]], [[320, 120], [420, 90]]];
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function http(method, path, body) {
  var res = await fetch(base + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
  var json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json };
}
async function cleanup() {
  var ids = (await pool.query("SELECT id FROM customers WHERE name LIKE 'Zqo %'")).rows.map(function (r) { return r.id; });
  if (!ids.length) return;
  await pool.query("DELETE FROM notifications WHERE title LIKE '%Zqo%' OR body LIKE '%Zqo%'");
  await pool.query('UPDATE quotations SET pay_share_id = NULL WHERE customer_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM document_responses WHERE document_id IN (SELECT id FROM quotations WHERE customer_id = ANY($1))', [ids]);
  await pool.query('DELETE FROM document_shares WHERE document_id IN (SELECT id FROM quotations WHERE customer_id = ANY($1) UNION SELECT id FROM invoices WHERE customer_id = ANY($1))', [ids]);
  await pool.query('DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM quotations WHERE customer_id = ANY($1) UNION SELECT id FROM invoices WHERE customer_id = ANY($1))', [ids]);
  await pool.query('DELETE FROM invoices WHERE customer_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM quotations WHERE customer_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM customers WHERE id = ANY($1)', [ids]);
}
var LINES = [
  { description: 'Zqo site survey and fitting', qty: 1, unitPrice: 500 },
  { description: 'Zqo bamboo blinds, standard weave', qty: 4, unitPrice: 300, optionKey: 'a' },
  { description: 'Zqo bamboo blinds, fine weave, lined', qty: 4, unitPrice: 550, optionKey: 'b' },
  { description: 'Zqo motor for each blind', qty: 4, unitPrice: 200, optionKey: 'b' }
];
var OPTIONS = [{ name: 'Standard', note: 'Zqo: hand pulled' }, { name: 'Premium', note: 'Zqo: lined and motorised' }];

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await cleanup();
  cust = await customers.create(boss, { name: 'Zqo Palm Hotel', phone: '0240000881', email: 'zqo.palm@example.com', category: 'active' });
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(async function () {
  if (server) await new Promise(function (r) { server.close(r); });
  await cleanup(); await pool.end();
});

test('options: each with its lines and total; the customer chooses one when approving; the quotation is that option', async function () {
  // Two or three, each with a line of its own.
  await assert.rejects(quotations.create(boss, { customerId: cust.id, items: LINES, options: [{ name: 'Only one' }] }), /two or three options/);
  await assert.rejects(quotations.create(boss, { customerId: cust.id, items: LINES.slice(0, 2), options: OPTIONS }), /Put at least one line in the option "Premium"/);
  var q = await quotations.create(boss, { customerId: cust.id, items: LINES, options: OPTIONS, validUntil: day(20),
    paymentSchedule: [{ label: 'Deposit', type: 'percent', value: 50, dueDate: day(3) }, { label: 'On fitting', type: 'percent', value: 50, dueDate: day(14) }] });
  assert.deepEqual(q.options.map(function (o) { return [o.key, o.name, o.totals.grandTotal, o.chosen]; }), [['a', 'Standard', 1700, false], ['b', 'Premium', 3500, false]]);
  assert.equal(q.grandTotal, 1700, 'the first option\'s total until one is chosen');
  assert.deepEqual(q.items.map(function (i) { return i.optionKey; }), ['', 'a', 'b', 'b']);
  // Accepted by hand only once the option is known.
  await quotations.setStatus(boss, q.id, 'sent');
  await assert.rejects(quotations.setStatus(boss, q.id, 'accepted'), /Choose the option the customer picked first/);

  // The customer's page: the options to choose from; the PDF shows each.
  var link = await shares.createShareLink(boss, 'quotation', q.id, 7);
  var page = await http('GET', '/api/share/' + link.token);
  assert.deepEqual(page.body.options.map(function (o) { return [o.name, o.totals.grandTotal]; }), [['Standard', 1700], ['Premium', 3500]]);
  assert.equal(page.body.items.filter(function (i) { return i.optionKey === 'b'; }).length, 2);
  var pdf = await documentPdf.documentPdf('quotation', q.id);
  assert.ok(pdf.buffer.length > 1000);
  assert.equal(pdf.view.options.length, 2);

  // Approving needs an option; the one chosen becomes the quotation.
  var bad = await http('POST', '/api/share/' + link.token + '/answer', { action: 'approved', name: 'Zqo Efua Ansah', signature: SIG });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /Choose one of the options/);
  var ok = await http('POST', '/api/share/' + link.token + '/answer', { action: 'approved', name: 'Zqo Efua Ansah', signature: SIG, option: 'b' });
  assert.equal(ok.status, 200);
  var row = (await pool.query('SELECT * FROM quotations WHERE id = $1', [q.id])).rows[0];
  assert.deepEqual([row.status, row.option_chosen, Number(row.grand_total)], ['accepted', 'b', 3500]);
  assert.deepEqual(row.payment_schedule.map(function (s) { return s.amount; }), [1750, 1750], 'the schedule follows the option chosen');
  var lines = (await pool.query("SELECT description, option_key FROM document_line_items WHERE document_type = 'quotation' AND document_id = $1 ORDER BY sort_order", [q.id])).rows;
  assert.deepEqual(lines.map(function (l) { return l.description; }), ['Zqo site survey and fitting', 'Zqo bamboo blinds, fine weave, lined', 'Zqo motor for each blind']);
  var told = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE title LIKE '%approved quotation%' AND title LIKE '%(Premium)%'")).rows[0].n;
  assert.ok(told >= 1, 'the rep is told which option');
  // Kept for the record: what the other option was.
  q = (await quotations.list(boss)).find(function (x) { return x.id === q.id; });
  assert.deepEqual(q.options.map(function (o) { return [o.name, o.chosen, o.dropped]; }), [['Standard', false, true], ['Premium', true, false]]);
  assert.equal(q.options[0].totals.grandTotal, 1700);
  // Its invoice is the option chosen.
  var inv = await invoices.createFromQuotation(boss, q.id);
  assert.equal(Number(inv.grandTotal), 3500);
  assert.equal(inv.items.length, 3);
  assert.ok(inv.items.every(function (i) { return !i.optionKey; }));
});

test('the rep records the option the customer picked on the phone; then it can be accepted', async function () {
  var q = await quotations.create(boss, { customerId: cust.id, items: LINES, options: OPTIONS.concat([{ name: 'Zqo Deluxe' }]).slice(0, 2), validUntil: day(20) });
  await assert.rejects(quotations.choose(boss, q.id, 'z'), /Choose one of the options/);
  var chosen = await quotations.choose(boss, q.id, 'a');
  assert.deepEqual([chosen.optionChosen, chosen.grandTotal, chosen.items.length], ['a', 1700, 2]);
  await assert.rejects(quotations.choose(boss, q.id, 'b'), /chosen already/);
  var ok = await quotations.setStatus(boss, q.id, 'accepted');
  assert.equal(ok.status, 'accepted');
  // Reopened and changed: it is the option chosen, now with no options.
  await quotations.setStatus(boss, q.id, 'draft');
  var edited = await quotations.update(boss, q.id, { customerId: cust.id, items: chosen.items, options: [], validUntil: day(20) });
  assert.deepEqual([edited.options, edited.optionChosen, edited.grandTotal], [[], null, 1700]);
  // A quotation without options is as before.
  var plain = await quotations.create(boss, { customerId: cust.id, items: [{ description: 'Zqo blinds', qty: 2, unitPrice: 300, optionKey: 'a' }], validUntil: day(20) });
  assert.deepEqual([plain.options, plain.items[0].optionKey, plain.grandTotal], [[], '', 600]);
});
