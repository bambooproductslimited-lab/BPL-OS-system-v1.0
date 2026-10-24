// Estimates and quotations answered on their link (approved with a name and
// a drawn signature, declined, changes asked for), and invoices paid online
// from theirs, through Paystack on Bamboo Products' own account. Nothing
// goes out: Paystack is stubbed.
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var app = require('../src/app');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var quotations = require('../src/services/quotations.service');
var estimates = require('../src/services/estimates.service');
var invoices = require('../src/services/invoices.service');
var shares = require('../src/services/shares.service');
var answers = require('../src/services/documentAnswers.service');
var invoicePay = require('../src/services/invoicePay.service');
var documentPdf = require('../src/services/documentPdf.service');
var { buildContext } = require('../src/services/context.service');

var boss, cust, server, base;
var keyWas = config.paystackBpl.secretKey;
var SIG = [[[20, 150], [80, 60], [140, 140], [220, 50], [300, 130]], [[320, 120], [420, 90]]];
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function http(method, path, body, headers) {
  var res = await fetch(base + path, { method: method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  var json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json };
}
async function cleanup() {
  if (!cust) return;
  await pool.query("DELETE FROM notifications WHERE title LIKE '%Zqs%' AND (link LIKE '/quotations?open=%' OR link LIKE '/estimates?open=%' OR link LIKE '/invoices?open=%')");
  await pool.query('DELETE FROM invoice_online_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = $1)', [cust.id]);
  await pool.query('DELETE FROM receipts WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM payments WHERE customer_id = $1', [cust.id]);
  await pool.query("DELETE FROM document_responses WHERE document_id IN (SELECT id FROM quotations WHERE customer_id = $1 UNION SELECT id FROM estimates WHERE customer_id = $1)", [cust.id]);
  await pool.query("DELETE FROM document_shares WHERE document_id IN (SELECT id FROM quotations WHERE customer_id = $1 UNION SELECT id FROM estimates WHERE customer_id = $1 UNION SELECT id FROM invoices WHERE customer_id = $1)", [cust.id]);
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = $1 UNION SELECT id FROM quotations WHERE customer_id = $1 UNION SELECT id FROM estimates WHERE customer_id = $1)", [cust.id]);
  await pool.query('DELETE FROM invoices WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM quotations WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM estimates WHERE customer_id = $1', [cust.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [cust.id]);
}

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var old = (await pool.query("SELECT id FROM customers WHERE name = 'Zqs Bamboo Lodge'")).rows[0];
  if (old) { cust = old; await cleanup(); }
  cust = await customers.create(boss, { name: 'Zqs Bamboo Lodge', phone: '0240000771', email: 'zqs.lodge@example.com', category: 'active' });
  await pool.query('UPDATE customers SET account_manager_id = $2 WHERE id = $1', [cust.id, boss.employee.id]);
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(async function () {
  invoicePay.setFetchForTests(null);
  config.paystackBpl.secretKey = keyWas;
  if (server) await new Promise(function (r) { server.close(r); });
  await cleanup();
  await pool.end();
});

test('a signature must be a real one: strokes in the box, not a dot', function () {
  assert.equal(answers.cleanSignature(null), null);
  assert.equal(answers.cleanSignature([[[10, 10], [12, 11]]]), null);
  assert.equal(answers.cleanSignature([[[10, 10]]]), null);
  var s = answers.cleanSignature([[[-50, 10], [900, 500], ['x', 3]]]);
  assert.deepEqual(s, [[[0, 10], [600, 200]]]);
  var tooMany = [Array.from({ length: 4100 }, function (_, i) { return [i % 600, i % 200]; })];
  assert.equal(answers.cleanSignature(tooMany), null);
});

test('a quotation approved and signed on its link is accepted, kept, told to the rep and on its PDF', async function () {
  var q = await quotations.create(boss, { customerId: cust.id, items: [{ description: 'Zqs bamboo gazebo', qty: 1, unitPrice: 8000 }], validUntil: day(20) });
  await quotations.setStatus(boss, q.id, 'sent');
  var link = await shares.createShareLink(boss, 'quotation', q.id, 7);

  var page = await http('GET', '/api/share/' + link.token);
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.answerState, { open: true, why: null });
  assert.equal(page.body.answer, null);
  var row = (await pool.query('SELECT status, viewed_at FROM quotations WHERE id = $1', [q.id])).rows[0];
  assert.equal(row.status, 'viewed');
  assert.ok(row.viewed_at);

  var bad = await http('POST', '/api/share/' + link.token + '/answer', { action: 'approved', name: 'Zqs Ama', signature: [[[1, 1], [2, 2]]] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /Sign in the box/);
  bad = await http('POST', '/api/share/' + link.token + '/answer', { action: 'approved', name: 'Z', signature: SIG });
  assert.match(bad.body.error.message, /full name/);
  bad = await http('POST', '/api/share/' + link.token + '/answer', { action: 'changes', note: '' });
  assert.match(bad.body.error.message, /what you would like changed/);

  var changes = await http('POST', '/api/share/' + link.token + '/answer', { action: 'changes', name: 'Zqs Ama', note: 'Zqs: can the roof be thatched?' });
  assert.equal(changes.status, 200);
  assert.equal((await pool.query('SELECT status, client_answer FROM quotations WHERE id = $1', [q.id])).rows[0].client_answer, 'changes');

  var ok = await http('POST', '/api/share/' + link.token + '/answer', { action: 'approved', name: 'Zqs Ama Mensah', signature: SIG }, { 'User-Agent': 'zqs-test' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.answer.action, 'approved');
  row = (await pool.query('SELECT status, client_answer, answered_at FROM quotations WHERE id = $1', [q.id])).rows[0];
  assert.equal(row.status, 'accepted');
  assert.equal(row.client_answer, 'approved');
  assert.ok(row.answered_at);

  // Final once approved.
  var again = await http('POST', '/api/share/' + link.token + '/answer', { action: 'declined', name: 'Zqs Ama' });
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /approved already/);

  page = await http('GET', '/api/share/' + link.token);
  assert.equal(page.body.answer.action, 'approved');
  assert.equal(page.body.answer.name, 'Zqs Ama Mensah');
  assert.deepEqual(page.body.answerState, { open: false, why: 'approved' });
  assert.equal(page.body.answer.signature.length, 2);

  var staff = await answers.list(boss, 'quotation', q.id);
  assert.deepEqual(staff.map(function (a) { return a.action; }), ['approved', 'changes']);
  var told = (await pool.query('SELECT title FROM notifications WHERE employee_id = $1 AND link = $2 ORDER BY at', [boss.employee.id, '/quotations?open=' + q.id])).rows;
  assert.equal(told.length, 2);
  assert.match(told[1].title, /Zqs Ama Mensah approved quotation .* online/);
  var mapped = (await quotations.list(boss)).find(function (x) { return x.id === q.id; });
  assert.equal(mapped.clientAnswer, 'approved');
  assert.ok(mapped.viewedAt);
  var audit = (await pool.query("SELECT actor_name FROM audit_logs WHERE entity_id = $1 AND action = 'quotation.client_approved'", [String(q.id)])).rows[0];
  assert.equal(audit.actor_name, 'Zqs Ama Mensah (customer)');

  var pdf = await documentPdf.documentPdf('quotation', q.id);
  assert.ok(pdf.buffer.length > 1000);
  assert.equal(pdf.view.answer.action, 'approved');

  // A rep who cannot read quotations does not see the answers.
  await assert.rejects(answers.list({ can: function () { return false; } }, 'quotation', q.id), /quotation.read/);
});

test('an estimate declined keeps its status; an expired or put-away one cannot be answered', async function () {
  var es = await estimates.create(boss, { customerId: cust.id, items: [{ description: 'Zqs bamboo fence', qty: 20, unitPrice: 150 }], validUntil: day(10) });
  var link = await shares.createShareLink(boss, 'estimate', es.id, 7);
  var no = await http('POST', '/api/share/' + link.token + '/answer', { action: 'declined', name: 'Zqs Kofi', note: 'Zqs: over budget' });
  assert.equal(no.status, 200);
  var row = (await pool.query('SELECT status, client_answer FROM estimates WHERE id = $1', [es.id])).rows[0];
  assert.equal(row.client_answer, 'declined');
  assert.notEqual(row.status, 'archived');
  var page = await http('GET', '/api/share/' + link.token);
  assert.deepEqual(page.body.answerState, { open: false, why: 'declined' });
  var told = (await pool.query('SELECT title, body FROM notifications WHERE employee_id = $1 AND link = $2', [boss.employee.id, '/estimates?open=' + es.id])).rows[0];
  assert.match(told.title, /Zqs Kofi declined estimate/);
  assert.equal(told.body, 'Zqs: over budget');

  var old = await estimates.create(boss, { customerId: cust.id, items: [{ description: 'Zqs bamboo gate', qty: 1, unitPrice: 900 }], validUntil: day(10) });
  await pool.query('UPDATE estimates SET valid_until = $2 WHERE id = $1', [old.id, day(-2)]);
  var oldLink = await shares.createShareLink(boss, 'estimate', old.id, 7);
  var late = await http('POST', '/api/share/' + oldLink.token + '/answer', { action: 'approved', name: 'Zqs Kofi', signature: SIG });
  assert.equal(late.status, 409);
  assert.match(late.body.error.message, /expired/);

  // An invoice's link has nothing to approve.
  var inv = await invoices.createManual(boss, { customerId: cust.id, items: [{ description: 'Zqs bamboo mat', qty: 1, unitPrice: 50 }], currency: 'GHS' });
  var invLink = await shares.createShareLink(boss, 'invoice', inv.id, 7);
  var wrong = await http('POST', '/api/share/' + invLink.token + '/answer', { action: 'approved', name: 'Zqs Kofi', signature: SIG });
  assert.equal(wrong.status, 400);
  var gone = await http('POST', '/api/share/not-a-real-token/answer', { action: 'changes', note: 'Zqs hello' });
  assert.equal(gone.status, 404);
});

// Paystack, as its API answers (no request leaves the machine).
var paystack = {};
function stubPaystack() {
  config.paystackBpl.secretKey = 'zqs-fake-bpl-paystack-key';
  invoicePay.setFetchForTests(async function (url, opts) {
    var data;
    if (/\/transaction\/initialize$/.test(url)) {
      var body = JSON.parse(opts.body);
      paystack[body.reference] = { status: 'ongoing', amount: body.amount, sent: body };
      data = { authorization_url: 'https://checkout.paystack.com/zqs' + body.reference.slice(-6).toLowerCase(), reference: body.reference };
    } else {
      var ref = decodeURIComponent(url.split('/').pop());
      var st = paystack[ref] || { status: 'ongoing', amount: 0 };
      data = { reference: ref, status: st.status, amount: st.amount, channel: st.channel || '', fees: 150, authorization: { card_type: 'visa ', last4: '4081' } };
    }
    return { ok: true, status: 200, json: async function () { return { status: true, message: 'ok', data: data }; } };
  });
}
async function paid(ref, extra) {
  Object.assign(paystack[ref], { status: 'success' }, extra || {});
  await pool.query('UPDATE invoice_online_payments SET checked_at = NULL WHERE reference = $1', [ref]);
}

test('paying an invoice online: the next part of its schedule, then the rest; each recorded once with a receipt', async function () {
  config.paystackBpl.secretKey = '';
  var inv = await invoices.createManual(boss, {
    customerId: cust.id, currency: 'GHS', items: [{ description: 'Zqs bamboo pavilion', qty: 1, unitPrice: 10000 }],
    paymentSchedule: [{ label: 'Zqs deposit', type: 'fixed', value: 4000, dueDate: day(3) }, { label: 'Zqs balance', type: 'fixed', value: 6000, dueDate: day(30) }]
  });
  var link = await shares.createShareLink(boss, 'invoice', inv.id, 7);
  var page = await http('GET', '/api/share/' + link.token);
  assert.equal(page.body.pay.on, false);
  assert.equal(page.body.pay.why, 'off');
  var off = await http('POST', '/api/share/' + link.token + '/pay', { pay: 'all' });
  assert.equal(off.status, 409);

  stubPaystack();
  page = await http('GET', '/api/share/' + link.token);
  assert.equal(page.body.pay.on, true);
  assert.deepEqual(page.body.pay.options.map(function (o) { return [o.kind, o.amount, o.label]; }), [['next', 4000, 'Zqs deposit'], ['all', 10000, 'The full balance']]);
  assert.equal((await pool.query('SELECT viewed_at FROM invoices WHERE id = $1', [inv.id])).rows[0].viewed_at !== null, true);

  // The amount is the server's: whatever the page sends, it is the deposit.
  var a = await http('POST', '/api/share/' + link.token + '/pay', { pay: 'next', amount: 1, back: 'https://evil.example.com' });
  assert.equal(a.status, 201);
  assert.equal(a.body.amount, 4000);
  assert.match(a.body.url, /^https:\/\/checkout\.paystack\.com\//);
  var sent = paystack[a.body.reference].sent;
  assert.equal(sent.amount, 400000);
  assert.equal(sent.currency, 'GHS');
  assert.deepEqual(sent.channels, ['card', 'mobile_money']);
  assert.equal(sent.email, 'zqs.lodge@example.com');
  assert.ok(sent.callback_url.indexOf('evil.example.com') < 0);
  assert.ok(sent.callback_url.endsWith('/share/' + link.token));

  var waiting = await http('GET', '/api/share/' + link.token + '/pay/' + a.body.reference);
  assert.equal(waiting.body.status, 'pending');
  assert.equal(waiting.body.recorded, false);

  await paid(a.body.reference, { channel: 'mobile_money' });
  // The page asking twice at once and Paystack's webhook with them: recorded once.
  var rawFirst = JSON.stringify({ event: 'charge.success', data: { reference: a.body.reference, status: 'success', amount: 400000, channel: 'mobile_money' } });
  var sigFirst = crypto.createHmac('sha512', 'zqs-fake-bpl-paystack-key').update(rawFirst).digest('hex');
  var together = await Promise.all([
    http('GET', '/api/share/' + link.token + '/pay/' + a.body.reference), http('GET', '/api/share/' + link.token + '/pay/' + a.body.reference),
    http('POST', '/api/share/paystack/webhook', rawFirst, { 'x-paystack-signature': sigFirst }), http('GET', '/api/share/' + link.token + '/pay/' + a.body.reference)
  ]);
  assert.ok(together.every(function (r) { return r.status === 200; }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [inv.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM receipts WHERE invoice_id = $1', [inv.id])).rows[0].n, 1);
  var done = await http('GET', '/api/share/' + link.token + '/pay/' + a.body.reference);
  assert.equal(done.body.status, 'success');
  assert.equal(done.body.recorded, true);
  var i = (await pool.query('SELECT status, amount_paid, balance_due FROM invoices WHERE id = $1', [inv.id])).rows[0];
  assert.equal(i.status, 'partially_paid');
  assert.equal(Number(i.amount_paid), 4000);
  var pays = (await pool.query("SELECT p.method, p.source, p.reference, p.received_by, r.receipt_no FROM payments p JOIN receipts r ON r.payment_id = p.id WHERE p.invoice_id = $1", [inv.id])).rows;
  assert.equal(pays.length, 1);
  assert.equal(pays[0].method, 'mobile_money');
  assert.equal(pays[0].source, 'online');
  assert.equal(pays[0].reference, 'Paystack ' + a.body.reference);
  assert.equal(pays[0].received_by, boss.employee.id);

  // Asked again, and Paystack's webhook too: still one payment.
  await http('GET', '/api/share/' + link.token + '/pay/' + a.body.reference);
  var raw = JSON.stringify({ event: 'charge.success', data: { reference: a.body.reference, status: 'success', amount: 400000, channel: 'mobile_money' } });
  var sig = crypto.createHmac('sha512', 'zqs-fake-bpl-paystack-key').update(raw).digest('hex');
  var hook = await http('POST', '/api/share/paystack/webhook', raw, { 'x-paystack-signature': sig });
  assert.equal(hook.status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [inv.id])).rows[0].n, 1);

  // Not signed with the key: refused.
  var forged = await http('POST', '/api/share/paystack/webhook', raw, { 'x-paystack-signature': 'zqs-forged' });
  assert.equal(forged.status, 403);

  // Another invoice's link cannot look at this payment.
  var other = await invoices.createManual(boss, { customerId: cust.id, currency: 'GHS', items: [{ description: 'Zqs bamboo stool', qty: 1, unitPrice: 300 }] });
  var otherLink = await shares.createShareLink(boss, 'invoice', other.id, 7);
  var peek = await http('GET', '/api/share/' + otherLink.token + '/pay/' + a.body.reference);
  assert.equal(peek.status, 404);

  // Now only the rest is left; paid by the webhook alone.
  page = await http('GET', '/api/share/' + link.token);
  assert.deepEqual(page.body.pay.options.map(function (o) { return [o.kind, o.amount]; }), [['all', 6000]]);
  var b = await http('POST', '/api/share/' + link.token + '/pay', { pay: 'all' });
  assert.equal(b.body.amount, 6000);
  paystack[b.body.reference].status = 'success';
  raw = JSON.stringify({ event: 'charge.success', data: { reference: b.body.reference, status: 'success', amount: 600000, channel: 'card', authorization: { card_type: 'visa', last4: '4081' } } });
  sig = crypto.createHmac('sha512', 'zqs-fake-bpl-paystack-key').update(raw).digest('hex');
  hook = await http('POST', '/api/share/paystack/webhook', raw, { 'x-paystack-signature': sig });
  assert.equal(hook.status, 200);
  i = (await pool.query('SELECT status, balance_due FROM invoices WHERE id = $1', [inv.id])).rows[0];
  assert.equal(i.status, 'paid');
  var card = (await pool.query('SELECT card_brand, card_last4, payment_id FROM invoice_online_payments WHERE reference = $1', [b.body.reference])).rows[0];
  assert.equal(card.card_brand, 'visa');
  assert.equal(card.card_last4, '4081');
  assert.ok(card.payment_id);
  page = await http('GET', '/api/share/' + link.token);
  assert.equal(page.body.pay.on, false);
  assert.equal(page.body.pay.why, 'paid');
  assert.equal(page.body.pay.paidOnline.length, 2);
  var told = (await pool.query("SELECT title FROM notifications WHERE employee_id = $1 AND link = $2 AND title LIKE '%paid%online%'", [boss.employee.id, '/invoices?open=' + inv.id])).rows;
  assert.equal(told.length, 2);
  var paidAgain = await http('POST', '/api/share/' + link.token + '/pay', { pay: 'all' });
  assert.equal(paidAgain.status, 409);
});

test('paid online after it was paid by hand: not recorded twice, the rep told once', async function () {
  stubPaystack();
  var inv = await invoices.createManual(boss, { customerId: cust.id, currency: 'GHS', items: [{ description: 'Zqs bamboo blinds', qty: 2, unitPrice: 400 }] });
  var link = await shares.createShareLink(boss, 'invoice', inv.id, 7);
  var a = await http('POST', '/api/share/' + link.token + '/pay', { pay: 'all' });
  await invoices.recordPayment(boss, inv.id, { amount: 800, method: 'cash' });
  await paid(a.body.reference);
  var r = await http('GET', '/api/share/' + link.token + '/pay/' + a.body.reference);
  assert.equal(r.body.status, 'success');
  assert.equal(r.body.recorded, false);
  await http('GET', '/api/share/' + link.token + '/pay/' + a.body.reference);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [inv.id])).rows[0].n, 1);
  assert.match((await pool.query('SELECT problem FROM invoice_online_payments WHERE reference = $1', [a.body.reference])).rows[0].problem, /already fully paid/);
  var told = (await pool.query("SELECT title, body FROM notifications WHERE employee_id = $1 AND link = $2 AND title LIKE '%not recorded%'", [boss.employee.id, '/invoices?open=' + inv.id])).rows;
  assert.equal(told.length, 1);
  assert.match(told[0].body, /Record it by hand, or refund it in Paystack/);
});

