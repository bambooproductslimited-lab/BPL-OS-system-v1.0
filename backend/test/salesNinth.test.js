// The ninth batch on Bamboo Products' side (migration 0189): payment links
// paid on the customer website, and contracts signed online. Fake Zqk data
// only; nothing goes out: Paystack is stubbed, email to a test transport.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var quotations = require('../src/services/quotations.service');
var links = require('../src/services/paymentLinks.service');
var contracts = require('../src/services/contracts.service');
var invoicePay = require('../src/services/invoicePay.service');
var mail = require('../src/services/mail.service');
var { buildContext } = require('../src/services/context.service');

var boss, server, base, cust, cat, item, varA;
var keyWas = config.paystackBpl.secretKey;
var sent = [];
var SIG = [[[20, 150], [80, 60], [140, 140], [220, 50], [300, 130]], [[320, 120], [420, 90]]];
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function http(method, path, body, headers) {
  var res = await fetch(base + path, { method: method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body == null ? undefined : JSON.stringify(body) });
  var json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json };
}
async function cleanup() {
  var custs = (await pool.query("SELECT id FROM customers WHERE name LIKE 'Zqk %'")).rows.map(function (r) { return r.id; });
  await pool.query("DELETE FROM notifications WHERE title LIKE '%Zqk%' OR body LIKE '%Zqk%'");
  await pool.query("DELETE FROM contract_templates WHERE name LIKE 'Zqk %'");
  if (custs.length) {
    await pool.query('DELETE FROM contracts WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM invoice_online_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ANY($1))', [custs]);
    await pool.query("DELETE FROM document_shares WHERE document_id IN (SELECT id FROM quotations WHERE customer_id = ANY($1) UNION SELECT id FROM invoices WHERE customer_id = ANY($1))", [custs]);
    await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = ANY($1) UNION SELECT id FROM quotations WHERE customer_id = ANY($1))", [custs]);
    await pool.query('DELETE FROM invoices WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM quotations WHERE customer_id = ANY($1)', [custs]);
  }
  await pool.query("DELETE FROM payment_links WHERE title LIKE 'Zqk %'");
  if (custs.length) {
    await pool.query('DELETE FROM customer_identities WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM customers WHERE id = ANY($1)', [custs]);
  }
  await pool.query("DELETE FROM catalog_item_variations WHERE item_id IN (SELECT id FROM catalog_items WHERE name LIKE 'Zqk %')");
  await pool.query("DELETE FROM catalog_items WHERE name LIKE 'Zqk %'");
  await pool.query("DELETE FROM catalog_categories WHERE name LIKE 'Zqk %'");
}

// Paystack, as its API answers (no request leaves the machine).
function stubPaystack() {
  config.paystackBpl.secretKey = 'zqk-fake-bpl-paystack-key';
  invoicePay.setFetchForTests(async function (url, opts) {
    var body = opts.body ? JSON.parse(opts.body) : null;
    var data = /\/transaction\/initialize$/.test(url)
      ? { authorization_url: 'https://checkout.paystack.com/zqk' + body.reference.slice(-6).toLowerCase(), reference: body.reference, callback: body.callback_url }
      : { reference: decodeURIComponent(url.split('/').pop()), status: 'ongoing', amount: 0 };
    return { ok: true, status: 200, json: async function () { return { status: true, message: 'ok', data: data }; } };
  });
}

