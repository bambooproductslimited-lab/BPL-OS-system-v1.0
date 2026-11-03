/*
 * Taxes by name on quotations, estimates and invoices (migration 0212):
 * VAT, NHIL and GETFund each a line on the document, carried from estimate
 * to quotation to invoice, on the share page, the PDF and the tax report.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { taxLines, docTaxOf } = require('../src/utils/documents');
var pdf = require('../src/services/documentPdf.service');
var shares = require('../src/services/shares.service');

var server, base;
test.before(function (t, done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
test.after(function () { server.close(); });

async function login(email) {
  var res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: 'bamboo123' }) });
  return (await res.json()).token;
}
function authed(token) { return { Authorization: 'Bearer ' + token }; }
function json(token) { return Object.assign({ 'Content-Type': 'application/json' }, authed(token)); }
async function post(token, path, body) {
  var res = await fetch(base + path, { method: 'POST', headers: json(token), body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
}

var GH = [{ id: 'tx_vat', name: 'VAT', rate: 15 }, { id: 'tx_nhil', name: 'NHIL', rate: 2.5 }, { id: 'tx_getfund', name: 'GETFund', rate: 2.5 }];

test('taxLines: one line per tax by name, adding up to the tax total', function () {
  var lines = taxLines({ subtotal: 1000, discountTotal: 100, taxTotal: 180, taxRate: 20, taxComponents: GH });
  assert.deepEqual(lines.map(function (l) { return [l.label, l.amount]; }), [['VAT (15%)', 135], ['NHIL (2.5%)', 22.5], ['GETFund (2.5%)', 22.5]]);
  // Odd cents: the last takes what is left, so they add up exactly.
  var odd = taxLines({ subtotal: 333.33, discountTotal: 0, taxTotal: 66.67, taxRate: 20, taxComponents: GH });
  assert.equal(Math.round(odd.reduce(function (s, l) { return s + l.amount; }, 0) * 100) / 100, 66.67);
  // Lines with their own tax too: those first, then the taxes by name.
  var both = taxLines({ subtotal: 1000, discountTotal: 0, taxTotal: 250, taxRate: 20, taxComponents: GH });
  assert.deepEqual(both.map(function (l) { return [l.label, l.amount]; }), [['Tax on items', 50], ['VAT (15%)', 150], ['NHIL (2.5%)', 25], ['GETFund (2.5%)', 25]]);
  // One plain rate, and lines' tax alone, as before.
  assert.deepEqual(taxLines({ subtotal: 100, discountTotal: 0, taxTotal: 20, taxRate: 20 }).map(function (l) { return l.label; }), ['Tax (20%)']);
  assert.deepEqual(taxLines({ subtotal: 100, discountTotal: 0, taxTotal: 15, taxRate: 0 }).map(function (l) { return l.label; }), ['Tax']);
  assert.deepEqual(taxLines({ subtotal: 100, discountTotal: 0, taxTotal: 0, taxRate: 0 }), []);
});

test('docTaxOf: the rate is the sum of the taxes; bad ones refused', function () {
  assert.deepEqual(docTaxOf({ taxComponents: GH, taxRate: 3 }).rate, 20);
  assert.deepEqual(docTaxOf({ taxRate: 12.5 }), { rate: 12.5, components: [] });
  // 0% and blank entries are dropped.
  assert.equal(docTaxOf({ taxComponents: [{ name: 'VAT', rate: 15 }, { name: 'Zero', rate: 0 }, null] }).components.length, 1);
  assert.throws(function () { docTaxOf({ taxComponents: [{ name: 'VAT', rate: 15 }, { name: 'vat', rate: 15 }] }); }, /twice/);
  assert.throws(function () { docTaxOf({ taxComponents: [{ name: 'VAT', rate: 150 }] }); }, /100%/);
  assert.throws(function () { docTaxOf({ taxComponents: [{ name: ' ', rate: 5 }] }); }, /name/);
});

test('the taxes to pick: for document makers, withholding marked', async function () {
  var daniel = await login('daniel.omondi@bplghana.com'); // makes quotations
  var alice = await login('alice.kamau@bplghana.com');
  var res = await fetch(base + '/api/commercial-settings/tax-rates', { headers: authed(daniel) });
  assert.equal(res.status, 200);
  var list = await res.json();
  assert.ok(list.some(function (t) { return t.name === 'NHIL' && t.rate === 2.5 && !t.withheld; }));
  assert.ok(list.some(function (t) { return t.id === 'tx_wht' && t.withheld; }));
  assert.equal((await fetch(base + '/api/commercial-settings/tax-rates', { headers: authed(alice) })).status, 403);
});

test('estimate -> quotation -> invoice carry VAT, NHIL and GETFund, each printed on its own line', async function () {
  var daniel = await login('daniel.omondi@bplghana.com');
  var peter = await login('peter.njoroge@bplghana.com');
  var cust = (await post(daniel, '/api/customers', { name: 'ZVT Tax Lines Ltd', contactPerson: 'Test', email: 'zvt@example.com', category: 'prospect' })).body;

  var est = await post(daniel, '/api/estimates', {
    customerId: cust.id, items: [{ description: 'Bamboo desk', qty: 2, unitPrice: 500 }],
    discount: { value: 10, type: 'percent' }, taxComponents: GH, taxRate: 99
  });
  assert.equal(est.status, 201);
  assert.equal(est.body.taxRate, 20);
  assert.deepEqual(est.body.taxComponents.map(function (t) { return t.name + ' ' + t.rate; }), ['VAT 15', 'NHIL 2.5', 'GETFund 2.5']);
  assert.equal(est.body.subtotal, 1000);
  assert.equal(est.body.discountTotal, 100);
  assert.equal(est.body.taxTotal, 180);
  assert.equal(est.body.grandTotal, 1080);

  // Edited: NHIL and GETFund taken off, VAT kept.
  var put = await fetch(base + '/api/estimates/' + est.body.id, { method: 'PUT', headers: json(daniel), body: JSON.stringify({ customerId: cust.id, items: [{ description: 'Bamboo desk', qty: 2, unitPrice: 500 }], taxComponents: [GH[0]] }) });
  var edited = await put.json();
  assert.equal(put.status, 200, JSON.stringify(edited));
  assert.equal(edited.taxRate, 15);
  assert.equal(edited.taxTotal, 150);
  put = await fetch(base + '/api/estimates/' + est.body.id, { method: 'PUT', headers: json(daniel), body: JSON.stringify({ customerId: cust.id, items: [{ description: 'Bamboo desk', qty: 2, unitPrice: 500 }], discount: { value: 10, type: 'percent' }, taxComponents: GH }) });
  assert.equal(put.status, 200);

  var quote = (await post(daniel, '/api/estimates/' + est.body.id + '/convert')).body;
  assert.equal(quote.taxRate, 20);
  assert.equal(quote.taxComponents.length, 3);
  assert.equal(quote.taxTotal, 180);

  await post(daniel, '/api/quotations/' + quote.id + '/status', { status: 'sent' });
  await post(daniel, '/api/quotations/' + quote.id + '/status', { status: 'accepted' });
  var inv = await post(peter, '/api/invoices/from-quotation', { quotationId: quote.id });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.deepEqual(inv.body.taxComponents.map(function (t) { return t.name; }), ['VAT', 'NHIL', 'GETFund']);
  assert.equal(inv.body.grandTotal, 1080);

  // The customer's copy (share page) and the PDF: one line per tax.
  var view = await shares.documentView('invoice', inv.body.id);
  assert.equal(view.taxComponents.length, 3);
  var rows = pdf.adjustmentRows(view, view.currency);
  assert.deepEqual(rows.map(function (r) { return r.label + ' = ' + r.value; }), [
    'Discount (10%) = - GHS 100.00', 'VAT (15%) = GHS 135.00', 'NHIL (2.5%) = GHS 22.50', 'GETFund (2.5%) = GHS 22.50'
  ]);
  var made = await pdf.documentPdf('invoice', inv.body.id);
  assert.ok(made.buffer.length > 1000);

  // A quotation made directly, then changed back to one plain rate.
  var q2 = await post(daniel, '/api/quotations', { customerId: cust.id, items: [{ description: 'Bamboo shelf', qty: 1, unitPrice: 400 }], taxComponents: GH });
  assert.equal(q2.status, 201);
  assert.equal(q2.body.taxComponents.length, 3);
  assert.equal(q2.body.taxTotal, 80);
  var q2put = await fetch(base + '/api/quotations/' + q2.body.id, { method: 'PUT', headers: json(daniel), body: JSON.stringify({ customerId: cust.id, items: [{ description: 'Bamboo shelf', qty: 1, unitPrice: 400 }], taxComponents: [], taxRate: 10 }) });
  var q2b = await q2put.json();
  assert.equal(q2put.status, 200, JSON.stringify(q2b));
  assert.deepEqual(q2b.taxComponents, []);
  assert.equal(q2b.taxTotal, 40);
});

test('a manual invoice: a tax named twice is refused; the tax report names each tax', async function () {
  var kelvin = await login('kelvin.duho@bplghana.com');
  var cust = (await post(kelvin, '/api/customers', { name: 'ZVT Report Co', category: 'active', contactPerson: 'X', email: 'zvtr@example.com', phone: '0000' })).body;
  var twice = await post(kelvin, '/api/invoices', { customerId: cust.id, items: [{ description: 'Stool', qty: 1, unitPrice: 100 }], taxComponents: [GH[0], { name: 'vat', rate: 15 }] });
  assert.equal(twice.status, 400);
  assert.match(twice.body.error.message || twice.body.message || JSON.stringify(twice.body), /twice/);

  function amount(tax, name) { return (tax.byRate.find(function (r) { return r.label === name && r.onWholeDocument; }) || { taxCollected: 0 }).taxCollected; }
  var before = await (await fetch(base + '/api/reports/tax-summary', { headers: authed(kelvin) })).json();
  var inv = await post(kelvin, '/api/invoices', { customerId: cust.id, items: [{ description: 'Bamboo bench', qty: 1, unitPrice: 2000 }], taxComponents: GH });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.taxTotal, 400);
  var after = await (await fetch(base + '/api/reports/tax-summary', { headers: authed(kelvin) })).json();
  assert.equal(Math.round((amount(after, 'VAT') - amount(before, 'VAT')) * 100) / 100, 300);
  assert.equal(Math.round((amount(after, 'NHIL') - amount(before, 'NHIL')) * 100) / 100, 50);
  assert.equal(Math.round((amount(after, 'GETFund') - amount(before, 'GETFund')) * 100) / 100, 50);
  assert.equal(after.reconciliationDiff, 0);
});