test('paid a different amount than asked, or not in cedis: never recorded as paid', async function () {
  stubPaystack();
  var inv = await invoices.createManual(boss, { customerId: cust.id, currency: 'GHS', items: [{ description: 'Zqs bamboo lamp', qty: 2, unitPrice: 250 }] });
  var link = await shares.createShareLink(boss, 'invoice', inv.id, 7);
  var a = await http('POST', '/api/share/' + link.token + '/pay', { pay: 'all' });
  assert.equal(a.body.amount, 500);
  await paid(a.body.reference, { amount: 100 });
  var r = await http('GET', '/api/share/' + link.token + '/pay/' + a.body.reference);
  assert.equal(r.body.status, 'failed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [inv.id])).rows[0].n, 0);

  var usd = await invoices.createManual(boss, { customerId: cust.id, currency: 'USD', items: [{ description: 'Zqs bamboo screen', qty: 1, unitPrice: 90 }] });
  var usdLink = await shares.createShareLink(boss, 'invoice', usd.id, 7);
  var page = await http('GET', '/api/share/' + usdLink.token);
  assert.equal(page.body.pay.on, false);
  assert.equal(page.body.pay.why, 'currency');
  var no = await http('POST', '/api/share/' + usdLink.token + '/pay', { pay: 'all' });
  assert.equal(no.status, 409);
  assert.match(no.body.error.message, /not in cedis/);
});

// Estimates made in Square, read from their PDFs (frontend lib/squareEstimates.js)
// and brought into Estimates (squareEstimates.service.js).
test('a Square estimate\'s text is read: number, dates, customer, items, totals', async function () {
  var lib = await import('../../frontend/src/lib/squareEstimates.js');
  var rows = [
    'Zq Bamboo Works', 'Estimate', 'Estimate # 000207',
    'Bill to\tEstimate date\t12/10/2026', 'Zqs Palm Villas\tExpires\t11/11/2026', 'zqs.palm@example.com', '024 000 0888',
    'Description\tAmount',
    'Bamboo deck tiles', '40 × GH₵85.00\tGH₵3,400.00', 'Oiled, 30cm',
    'Fixing kit\t2 x GH₵120.00\tGH₵240.00',
    'Subtotal\tGH₵3,640.00', 'Discount\t-GH₵140.00', 'Total\tGH₵3,500.00', 'Message', 'Zqs: thank you'
  ];
  var e = lib.parseSquareEstimate(rows);
  assert.equal(e.squareNo, '000207');
  assert.equal(e.date, '2026-10-12');
  assert.equal(e.validUntil, '2026-11-11');
  assert.equal(e.customer.name, 'Zqs Palm Villas');
  assert.equal(e.customer.email, 'zqs.palm@example.com');
  assert.equal(e.customer.phone, '024 000 0888');
  assert.deepEqual(e.items.map(function (it) { return [it.description, it.qty, it.unitPrice, it.notes]; }), [['Bamboo deck tiles', 40, 85, 'Oiled, 30cm'], ['Fixing kit', 2, 120, '']]);
  assert.equal(e.subtotal, 3640);
  assert.equal(e.discount, 140);
  assert.equal(e.total, 3500);
  assert.deepEqual(e.warnings, []);
  assert.equal(lib.dateOf('Nov 3rd, 2026'), '2026-11-03');
  assert.equal(lib.dateOf('3 September 2026'), '2026-09-03');
  assert.equal(lib.moneyOf('$1,234.50'), 1234.5);
  var pasted = lib.parseSquareEstimate(lib.textRows('Estimate #000300\nItem    Qty    Price    Amount\nZqs stool    3    $40.00    $120.00\nSubtotal    $120.00'));
  assert.deepEqual(pasted.items.map(function (it) { return [it.description, it.qty, it.unitPrice]; }), [['Zqs stool', 3, 40]]);
  assert.deepEqual(pasted.warnings, ['customer']);
});

test('Square estimates brought over: customer found or added, once each, backdated, answer kept', async function () {
  var squareEstimates = require('../src/services/squareEstimates.service');
  var e1 = { squareNo: '#ZQS901', customer: { name: 'Someone Else', email: 'ZQS.LODGE@example.com' }, date: '2026-09-01', validUntil: day(30), status: 'accepted',
    items: [{ description: 'Zqs bamboo bar counter', qty: 1, unitPrice: 6000 }, { description: 'Zqs stools', qty: 4, unitPrice: 300, discount: 100 }], taxRate: 15, notes: 'Zqs: from Square' };
  var e2 = { squareNo: 'ZQS902', customer: { name: 'Zqs Brand New Cafe', email: 'zqs.cafe@example.com', phone: '0240000992' }, status: 'finalized', items: [{ description: 'Zqs menu boards', qty: 3, unitPrice: 150 }] };
  var r = await squareEstimates.importParsed(boss, [e1, e2]);
  assert.equal(r.created.length, 2);
  assert.equal(r.customersAdded, 1);
  var one = (await pool.query('SELECT * FROM estimates WHERE id = $1', [r.created[0].id])).rows[0];
  assert.equal(one.customer_id, cust.id);
  assert.equal(one.external_id, 'square-estimate:zqs901');
  assert.equal(one.source, 'square');
  assert.equal(one.status, 'finalized');
  assert.equal(one.client_answer, 'approved');
  assert.equal(one.created_at.toISOString().slice(0, 10), '2026-09-01');
  assert.equal(Number(one.subtotal), 7200);
  assert.equal(Number(one.grand_total), Math.round((7100 * 1.15) * 100) / 100);
  assert.equal(one.client_notes, 'Zqs: from Square');
  var two = (await pool.query('SELECT e.*, c.name, c.source AS csource, c.category FROM estimates e JOIN customers c ON c.id = e.customer_id WHERE e.id = $1', [r.created[1].id])).rows[0];
  assert.equal(two.name, 'Zqs Brand New Cafe');
  assert.equal(two.csource, 'square');
  assert.equal(two.category, 'prospect');
  assert.equal(two.client_answer, null);

  var again = await squareEstimates.importParsed(boss, [e1]);
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped[0].id, r.created[0].id);
  var mapped = (await estimates.list(boss)).find(function (x) { return x.id === r.created[0].id; });
  assert.equal(mapped.source, 'square');
  assert.equal(mapped.squareNo, 'zqs901');

  await assert.rejects(squareEstimates.importParsed(boss, [{ squareNo: 'ZQS903', customer: { name: 'Zqs X' }, items: [] }]), /has no items/);
  await assert.rejects(squareEstimates.importParsed(boss, [{ squareNo: '', items: [{ description: 'x', qty: 1, unitPrice: 1 }] }]), /Square number/);
  await assert.rejects(squareEstimates.importParsed({ can: function () { return false; } }, [e2]), /quotation.manage/);
  await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM estimates WHERE customer_id = $1)", [two.customer_id]);
  await pool.query('DELETE FROM estimates WHERE customer_id = $1', [two.customer_id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [two.customer_id]);
});