test.before(async function () {
  await cleanup();
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  cat = (await pool.query("INSERT INTO catalog_categories (name) VALUES ('Zqk Chairs') RETURNING id")).rows[0].id;
  item = (await pool.query("INSERT INTO catalog_items (name, category_id, tax_rate_id, active) VALUES ('Zqk lounge chair', $1, 'tx_zero', true) RETURNING id", [cat])).rows[0].id;
  varA = (await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price, active) VALUES ($1, 'Regular', 'ZQK-1', 'each', 300, true) RETURNING id", [item])).rows[0].id;
  cust = await customers.create(boss, { name: 'Zqk Coastal Hotel', phone: '0240000771', email: 'zqk.hotel@example.com', category: 'active', address: 'Zqk: Labadi beach road' });
  mail.setTransportForTests({ sendMail: async function (m) { sent.push(m); return { messageId: 'zqk-' + sent.length }; } });
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(async function () {
  invoicePay.setFetchForTests(null);
  config.paystackBpl.secretKey = keyWas;
  mail.setTransportForTests(null);
  if (server) await new Promise(function (r) { server.close(r); });
  await cleanup();
  await pool.end();
});

test('payment links: an amount, items or what the customer types; paid on the customer website through Paystack, as an invoice for them', async function () {
  links._paidBy.clear();
  await assert.rejects(links.create({ can: function () { return false; } }, {}), /invoice\.manage/);
  await assert.rejects(links.create(boss, { title: 'Zqk deposit', kind: 'amount', amount: 0 }), /from GHS 1/);
  await assert.rejects(links.create(boss, { title: 'Zqk deposit', kind: 'wish' }), /set amount, items/);
  await assert.rejects(links.create(boss, { title: 'Zqk deposit', kind: 'amount', amount: 500, expiresOn: day(-1) }), /today or later/);
  var fixed = await links.create(boss, { title: 'Zqk deposit for the deck', description: 'Zqk: half before we start', kind: 'amount', amount: 500 });
  assert.match(fixed.url, /^https:\/\/online\.bplghana\.com\/pay\/[A-Za-z0-9_-]{16}$/);
  assert.deepEqual([fixed.kind, fixed.total, fixed.state, fixed.singleUse], ['amount', 500, 'open', false]);

  // Its page: the title and the amount, nothing about anyone.
  var page = await http('GET', '/api/pay/' + fixed.token);
  assert.equal(page.status, 200);
  assert.deepEqual([page.body.title, page.body.total, page.body.kind, page.body.state, page.body.forName], ['Zqk deposit for the deck', 500, 'amount', 'open', null]);
  assert.equal(page.body.payOnline, false);
  assert.equal((await http('GET', '/api/pay/zqk-not-a-link-000')).status, 404);

  // Paid without Paystack set up: the invoice's page to pay by bank.
  config.paystackBpl.secretKey = '';
  var bad = await http('POST', '/api/pay/' + fixed.token, { name: 'Z', phone: '0244000771' });
  assert.match(bad.body.error.message, /Type your name/);
  bad = await http('POST', '/api/pay/' + fixed.token, { name: 'Zqk Ama Link', phone: '12' });
  assert.match(bad.body.error.message, /phone number/);
  var r = await http('POST', '/api/pay/' + fixed.token, { name: 'Zqk Ama Link', phone: '024 400 0772', email: 'zqk.ama@example.com', amount: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 500, 'the link\'s amount, not one sent');
  assert.equal(r.body.payUrl, null);
  assert.match(r.body.url, /^https:\/\/online\.bplghana\.com\/share\//);
  var inv = (await pool.query('SELECT * FROM invoices WHERE invoice_no = $1', [r.body.invoiceNo])).rows[0];
  assert.equal(inv.payment_link_id, fixed.id);
  assert.equal(Number(inv.grand_total), 500);
  assert.match(inv.notes, /Paid by link: Zqk deposit for the deck/);
  var c = (await pool.query('SELECT name, origin_channel FROM customers WHERE id = $1', [inv.customer_id])).rows[0];
  assert.deepEqual([c.name, c.origin_channel], ['Zqk Ama Link', 'shop']);
  var share = (await pool.query('SELECT created_by FROM document_shares WHERE token = $1', [r.body.token])).rows[0];
  assert.equal(share.created_by, boss.employee.id, 'a payment is put down as received by whoever made the link');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE employee_id = $1 AND title = '🔗 Zqk deposit for the deck'", [boss.employee.id])).rows[0]);

  // Back again: the same invoice, not another.
  stubPaystack();
  var again = await http('POST', '/api/pay/' + fixed.token, { name: 'Zqk Ama Link', phone: '0244000772' });
  assert.equal(again.body.invoiceNo, r.body.invoiceNo);
  assert.match(again.body.payUrl, /^https:\/\/checkout\.paystack\.com\/zqk/);
  var op = (await pool.query('SELECT amount FROM invoice_online_payments WHERE invoice_id = $1', [inv.id])).rows[0];
  assert.equal(Number(op.amount), 500);

  // The customer types the amount.
  var open = await links.create(boss, { title: 'Zqk pay what you owe', kind: 'open' });
  assert.equal((await http('GET', '/api/pay/' + open.token)).body.total, null);
  bad = await http('POST', '/api/pay/' + open.token, { name: 'Zqk Kofi Open', phone: '0244000773' });
  assert.match(bad.body.error.message, /Type the amount/);
  r = await http('POST', '/api/pay/' + open.token, { name: 'Zqk Kofi Open', phone: '0244000773', amount: 75.5 });
  assert.equal(r.body.total, 75.5);

  // Items from the catalogue, priced when made.
  await assert.rejects(links.create(boss, { title: 'Zqk chairs', kind: 'items', lines: [] }), /at least one item/);
  var items = await links.create(boss, { title: 'Zqk two lounge chairs', kind: 'items', lines: [{ variationId: varA, qty: 2 }], singleUse: true });
  assert.equal(items.total, 600);
  assert.deepEqual(items.lines.map(function (l) { return [l.description, l.qty, l.unitPrice]; }), [['Zqk lounge chair', 2, 300]]);
  await pool.query('UPDATE catalog_item_variations SET unit_price = 999 WHERE id = $1', [varA]);
  r = await http('POST', '/api/pay/' + items.token, { name: 'Zqk Yaa Items', phone: '0244000774' });
  assert.equal(r.body.total, 600, 'the price when the link was made');
  // Single use: paid, it is done.
  await pool.query("UPDATE invoices SET status = 'paid', amount_paid = grand_total, balance_due = 0 WHERE invoice_no = $1", [r.body.invoiceNo]);
  assert.equal((await http('GET', '/api/pay/' + items.token)).body.state, 'paid');
  bad = await http('POST', '/api/pay/' + items.token, { name: 'Zqk Late Comer', phone: '0244000775' });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error.message, /has been paid/);

  // Made for one customer: their first name, nothing asked.
  var mine = await links.create(boss, { title: 'Zqk balance for the hotel', kind: 'amount', amount: 1200, customerId: cust.id });
  page = await http('GET', '/api/pay/' + mine.token);
  assert.equal(page.body.forName, 'Zqk');
  r = await http('POST', '/api/pay/' + mine.token, {});
  assert.equal(r.status, 201);
  assert.equal((await pool.query('SELECT customer_id FROM invoices WHERE invoice_no = $1', [r.body.invoiceNo])).rows[0].customer_id, cust.id);

  // Paused, then open again; closed for good; past its day.
  var p = await links.setStatus(boss, fixed.id, { status: 'paused' });
  assert.equal(p.state, 'paused');
  bad = await http('POST', '/api/pay/' + fixed.token, { name: 'Zqk Ama Link', phone: '0244000772' });
  assert.match(bad.body.error.message, /not taking payments/);
  await links.setStatus(boss, fixed.id, { status: 'active' });
  await links.setStatus(boss, open.id, { status: 'closed' });
  await assert.rejects(links.setStatus(boss, open.id, { status: 'active' }), /stays closed/);
  await pool.query("UPDATE payment_links SET expires_on = current_date - 1 WHERE id = $1", [mine.id]);
  assert.equal((await http('GET', '/api/pay/' + mine.token)).body.state, 'expired');

  // Staff: the links, what each took, and the invoices behind one.
  var listed = await links.list(boss, {});
  var f = listed.links.find(function (x) { return x.id === fixed.id; });
  assert.deepEqual([f.openCount, f.paidCount], [1, 0]);
  assert.equal(listed.links.find(function (x) { return x.id === items.id; }).paidTotal, 600);
  assert.ok(listed.summary.paidTotal >= 600);
  assert.ok((await links.list(boss, { state: 'done' })).links.every(function (x) { return x.state !== 'open'; }));
  var one = await links.get(boss, fixed.id);
  assert.equal(one.invoices.length, 1);
  assert.equal(one.invoices[0].customer, 'Zqk Ama Link');

  // Left unpaid three days, with Paystack set up: voided.
  await pool.query("UPDATE invoices SET issued_at = current_date - 4 WHERE payment_link_id = $1", [open.id]);
  await pool.query("UPDATE invoice_online_payments SET created_at = now() - interval '4 days' WHERE invoice_id IN (SELECT id FROM invoices WHERE payment_link_id = $1)", [open.id]);
  config.paystackBpl.secretKey = '';
  assert.equal(await links.sweep(), 0, 'paid by bank without Paystack: left alone');
  stubPaystack();
  assert.ok(await links.sweep() >= 1);
  assert.equal((await pool.query('SELECT status FROM invoices WHERE payment_link_id = $1', [open.id])).rows[0].status, 'void');
  assert.equal((await pool.query('SELECT status FROM invoices WHERE payment_link_id = $1', [fixed.id])).rows[0].status, 'unpaid', 'a recent one stays');
});

test('contracts: from a template filled from the customer and quotation, sent to sign on the customer website, signed or declined, voided', async function () {
  var t = await contracts.templates(boss);
  assert.match(t.sample.body, /\{customer\}/);
  await assert.rejects(contracts.saveTemplate(boss, { name: 'Z', body: t.sample.body }), /name/);
  var tpl = await contracts.saveTemplate(boss, { name: 'Zqk supply agreement', body: t.sample.body });
  tpl = await contracts.saveTemplate(boss, { id: tpl.id, name: 'Zqk supply agreement', body: t.sample.body + '\n\nZqk: {unknown} stays as written.' });
  var q = await quotations.create(boss, { customerId: cust.id, currency: 'GHS', items: [{ description: 'Zqk bamboo deck', qty: 1, unitPrice: 10000 }], validUntil: day(20) });

  await assert.rejects(contracts.create(boss, { templateId: tpl.id }), /Choose the customer/);
  var other = await customers.create(boss, { name: 'Zqk Other Client', phone: '0240000779', category: 'active' });
  await assert.rejects(contracts.create(boss, { customerId: other.id, quotationId: q.id, templateId: tpl.id }), /this customer's quotations/);
  var k = await contracts.create(boss, { customerId: cust.id, quotationId: q.id, templateId: tpl.id });
  assert.match(k.contractNo, /^CT-\d{4,}$/);
  assert.equal(k.status, 'draft');
  assert.equal(k.url, null);
  assert.match(k.body, /and Zqk Coastal Hotel of Zqk: Labadi beach road/);
  assert.match(k.body, /quotation Q/);
  assert.match(k.body, new RegExp(q.quoteNo));
  assert.match(k.body, /The price is GHS 10,000\.00/);
  assert.match(k.body, /Bamboo Products Limited/);
  assert.match(k.body, /\{unknown\} stays as written/);
  // A draft is not on the website.
  var token = (await pool.query('SELECT token FROM contracts WHERE id = $1', [k.id])).rows[0].token;
  assert.equal((await http('GET', '/api/c/' + token)).status, 404);
  k = await contracts.update(boss, k.id, { title: 'Zqk deck contract', body: k.body + '\n\nZqk: a clause added.' });
  assert.equal(k.title, 'Zqk deck contract');

  // Sent: its link, emailed to the customer.
  var s = await contracts.send(boss, k.id);
  assert.equal(s.status, 'sent');
  assert.equal(s.url, 'https://online.bplghana.com/c/' + token);
  assert.equal(s.emailed, true);
  assert.match(s.message, /to read and sign: https:\/\/online\.bplghana\.com\/c\//);
  assert.ok(sent.some(function (m) { return m.to === 'zqk.hotel@example.com' && m.subject === 'Your contract ' + k.contractNo + ' from Bamboo Products'; }));
  await assert.rejects(contracts.update(boss, k.id, { body: 'Zqk changed after sending, which is not allowed.' }), /Only a draft/);

  // The customer's page: the words; looked at, noted.
  var page = await http('GET', '/api/c/' + token);
  assert.equal(page.status, 200);
  assert.deepEqual([page.body.title, page.body.status, page.body.customerName, page.body.company], ['Zqk deck contract', 'sent', 'Zqk Coastal Hotel', 'Bamboo Products Limited']);
  assert.equal(page.body.signature, null);
  assert.ok((await contracts.get(boss, k.id)).viewedAt);

  var bad = await http('POST', '/api/c/' + token + '/sign', { name: 'Zqk Esi Manager', signature: SIG });
  assert.match(bad.body.error.message, /Tick the box/);
  bad = await http('POST', '/api/c/' + token + '/sign', { name: 'Zqk Esi Manager', agree: true, signature: [[[1, 1], [2, 2]]] });
  assert.match(bad.body.error.message, /Sign in the box/);
  var signed = await http('POST', '/api/c/' + token + '/sign', { name: 'Zqk Esi Manager', agree: true, signature: SIG }, { 'User-Agent': 'Zqk test browser' });
  assert.equal(signed.status, 200);
  assert.equal(signed.body.status, 'signed');
  assert.equal(signed.body.signerName, 'Zqk Esi Manager');
  assert.deepEqual(signed.body.signature, SIG);
  var row = (await pool.query('SELECT signed_ua, signed_at FROM contracts WHERE id = $1', [k.id])).rows[0];
  assert.equal(row.signed_ua, 'Zqk test browser');
  assert.ok(row.signed_at);
  assert.ok((await pool.query('SELECT 1 FROM notifications WHERE employee_id = $1 AND title = $2', [boss.employee.id, '✍️ Contract signed: ' + k.contractNo])).rows[0]);
  bad = await http('POST', '/api/c/' + token + '/sign', { name: 'Zqk Esi Manager', agree: true, signature: SIG });
  assert.equal(bad.status, 409);
  bad = await http('POST', '/api/c/' + token + '/decline', { note: 'Zqk changed my mind' });
  assert.equal(bad.status, 409);

  // Another, declined with a reason.
  var k2 = await contracts.create(boss, { customerId: cust.id, title: 'Zqk maintenance contract', body: 'Zqk: we look after the deck every three months for {customer}.' });
  assert.equal((await contracts.get(boss, k2.id)).body, 'Zqk: we look after the deck every three months for Zqk Coastal Hotel.');
  // Nothing to fill: the placeholder and the word before it go.
  assert.equal(contracts.fill('Zqk Hotel of {address} ("the Client"), quotation {quote_no}.', { address: '', quote_no: '' }), 'Zqk Hotel ("the Client"), quotation .');
  await contracts.send(boss, k2.id);
  var t2 = (await pool.query('SELECT token FROM contracts WHERE id = $1', [k2.id])).rows[0].token;
  bad = await http('POST', '/api/c/' + t2 + '/decline', { note: 'no' });
  assert.match(bad.body.error.message, /Tell us why/);
  var d = await http('POST', '/api/c/' + t2 + '/decline', { note: 'Zqk: every month, please' });
  assert.deepEqual([d.body.status, d.body.declineNote], ['declined', 'Zqk: every month, please']);

  // Voided, with a reason; the counts.
  await assert.rejects(contracts.voidIt(boss, k.id, { reason: '' }), /Say why/);
  var v = await contracts.voidIt(boss, k.id, { reason: 'Zqk: replaced by a new one' });
  assert.equal(v.status, 'void');
  await assert.rejects(contracts.voidIt(boss, k.id, { reason: 'Zqk again' }), /void already/);
  assert.equal((await http('GET', '/api/c/' + token)).body.status, 'void');
  var listed = await contracts.list(boss, { customerId: cust.id });
  assert.deepEqual(listed.contracts.map(function (x) { return x.status; }).sort(), ['declined', 'void']);
  assert.ok(listed.counts.void >= 1);
  await contracts.deleteTemplate(boss, tpl.id);
  await assert.rejects(contracts.deleteTemplate(boss, tpl.id), /gone/);
});

test('the customer website reaches payment links\' and contracts\' pages, not the staff lists', async function () {
  var call = function (path) { return fetch(base + path, { headers: { Origin: 'https://online.bplghana.com' } }); };
  var ok = await call('/api/pay/zqk-not-a-link-000');
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://online.bplghana.com');
  ok = await call('/api/c/zqk-not-a-contract-000');
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://online.bplghana.com');
  var no = await call('/api/payment-links');
  assert.equal(no.headers.get('access-control-allow-origin'), null);
  no = await call('/api/contracts');
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});