test('repeating invoices: each day\'s raised once, from the first invoice, until the last', async function () {
  var invoiceSeries = require('../src/services/invoiceSeries.service');
  assert.equal(invoiceSeries.advance('2026-01-31', 'month', 1), '2026-02-28');
  assert.equal(invoiceSeries.advance('2026-01-31', 'quarter', 1), '2026-04-30');
  assert.equal(invoiceSeries.advance('2026-02-27', 'week', 2), '2026-03-13');
  assert.equal(invoiceSeries.advance('2028-02-29', 'year', 1), '2029-02-28');

  var inv = await invoices.createManual(boss, { customerId: cust.id, currency: 'GHS', items: [{ description: 'Zqs monthly upkeep', qty: 1, unitPrice: 750 }], taxRate: 0, notes: 'Zqs: upkeep of the bamboo garden' });
  await assert.rejects(invoiceSeries.create(boss, inv.id, { every: 'month', startOn: day(-1) }), /past/);
  await assert.rejects(invoiceSeries.create(boss, inv.id, { every: 'fortnight' }), /Repeat every/);
  var s = await invoiceSeries.create(boss, inv.id, { every: 'month', startOn: day(0), maxCount: 2, dueDays: 10, name: 'Zqs upkeep' });
  assert.equal(s.status, 'active');
  assert.equal(s.nextOn, day(0));
  await assert.rejects(invoiceSeries.create(boss, inv.id, { every: 'month' }), /already repeats/);

  assert.equal(await invoiceSeries.runDue(new Date()), 1);
  assert.equal(await invoiceSeries.runDue(new Date()), 0);
  var first = (await pool.query('SELECT * FROM invoices WHERE series_id = $1 AND series_period IS NOT NULL ORDER BY series_period', [s.id])).rows;
  assert.equal(first.length, 1);
  assert.equal(String(first[0].series_period).slice(0, 10), day(0));
  assert.equal(String(first[0].issued_at).slice(0, 10), day(0));
  assert.equal(String(first[0].due_date).slice(0, 10), day(10));
  assert.equal(Number(first[0].grand_total), 750);
  assert.equal(first[0].notes, 'Zqs: upkeep of the bamboo garden');
  var lines = (await pool.query("SELECT description FROM document_line_items WHERE document_type = 'invoice' AND document_id = $1", [first[0].id])).rows;
  assert.deepEqual(lines.map(function (l) { return l.description; }), ['Zqs monthly upkeep']);
  var told = (await pool.query('SELECT title FROM notifications WHERE employee_id = $1 AND link = $2', [boss.employee.id, '/invoices?open=' + first[0].id])).rows;
  assert.match(told[0].title, /raised for Zqs Bamboo Lodge/);

  // Paused: nothing raised; started again, from the next day still to come.
  var later = new Date(Date.now() + 40 * 86400000);
  await invoiceSeries.update(boss, s.id, { status: 'paused' });
  assert.equal(await invoiceSeries.runDue(later), 0);
  var back = await invoiceSeries.update(boss, s.id, { status: 'active' });
  assert.equal(back.nextOn, invoiceSeries.advance(day(0), 'month', 1));
  assert.equal(await invoiceSeries.runDue(later), 1);
  var listed = (await invoiceSeries.list(boss)).find(function (x) { return x.id === s.id; });
  assert.equal(listed.raised, 2);
  assert.equal(listed.status, 'ended');
  assert.equal(listed.templateNo, inv.invoiceNo);
  assert.ok(listed.lastInvoice && listed.lastInvoice.invoiceNo);
  assert.equal(await invoiceSeries.runDue(new Date(Date.now() + 400 * 86400000)), 0);
  await assert.rejects(invoiceSeries.update(boss, s.id, { status: 'active' }), /stopped/);
  var mapped = (await invoices.list(boss)).find(function (x) { return x.id === first[0].id; });
  assert.equal(mapped.seriesId, s.id);
  await assert.rejects(invoiceSeries.list({ can: function () { return false; } }), /invoice.read/);
  await pool.query('UPDATE invoices SET series_id = NULL WHERE series_id = $1', [s.id]);
  await pool.query('DELETE FROM invoice_series WHERE id = $1', [s.id]);
});

test('item options make the variations; changed, the new ones are added and the old put away; bulk edit', async function () {
  var catalogOptions = require('../src/services/catalogOptions.service');
  var catalog = require('../src/services/catalog.service');
  var item = await catalog.create(boss, { name: 'Zqs Lounge chair', code: 'ZQS-LCH', unitPrice: 900, costPrice: 400, stockQty: 5 });
  try {
    await assert.rejects(catalogOptions.set(boss, item.id, { options: [{ name: 'Size', choices: [] }] }), /at least one choice/);
    await assert.rejects(catalogOptions.set(boss, item.id, { options: [{ name: 'Size', choices: ['S'] }, { name: 'size', choices: ['M'] }] }), /Two options/);
    var r = await catalogOptions.set(boss, item.id, { options: [{ name: 'Size', choices: ['Small', 'Large', 'small'] }, { name: 'Finish', choices: ['Natural', 'Dark'] }] });
    assert.equal(r.added, 4);
    assert.equal(r.putAway, 1);
    var vars = (await pool.query('SELECT name, code, unit_price, cost_price, active, option_values FROM catalog_item_variations WHERE item_id = $1 ORDER BY active, position', [item.id])).rows;
    var on = vars.filter(function (v) { return v.active; });
    assert.deepEqual(on.map(function (v) { return v.name; }), ['Small / Natural', 'Small / Dark', 'Large / Natural', 'Large / Dark']);
    assert.deepEqual(on.map(function (v) { return v.code; }), ['ZQS-LCH-SMAL-NATU', 'ZQS-LCH-SMAL-DARK', 'ZQS-LCH-LARG-NATU', 'ZQS-LCH-LARG-DARK']);
    assert.equal(Number(on[0].unit_price), 900);
    assert.deepEqual(on[3].option_values, { Size: 'Large', Finish: 'Dark' });
    assert.equal(vars[0].active, false); // the first one, Regular, put away

    // A price changed on one, then Medium added and Dark taken off.
    var dark = (await pool.query("SELECT id FROM catalog_item_variations WHERE item_id = $1 AND name = 'Large / Natural'", [item.id])).rows[0].id;
    await pool.query('UPDATE catalog_item_variations SET unit_price = 1200 WHERE id = $1', [dark]);
    r = await catalogOptions.set(boss, item.id, { options: [{ name: 'Size', choices: ['Small', 'Medium', 'Large'] }, { name: 'Finish', choices: ['Natural'] }], unitPrice: 1000 });
    assert.equal(r.kept, 2);
    assert.equal(r.added, 1);
    assert.equal(r.putAway, 2);
    on = (await pool.query('SELECT id, name, code, unit_price FROM catalog_item_variations WHERE item_id = $1 AND active ORDER BY name', [item.id])).rows;
    assert.equal(on.find(function (v) { return v.name === 'Medium / Natural'; }).code, 'ZQS-LCH-MEDI-NATU');
    assert.deepEqual(on.map(function (v) { return [v.name, Number(v.unit_price)]; }), [['Large / Natural', 1200], ['Medium / Natural', 1000], ['Small / Natural', 900]]);
    assert.deepEqual(await catalogOptions.get(boss, item.id), [{ name: 'Size', choices: ['Small', 'Medium', 'Large'] }, { name: 'Finish', choices: ['Natural'] }]);
    var listed = (await catalog.listItems(boss)).find(function (x) { return x.id === item.id; });
    assert.equal(listed.options.length, 2);
    assert.deepEqual(listed.variations.find(function (v) { return v.name === 'Medium / Natural'; }).optionValues, { Size: 'Medium', Finish: 'Natural' });

    // Bulk: prices, a stock count and one put away, in one go, each kept in the log.
    var b = await catalogOptions.bulk(boss, { changes: [
      { id: on[0].id, unitPrice: 1300, stockQty: 7 }, { id: on[1].id, costPrice: 450 }, { id: on[2].id, active: false }, { id: on[2].id, unitPrice: 900 }
    ], note: 'Zqs price review' });
    assert.equal(b.changed, 3);
    assert.equal(b.stockChanges, 1);
    var after = (await pool.query('SELECT name, unit_price, cost_price, stock_qty, active FROM catalog_item_variations WHERE id = ANY($1::uuid[]) ORDER BY name', [[on[0].id, on[1].id, on[2].id]])).rows;
    assert.deepEqual(after.map(function (v) { return [v.name, Number(v.unit_price), Number(v.cost_price), Number(v.stock_qty), v.active]; }),
      [['Large / Natural', 1300, 400, 7, true], ['Medium / Natural', 1000, 450, 0, true], ['Small / Natural', 900, 400, 0, false]]);
    var logged = (await pool.query("SELECT summary FROM audit_logs WHERE entity_id = $1 AND action = 'catalog.variation.stock'", [String(on[0].id)])).rows[0];
    assert.match(logged.summary, /stock 0 → 7/);
    assert.match(logged.summary, /Zqs price review/);
    await assert.rejects(catalogOptions.bulk(boss, { changes: [{ id: on[0].id, unitPrice: -1 }] }), /zero or more/);
    await assert.rejects(catalogOptions.bulk({ can: function () { return false; } }, { changes: [{ id: on[0].id, unitPrice: 1 }] }), /catalog.manage/);
  } finally {
    await pool.query('DELETE FROM catalog_items WHERE id = $1', [item.id]);
  }
});
